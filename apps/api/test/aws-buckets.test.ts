import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CloudAccount, cloudAccountSchema, type Role } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

/** IDs de conta e buckets fictícios, diferentes a cada chamada (o nome do bucket é único no banco de teste). */
const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const suffix = () => randomInt(1_000_000, 9_999_999);
const trail = () => `exemplo-cloudtrail-${suffix()}`;
const guardduty = () => `exemplo-guardduty-${suffix()}`;
const waf = () => `aws-waf-logs-exemplo-${suffix()}`;

/**
 * Buckets de log da conta AWS no cadastro e na alteração (o campo do painel): um bucket por fonte, as regras do S3,
 * a auditoria com o antes e o depois, a conexão que volta a aguardar quando a lista muda (sem pedir nada à AWS),
 * papéis, isolamento entre clientes e o bucket que já é de outro cliente.
 *
 * Nenhum teste daqui pede "Verificar": a tarefa `aws-check` de `aws-connect.test.ts` varre os pedidos de todos os
 * clientes no mesmo banco (o pedido descartado pela troca de buckets é testado lá).
 */
describe('buckets de log da conta AWS (cadastro e alteração)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession;
  let adminB: TestSession;
  const sessions = new Map<Role, TestSession>();

  async function sessionFor(tenantId: string | null, role: Role): Promise<TestSession> {
    const user = await createSignedInUser(app, { role, ...(tenantId !== null && { tenantId }) });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }
  const get = (session: TestSession, path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', session.cookie);
  const write = (session: TestSession, method: 'post' | 'patch', path: string) => {
    const agent = request(app.getHttpServer());
    return agent[method](path)
      .set('Cookie', session.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', session.csrfToken);
  };
  const patchBuckets = (session: TestSession, id: string, buckets: unknown) =>
    write(session, 'patch', `/v1/cloud-accounts/${id}`).send({ buckets });
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });
  const rowOf = (id: string) =>
    prisma.cloudAccount.findUniqueOrThrow({
      where: { id },
      select: {
        cloudtrailBucket: true,
        guarddutyBucket: true,
        wafBucket: true,
        connection: true,
        connectionError: true,
        checkRequestedAt: true,
        ingestFrom: true,
      },
    });

  async function awsAccount(session: TestSession, buckets: object = {}): Promise<CloudAccount> {
    const created = await write(session, 'post', '/v1/cloud-accounts')
      .send({ provider: 'aws', accountId: accountId(), regions: ['sa-east-1'], buckets })
      .expect(201);
    return cloudAccountSchema.parse(created.body);
  }

  /** A conta como o "Verificar" deixou: conectada, lendo desde um dia. Nenhum coletor mexe numa conta AWS conectada. */
  const INGEST_FROM = new Date('2026-11-03T00:00:00.000Z');
  async function connected(id: string): Promise<void> {
    await prisma.cloudAccount.update({
      where: { id },
      data: { connection: 'connected', connectionError: null, ingestFrom: INGEST_FROM },
    });
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (buckets)');
    tenantB = await createTenant(app, 'Cliente Demo B (buckets)');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    sessions.set('admin_cliente', adminA);
    sessions.set('analista_cliente', await sessionFor(tenantA, 'analista_cliente'));
    sessions.set('leitura', await sessionFor(tenantA, 'leitura'));
    const verax = await sessionFor(null, 'admin_verax');
    await write(verax, 'post', '/v1/session/tenant').send({ tenantId: tenantA }).expect(200);
    sessions.set('admin_verax', verax);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('cadastro', () => {
    it('um bucket por fonte, gravados e na trilha; a conta nasce aguardando a verificação', async () => {
      const buckets = { cloudtrail: trail(), guardduty: guardduty(), waf: waf() };
      const created = await write(adminA, 'post', '/v1/cloud-accounts')
        .send({ provider: 'aws', accountId: accountId(), regions: ['sa-east-1'], buckets })
        .expect(201);
      const account = cloudAccountSchema.parse(created.body);
      expect(account.buckets).toEqual(buckets);
      expect(account).toMatchObject({ connection: 'waiting', checkRequestedAt: null });
      expect(await rowOf(account.id)).toMatchObject({
        cloudtrailBucket: buckets.cloudtrail,
        guarddutyBucket: buckets.guardduty,
        wafBucket: buckets.waf,
      });
      expect(await entryOf(created)).toMatchObject({
        action: 'cloud_account.create',
        tenantId: tenantA,
        after: { buckets },
      });
    });

    it.each([
      [
        'o ARN no lugar do nome',
        { cloudtrail: 'arn:aws:s3:::exemplo-cloudtrail-logs' },
        'buckets.cloudtrail',
      ],
      ['um começo reservado pela AWS', { guardduty: 'amzn-s3-demo-bucket' }, 'buckets.guardduty'],
      ['o WAF sem aws-waf-logs-', { waf: 'exemplo-waf-logs' }, 'buckets.waf'],
      ['outra fonte', { vpcflow: 'exemplo-vpc-flow-logs' }, 'buckets'],
    ])('recusa %s (400), com o campo do problema, sem cadastrar', async (_label, buckets, path) => {
      const id = accountId();
      const refused = await write(adminA, 'post', '/v1/cloud-accounts')
        .send({ provider: 'aws', accountId: id, regions: ['sa-east-1'], buckets })
        .expect(400);
      expect((refused.body as { issues: { path: string }[] }).issues.map((issue) => issue.path)).toContain(
        path,
      );
      expect(await prisma.cloudAccount.count({ where: { accountId: id } })).toBe(0);
    });
  });

  describe('alteração', () => {
    it('incluir buckets numa conta conectada: a conexão volta a aguardar, sem pedir nada à AWS; antes e depois na trilha', async () => {
      const first = trail();
      const account = await awsAccount(adminA, { cloudtrail: first });
      await connected(account.id);
      const added = { guardduty: guardduty(), waf: waf() };
      const response = await patchBuckets(adminA, account.id, added).expect(200);
      const updated = cloudAccountSchema.parse(response.body);
      expect(updated.buckets).toEqual({ cloudtrail: first, ...added });
      // Aguardando, sem erro e sem pedido: a verificação é do cliente, depois de atualizar a pilha.
      expect(updated).toMatchObject({
        connection: 'waiting',
        connectionError: null,
        checkRequestedAt: null,
        ingestFrom: '2026-11-03',
      });
      expect(await rowOf(account.id)).toMatchObject({
        guarddutyBucket: added.guardduty,
        wafBucket: added.waf,
        checkRequestedAt: null,
        ingestFrom: INGEST_FROM,
      });
      expect(await entryOf(response)).toMatchObject({
        action: 'cloud_account.update',
        outcome: 'success',
        tenantId: tenantA,
        before: { buckets: { cloudtrail: first, guardduty: null, waf: null }, connection: 'connected' },
        after: { buckets: { cloudtrail: first, ...added }, connection: 'waiting' },
      });
    });

    it('tirar um bucket (null) também recomeça a conexão, e o erro da lista antiga sai', async () => {
      const keep = trail();
      const account = await awsAccount(adminA, { cloudtrail: keep, waf: waf() });
      await prisma.cloudAccount.update({
        where: { id: account.id },
        data: { connection: 'error', connectionError: 'bucket_denied' },
      });
      const response = await patchBuckets(adminA, account.id, { waf: null }).expect(200);
      expect(cloudAccountSchema.parse(response.body)).toMatchObject({
        buckets: { cloudtrail: keep, guardduty: null, waf: null },
        connection: 'waiting',
        connectionError: null,
      });
    });

    it('a mesma lista, repetida ou só com a fonte trocada, não mexe na conexão', async () => {
      const [a, b] = [trail(), guardduty()];
      const account = await awsAccount(adminA, { cloudtrail: a, guardduty: b });
      await connected(account.id);
      const same = await patchBuckets(adminA, account.id, { cloudtrail: a, guardduty: b, waf: null }).expect(
        200,
      );
      expect(same.body).toMatchObject({ connection: 'connected' });
      // Os mesmos nomes em outras fontes: a pilha e o "Verificar" leem os mesmos buckets.
      const swapped = await patchBuckets(adminA, account.id, { cloudtrail: b, guardduty: a }).expect(200);
      expect(swapped.body).toMatchObject({
        buckets: { cloudtrail: b, guardduty: a, waf: null },
        connection: 'connected',
      });
      // Outra alteração sem os buckets (as regiões) também não mexe.
      const regions = await write(adminA, 'patch', `/v1/cloud-accounts/${account.id}`)
        .send({ regions: ['us-east-1'] })
        .expect(200);
      expect(regions.body).toMatchObject({ connection: 'connected' });
    });

    it('o mesmo bucket em duas fontes da conta vale (bucket central)', async () => {
      const central = trail();
      const account = await awsAccount(adminA);
      const response = await patchBuckets(adminA, account.id, {
        cloudtrail: central,
        guardduty: central,
      }).expect(200);
      expect(response.body).toMatchObject({ buckets: { cloudtrail: central, guardduty: central } });
    });

    it.each([
      ['o WAF sem aws-waf-logs-', { waf: 'exemplo-waf-logs' }],
      ['maiúscula', { cloudtrail: 'Exemplo-CloudTrail' }],
      ['o ARN no lugar do nome', { guardduty: 'arn:aws:s3:::exemplo-guardduty' }],
      ['um fim reservado pela AWS', { cloudtrail: 'exemplo-trilha--x-s3' }],
      ['outra fonte', { vpcflow: 'exemplo-vpc-flow-logs' }],
      ['uma lista', ['exemplo-cloudtrail-logs']],
      ['dois buckets na mesma fonte', { cloudtrail: ['exemplo-a', 'exemplo-b'] }],
    ])('recusa %s (400), sem mudar nada', async (_label, buckets) => {
      const original = trail();
      const account = await awsAccount(adminA, { cloudtrail: original });
      await connected(account.id);
      await patchBuckets(adminA, account.id, buckets).expect(400);
      expect(await rowOf(account.id)).toMatchObject({
        cloudtrailBucket: original,
        guarddutyBucket: null,
        wafBucket: null,
        connection: 'connected',
      });
    });

    it('buckets só existem na conta AWS', async () => {
      const gcp = cloudAccountSchema.parse(
        (
          await write(adminA, 'post', '/v1/cloud-accounts')
            .send({ provider: 'gcp', accountId: `vx-${suffix()}-bkt` })
            .expect(201)
        ).body,
      );
      const refused = await patchBuckets(adminA, gcp.id, { cloudtrail: trail() }).expect(400);
      expect(refused.body).toMatchObject({ message: 'Campo que não existe nesta conta: buckets' });
    });
  });

  describe('origem de log de um cliente só', () => {
    it('um bucket de outro cliente, em qualquer fonte, é recusado na alteração (409), sem dizer de quem', async () => {
      const taken = trail();
      await awsAccount(adminB, { cloudtrail: taken });
      const mine = await awsAccount(adminA);
      await connected(mine.id);
      const conflict = await patchBuckets(adminA, mine.id, { guardduty: taken }).expect(409);
      expect(conflict.body).toMatchObject({
        message: `O bucket ${taken} já está cadastrado em outro cliente`,
      });
      expect(conflict.text).not.toContain(tenantB);
      expect(await rowOf(mine.id)).toMatchObject({ guarddutyBucket: null, connection: 'connected' });
    });

    it('outra conta do mesmo cliente pode usar o mesmo bucket (a decisão da T5.2 continua)', async () => {
      const shared = trail();
      await awsAccount(adminA, { cloudtrail: shared });
      const other = await awsAccount(adminA);
      await patchBuckets(adminA, other.id, { cloudtrail: shared }).expect(200);
    });
  });

  describe('acesso', () => {
    it('A/B: os buckets da conta de B dão 404 para A, sem tocar nela; a tentativa fica na trilha de A', async () => {
      const original = trail();
      const ofB = await awsAccount(adminB, { cloudtrail: original });
      await connected(ofB.id);
      const response = await patchBuckets(adminA, ofB.id, { cloudtrail: null, waf: waf() }).expect(404);
      expect(await rowOf(ofB.id)).toMatchObject({
        cloudtrailBucket: original,
        wafBucket: null,
        connection: 'connected',
      });
      expect(await entryOf(response)).toMatchObject({
        outcome: 'failure',
        statusCode: 404,
        tenantId: tenantA,
      });
      expect((await get(adminB, `/v1/cloud-accounts/${ofB.id}`).expect(200)).body).toMatchObject({
        buckets: { cloudtrail: original, guardduty: null, waf: null },
      });
    });

    it('papéis: admin_cliente e admin_verax (com o cliente) alteram; analista e leitura, 403, sem gravar', async () => {
      const expected: Record<Role, number> = {
        admin_verax: 200,
        admin_cliente: 200,
        analista_cliente: 403,
        leitura: 403,
      };
      for (const [role, status] of Object.entries(expected) as [Role, number][]) {
        const account = await awsAccount(adminA);
        const name = trail();
        const response = await patchBuckets(sessions.get(role) as TestSession, account.id, {
          cloudtrail: name,
        }).expect(status);
        expect((await rowOf(account.id)).cloudtrailBucket).toBe(status === 200 ? name : null);
        if (status === 403) {
          expect(await entryOf(response)).toMatchObject({ outcome: 'denied', statusCode: 403 });
        }
      }
    });

    it('quem só lê vê os buckets', async () => {
      const buckets = { cloudtrail: trail(), guardduty: null, waf: waf() };
      const account = await awsAccount(adminA, buckets);
      const seen = await get(
        sessions.get('leitura') as TestSession,
        `/v1/cloud-accounts/${account.id}`,
      ).expect(200);
      expect(seen.body).toMatchObject({ buckets });
    });
  });
});
