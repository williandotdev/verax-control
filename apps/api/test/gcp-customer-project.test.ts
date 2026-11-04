import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { cloudAccountSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

/** Começo do tópico do nó, como o start.sh escreve no nó (projeto e prefixo fictícios). */
const TOPIC_PREFIX = 'projects/projeto-dos-nos/topics/verax-c1-security-';

/** Projeto, identidade de sink e conta AWS fictícios, diferentes a cada chamada. */
const gcpProject = () => `cli-${randomInt(1_000_000, 9_999_999)}-proj`;
const sinkIdentity = () =>
  `serviceAccount:service-${randomInt(100_000_000_000, 999_999_999_999)}@gcp-sa-logging.iam.gserviceaccount.com`;
const awsAccountId = () => String(randomInt(100_000_000_000, 999_999_999_999));

/**
 * Projeto GCP de cliente (fase 2, PR-05): o cliente cria o sink no projeto dele com o comando do painel, que aponta
 * para o tópico do nó, e cola a identidade do sink. A Verax não recebe nenhum papel no projeto do cliente; a
 * identidade vai para o Terraform do nó (`customer_projects`), que só a deixa publicar no tópico do projeto.
 */
describe('projeto GCP de cliente: tópico do nó e identidade do sink (fase 2, PR-05)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let adminA: TestSession;
  let adminB: TestSession;
  let readerA: TestSession;
  const capture = new LogCapture();

  async function sessionFor(tenantId: string, role: 'admin_cliente' | 'leitura') {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }

  const call = (session: TestSession) => {
    const server = request(app.getHttpServer());
    const write = (method: 'post' | 'patch', path: string) =>
      server[method](path)
        .set('Cookie', session.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', session.csrfToken);
    return {
      get: (path: string) => server.get(path).set('Cookie', session.cookie),
      post: (path: string, body: object) => write('post', path).send(body),
      patch: (path: string, body: object) => write('patch', path).send(body),
    };
  };
  const createGcp = async (session: TestSession, body: object = {}) =>
    cloudAccountSchema.parse(
      (
        await call(session)
          .post('/v1/cloud-accounts', { provider: 'gcp', accountId: gcpProject(), ...body })
          .expect(201)
      ).body,
    );
  const identityOf = async (id: string) =>
    (await prisma.cloudAccount.findUniqueOrThrow({ where: { id } })).sinkWriterIdentity;
  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  beforeAll(async () => {
    app = await createApp({ gcpSinkTopicPrefix: TOPIC_PREFIX, capture });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (projeto GCP)');
    tenantB = await createTenant(app, 'Cliente B (projeto GCP)');
    adminA = await sessionFor(tenantA, 'admin_cliente');
    adminB = await sessionFor(tenantB, 'admin_cliente');
    readerA = await sessionFor(tenantA, 'leitura');
  });

  afterAll(async () => {
    await app.close();
  });

  // A identidade do sink é dado do cliente: A não lê nem troca a de B.
  describeTenantIsolation({
    resource: 'identidade do sink do projeto GCP',
    basePath: '/v1/cloud-accounts',
    context: () => ({ app, sessionA: adminA, sessionB: adminB }),
    createInTenantB: async () =>
      (
        await prisma.cloudAccount.create({
          data: {
            tenantId: tenantB,
            provider: 'gcp',
            accountId: gcpProject(),
            regions: [],
            sinkWriterIdentity: sinkIdentity(),
          },
        })
      ).id,
    readDirect: (id) => prisma.cloudAccount.findUniqueOrThrow({ where: { id } }),
    patchBody: { sinkWriterIdentity: sinkIdentity() },
  });

  it('o projeto da GCP sai com o tópico do nó para o comando do sink; AWS, sem', async () => {
    const account = await createGcp(adminA);
    expect(account).toMatchObject({
      sinkTopic: `${TOPIC_PREFIX}${account.accountId}`,
      sinkWriterIdentity: null,
      pubsubSubscription: null,
      connection: 'waiting',
    });
    const fetched = await call(adminA).get(`/v1/cloud-accounts/${account.id}`).expect(200);
    expect(fetched.body).toMatchObject({ sinkTopic: `${TOPIC_PREFIX}${account.accountId}` });
    const listed = await call(adminA).get('/v1/cloud-accounts?pageSize=100').expect(200);
    expect((listed.body as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({ id: account.id, sinkTopic: account.sinkTopic }),
    );

    const aws = await call(adminA)
      .post('/v1/cloud-accounts', { provider: 'aws', accountId: awsAccountId(), regions: ['sa-east-1'] })
      .expect(201);
    expect(aws.body).toMatchObject({ sinkTopic: null, sinkWriterIdentity: null });
  });

  it('o admin cola a identidade do sink: gravada e auditada, sem mexer na conexão; null apaga', async () => {
    const account = await createGcp(adminA);
    const at = new Date('2026-11-04T12:00:00.000Z');
    await prisma.cloudAccount.update({
      where: { id: account.id },
      data: { connection: 'connected', lastCollectedAt: at, lastEventAt: at },
    });
    const identity = sinkIdentity();
    const saved = await call(adminA)
      .patch(`/v1/cloud-accounts/${account.id}`, { sinkWriterIdentity: identity })
      .expect(200);
    // A identidade é de quem publica, não da fonte que o nó lê: a conexão continua como estava.
    expect(cloudAccountSchema.parse(saved.body)).toMatchObject({
      sinkWriterIdentity: identity,
      sinkTopic: `${TOPIC_PREFIX}${account.accountId}`,
      connection: 'connected',
      lastCollectedAt: at.toISOString(),
    });
    expect(await entryOf(saved)).toMatchObject({
      action: 'cloud_account.update',
      tenantId: tenantA,
      before: { sinkWriterIdentity: null },
      after: { sinkWriterIdentity: identity },
    });

    const cleared = await call(adminA)
      .patch(`/v1/cloud-accounts/${account.id}`, { sinkWriterIdentity: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ sinkWriterIdentity: null });
    expect(await identityOf(account.id)).toBeNull();
  });

  it('a identidade também pode chegar no cadastro, e entra na auditoria', async () => {
    const identity = sinkIdentity();
    const created = await call(adminA)
      .post('/v1/cloud-accounts', { provider: 'gcp', accountId: gcpProject(), sinkWriterIdentity: identity })
      .expect(201);
    expect(created.body).toMatchObject({ sinkWriterIdentity: identity });
    expect(await entryOf(created)).toMatchObject({
      action: 'cloud_account.create',
      after: { sinkWriterIdentity: identity },
    });
  });

  it.each([
    ['a identidade compartilhada antiga', 'serviceAccount:cloud-logs@system.gserviceaccount.com'],
    ['uma conta de serviço comum', 'serviceAccount:coletor@projeto-qualquer.iam.gserviceaccount.com'],
    [
      'o agente de uma pasta',
      'serviceAccount:service-folder-123456789012@gcp-sa-logging.iam.gserviceaccount.com',
    ],
    ['uma pessoa', 'user:alguem@example.com'],
    ['o e-mail sem o tipo', 'service-123456789012@gcp-sa-logging.iam.gserviceaccount.com'],
  ])('recusa %s (400), sem gravar', async (_label, identity) => {
    const account = await createGcp(adminA);
    await call(adminA)
      .patch(`/v1/cloud-accounts/${account.id}`, { sinkWriterIdentity: identity })
      .expect(400);
    expect(await identityOf(account.id)).toBeNull();
  });

  it('só a conta da GCP tem identidade de sink, na API e no banco', async () => {
    const aws = cloudAccountSchema.parse(
      (
        await call(adminA)
          .post('/v1/cloud-accounts', { provider: 'aws', accountId: awsAccountId(), regions: ['sa-east-1'] })
          .expect(201)
      ).body,
    );
    const refused = await call(adminA)
      .patch(`/v1/cloud-accounts/${aws.id}`, { sinkWriterIdentity: sinkIdentity() })
      .expect(400);
    expect(refused.body).toMatchObject({ message: 'Campo que não existe nesta conta: sinkWriterIdentity' });
    await call(adminA)
      .post('/v1/cloud-accounts', {
        provider: 'aws',
        accountId: awsAccountId(),
        regions: ['sa-east-1'],
        sinkWriterIdentity: sinkIdentity(),
      })
      .expect(400);
    // A restrição do banco segura até uma escrita que não passe pela API.
    await expect(
      prisma.cloudAccount.update({ where: { id: aws.id }, data: { sinkWriterIdentity: sinkIdentity() } }),
    ).rejects.toThrow();
  });

  it('A/B: a identidade do sink de um cliente não entra em outro, no cadastro nem na alteração', async () => {
    const identity = sinkIdentity();
    await createGcp(adminA, { sinkWriterIdentity: identity });

    const conflict = await call(adminB)
      .post('/v1/cloud-accounts', { provider: 'gcp', accountId: gcpProject(), sinkWriterIdentity: identity })
      .expect(409);
    // Diz só que já existe, sem dizer de quem.
    expect(conflict.body).toMatchObject({
      message: 'A identidade do sink já está cadastrada em outro cliente',
    });
    expect(JSON.stringify(conflict.body)).not.toContain(tenantA);

    const ofB = await createGcp(adminB);
    await call(adminB).patch(`/v1/cloud-accounts/${ofB.id}`, { sinkWriterIdentity: identity }).expect(409);
    expect(await identityOf(ofB.id)).toBeNull();

    // B não vê as contas de A, nem a identidade delas.
    const listB = await call(adminB).get('/v1/cloud-accounts?pageSize=100').expect(200);
    expect(JSON.stringify(listB.body)).not.toContain(identity);
    expect(await prisma.cloudAccount.count({ where: { sinkWriterIdentity: identity } })).toBe(1);
  });

  it('a mesma identidade não entra em dois projetos do mesmo cliente, no cadastro nem na alteração', async () => {
    const identity = sinkIdentity();
    const first = await createGcp(adminA, { sinkWriterIdentity: identity });

    // A identidade é de um projeto só: em outro, daria a ele a publicação no tópico do primeiro.
    const conflict = await call(adminA)
      .post('/v1/cloud-accounts', { provider: 'gcp', accountId: gcpProject(), sinkWriterIdentity: identity })
      .expect(409);
    expect(conflict.body).toMatchObject({
      message: 'A identidade do sink já está cadastrada em outra conta deste cliente',
    });
    expect(JSON.stringify(conflict.body)).not.toContain(first.id);
    expect(JSON.stringify(conflict.body)).not.toContain(first.accountId);

    const second = await createGcp(adminA);
    await call(adminA).patch(`/v1/cloud-accounts/${second.id}`, { sinkWriterIdentity: identity }).expect(409);
    expect(await identityOf(second.id)).toBeNull();

    // A própria conta pode receber a identidade que já tem (a alteração não conflita consigo mesma).
    await call(adminA).patch(`/v1/cloud-accounts/${first.id}`, { sinkWriterIdentity: identity }).expect(200);
    expect(await prisma.cloudAccount.count({ where: { sinkWriterIdentity: identity } })).toBe(1);
  });

  it('leitura vê o tópico e a identidade, mas não grava a identidade (403)', async () => {
    const identity = sinkIdentity();
    const account = await createGcp(adminA, { sinkWriterIdentity: identity });
    const read = await call(readerA).get(`/v1/cloud-accounts/${account.id}`).expect(200);
    expect(read.body).toMatchObject({
      sinkTopic: `${TOPIC_PREFIX}${account.accountId}`,
      sinkWriterIdentity: identity,
    });
    await call(readerA)
      .patch(`/v1/cloud-accounts/${account.id}`, { sinkWriterIdentity: sinkIdentity() })
      .expect(403);
    expect(await identityOf(account.id)).toBe(identity);
  });

  it('o log da requisição não leva o corpo: a identidade colada fica só no banco e na auditoria', async () => {
    const account = await createGcp(adminA);
    const identity = sinkIdentity();
    const saved = await call(adminA)
      .patch(`/v1/cloud-accounts/${account.id}`, { sinkWriterIdentity: identity })
      .expect(200);
    const requestId = saved.headers['x-request-id'] as string;
    const lines = capture.entries().filter((entry) => JSON.stringify(entry).includes(requestId));
    expect(lines.length).toBeGreaterThan(0);
    expect(capture.text).not.toContain(identity);
  });
});
