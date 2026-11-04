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
