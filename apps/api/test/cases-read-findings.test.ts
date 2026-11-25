import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  caseDetailSchema,
  type CaseFindingPage,
  caseFindingPageSchema,
  type CaseTimeline,
  caseTimelineSchema,
  INVALID_CASE_CURSOR_CODE,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { caseCursorScope, encodeCaseCursor } from '../src/cases/case-cursor.js';
import { CASE_READ_LIMITS, CasesService, DEFAULT_CASE_READ_LIMITS } from '../src/cases/cases.service.js';
import type { RequestAuth } from '../src/common/auth/request-auth.js';
import { requestContext } from '../src/common/context/request-context.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import {
  cleanCases,
  HOUR_MS,
  insertCase,
  insertFinding,
  insertIncident,
  SEVERITIES,
} from './support/cases.js';
import { createApp } from './support/create-app.js';

const DAY_MS = 24 * HOUR_MS;

/** Os alertas de um caso, página por página, e a linha do tempo dele (`CASES_MODE=on`). */
describe('alertas e linha do tempo de um caso', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let cookie: string;
  let otherTenant: string;
  let otherCookie: string;

  const get = (path: string, as = cookie) => request(app.getHttpServer()).get(path).set('Cookie', as);

  const pageOf = async (caseId: string, query = ''): Promise<CaseFindingPage> =>
    caseFindingPageSchema.parse((await get(`/v1/cases/${caseId}/findings?${query}`).expect(200)).body);

  const timelineOf = async (caseId: string): Promise<CaseTimeline> =>
    caseTimelineSchema.parse((await get(`/v1/cases/${caseId}/timeline`).expect(200)).body);

  /** Todas as páginas, do começo ao fim. */
  async function walk(caseId: string, query: string, between?: (page: number) => Promise<unknown>) {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: CaseFindingPage = await pageOf(
        caseId,
        cursor === null ? query : `${query}&cursor=${cursor}`,
      );
      ids.push(...page.items.map((item) => item.finding.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(100);
      if (cursor !== null) await between?.(pages);
    } while (cursor !== null);
    return { ids, pages };
  }

  async function caseWith(findings: Partial<Prisma.FindingUncheckedCreateInput>[]): Promise<string> {
    const id = await insertCase(prisma, tenantId);
    for (const finding of findings) await insertFinding(prisma, tenantId, { caseId: id, ...finding });
    return id;
  }

  /** Os ids dos alertas do caso, do mais recente para trás, lidos direto do banco. */
  const expectedIds = async (caseId: string, where: Prisma.FindingWhereInput = {}): Promise<string[]> =>
    (
      await prisma.finding.findMany({
        where: { caseId, ...where },
        select: { id: true },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      })
    ).map((row) => row.id);

  beforeAll(async () => {
    app = await createApp({
      casesMode: 'on',
      overrideProviders: [
        { provide: CASE_READ_LIMITS, useValue: { ...DEFAULT_CASE_READ_LIMITS, analysisAlerts: 5 } },
      ],
    });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo A (alertas do caso)');
    otherTenant = await createTenant(app, 'Cliente Demo B (alertas do caso)');
    cookie = (await createSignedInUser(app, { role: 'leitura', tenantId })).cookie;
    otherCookie = (await createSignedInUser(app, { role: 'leitura', tenantId: otherTenant })).cookie;
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantId, otherTenant]);
    await app.close();
  }, 60_000);

  describe('os alertas', () => {
    it('um caso sem alerta guardado: página vazia, sem cursor', async () => {
      expect(await pageOf(await caseWith([]))).toEqual({ items: [], nextCursor: null });
    });

    it('do mais recente para trás; com o mesmo horário, o id decide; todo alerta é alcançado', async () => {
      const base = Date.now();
      const id = await caseWith(
        Array.from({ length: 23 }, (_, index) => ({
          // Muitos com o mesmo milissegundo, na virada das páginas.
          occurredAt: new Date(base - Math.floor(index / 7) * 1000),
        })),
      );
      const expected = await expectedIds(id);
      for (const pageSize of [1, 5, 7, 23, 100]) {
        const { ids, pages } = await walk(id, `pageSize=${pageSize}`);
        expect(ids, String(pageSize)).toEqual(expected);
        expect(pages).toBe(Math.ceil(23 / pageSize));
      }
    });

    it('com alertas novos chegando no meio, nenhum repete e nenhum dos que já havia é pulado', async () => {
      const base = Date.now() - HOUR_MS;
      const id = await caseWith(
        Array.from({ length: 20 }, (_, index) => ({ occurredAt: new Date(base - index * 1000) })),
      );
      const before = await expectedIds(id);
      const { ids } = await walk(id, 'pageSize=6', async (page) => {
        // Um mais novo que tudo, um no meio do que já passou e um no que ainda falta.
        for (const offset of [60_000, -1_500, -15_500 - page]) {
          await insertFinding(prisma, tenantId, { caseId: id, occurredAt: new Date(base + offset) });
        }
      });
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((item) => before.includes(item))).toEqual(before);
      // O que chegou no trecho que faltava aparece no lugar dele; o que chegou antes do cursor, não.
      const all = await expectedIds(id);
      expect(all.filter((item) => ids.includes(item))).toEqual(ids);
    });

    it('com alertas saindo no meio (a retenção), os outros continuam todos', async () => {
      const base = Date.now() - HOUR_MS;
      const id = await caseWith(
        Array.from({ length: 12 }, (_, index) => ({ occurredAt: new Date(base - index * 1000) })),
      );
      const all = await expectedIds(id);
      // Sai o próprio alerta do cursor, e um que ainda vinha.
      const gone = [all[3] as string, all[7] as string];
      const { ids } = await walk(id, 'pageSize=4', async (page) => {
        if (page === 1) await prisma.finding.deleteMany({ where: { id: { in: gone } } });
      });
      expect(ids).toEqual(all.filter((item) => item !== all[7]));
    });

    it('status, severidade e subgrupo, sozinhos e juntos', async () => {
      const incidentId = await insertIncident(prisma, tenantId);
      const id = await caseWith([
        { status: 'new', severity: 'high', caseGroup: 'openssl' },
        { status: 'new', severity: 'low', caseGroup: 'openssl' },
        { status: 'resolved', severity: 'high', caseGroup: 'openssl' },
        { status: 'resolved', severity: 'high', caseGroup: 'open%' },
        { status: 'investigating', severity: 'critical', caseGroup: null, incidentId },
      ]);
      const checks: [string, Prisma.FindingWhereInput, number][] = [
        ['status=new', { status: 'new' }, 2],
        ['status=investigating', { status: 'investigating' }, 1],
        ['status=legitimate', { status: 'legitimate' }, 0],
        ['severity=high', { severity: 'high' }, 3],
        ['group=openssl', { caseGroup: 'openssl' }, 3],
        [`group=${encodeURIComponent('open%')}`, { caseGroup: 'open%' }, 1],
        ['group=OPENSSL', { caseGroup: 'OPENSSL' }, 0],
        ['status=resolved&severity=high&group=openssl', { status: 'resolved', caseGroup: 'openssl' }, 1],
      ];
      for (const [query, where, count] of checks) {
        const { ids } = await walk(id, `${query}&pageSize=1`);
        expect(ids, query).toEqual(await expectedIds(id, where));
        expect(ids, query).toHaveLength(count);
      }
    });

    it('cada alerta no formato da lista de alertas, com o subgrupo e a situação na origem', async () => {
      const triagedAt = new Date('2026-11-20T10:00:00Z');
      const id = await caseWith([
        {
          title: '<b>do evento</b>',
          status: 'resolved',
          triagedAt,
          lastSeenAt: new Date('2026-11-21T10:00:00Z'),
          caseGroup: 's3:exemplo',
          occurredAt: new Date('2026-11-24T10:00:00Z'),
        },
        {
          status: 'resolved',
          triagedAt,
          lastSeenAt: triagedAt,
          occurredAt: new Date('2026-11-24T09:00:00Z'),
        },
        { status: 'new', lastSeenAt: triagedAt, occurredAt: new Date('2026-11-24T08:00:00Z') },
        {
          status: 'legitimate',
          triagedAt,
          lastSeenAt: new Date('2026-11-21T10:00:00Z'),
          occurredAt: new Date('2026-11-24T07:00:00Z'),
        },
        {
          status: 'resolved',
          triagedAt,
          lastSeenAt: new Date('2026-11-21T10:00:00Z'),
          incidentId: await insertIncident(prisma, tenantId),
          occurredAt: new Date('2026-11-24T06:00:00Z'),
        },
        { status: 'resolved', triagedAt, lastSeenAt: null, occurredAt: new Date('2026-11-24T05:00:00Z') },
      ]);
      const { items } = await pageOf(id);
      expect(items.map(({ group, lastSeenAt, stillActive }) => ({ group, lastSeenAt, stillActive }))).toEqual(
        [
          { group: 's3:exemplo', lastSeenAt: '2026-11-21T10:00:00.000Z', stillActive: true },
          { group: null, lastSeenAt: '2026-11-20T10:00:00.000Z', stillActive: false },
          { group: null, lastSeenAt: '2026-11-20T10:00:00.000Z', stillActive: false },
          { group: null, lastSeenAt: '2026-11-21T10:00:00.000Z', stillActive: false },
          { group: null, lastSeenAt: '2026-11-21T10:00:00.000Z', stillActive: false },
          { group: null, lastSeenAt: null, stillActive: false },
        ],
      );
      expect(items[0]?.finding).toMatchObject({ title: '<b>do evento</b>', source: 'cloudtrail' });
    });

    describe('o cursor', () => {
      it('de outro caso ou de outros filtros é recusado, com código', async () => {
        const findings = Array.from({ length: 3 }, (_, index) => ({
          occurredAt: new Date(Date.now() - index * 1000),
        }));
        const one = await caseWith(findings);
        const two = await caseWith(findings);
        const { nextCursor } = await pageOf(one, 'pageSize=1');
        const refused = [
          `/v1/cases/${two}/findings?pageSize=1&cursor=${nextCursor as string}`,
          `/v1/cases/${one}/findings?pageSize=1&status=new&cursor=${nextCursor as string}`,
          `/v1/cases/${one}/findings?pageSize=1&group=x&cursor=${nextCursor as string}`,
        ];
        for (const path of refused) {
          const response = await get(path).expect(400);
          expect(response.body, path).toMatchObject({ code: INVALID_CASE_CURSOR_CODE });
        }
        // O tamanho da página pode mudar no meio.
        const rest = await pageOf(one, `pageSize=100&cursor=${nextCursor as string}`);
        expect(rest.items).toHaveLength(2);
      });

      it('adulterado é recusado sem erro do servidor', async () => {
        const id = await caseWith([{}, {}]);
        const { nextCursor } = await pageOf(id, 'pageSize=1');
        const cursor = nextCursor as string;
        for (const bad of [
          cursor.slice(1),
          cursor.slice(0, -3),
          `${cursor}AAAA`,
          'AAAA',
          Buffer.from('{"__proto__":{"a":1}}').toString('base64url'),
          Buffer.from('[1,null,null,null]').toString('base64url'),
          'x'.repeat(256),
        ]) {
          const response = await get(`/v1/cases/${id}/findings?cursor=${bad}`);
          expect(response.status, bad).toBe(400);
        }
        for (const bad of ['', '%20', 'a%27b', 'x'.repeat(257), '%00']) {
          await get(`/v1/cases/${id}/findings?cursor=${bad}`).expect(400);
        }
      });

      it('montado à mão só muda o ponto de partida dentro do próprio caso', async () => {
        const id = await caseWith([{}, {}, {}]);
        const forged = encodeCaseCursor(
          new Date('9999-12-31T23:59:59.999Z'),
          'ffffffff-ffff-ffff-ffff-ffffffffffff',
          caseCursorScope(id, {}),
        );
        const { ids } = await walk(id, 'pageSize=2');
        const page = await pageOf(id, `pageSize=100&cursor=${forged}`);
        expect(page.items.map((item) => item.finding.id)).toEqual(ids);
        const past = encodeCaseCursor(
          new Date('0001-01-01T00:00:00.000Z'),
          '00000000-0000-0000-0000-000000000000',
          caseCursorScope(id, {}),
        );
        expect(await pageOf(id, `cursor=${past}`)).toEqual({ items: [], nextCursor: null });
      });

      it('o cursor de um cliente não abre o caso dele para outro', async () => {
        const id = await caseWith([{}, {}]);
        const { nextCursor } = await pageOf(id, 'pageSize=1');
        await get(`/v1/cases/${id}/findings?cursor=${nextCursor as string}`, otherCookie).expect(404);
        const theirs = await insertCase(prisma, otherTenant);
        await insertFinding(prisma, otherTenant, { caseId: theirs });
        const response = await get(
          `/v1/cases/${theirs}/findings?cursor=${nextCursor as string}`,
          otherCookie,
        );
        expect(response.status).toBe(400);
      });
    });

    it.each([
      'page=1',
      'q=x',
      'pageSize=0',
      'pageSize=101',
      'status=aberto',
      'severity=x',
      'group=%00',
      'x=1',
    ])('pedido inválido é recusado: %s', async (query) => {
      await get(`/v1/cases/${randomUUID()}/findings?${query}`).expect(400);
    });
  });

  describe('a linha do tempo', () => {
    it('sem alerta: nenhuma faixa', async () => {
      expect(await timelineOf(await caseWith([]))).toEqual({
        granularity: 'hour',
        from: null,
        to: null,
        truncated: false,
        buckets: [],
      });
    });

    it('de hora em hora, por severidade, sem buracos, com as pontas na hora cheia', async () => {
      const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 5 * HOUR_MS;
      const id = await caseWith([
        { occurredAt: new Date(hour), severity: 'critical' },
        { occurredAt: new Date(hour + HOUR_MS - 1), severity: 'high' },
        { occurredAt: new Date(hour + HOUR_MS), severity: 'medium', status: 'resolved' },
        { occurredAt: new Date(hour + 3 * HOUR_MS + 1), severity: 'low' },
        { occurredAt: new Date(hour + 3 * HOUR_MS + 2), severity: 'low' },
      ]);
      const at = (index: number) => new Date(hour + index * HOUR_MS).toISOString();
      const zero = { critical: 0, high: 0, medium: 0, low: 0 };
      expect(await timelineOf(id)).toEqual({
        granularity: 'hour',
        from: at(0),
        to: at(4),
        truncated: false,
        buckets: [
          { at: at(0), ...zero, critical: 1, high: 1 },
          { at: at(1), ...zero, medium: 1 },
          { at: at(2), ...zero },
          { at: at(3), ...zero, low: 2 },
        ],
      });
    });

    it('acima de 7 dias, por dia de Brasília (que vira às 03:00 UTC)', async () => {
      const id = await caseWith([
        { occurredAt: new Date('2026-11-10T02:59:59.999Z'), severity: 'low' },
        { occurredAt: new Date('2026-11-10T03:00:00.000Z'), severity: 'high' },
        { occurredAt: new Date('2026-11-11T02:59:59.999Z'), severity: 'high' },
        { occurredAt: new Date('2026-11-20T15:00:00.000Z'), severity: 'critical' },
      ]);
      const timeline = await timelineOf(id);
      expect(timeline).toMatchObject({
        granularity: 'day',
        from: '2026-11-09T03:00:00.000Z',
        to: '2026-11-21T03:00:00.000Z',
        truncated: false,
      });
      expect(timeline.buckets).toHaveLength(12);
      expect(timeline.buckets[0]).toMatchObject({ at: '2026-11-09T03:00:00.000Z', low: 1, high: 0 });
      expect(timeline.buckets[1]).toMatchObject({ at: '2026-11-10T03:00:00.000Z', low: 0, high: 2 });
      expect(timeline.buckets[2]).toMatchObject({ at: '2026-11-11T03:00:00.000Z', high: 0 });
      expect(timeline.buckets[11]).toMatchObject({ at: '2026-11-20T03:00:00.000Z', critical: 1 });
    });

    it('datas antigas (com o horário de verão de antes) e forjadas não estouram as faixas', async () => {
      const old = await caseWith([
        { occurredAt: new Date('2018-11-03T12:00:00Z') },
        { occurredAt: new Date('2018-11-05T12:00:00Z') },
        { occurredAt: new Date('2018-11-20T12:00:00Z') },
      ]);
      const timeline = await timelineOf(old);
      expect(timeline.buckets).toHaveLength(18);
      expect(timeline.buckets.filter((bucket) => bucket.high > 0).map((bucket) => bucket.at)).toEqual([
        '2018-11-03T03:00:00.000Z',
        '2018-11-05T03:00:00.000Z',
        '2018-11-20T03:00:00.000Z',
      ]);
      const forged = await caseWith([
        { occurredAt: new Date('1970-01-01T00:00:00Z') },
        { occurredAt: new Date('2026-11-20T12:00:00Z') },
      ]);
      const bounded = await timelineOf(forged);
      expect(bounded.buckets).toHaveLength(366);
      expect(bounded.truncated).toBe(true);
      expect(bounded.buckets.at(-1)).toMatchObject({ at: '2026-11-20T03:00:00.000Z', high: 1 });
      expect(bounded.buckets.reduce((sum, bucket) => sum + bucket.high, 0)).toBe(1);
    });

    it('horário no futuro fica fora, avisado; o da hora de agora entra', async () => {
      const now = Date.now();
      const id = await caseWith([
        { occurredAt: new Date(now) },
        { occurredAt: new Date('2099-01-01T00:00:00Z') },
      ]);
      const timeline = await timelineOf(id);
      expect(timeline).toMatchObject({ granularity: 'hour', truncated: true });
      expect(timeline.buckets.reduce((sum, bucket) => sum + bucket.high, 0)).toBe(1);
      const onlyFuture = await caseWith([{ occurredAt: new Date('2099-01-01T00:00:00Z') }]);
      expect(await timelineOf(onlyFuture)).toMatchObject({ from: null, truncated: true, buckets: [] });
    });

    it('na faixa do dia de hoje, o que está depois da hora de agora também fica fora', async () => {
      const now = new Date('2026-11-24T15:20:00Z');
      const id = await caseWith([
        { occurredAt: new Date('2026-11-01T12:00:00Z') },
        { occurredAt: new Date('2026-11-24T15:59:59.999Z') },
        // O mesmo dia de Brasília, depois do fim da hora de agora.
        { occurredAt: new Date('2026-11-24T16:00:00.000Z') },
        { occurredAt: new Date('2026-11-24T20:00:00Z') },
      ]);
      const auth = { role: 'leitura', scopeTenantId: tenantId } as unknown as RequestAuth;
      const timeline = await requestContext.run({ auth }, () => app.get(CasesService).timeline(id, now));
      expect(timeline).toMatchObject({ granularity: 'day', truncated: true });
      expect(timeline.buckets).toHaveLength(24);
      expect(timeline.buckets[0]?.high).toBe(1);
      expect(timeline.buckets.at(-1)).toMatchObject({ at: '2026-11-24T03:00:00.000Z', high: 1 });
    });

    it('a soma das faixas é a dos alertas, qualquer que seja a mistura', async () => {
      const base = Date.now();
      const id = await caseWith(
        Array.from({ length: 60 }, (_, index) => ({
          severity: SEVERITIES[index % 4],
          occurredAt: new Date(base - index * 17 * HOUR_MS - index * 1234),
        })),
      );
      const { buckets, granularity } = await timelineOf(id);
      expect(granularity).toBe('day');
      for (const severity of SEVERITIES) {
        expect(buckets.reduce((sum, bucket) => sum + bucket[severity], 0)).toBe(15);
      }
      const starts = buckets.map((bucket) => Date.parse(bucket.at));
      for (const [index, start] of starts.entries()) {
        if (index > 0) expect(start - (starts[index - 1] as number)).toBe(DAY_MS);
      }
    });

    it('não mistura o outro caso nem o outro cliente', async () => {
      const at = new Date(Date.now() - HOUR_MS);
      const id = await caseWith([{ occurredAt: at }]);
      await caseWith([{ occurredAt: at }, { occurredAt: at }]);
      const theirs = await insertCase(prisma, otherTenant);
      await insertFinding(prisma, otherTenant, { caseId: theirs, occurredAt: at });
      const { buckets } = await timelineOf(id);
      expect(buckets.reduce((sum, bucket) => sum + bucket.high, 0)).toBe(1);
      await get(`/v1/cases/${theirs}/timeline`).expect(404);
    });
  });

  describe('o teto de alertas do detalhe', () => {
    const detailOf = async (caseId: string) =>
      caseDetailSchema.parse((await get(`/v1/cases/${caseId}`).expect(200)).body);
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);

    it('até o teto, a leitura é inteira', async () => {
      const id = await caseWith(Array.from({ length: 5 }, (_, index) => ({ occurredAt: at(index) })));
      expect((await detailOf(id)).analysis).toMatchObject({ alerts: 5, complete: true });
    });

    it('além dele, só os mais recentes, e o detalhe avisa; as contagens do caso continuam inteiras', async () => {
      const id = await caseWith(
        Array.from({ length: 7 }, (_, index) => ({
          occurredAt: at(index),
          sourceIp: `203.0.113.${index}`,
        })),
      );
      const detail = await detailOf(id);
      expect(detail.counts.total).toBe(7);
      expect(detail.analysis).toMatchObject({ alerts: 5, complete: false, rare: { ips: { distinct: 5 } } });
      expect(detail.analysis?.rare.ips.values.map(({ value }) => value)).toEqual([
        '203.0.113.0',
        '203.0.113.1',
        '203.0.113.2',
        '203.0.113.3',
        '203.0.113.4',
      ]);
    });

    it('o número de alertas pode ser o do teto sem faltar nenhum', async () => {
      const id = await caseWith(Array.from({ length: 5 }, () => ({})));
      // A contagem errada (antes da conferência semanal) não diz que está inteiro sem estar.
      await prisma.alertCase.update({ where: { id }, data: { total: 6 } });
      expect((await detailOf(id)).analysis).toMatchObject({ alerts: 5, complete: false });
    });
  });

  describe('o prazo no banco', () => {
    /** O banco da requisição com uma espera antes de cada leitura: o comando passa do prazo. */
    const slow = <T>(work: () => Promise<T>): Promise<T> => {
      const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((
        run: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: object,
      ) =>
        real(async (tx: Prisma.TransactionClient) => {
          const wrapped = new Proxy(tx, {
            get(target, property) {
              if (property !== '$queryRaw') return Reflect.get(target, property) as unknown;
              return async () => {
                await target.$executeRaw`SELECT set_config('statement_timeout', '50ms', true)`;
                return target.$queryRaw`SELECT pg_sleep(2)::text AS slept`;
              };
            },
          });
          return run(wrapped);
        }, options)) as never);
      return work().finally(() => spy.mockRestore());
    };

    it('a leitura dos alertas do caso que passa do prazo: o detalhe sai sem ela', async () => {
      const id = await caseWith([{ sourceIp: '198.51.100.1' }]);
      const body = await slow(async () => (await get(`/v1/cases/${id}`).expect(200)).body as object);
      expect(body).toMatchObject({ id, analysis: null, operations: [], counts: { total: 1 } });
    });

    it('a linha do tempo que passa do prazo: 503 genérico', async () => {
      const id = await caseWith([{}]);
      const response = await slow(async () => get(`/v1/cases/${id}/timeline`));
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ message: 'Serviço temporariamente indisponível' });
      // Depois, volta ao normal: o prazo não fica na conexão.
      await get(`/v1/cases/${id}/timeline`).expect(200);
      const [row] = await prisma.$queryRaw<{ value: string }[]>`
        SELECT current_setting('statement_timeout') AS value`;
      expect(row?.value).toBe('0');
    });

    it('outro erro do banco continua sendo erro', async () => {
      const id = await caseWith([{}]);
      const spy = vi.spyOn(prisma, '$transaction').mockRejectedValue(new Error('conexão caiu'));
      try {
        for (const path of [`/v1/cases/${id}`, `/v1/cases/${id}/timeline`]) {
          const response = await get(path).expect(500);
          expect(response.body, path).toMatchObject({ message: 'Erro interno' });
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('as transações da leitura não gravam', async () => {
      const id = await caseWith([{}]);
      const modes: string[] = [];
      const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((
        run: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: object,
      ) =>
        real(async (tx: Prisma.TransactionClient) => {
          const result = await run(tx);
          const [row] = await tx.$queryRaw<{ mode: string; timeout: string }[]>`
            SELECT current_setting('transaction_read_only') AS mode, current_setting('statement_timeout') AS timeout`;
          modes.push(`${row?.mode ?? ''} ${row?.timeout ?? ''}`);
          return result;
        }, options)) as never);
      try {
        await get(`/v1/cases/${id}`).expect(200);
        await get(`/v1/cases/${id}/timeline`).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(modes).toEqual(['on 1500ms', 'on 3s']);
    });
  });
});
