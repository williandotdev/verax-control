import 'reflect-metadata';
import { randomBytes, randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AWS_READER_AUDIENCE, cloudAccountSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

/** IDs de conta fictícios (12 dígitos), diferentes a cada chamada. */
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (prefix = 'trilha') => `${prefix}-${randomInt(1_000_000, 9_999_999)}`;
/** Projeto da GCP, conta do Cloudflare, assinatura e zona fictícios, diferentes a cada chamada. */
const gcpProject = () => `vx-${randomInt(1_000_000, 9_999_999)}-proj`;
const cloudflareAccount = () => randomBytes(16).toString('hex');
const subscription = (project = gcpProject(), id = `verax-logs-${randomInt(1_000_000, 9_999_999)}`) =>
  `projects/${project}/subscriptions/${id}`;
const zone = () => `z${randomInt(1_000_000, 9_999_999)}.example.com`;

describe('contas cloud (T3.3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession;
  let adminB: TestSession;
  let readerA: TestSession;

  async function sessionFor(tenantId: string, role: 'admin_cliente' | 'leitura' | 'analista_cliente') {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }

  const call = (session: TestSession) => {
    const server = request(app.getHttpServer());
    const write = (method: 'post' | 'patch' | 'put' | 'delete', path: string) =>
      server[method](path)
        .set('Cookie', session.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', session.csrfToken);
    return {
      get: (path: string) => server.get(path).set('Cookie', session.cookie),
      post: (path: string, body: object) => write('post', path).send(body),
      patch: (path: string, body: object) => write('patch', path).send(body),
      put: (path: string, body: object) => write('put', path).send(body),
      delete: (path: string) => write('delete', path),
    };
  };
  const newAccount = (overrides: object = {}) => ({
    provider: 'aws',
    accountId: accountId(),
    regions: ['sa-east-1', 'us-east-1'],
    ...overrides,
  });
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A');
    tenantB = await createTenant(app, 'Cliente B');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    readerA = await sessionFor(tenantA, 'leitura');
  });

  afterAll(async () => {
    await app.close();
  });

  describeTenantIsolation({
    resource: 'contas cloud',
    basePath: '/v1/cloud-accounts',
    context: () => ({ app, sessionA: adminA, sessionB: adminB }),
    createInTenantB: async () =>
      (
        await prisma.cloudAccount.create({
          data: { tenantId: tenantB, accountId: accountId(), regions: ['sa-east-1'] },
        })
      ).id,
    readDirect: (id) => prisma.cloudAccount.findUniqueOrThrow({ where: { id } }),
    patchBody: { regions: ['eu-west-1'] },
    hasDelete: true,
  });

  describe('cadastro', () => {
    it('AWS sem chave: deriva o papel de leitura do ID, sem ExternalId na conta, na linha nem na trilha', async () => {
      const body = newAccount({
        buckets: { cloudtrail: bucket(), waf: `aws-waf-logs-${randomInt(1e6, 9e6)}` },
      });
      const created = await call(adminA).post('/v1/cloud-accounts', body).expect(201);
      const account = cloudAccountSchema.parse(created.body);
      expect(account.readerRoleArn).toBe(`arn:aws:iam::${account.accountId}:role/verax/verax-control-reader`);
      expect(account).toMatchObject({ connection: 'waiting', checkRequestedAt: null, ingestFrom: null });
      // Este nó (como o ambiente local) não informa o ID da conta de serviço nem o IP de saída: a tela os pede à Verax.
      // O audience é o padrão do template.
      expect(account).toMatchObject({
        nodeServiceAccountId: null,
        webIdentityAudience: AWS_READER_AUDIENCE,
        egressIps: [],
      });
      expect(account.buckets.guardduty).toBeNull();
      expect(created.text).not.toMatch(/externalId|ExternalId|VeraxControlReadOnly/);
      expect(
        (await prisma.cloudAccount.findUniqueOrThrow({ where: { id: account.id } })).externalId,
      ).toBeNull();

      const entry = await entryOf(created);
      expect(entry).toMatchObject({ action: 'cloud_account.create', tenantId: tenantA });
      expect(JSON.stringify(entry)).not.toMatch(/externalId/i);
    });

    it.each([
      ['ExternalId no corpo', { externalId: 'escolhido-pelo-cliente-0000000000000000' }],
      ['chave de acesso', { accessKeyId: 'chave-colada-no-cadastro', secretAccessKey: 'x'.repeat(40) }],
      ['papel escolhido', { roleArn: 'arn:aws:iam::123456789012:role/Admin' }],
      ['papel de leitura escolhido', { readerRoleArn: 'arn:aws:iam::123456789012:role/Admin' }],
      ['ID da conta de serviço do nó', { nodeServiceAccountId: '123456789012345678901' }],
      ['pedido de verificação', { checkRequestedAt: '2026-11-04T12:00:00.000Z' }],
      ['dia de início da coleta', { ingestFrom: '2020-01-01' }],
      ['cliente no corpo', { tenantId: '018f0000-0000-7000-8000-00000000000b' }],
      ['ID de conta curto', { accountId: '12345' }],
      ['região inválida', { regions: ['marte-1'] }],
      ['região repetida', { regions: ['sa-east-1', 'sa-east-1'] }],
      ['bucket do WAF sem o prefixo da AWS', { buckets: { waf: 'logs-do-waf' } }],
      ['nome de bucket inválido', { buckets: { cloudtrail: 'Bucket_Maiusculo' } }],
    ])('recusa %s (400)', async (_label, overrides) => {
      await call(adminA).post('/v1/cloud-accounts', newAccount(overrides)).expect(400);
    });

    it('um ID de conta não pertence a dois clientes', async () => {
      const id = accountId();
      await call(adminA)
        .post('/v1/cloud-accounts', newAccount({ accountId: id }))
        .expect(201);
      const conflict = await call(adminB)
        .post('/v1/cloud-accounts', newAccount({ accountId: id }))
        .expect(409);
      expect(conflict.body).toMatchObject({ message: 'Esta conta já está cadastrada' });
      expect(await prisma.cloudAccount.count({ where: { accountId: id } })).toBe(1);
    });

    it('um bucket de log é de um cliente só; contas do mesmo cliente podem dividi-lo', async () => {
      const shared = bucket();
      await call(adminA)
        .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: shared } }))
        .expect(201);
      await call(adminA)
        .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: shared } }))
        .expect(201);
      await call(adminB)
        .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: shared } }))
        .expect(409);
    });

    it('o mesmo bucket em outra fonte, em outro cliente, também é recusado', async () => {
      const name = bucket('multiuso');
      await call(adminA)
        .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: name } }))
        .expect(201);
      await call(adminB)
        .post('/v1/cloud-accounts', newAccount({ buckets: { guardduty: name } }))
        .expect(409);
    });

    it('dois clientes registrando o mesmo bucket ao mesmo tempo: só um consegue', async () => {
      const contested = bucket('disputado');
      const results = await Promise.all([
        call(adminA).post('/v1/cloud-accounts', newAccount({ buckets: { guardduty: contested } })),
        call(adminB).post('/v1/cloud-accounts', newAccount({ buckets: { guardduty: contested } })),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    });
  });

  describe('GCP e Cloudflare', () => {
    it('projeto da GCP: sem papel nem valores do papel da AWS; a assinatura do Pub/Sub fica gravada', async () => {
      const name = subscription();
      const created = await call(adminA)
        .post('/v1/cloud-accounts', { provider: 'gcp', accountId: gcpProject(), pubsubSubscription: name })
        .expect(201);
      const account = cloudAccountSchema.parse(created.body);
      expect(account).toMatchObject({
        provider: 'gcp',
        readerRoleArn: null,
        nodeServiceAccountId: null,
        webIdentityAudience: null,
        checkRequestedAt: null,
        ingestFrom: null,
        egressIps: [],
        regions: [],
        pubsubSubscription: name,
        zones: [],
        // Sem GCP_SINK_TOPIC_PREFIX (como no ambiente local), sem tópico para o comando do sink.
        sinkTopic: null,
        sinkWriterIdentity: null,
      });
      expect(await entryOf(created)).toMatchObject({ action: 'cloud_account.create', tenantId: tenantA });
    });

    it('conta do Cloudflare: zonas gravadas, sem token', async () => {
      const zones = [zone(), zone()];
      const created = await call(adminA)
        .post('/v1/cloud-accounts', { provider: 'cloudflare', accountId: cloudflareAccount(), zones })
        .expect(201);
      expect(cloudAccountSchema.parse(created.body)).toMatchObject({
        provider: 'cloudflare',
        readerRoleArn: null,
        nodeServiceAccountId: null,
        webIdentityAudience: null,
        zones,
        pubsubSubscription: null,
        // Sem credencial ainda, e sem NODE_EGRESS_IPS (como no ambiente local), sem IP para o filtro do token.
        keyStatus: null,
        egressIps: [],
      });
    });

    it('sem o cofre ligado no nó (como o nó da Verax), colar o token dá 409, sem chamar o Cloudflare nem gravar', async () => {
      const created = await call(adminA)
        .post('/v1/cloud-accounts', { provider: 'cloudflare', accountId: cloudflareAccount() })
        .expect(201);
      const id = (created.body as { id: string }).id;
      // Formato válido, gerado na hora; a checagem do cofre vem antes de qualquer chamada para fora.
      const token = randomBytes(30).toString('base64url');
      const response = await call(adminA)
        .put(`/v1/cloud-accounts/${id}/credential`, { kind: 'cloudflare_api_token', token })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'CREDENTIAL_VAULT_DISABLED' });
      expect(response.text).not.toContain(token);
      expect(await prisma.cloudCredential.count({ where: { cloudAccountId: id } })).toBe(0);
      await call(readerA)
        .put(`/v1/cloud-accounts/${id}/credential`, { kind: 'cloudflare_api_token', token })
        .expect(403);
    });

    it.each([
      [
        'token do Cloudflare',
        { provider: 'cloudflare', accountId: cloudflareAccount(), apiToken: 'x'.repeat(40) },
      ],
      [
        'chave de conta de serviço da GCP',
        { provider: 'gcp', accountId: gcpProject(), credentialsJson: '{}' },
      ],
      ['regiões num projeto da GCP', { provider: 'gcp', accountId: gcpProject(), regions: ['sa-east-1'] }],
      ['ID de conta AWS como projeto', { provider: 'gcp', accountId: accountId() }],
      [
        'zona com protocolo',
        { provider: 'cloudflare', accountId: cloudflareAccount(), zones: ['https://x.com'] },
      ],
      ['provedor desconhecido', { provider: 'azure', accountId: gcpProject() }],
    ])('recusa %s (400)', async (_label, body) => {
      await call(adminA).post('/v1/cloud-accounts', body).expect(400);
    });

    it('um projeto não pertence a dois clientes', async () => {
      const project = gcpProject();
      await call(adminA).post('/v1/cloud-accounts', { provider: 'gcp', accountId: project }).expect(201);
      await call(adminB).post('/v1/cloud-accounts', { provider: 'gcp', accountId: project }).expect(409);
    });

    it('o mesmo ID de assinatura em projetos diferentes não conflita: vale o nome completo', async () => {
      const id = `verax-logs-${randomInt(1_000_000, 9_999_999)}`;
      await call(adminA)
        .post('/v1/cloud-accounts', {
          provider: 'gcp',
          accountId: gcpProject(),
          pubsubSubscription: subscription(gcpProject(), id),
        })
        .expect(201);
      await call(adminB)
        .post('/v1/cloud-accounts', {
          provider: 'gcp',
          accountId: gcpProject(),
          pubsubSubscription: subscription(gcpProject(), id),
        })
        .expect(201);
    });

    it('só o ID da assinatura, sem o projeto, é recusado', async () => {
      await call(adminA)
        .post('/v1/cloud-accounts', {
          provider: 'gcp',
          accountId: gcpProject(),
          pubsubSubscription: 'verax-logs',
        })
        .expect(400);
    });

    it('a assinatura serve vários projetos do mesmo cliente, nunca de outro', async () => {
      const name = subscription();
      for (const session of [adminA, adminA]) {
        await call(session)
          .post('/v1/cloud-accounts', { provider: 'gcp', accountId: gcpProject(), pubsubSubscription: name })
          .expect(201);
      }
      const conflict = await call(adminB)
        .post('/v1/cloud-accounts', { provider: 'gcp', accountId: gcpProject(), pubsubSubscription: name })
        .expect(409);
      expect(conflict.body).toMatchObject({
        message: `A assinatura ${name} já está cadastrada em outro cliente`,
      });
    });

    it('uma zona do Cloudflare é de um cliente só, inclusive ao alterar', async () => {
      const taken = zone();
      await call(adminA)
        .post('/v1/cloud-accounts', {
          provider: 'cloudflare',
          accountId: cloudflareAccount(),
          zones: [taken],
        })
        .expect(201);
      await call(adminB)
        .post('/v1/cloud-accounts', {
          provider: 'cloudflare',
          accountId: cloudflareAccount(),
          zones: [taken],
        })
        .expect(409);
      const other = cloudAccountSchema.parse(
        (
          await call(adminB)
            .post('/v1/cloud-accounts', { provider: 'cloudflare', accountId: cloudflareAccount() })
            .expect(201)
        ).body,
      );
      await call(adminB)
        .patch(`/v1/cloud-accounts/${other.id}`, { zones: [zone(), taken] })
        .expect(409);
    });

    it('a alteração só aceita os campos do provedor da conta', async () => {
      const gcp = cloudAccountSchema.parse(
        (
          await call(adminA)
            .post('/v1/cloud-accounts', { provider: 'gcp', accountId: gcpProject() })
            .expect(201)
        ).body,
      );
      const refused = await call(adminA)
        .patch(`/v1/cloud-accounts/${gcp.id}`, { regions: ['sa-east-1'], zones: [zone()] })
        .expect(400);
      expect(refused.body).toMatchObject({ message: 'Campo que não existe nesta conta: regions, zones' });
      const name = subscription();
      const updated = await call(adminA)
        .patch(`/v1/cloud-accounts/${gcp.id}`, { pubsubSubscription: name })
        .expect(200);
      expect(updated.body).toMatchObject({ pubsubSubscription: name, regions: [] });

      const aws = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      await call(adminA)
        .patch(`/v1/cloud-accounts/${aws.id}`, { pubsubSubscription: subscription() })
        .expect(400);
    });

    it('o banco aceita conta AWS sem ExternalId (o papel sem chave não tem), e só a AWS tem verificação e início da coleta', async () => {
      await expect(
        prisma.cloudAccount.create({
          data: { tenantId: tenantA, provider: 'aws', accountId: accountId(), regions: [] },
        }),
      ).resolves.toMatchObject({ externalId: null, checkRequestedAt: null, ingestFrom: null });
      for (const data of [
        { checkRequestedAt: new Date() },
        { ingestFrom: new Date('2026-11-03T00:00:00.000Z') },
      ]) {
        await expect(
          prisma.cloudAccount.create({
            data: { tenantId: tenantA, provider: 'gcp', accountId: gcpProject(), regions: [], ...data },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('leitura', () => {
    it('leitura vê a conta e os valores do papel (nenhum é segredo); não cadastra nem altera', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      const seen = await call(readerA).get(`/v1/cloud-accounts/${created.id}`).expect(200);
      expect(seen.body).toMatchObject({ id: created.id, readerRoleArn: created.readerRoleArn });
      const list = await call(readerA).get('/v1/cloud-accounts?pageSize=100').expect(200);
      expect(JSON.stringify(list.body)).not.toMatch(/externalId/i);

      await call(readerA).post('/v1/cloud-accounts', newAccount()).expect(403);
      await call(readerA)
        .patch(`/v1/cloud-accounts/${created.id}`, { regions: ['us-east-1'] })
        .expect(403);
      await call(readerA).delete(`/v1/cloud-accounts/${created.id}`).expect(403);
    });
  });

  describe('alteração', () => {
    it('regiões e buckets mudam; null apaga um bucket; o ID da conta não muda', async () => {
      const created = cloudAccountSchema.parse(
        (
          await call(adminA)
            .post('/v1/cloud-accounts', newAccount({ buckets: { cloudtrail: bucket() } }))
            .expect(201)
        ).body,
      );
      const updated = await call(adminA)
        .patch(`/v1/cloud-accounts/${created.id}`, { regions: ['eu-west-1'], buckets: { cloudtrail: null } })
        .expect(200);
      expect(updated.body).toMatchObject({ regions: ['eu-west-1'], buckets: { cloudtrail: null } });
      expect(await entryOf(updated)).toMatchObject({ action: 'cloud_account.update', tenantId: tenantA });

      await call(adminA).patch(`/v1/cloud-accounts/${created.id}`, { accountId: accountId() }).expect(400);
    });

    it('o último evento gravado pelo sync aparece na conta', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      expect(created.lastEventAt).toBeNull();
      const at = new Date('2026-11-03T10:15:00.000Z');
      await prisma.cloudAccount.update({ where: { id: created.id }, data: { lastEventAt: at } });
      const seen = await call(readerA).get(`/v1/cloud-accounts/${created.id}`).expect(200);
      expect(seen.body).toMatchObject({ lastEventAt: at.toISOString() });
    });

    it('desativar é exclusão lógica, auditada', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      const removed = await call(adminA).delete(`/v1/cloud-accounts/${created.id}`).expect(204);
      expect((await prisma.cloudAccount.findUniqueOrThrow({ where: { id: created.id } })).status).toBe(
        'inactive',
      );
      expect(await entryOf(removed)).toMatchObject({
        action: 'cloud_account.deactivate',
        before: { status: 'active' },
        after: { status: 'inactive' },
      });
    });
  });

  describe('conta cadastrada pela Verax no console (sincronização com o plano de controle)', () => {
    /** Como a tarefa `control-plane-sync` do worker grava a conta do console. */
    const consoleAccount = (tenantId = tenantA) =>
      prisma.cloudAccount.create({
        data: {
          tenantId,
          provider: 'cloudflare',
          accountId: cloudflareAccount(),
          regions: [],
          zones: [zone()],
          origin: 'control_plane',
          controlPlaneRevision: 1,
        },
      });

    it('a conta mostra quem cadastrou (managedBy)', async () => {
      const verax = await consoleAccount();
      const panel = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      expect(panel.managedBy).toBe('panel');
      const seen = cloudAccountSchema.parse(
        (await call(readerA).get(`/v1/cloud-accounts/${verax.id}`).expect(200)).body,
      );
      expect(seen.managedBy).toBe('verax');
    });

    it('o painel não altera, desativa nem reativa a conta do console: 409 CONSOLE_MANAGED, sem mudar nada', async () => {
      const verax = await consoleAccount();
      for (const body of [{ zones: [zone()] }, { status: 'inactive' }]) {
        const refused = await call(adminA).patch(`/v1/cloud-accounts/${verax.id}`, body).expect(409);
        expect(refused.body).toMatchObject({ code: 'CONSOLE_MANAGED' });
        expect((refused.body as { message: string }).message).toBe(
          'Cadastrada pela Verax: peça a alteração à Verax.',
        );
        expect(await entryOf(refused)).toMatchObject({
          action: 'cloud_account.update',
          resourceId: verax.id,
          outcome: 'failure',
          tenantId: tenantA,
        });
      }
      const removed = await call(adminA).delete(`/v1/cloud-accounts/${verax.id}`).expect(409);
      expect(removed.body).toMatchObject({ code: 'CONSOLE_MANAGED' });
      expect(await entryOf(removed)).toMatchObject({
        action: 'cloud_account.deactivate',
        outcome: 'failure',
      });
      expect(await prisma.cloudAccount.findUniqueOrThrow({ where: { id: verax.id } })).toMatchObject({
        status: 'active',
        zones: verax.zones,
        updatedAt: verax.updatedAt,
      });
    });

    it('a credencial continua com o cliente (o DELETE responde como em qualquer conta)', async () => {
      const verax = await consoleAccount();
      const response = await call(adminA).delete(`/v1/cloud-accounts/${verax.id}/credential`).expect(404);
      expect((response.body as { code?: string }).code).not.toBe('CONSOLE_MANAGED');
    });

    it('o "Verificar" da conta AWS do console continua com o cliente', async () => {
      const verax = await prisma.cloudAccount.create({
        data: {
          tenantId: tenantA,
          accountId: accountId(),
          regions: ['us-east-1'],
          origin: 'control_plane',
          controlPlaneRevision: 2,
        },
      });
      await call(adminA).post(`/v1/cloud-accounts/${verax.id}/aws/verify`, {}).expect(202);
    });

    it('o cliente B não altera a conta do console de A (404, não 409)', async () => {
      const verax = await consoleAccount();
      await call(adminB)
        .patch(`/v1/cloud-accounts/${verax.id}`, { zones: [zone()] })
        .expect(404);
    });

    it('a trilha do cliente mostra o que o nó aplicou do console como "Verax (administrativo)"', async () => {
      const verax = await consoleAccount();
      await prisma.auditLog.create({
        data: {
          actorType: 'system',
          actorId: 'verax-control-plane',
          tenantId: tenantA,
          action: 'cloud_account.create',
          outcome: 'success',
          resourceType: 'cloud_account',
          resourceId: verax.id,
        },
      });
      const trail = await call(adminA).get('/v1/audit?resourceType=cloud_account').expect(200);
      const entry = (trail.body as { items: { resourceId: string; actor: unknown }[] }).items.find(
        (item) => item.resourceId === verax.id,
      );
      expect(entry?.actor).toEqual({
        type: 'system',
        id: null,
        name: 'Verax (administrativo)',
        verax: false,
      });
    });

    it('a linha do console exige a revisão, e a do painel não aceita uma (CHECK do banco)', async () => {
      await expect(
        prisma.cloudAccount.create({
          data: {
            tenantId: tenantA,
            provider: 'cloudflare',
            accountId: cloudflareAccount(),
            origin: 'control_plane',
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.cloudAccount.create({
          data: {
            tenantId: tenantA,
            provider: 'cloudflare',
            accountId: cloudflareAccount(),
            controlPlaneRevision: 1,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('exclusão do cadastro (POST /v1/cloud-accounts/:id/delete)', () => {
    const remove = (session: TestSession, id: string, confirmAccountId: string) =>
      call(session).post(`/v1/cloud-accounts/${id}/delete`, { confirmAccountId });

    /** O que as chaves estrangeiras levam junto com a conta. */
    const dependents = (id: string) =>
      Promise.all([
        prisma.awsSource.count({ where: { cloudAccountId: id } }),
        prisma.awsDiscoveryRun.count({ where: { cloudAccountId: id } }),
        prisma.collectorCursor.count({ where: { cloudAccountId: id } }),
        prisma.awsVolumeObject.count({ where: { cloudAccountId: id } }),
        prisma.cloudCredential.count({ where: { cloudAccountId: id } }),
      ]);

    /** Um achado da conta, como o sync grava: guarda o ID da conta como texto. */
    const findingOf = (tenantId: string, account: string) =>
      prisma.finding.create({
        data: {
          tenantId,
          accountId: account,
          source: 'wazuh',
          sourceEventId: `wazuh/${account}/cloudtrail:${randomBytes(8).toString('hex')}:80202`,
          logSource: 'cloudtrail',
          occurredAt: new Date('2026-11-20T12:00:00.000Z'),
          severity: 'high',
          ruleId: '80202',
          ruleLevel: 10,
          title: 'Achado de teste da conta excluída',
          mitreTactics: [],
          mitreTechniques: [],
        },
      });

    it('AWS do painel: a linha e o que depende dela saem; o achado e a trilha ficam; o mesmo ID volta', async () => {
      const id = accountId();
      const created = cloudAccountSchema.parse(
        (
          await call(adminA)
            .post('/v1/cloud-accounts', newAccount({ accountId: id, buckets: { cloudtrail: bucket() } }))
            .expect(201)
        ).body,
      );
      await prisma.awsDiscoveryRun.create({
        data: { tenantId: tenantA, cloudAccountId: created.id, trigger: 'connect' },
      });
      await prisma.collectorCursor.create({
        data: { cloudAccountId: created.id, stream: 'aws_security_hub', region: 'sa-east-1' },
      });
      await prisma.awsVolumeObject.create({
        data: {
          cloudAccountId: created.id,
          tenantId: tenantA,
          objectHash: randomBytes(32).toString('hex'),
          day: new Date('2026-11-20T00:00:00Z'),
          stream: 'cloudtrail',
          compressedBytes: 10n,
          bytes: 500n,
          isizeFallback: false,
        },
      });
      const finding = await findingOf(tenantA, id);
      const [sources, runs, cursors, objects] = await dependents(created.id);
      expect({ sources, runs, cursors, objects }).toEqual({ sources: 1, runs: 1, cursors: 1, objects: 1 });

      const deleted = await remove(adminA, created.id, id).expect(204);

      expect(deleted.text).toBe('');
      expect(await prisma.cloudAccount.findUnique({ where: { id: created.id } })).toBeNull();
      expect(await dependents(created.id)).toEqual([0, 0, 0, 0, 0]);
      expect(await prisma.finding.findUniqueOrThrow({ where: { id: finding.id } })).toMatchObject({
        accountId: id,
        tenantId: tenantA,
      });
      const entry = await entryOf(deleted);
      expect(entry).toMatchObject({
        action: 'cloud_account.delete',
        resourceType: 'cloud_account',
        resourceId: created.id,
        outcome: 'success',
        tenantId: tenantA,
        actorType: 'user',
        before: { accountId: id, provider: 'aws', origin: 'panel', managedBy: 'panel' },
      });
      expect(entry.after).toBeNull();
      expect(JSON.stringify(entry.before)).not.toMatch(/ciphertext|secret|token/i);
      // A trilha de antes da exclusão continua lá.
      expect(
        await prisma.auditLog.count({ where: { resourceId: created.id, action: 'cloud_account.create' } }),
      ).toBe(1);
      await call(adminA).get(`/v1/cloud-accounts/${created.id}`).expect(404);

      // O mesmo ID de conta pode ser cadastrado de novo (outro cadastro, outro id).
      const again = cloudAccountSchema.parse(
        (
          await call(adminA)
            .post('/v1/cloud-accounts', newAccount({ accountId: id }))
            .expect(201)
        ).body,
      );
      expect(again.id).not.toBe(created.id);
      expect(again).toMatchObject({ accountId: id, connection: 'waiting', status: 'active' });
    });

    it('Cloudflare (e conta desativada): sai e o mesmo ID volta, inclusive noutro cliente', async () => {
      const id = cloudflareAccount();
      const zoneName = zone();
      const created = cloudAccountSchema.parse(
        (
          await call(adminA)
            .post('/v1/cloud-accounts', { provider: 'cloudflare', accountId: id, zones: [zoneName] })
            .expect(201)
        ).body,
      );
      await call(adminA).delete(`/v1/cloud-accounts/${created.id}`).expect(204);
      await remove(adminA, created.id, id).expect(204);
      expect(await prisma.cloudAccount.count({ where: { accountId: id } })).toBe(0);
      // A conta e a zona ficam livres.
      await call(adminB)
        .post('/v1/cloud-accounts', { provider: 'cloudflare', accountId: id, zones: [zoneName] })
        .expect(201);
    });

    it('o ID digitado diferente: 400 ACCOUNT_ID_MISMATCH, nada muda, e a recusa fica na trilha', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      const before = await prisma.cloudAccount.findUniqueOrThrow({ where: { id: created.id } });
      for (const typed of [accountId(), ` ${created.accountId}`, created.accountId.slice(1)]) {
        const refused = await remove(adminA, created.id, typed).expect(400);
        expect(refused.body).toMatchObject({ code: 'ACCOUNT_ID_MISMATCH' });
        expect(await entryOf(refused)).toMatchObject({
          action: 'cloud_account.delete',
          resourceId: created.id,
          outcome: 'failure',
          tenantId: tenantA,
        });
      }
      for (const body of [{}, { confirmAccountId: created.accountId, permanent: true }]) {
        await call(adminA).post(`/v1/cloud-accounts/${created.id}/delete`, body).expect(400);
      }
      expect(await prisma.cloudAccount.findUniqueOrThrow({ where: { id: created.id } })).toEqual(before);
    });

    it('quem só lê não exclui (403); o cliente B recebe 404 na conta de A, e nada muda', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      const before = await prisma.cloudAccount.findUniqueOrThrow({ where: { id: created.id } });
      await remove(readerA, created.id, created.accountId).expect(403);
      await remove(adminB, created.id, created.accountId).expect(404);
      expect(await prisma.cloudAccount.findUniqueOrThrow({ where: { id: created.id } })).toEqual(before);
      // Uma conta que não existe (ou já foi excluída) também é 404.
      await remove(adminA, '018f0000-0000-7000-8000-0000000000ff', created.accountId).expect(404);
    });

    it('conta do console: sai, e a sincronização guarda a falha deleted_in_panel na revisão de agora', async () => {
      const verax = await prisma.cloudAccount.create({
        data: {
          tenantId: tenantA,
          provider: 'cloudflare',
          accountId: cloudflareAccount(),
          zones: [zone()],
          origin: 'control_plane',
          controlPlaneRevision: 3,
        },
      });
      // O resultado da credencial da fonte sai junto: a conta recriada recebe de novo a do console.
      await prisma.controlPlaneSyncItem.create({
        data: {
          kind: 'log_source_credential',
          itemId: verax.id,
          tenantId: tenantA,
          revision: 1,
          outcome: 'applied',
        },
      });

      const deleted = await remove(adminA, verax.id, verax.accountId).expect(204);

      expect(await prisma.cloudAccount.findUnique({ where: { id: verax.id } })).toBeNull();
      expect(
        await prisma.controlPlaneSyncItem.findUnique({
          where: { kind_itemId: { kind: 'log_source', itemId: verax.id } },
        }),
      ).toMatchObject({
        tenantId: tenantA,
        revision: 3,
        outcome: 'failed',
        code: 'deleted_in_panel',
        nextAttemptAt: null,
      });
      expect(
        await prisma.controlPlaneSyncItem.findUnique({
          where: { kind_itemId: { kind: 'log_source_credential', itemId: verax.id } },
        }),
      ).toBeNull();
      expect(await entryOf(deleted)).toMatchObject({
        action: 'cloud_account.delete',
        outcome: 'success',
        before: { origin: 'control_plane', managedBy: 'verax' },
      });
    });

    it('conta do console com uma revisão mais nova que falhou: a falha da exclusão fica nessa revisão', async () => {
      const verax = await prisma.cloudAccount.create({
        data: {
          tenantId: tenantA,
          provider: 'cloudflare',
          accountId: cloudflareAccount(),
          zones: [zone()],
          origin: 'control_plane',
          controlPlaneRevision: 2,
        },
      });
      await prisma.controlPlaneSyncItem.create({
        data: {
          kind: 'log_source',
          itemId: verax.id,
          tenantId: tenantA,
          revision: 5,
          outcome: 'failed',
          code: 'origin_conflict',
        },
      });
      await remove(adminA, verax.id, verax.accountId).expect(204);
      expect(
        await prisma.controlPlaneSyncItem.findUnique({
          where: { kind_itemId: { kind: 'log_source', itemId: verax.id } },
        }),
      ).toMatchObject({ revision: 5, outcome: 'failed', code: 'deleted_in_panel' });
    });

    it('o cliente B não exclui a conta do console de A (404), e nenhum item da sincronização é gravado', async () => {
      const verax = await prisma.cloudAccount.create({
        data: {
          tenantId: tenantA,
          provider: 'cloudflare',
          accountId: cloudflareAccount(),
          zones: [zone()],
          origin: 'control_plane',
          controlPlaneRevision: 1,
        },
      });
      await remove(adminB, verax.id, verax.accountId).expect(404);
      expect(await prisma.cloudAccount.findUnique({ where: { id: verax.id } })).not.toBeNull();
      expect(await prisma.controlPlaneSyncItem.count({ where: { itemId: verax.id } })).toBe(0);
    });
  });

  describe('conexão (fase 2)', () => {
    it('a API devolve a conexão: aguardando no cadastro, depois o que o coletor gravou', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      expect(created).toMatchObject({ connection: 'waiting', connectionError: null, lastCollectedAt: null });

      await prisma.cloudAccount.update({
        where: { id: created.id },
        data: { connection: 'error', connectionError: 'AccessDenied' },
      });
      const failed = await call(readerA).get(`/v1/cloud-accounts/${created.id}`).expect(200);
      expect(cloudAccountSchema.parse(failed.body)).toMatchObject({
        connection: 'error',
        connectionError: 'AccessDenied',
        lastCollectedAt: null,
      });

      const at = new Date('2026-11-03T12:00:00.000Z');
      await prisma.cloudAccount.update({
        where: { id: created.id },
        data: { connection: 'connected', connectionError: null, lastCollectedAt: at },
      });
      const list = await call(readerA).get('/v1/cloud-accounts?pageSize=100').expect(200);
      const seen = (list.body as { items: { id: string }[] }).items.find((item) => item.id === created.id);
      expect(seen).toMatchObject({
        connection: 'connected',
        connectionError: null,
        lastCollectedAt: at.toISOString(),
      });
    });

    it('ninguém grava a conexão pela API: só o coletor', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      await call(adminA)
        .post('/v1/cloud-accounts', newAccount({ connection: 'connected' }))
        .expect(400);
      for (const body of [
        { connection: 'connected' },
        { connectionError: null },
        { lastCollectedAt: '2026-11-03T12:00:00.000Z' },
      ]) {
        await call(adminA).patch(`/v1/cloud-accounts/${created.id}`, body).expect(400);
      }
      expect(
        await prisma.cloudAccount.findUniqueOrThrow({
          where: { id: created.id },
          select: { connection: true, lastCollectedAt: true },
        }),
      ).toEqual({ connection: 'waiting', lastCollectedAt: null });
    });

    it('trocar a assinatura do Pub/Sub volta a conexão para aguardando; a mesma assinatura não muda nada', async () => {
      const project = gcpProject();
      const created = cloudAccountSchema.parse(
        (
          await call(adminA)
            .post('/v1/cloud-accounts', {
              provider: 'gcp',
              accountId: project,
              pubsubSubscription: subscription(project),
            })
            .expect(201)
        ).body,
      );
      const at = new Date('2026-11-03T12:00:00.000Z');
      // Com evento já recebido: o sync da GCP de outro teste, rodando ao mesmo tempo no mesmo banco, lê todas as
      // contas GCP ativas e mantém conectada a que já recebeu evento (a sem evento ele deixaria aguardando).
      await prisma.cloudAccount.update({
        where: { id: created.id },
        data: { connection: 'connected', lastCollectedAt: at, lastEventAt: at },
      });
      // Confere a resposta da própria alteração, e não uma leitura depois: o sync pode gravar a conexão desta conta a
      // qualquer momento.
      const same = await call(adminA)
        .patch(`/v1/cloud-accounts/${created.id}`, { pubsubSubscription: created.pubsubSubscription })
        .expect(200);
      expect(same.body).toMatchObject({ connection: 'connected' });

      const changed = await call(adminA)
        .patch(`/v1/cloud-accounts/${created.id}`, { pubsubSubscription: subscription(project) })
        .expect(200);
      // A última coleta continua: é história, não estado.
      const account = cloudAccountSchema.parse(changed.body);
      expect(account).toMatchObject({ connection: 'waiting', connectionError: null });
      expect(account.lastCollectedAt).not.toBeNull();
      expect(await entryOf(changed)).toMatchObject({
        action: 'cloud_account.update',
        before: { connection: 'connected' },
        after: { connection: 'waiting' },
      });
    });

    it('desativar e reativar a conta voltam a conexão para aguardando, com o antes e o depois na auditoria', async () => {
      const created = cloudAccountSchema.parse(
        (await call(adminA).post('/v1/cloud-accounts', newAccount()).expect(201)).body,
      );
      const at = new Date('2026-11-03T12:00:00.000Z');
      await prisma.cloudAccount.update({
        where: { id: created.id },
        data: { connection: 'connected', lastCollectedAt: at, lastEventAt: at },
      });
      const stored = () =>
        prisma.cloudAccount.findUniqueOrThrow({
          where: { id: created.id },
          select: { status: true, connection: true, connectionError: true, lastCollectedAt: true },
        });

      // Desativada, a conta para de ser lida: nem conectada nem com erro. A última coleta é história.
      const removed = await call(adminA).delete(`/v1/cloud-accounts/${created.id}`).expect(204);
      expect(await stored()).toEqual({
        status: 'inactive',
        connection: 'waiting',
        connectionError: null,
        lastCollectedAt: at,
      });
      expect(await entryOf(removed)).toMatchObject({
        action: 'cloud_account.deactivate',
        before: { status: 'active', connection: 'connected' },
        after: { status: 'inactive', connection: 'waiting' },
      });

      // Reativada, recomeça do zero, qualquer que fosse o estado gravado enquanto parada.
      await prisma.cloudAccount.update({
        where: { id: created.id },
        data: { connection: 'error', connectionError: 'AccessDenied' },
      });
      const reactivated = await call(adminA)
        .patch(`/v1/cloud-accounts/${created.id}`, { status: 'active' })
        .expect(200);
      expect(cloudAccountSchema.parse(reactivated.body)).toMatchObject({
        status: 'active',
        connection: 'waiting',
        connectionError: null,
        lastCollectedAt: at.toISOString(),
      });
      expect(await entryOf(reactivated)).toMatchObject({
        action: 'cloud_account.update',
        before: { status: 'inactive', connection: 'error', connectionError: 'AccessDenied' },
        after: { status: 'active', connection: 'waiting', connectionError: null },
      });

      // Desativar pela alteração também recomeça; repetir a situação atual, ou mudar só as regiões, não mexe.
      await prisma.cloudAccount.update({ where: { id: created.id }, data: { connection: 'connected' } });
      const unchanged = await call(adminA)
        .patch(`/v1/cloud-accounts/${created.id}`, { status: 'active', regions: ['eu-west-1'] })
        .expect(200);
      expect(unchanged.body).toMatchObject({ connection: 'connected' });
      const paused = await call(adminA)
        .patch(`/v1/cloud-accounts/${created.id}`, { status: 'inactive' })
        .expect(200);
      expect(paused.body).toMatchObject({ status: 'inactive', connection: 'waiting' });
    });

    it('isolamento: A não vê a conexão nem o erro das contas de B', async () => {
      const ofB = await prisma.cloudAccount.create({
        data: {
          tenantId: tenantB,
          accountId: accountId(),
          regions: ['sa-east-1'],
          connection: 'error',
          connectionError: 'ErroDaContaDoClienteB',
          lastCollectedAt: new Date('2026-11-03T11:00:00.000Z'),
        },
      });
      const list = await call(adminA).get('/v1/cloud-accounts?pageSize=100').expect(200);
      expect(JSON.stringify(list.body)).not.toContain('ErroDaContaDoClienteB');
      await call(adminA).get(`/v1/cloud-accounts/${ofB.id}`).expect(404);
      const own = await call(adminB).get(`/v1/cloud-accounts/${ofB.id}`).expect(200);
      expect(own.body).toMatchObject({ connection: 'error', connectionError: 'ErroDaContaDoClienteB' });
    });
  });
});
