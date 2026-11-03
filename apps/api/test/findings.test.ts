import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { findingDetailSchema, findingSchema, paginatedSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { RAW_EVENT_READER, type RawEventReader } from '../src/findings/raw-events.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

const findingPage = paginatedSchema(findingSchema);
const HOUR = 3_600_000;

/** Leitor de evento bruto controlado pelo teste: devolve o evento, nada ou falha. */
class FakeRawEvents implements RawEventReader {
  mode: 'event' | 'missing' | 'error' = 'event';
  read(source: string, sourceEventId: string): Promise<Record<string, unknown> | null> {
    if (this.mode === 'error') return Promise.reject(new Error('indexer fora do ar'));
    if (this.mode === 'missing') return Promise.resolve(null);
    return Promise.resolve({ id: sourceEventId, source, data: { aws: { eventName: 'StopLogging' } } });
  }
}

describe('achados (T5.4 e T5.5)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const rawEvents = new FakeRawEvents();
  let tenantA: string;
  let tenantB: string;
  let analystA: TestSession;
  let analystB: TestSession;
  let readerA: TestSession;
  let analystUserA: { id: string; name: string };

  async function sessionFor(tenantId: string, role: 'analista_cliente' | 'leitura') {
    const signedIn = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, signedIn.cookie);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: signedIn.id },
      select: { id: true, name: true },
    });
    return { session: { cookie, csrfToken: token }, user };
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

  /** Achado gravado como o sync grava (direto no banco: pela API, achado não é criado). */
  async function insertFinding(
    tenantId: string,
    overrides: Partial<Prisma.FindingUncheckedCreateInput> = {},
  ) {
    return prisma.finding.create({
      data: {
        tenantId,
        accountId: '111122223333',
        source: 'wazuh',
        sourceEventId: randomUUID(),
        logSource: 'cloudtrail',
        occurredAt: new Date(),
        severity: 'high',
        ruleId: '80202',
        ruleLevel: 10,
        title: 'AWS CloudTrail: trilha desligada',
        eventName: 'StopLogging',
        region: 'sa-east-1',
        resource: 'arn:aws:cloudtrail:sa-east-1:111122223333:trail/principal',
        actorUser: 'deploy-bot',
        actorType: 'IAMUser',
        accessKeyId: 'DEMO3QX7Z2KD9WLB5N8R',
        sourceIp: '198.51.100.23',
        mitreTactics: ['Defense Evasion'],
        mitreTechniques: ['T1562.008'],
        ...overrides,
      },
    });
  }

  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  beforeAll(async () => {
    app = await createApp({ overrideProviders: [{ provide: RAW_EVENT_READER, useValue: rawEvents }] });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A');
    tenantB = await createTenant(app, 'Cliente B');
    const analyst = await sessionFor(tenantA, 'analista_cliente');
    analystA = analyst.session;
    analystUserA = analyst.user;
    analystB = (await sessionFor(tenantB, 'analista_cliente')).session;
    readerA = (await sessionFor(tenantA, 'leitura')).session;
  });

  afterAll(async () => {
    await app.close();
  });

  describeTenantIsolation({
    resource: 'achados',
    basePath: '/v1/findings',
    context: () => ({ app, sessionA: analystA, sessionB: analystB }),
    createInTenantB: async () => (await insertFinding(tenantB)).id,
    readDirect: (id) => prisma.finding.findUniqueOrThrow({ where: { id } }),
  });

  describe('lista', () => {
    it('mais recentes primeiro, no formato do contrato, com a contagem de comentários', async () => {
      const older = await insertFinding(tenantA, { occurredAt: new Date(Date.now() - 2 * HOUR) });
      const newer = await insertFinding(tenantA, { occurredAt: new Date(Date.now() - HOUR) });
      await prisma.findingComment.create({
        data: { tenantId: tenantA, findingId: newer.id, authorId: analystUserA.id, body: 'olhando' },
      });
      const page = findingPage.parse(
        (await call(analystA).get('/v1/findings?pageSize=100').expect(200)).body,
      );
      const ids = page.items.map((item) => item.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      expect(page.items.find((item) => item.id === newer.id)).toMatchObject({
        source: 'cloudtrail',
        actor: { user: 'deploy-bot', accessKeyId: 'DEMO3QX7Z2KD9WLB5N8R', ip: '198.51.100.23' },
        commentCount: 1,
        incidentId: null,
      });
    });

    it('filtra por severidade, status, conta e período', async () => {
      const tenant = await createTenant(app, 'Cliente com filtros');
      const { session } = await sessionFor(tenant, 'leitura');
      const critical = await insertFinding(tenant, { severity: 'critical', accountId: '444455556666' });
      const resolved = await insertFinding(tenant, { status: 'resolved' });
      const old = await insertFinding(tenant, { occurredAt: new Date(Date.now() - 10 * 24 * HOUR) });
      const idsFor = async (query: string) =>
        findingPage
          .parse((await call(session).get(`/v1/findings?${query}`).expect(200)).body)
          .items.map((item) => item.id);
      expect(await idsFor('severity=critical')).toEqual([critical.id]);
      expect(await idsFor('status=resolved')).toEqual([resolved.id]);
      expect(await idsFor('accountId=444455556666')).toEqual([critical.id]);
      expect(await idsFor('period=7d')).not.toContain(old.id);
      expect(await idsFor('period=30d')).toContain(old.id);
    });

    it.each(['severity=urgente', "accountId=1' OR '1'='1", 'period=1y', 'pageSize=1000'])(
      'filtro inválido é recusado: %s',
      async (query) => {
        await call(analystA).get(`/v1/findings?${query}`).expect(400);
      },
    );
  });

  describe('detalhe', () => {
    it('regra, técnicas, comentários em ordem e o evento bruto do indexer', async () => {
      const finding = await insertFinding(tenantA);
      rawEvents.mode = 'event';
      const detail = findingDetailSchema.parse(
        (await call(readerA).get(`/v1/findings/${finding.id}`).expect(200)).body,
      );
      expect(detail).toMatchObject({
        ruleId: '80202',
        ruleLevel: 10,
        mitreTechniques: ['T1562.008'],
        comments: [],
        rawEvent: { id: finding.sourceEventId, source: 'wazuh' },
      });
    });

    it('acima de 500 comentários, o detalhe traz os 500 mais recentes, em ordem cronológica', async () => {
      const finding = await insertFinding(tenantA);
      const start = Date.now() - 1000 * 60_000;
      await prisma.findingComment.createMany({
        data: Array.from({ length: 501 }, (_, index) => ({
          tenantId: tenantA,
          findingId: finding.id,
          authorId: analystUserA.id,
          body: `comentário ${index}`,
          createdAt: new Date(start + index * 60_000),
        })),
      });
      await call(analystA).post(`/v1/findings/${finding.id}/comments`, { body: 'o mais novo' }).expect(201);
      const detail = findingDetailSchema.parse(
        (await call(readerA).get(`/v1/findings/${finding.id}`).expect(200)).body,
      );
      expect(detail.commentCount).toBe(502);
      expect(detail.comments).toHaveLength(500);
      expect(detail.comments.at(-1)?.body).toBe('o mais novo');
      expect(detail.comments[0]?.body).toBe('comentário 2');
    });

    it('evento fora da retenção ou indexer fora do ar: o detalhe sai sem o evento bruto', async () => {
      const finding = await insertFinding(tenantA);
      const rawEventOf = async () =>
        findingDetailSchema.parse((await call(readerA).get(`/v1/findings/${finding.id}`).expect(200)).body)
          .rawEvent;
      rawEvents.mode = 'missing';
      expect(await rawEventOf()).toBeNull();
      rawEvents.mode = 'error';
      expect(await rawEventOf()).toBeNull();
      rawEvents.mode = 'event';
    });
  });

  describe('triagem', () => {
    it('muda o status com comentário, na mesma auditoria, e devolve o detalhe', async () => {
      const finding = await insertFinding(tenantA);
      const response = await call(analystA)
        .patch(`/v1/findings/${finding.id}/status`, {
          status: 'legitimate',
          comment: 'Janela de manutenção combinada com o cliente.',
        })
        .expect(200);
      const detail = findingDetailSchema.parse(response.body);
      expect(detail.status).toBe('legitimate');
      expect(detail.comments).toEqual([
        expect.objectContaining({
          body: 'Janela de manutenção combinada com o cliente.',
          author: analystUserA,
        }),
      ]);
      expect(detail.commentCount).toBe(1);
      expect(await entryOf(response)).toMatchObject({
        action: 'finding.status',
        tenantId: tenantA,
        resourceId: finding.id,
        before: { status: 'new' },
        after: { status: 'legitimate', commentId: detail.comments[0]?.id },
      });
    });

    it('comentário avulso: 201, autor da sessão, auditado', async () => {
      const finding = await insertFinding(tenantA);
      const response = await call(analystA)
        .post(`/v1/findings/${finding.id}/comments`, { body: 'Pedi o log do firewall.' })
        .expect(201);
      expect(response.body).toMatchObject({ body: 'Pedi o log do firewall.', author: analystUserA });
      expect(await entryOf(response)).toMatchObject({ action: 'finding.comment', resourceId: finding.id });
    });

    it.each([
      ['status desconhecido', { status: 'ignorado' }],
      ['comentário vazio', { status: 'resolved', comment: '   ' }],
      ['comentário com caractere de controle', { status: 'resolved', comment: 'a\u0000b' }],
      ['campo a mais', { status: 'resolved', tenantId: randomUUID() }],
    ])('recusa %s (400), sem mudar nada', async (_label, body) => {
      const finding = await insertFinding(tenantA);
      await call(analystA).patch(`/v1/findings/${finding.id}/status`, body).expect(400);
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: finding.id } })).status).toBe('new');
    });

    it('leitura vê, mas não muda status nem comenta', async () => {
      const finding = await insertFinding(tenantA);
      await call(readerA).patch(`/v1/findings/${finding.id}/status`, { status: 'resolved' }).expect(403);
      await call(readerA).post(`/v1/findings/${finding.id}/comments`, { body: 'oi' }).expect(403);
    });

    it('A não muda status nem comenta achado de B (404), e nada muda', async () => {
      const finding = await insertFinding(tenantB);
      await call(analystA).patch(`/v1/findings/${finding.id}/status`, { status: 'resolved' }).expect(404);
      await call(analystA).post(`/v1/findings/${finding.id}/comments`, { body: 'oi' }).expect(404);
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: finding.id } })).status).toBe('new');
      expect(await prisma.findingComment.count({ where: { findingId: finding.id } })).toBe(0);
    });
  });

  describe('garantias do banco', () => {
    it('o mesmo alerta do Wazuh não vira dois achados', async () => {
      const sourceEventId = randomUUID();
      await insertFinding(tenantA, { sourceEventId });
      await expect(insertFinding(tenantA, { sourceEventId })).rejects.toThrow();
    });

    it('comentário não aponta para achado de outro cliente', async () => {
      const finding = await insertFinding(tenantB);
      await expect(
        prisma.findingComment.create({
          data: { tenantId: tenantA, findingId: finding.id, authorId: analystUserA.id, body: 'x' },
        }),
      ).rejects.toThrow();
    });

    it('comentário não é editado nem apagado', async () => {
      const finding = await insertFinding(tenantA);
      const comment = await prisma.findingComment.create({
        data: { tenantId: tenantA, findingId: finding.id, authorId: analystUserA.id, body: 'registro' },
      });
      await expect(
        prisma.findingComment.update({ where: { id: comment.id }, data: { body: 'outro' } }),
      ).rejects.toThrow(/somente inserção/);
      await expect(prisma.findingComment.delete({ where: { id: comment.id } })).rejects.toThrow(
        /somente inserção/,
      );
    });
  });
});
