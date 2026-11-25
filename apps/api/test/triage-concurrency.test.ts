import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore } from '../src/alerts/finding-store.js';
import { CaseReconcileJob } from '../src/cases/case-reconcile-job.js';
import {
  DEFAULT_TRIAGE_LIMITS,
  TRIAGE_LIMITS,
  type TriageLimits,
} from '../src/cases/triage-operations.service.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { type FindingSeverity, type FindingStatus, Prisma } from '../src/generated/prisma/client.js';
import { AlertNotices } from '../src/notifications/finding-notices.js';
import { RetentionJob } from '../src/retention/retention-job.js';
import { DAY_MS } from '../src/retention/retention-policy.js';
import { createTenant } from './support/auth-helpers.js';
import {
  assignAll,
  assignJob,
  CASE_ACCOUNT,
  casesOf,
  cleanCases,
  expectExactCounters,
  insertMixed,
  loops,
  onlyTenantPhases,
  SEVERITIES,
  STATUSES,
} from './support/cases.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import {
  caseWith,
  drain,
  earlier,
  expectNoDrift,
  findingsById,
  manyFindings,
  memoryLogger,
  operate,
  operation,
  type Operator,
  operatorFor,
  patch,
  post,
  statusRequest,
  triageJob,
  undo,
} from './support/triage.js';

/** Um gerador fixo (mulberry32): as misturas rodam iguais em toda execução. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sem aviso por e-mail: a fila de saída é uma só, e outra suíte a lê inteira. */
class NoNotices extends AlertNotices {
  override enqueue = () => Promise.resolve(0);
}

/**
 * A triagem em massa com tudo o que mexe nos mesmos alertas ao mesmo tempo, e sequências aleatórias dela: ninguém cai em
 * deadlock, nenhuma contagem se perde, e cada operação mexe uma vez em cada alerta.
 */
describe('triagem em massa com escritas ao mesmo tempo', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const capture = new LogCapture();
  const tenants: string[] = [];
  const limits: TriageLimits = { ...DEFAULT_TRIAGE_LIMITS };

  async function customer(name: string): Promise<{ tenantId: string; who: Operator }> {
    const tenantId = await createTenant(app, `Cliente Demo (ao mesmo tempo: ${name})`);
    tenants.push(tenantId);
    return { tenantId, who: await operatorFor(app, tenantId, 'admin_cliente') };
  }

  const draft = (tenantId: string, index: number): FindingDraft => ({
    tenantId,
    accountId: CASE_ACCOUNT,
    source: 'wazuh',
    sourceEventId: `lote-ao-mesmo-tempo-${index}-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    severity: SEVERITIES[index % 4] as FindingSeverity,
    ruleId: `10030${index % 3}`,
    ruleLevel: 10,
    title: 'Alerta de teste',
    logSource: 'cloudtrail',
    eventName: null,
    region: null,
    resource: null,
    actorUser: `pessoa-${index % 4}`,
    actorType: null,
    accessKeyId: null,
    sourceIp: null,
    mitreTactics: [],
    mitreTechniques: [],
  });
  const remove = (who: Operator, path: string) =>
    request(app.getHttpServer())
      .delete(path)
      .set('Cookie', who.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', who.csrfToken);
  const client = async () => {
    const connection = new pg.Client({ connectionString: inject('testDatabaseUrl') });
    await connection.connect();
    return connection;
  };

  /** O que vale sempre: cada alerta com operação tem o item dela, as contagens fecham, e um caso aberto por chave. */
  async function expectInvariants(tenantId: string): Promise<void> {
    await expectExactCounters(prisma, [tenantId]);
    await expectNoDrift(prisma, [tenantId]);
    const marked = await prisma.finding.findMany({
      where: { tenantId, triageOpId: { not: null } },
      select: { id: true, triageOpId: true, triageItems: { select: { operationId: true } } },
    });
    for (const row of marked) {
      expect(row.triageItems.map((item) => item.operationId)).toContain(row.triageOpId);
    }
    const operations = await prisma.triageOperation.findMany({
      where: { tenantId, action: { not: 'undo_all_of' } },
      include: { _count: { select: { items: true } } },
    });
    for (const row of operations) {
      // O item sai com o alerta (o expurgo): nunca há mais itens que alertas mudados.
      expect(row._count.items, `${row.action} ${row.state}`).toBeLessThanOrEqual(row.changed);
      expect(row.changed + row.skipped, `${row.action} ${row.state}`).toBeLessThanOrEqual(row.matched);
    }
    const open = (await casesOf(prisma, tenantId)).flatMap((row) =>
      row.openKey === null ? [] : [row.openKey],
    );
    expect(new Set(open).size).toBe(open.length);
    for (const incident of await prisma.incident.findMany({
      where: { tenantId },
      include: { _count: { select: { findings: true } } },
    })) {
      expect(incident.findingCount).toBe(incident._count.findings);
      expect(incident._count.findings).toBeGreaterThan(0);
    }
  }

  beforeAll(async () => {
    app = await createApp({
      casesMode: 'on',
      capture,
      overrideProviders: [{ provide: TRIAGE_LIMITS, useValue: limits }],
    });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
  }, 60_000);

  beforeEach(() => {
    Object.assign(limits, DEFAULT_TRIAGE_LIMITS);
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  it(
    'coletores, atribuição, expurgo, conferência, triagem um a um, incidentes e várias operações: nada trava e tudo fecha',
    { timeout: 180_000 },
    async () => {
      const { tenantId, who } = await customer('tudo');
      limits.syncAlerts = 25;
      limits.maxActive = 1_000;
      const old = new Date(Date.now() - 200 * DAY_MS);
      await insertMixed(prisma, tenantId, 240, earlier());
      await insertMixed(prisma, tenantId, 60, old);
      await assignAll(prisma, [tenantId]);
      const { lines, logger } = memoryLogger();
      // Réplicas sem a concessão entre elas: a correção não depende dela.
      const workers = [0, 1].map(() => triageJob(prisma, [tenantId], { batch: 9, logger, pauseMs: 5 }));
      const assigners = [0, 1].map(() => assignJob(prisma, [tenantId], { batch: 11, logger }));
      const background = loops(
        ...workers.map((job) => () => job.runOnce()),
        ...assigners.map((job) => () => job.runOnce()),
        () =>
          new CaseReconcileJob(prisma, {
            tenantIds: [tenantId],
            name: `conf-${randomBytes(6).toString('hex')}`,
            logger,
          }).runOnce(),
      );
      const store = new FindingStore(prisma, new NoNotices());
      // O coletor que espera mais de 5 s pelo lock do cliente (só com a máquina afogada) desiste e relê, como na vida real.
      const persist = async (each: FindingDraft, tries = 4): Promise<void> => {
        try {
          await store.persist(each, null, new Date());
        } catch (error) {
          const expired = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028';
          if (!expired || tries === 0) throw error;
          await persist(each, tries - 1);
        }
      };
      const answers = new Map<number, number>();
      const unexpected: string[] = [];
      const note = (response: { status: number; body: unknown }, ...allowed: number[]) => {
        answers.set(response.status, (answers.get(response.status) ?? 0) + 1);
        if (!allowed.includes(response.status)) {
          unexpected.push(`${response.status} ${JSON.stringify(response.body).slice(0, 200)}`);
        }
      };
      const someIds = async (next: () => number, count: number): Promise<string[]> => {
        const rows = await prisma.finding.findMany({
          where: { tenantId, occurredAt: { gt: new Date(Date.now() - DAY_MS) } },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        return [
          ...new Set(Array.from({ length: count }, () => rows[Math.floor(next() * rows.length)]?.id)),
        ].filter((id) => id !== undefined);
      };
      const collect = async (collector: number) => {
        for (let index = 0; index < 40; index += 1) {
          await persist(draft(tenantId, collector * 1000 + index));
        }
      };
      const single = async (seed: number) => {
        const next = random(seed);
        for (let index = 0; index < 25; index += 1) {
          const [id] = await someIds(next, 1);
          if (id === undefined) continue;
          note(
            await patch(app, who, `/v1/findings/${id}/status`, {
              status: STATUSES[Math.floor(next() * 4)] as FindingStatus,
            }),
            200,
            404,
          );
        }
      };
      const bulk = async (seed: number) => {
        const next = random(seed);
        for (let index = 0; index < 12; index += 1) {
          const roll = next();
          const cases = (await casesOf(prisma, tenantId)).filter((row) => row.pending);
          const target =
            roll < 0.5 && cases.length > 0
              ? { caseIds: [cases[Math.floor(next() * cases.length)]?.id] }
              : { findingIds: await someIds(next, 30) };
          const overrides = { includeCritical: next() < 0.5, status: STATUSES[Math.floor(next() * 4)] };
          const made = await post(app, who, '/v1/triage-operations', statusRequest(target, 5_000, overrides));
          note(made, 201, 202, 409, 404, 503);
          if (made.status > 202) continue;
          const { id } = made.body as { id: string };
          const then = next();
          if (then < 0.2) note(await post(app, who, `/v1/triage-operations/${id}/cancel`), 200, 409, 503);
          if (then < 0.7) {
            note(
              await post(app, who, `/v1/triage-operations/${id}/undo`, { requestId: randomUUID() }),
              201,
              202,
              409,
              503,
            );
          }
        }
      };
      const incidents = async (seed: number) => {
        const next = random(seed);
        for (let index = 0; index < 10; index += 1) {
          const findingIds = await someIds(next, 40);
          const open = await prisma.incident.findMany({
            where: { tenantId, status: 'open' },
            select: { id: true },
          });
          const existing = open[Math.floor(next() * open.length)]?.id;
          const action =
            existing === undefined || next() < 0.4
              ? { action: 'promote', status: undefined }
              : { action: 'attach', status: undefined, incidentId: existing };
          const made = await post(
            app,
            who,
            '/v1/triage-operations',
            statusRequest({ findingIds }, 5_000, { ...action, includeCritical: true }),
          );
          note(made, 201, 202, 409, 404, 503);
          if (existing !== undefined) {
            const inside = await prisma.finding.findFirst({
              where: { incidentId: existing },
              select: { id: true },
            });
            if (inside !== null) {
              note(await remove(who, `/v1/incidents/${existing}/findings/${inside.id}`), 200, 404, 409);
            }
          }
          if (made.status <= 202 && next() < 0.5) {
            const { id } = made.body as { id: string };
            note(
              await post(app, who, `/v1/triage-operations/${id}/undo`, { requestId: randomUUID() }),
              201,
              202,
              409,
              503,
            );
          }
        }
      };
      const splitting = async (seed: number) => {
        const next = random(seed);
        for (let index = 0; index < 8; index += 1) {
          const rows = (await casesOf(prisma, tenantId)).filter((row) => row.total > 3);
          const chosen = rows[Math.floor(next() * rows.length)]?.id;
          if (chosen === undefined) continue;
          const inside = await prisma.finding.findMany({
            where: { caseId: chosen },
            take: 3,
            select: { id: true },
          });
          note(
            await post(app, who, `/v1/cases/${chosen}/split`, { findingIds: inside.map((row) => row.id) }),
            201,
            404,
            409,
            503,
          );
        }
      };
      const purge = async () => {
        const job = new RetentionJob(onlyTenantPhases(prisma), {
          historyDays: 90,
          name: `lote-${randomBytes(6).toString('hex')}`,
          batch: 7,
          pauseMs: 5,
          tenantIds: [tenantId],
        });
        await job.maybeRun(new Date(new Date().setUTCHours(23, 59, 0, 0)));
      };
      await Promise.all([
        collect(1),
        collect(2),
        single(3),
        single(4),
        bulk(5),
        bulk(6),
        incidents(7),
        splitting(8),
        purge(),
      ]);
      await background.stop();
      await drain(prisma, [tenantId]);
      await assignAll(prisma, [tenantId]);

      expect(unexpected).toEqual([]);
      // Espera longa por uma trava devolve o lote (é o esperado sob carga); deadlock ou qualquer outro erro reprova.
      expect(lines.filter((line) => line['sqlState'] !== '55P03')).toEqual([]);
      expect(capture.text).not.toContain('40P01');
      expect(capture.text).not.toContain('erro não tratado');
      expect(answers.get(201) ?? 0).toBeGreaterThan(0);
      expect(answers.get(202) ?? 0).toBeGreaterThan(0);
      expect(
        await prisma.triageOperation.count({ where: { tenantId, state: { in: ['queued', 'running'] } } }),
      ).toBe(0);
      await expectInvariants(tenantId);
      // Nenhum pendente ficou sem caso.
      expect(
        await prisma.finding.count({
          where: { tenantId, caseId: null, incidentId: null, status: { in: ['new', 'investigating'] } },
        }),
      ).toBe(0);
    },
  );

  it('o pedido espera a triagem de um alerta em curso e a respeita; presa demais, 503 sem mudar nada', async () => {
    const { tenantId, who } = await customer('espera');
    const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}, {}]);
    const blocker = await client();
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE "Finding" SET "status" = \'legitimate\' WHERE "id" = $1', [ids[1]]);
      const made = operate(app, who, statusRequest({ caseIds: [caseId] }, 3));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await blocker.query('COMMIT');
      expect(await made).toMatchObject({ state: 'done', matched: 3, changed: 2, skipped: 1 });
      expect((await findingsById(prisma, ids)).get(ids[1] as string)).toMatchObject({
        status: 'legitimate',
        triageOpId: null,
      });

      const other = await caseWith(prisma, tenantId, [{}, {}]);
      await blocker.query('BEGIN');
      await blocker.query('UPDATE "Finding" SET "status" = \'legitimate\' WHERE "id" = $1', [other.ids[0]]);
      const startedAt = performance.now();
      const busy = await post(
        app,
        who,
        '/v1/triage-operations',
        statusRequest({ caseIds: [other.caseId] }, 2),
      );
      expect(busy.status).toBe(503);
      expect(performance.now() - startedAt).toBeLessThan(10_000);
      await blocker.query('ROLLBACK');
      expect(await prisma.triageOperation.count({ where: { tenantId } })).toBe(1);
      expect((await findingsById(prisma, other.ids)).get(other.ids[1] as string)?.status).toBe('new');
      // Solta a trava, o mesmo pedido passa.
      expect(await operate(app, who, statusRequest({ caseIds: [other.caseId] }, 2))).toMatchObject({
        changed: 2,
      });
    } finally {
      await blocker.end();
    }
    await expectInvariants(tenantId);
  });

  it('toda escrita em massa espera o lock dos alertas do cliente, e só o dele', async () => {
    const { tenantId, who } = await customer('lock');
    const { tenantId: otherId, who: otherWho } = await customer('lock outro');
    const small = await caseWith(prisma, tenantId, [{}, {}]);
    const undoable = await caseWith(prisma, tenantId, [{}]);
    const splittable = await caseWith(prisma, tenantId, [{}, {}]);
    const promotable = await caseWith(prisma, tenantId, [{}]);
    const large = await caseWith(prisma, tenantId, []);
    await manyFindings(prisma, tenantId, large.caseId, 20);
    const bulky = await caseWith(prisma, tenantId, []);
    await manyFindings(prisma, tenantId, bulky.caseId, 8);
    const done = await operate(app, who, statusRequest({ caseIds: [undoable.caseId] }, 1));
    const doneBulky = await operate(app, who, statusRequest({ caseIds: [bulky.caseId] }, 8));
    limits.syncAlerts = 5;
    const queuedOperation = await operate(app, who, statusRequest({ caseIds: [large.caseId] }, 20), 202);
    const cancelable = await operate(app, who, statusRequest({ caseIds: [large.caseId] }, 20), 202);
    const elsewhere = await caseWith(prisma, otherId, [{}]);

    const works: [string, () => Promise<number>][] = [
      [
        'pedido',
        () => operate(app, who, statusRequest({ caseIds: [small.caseId] }, 2)).then((row) => row.changed),
      ],
      ['desfazer', () => undo(app, who, done.id).then((row) => row.changed)],
      ['desfazer na fila', () => undo(app, who, doneBulky.id, 202).then((row) => row.matched)],
      [
        'promover',
        () =>
          operate(app, who, {
            ...statusRequest({ caseIds: [promotable.caseId] }, 1),
            action: 'promote',
            status: undefined,
          }).then((row) => row.changed),
      ],
      [
        'dividir',
        () =>
          post(app, who, `/v1/cases/${splittable.caseId}/split`, { findingIds: [splittable.ids[0]] }).then(
            (response) => (response.body as { moved: number }).moved,
          ),
      ],
      [
        'cancelar',
        () =>
          post(app, who, `/v1/triage-operations/${cancelable.id}/cancel`).then((response) => response.status),
      ],
      [
        'lote',
        () =>
          triageJob(prisma, [tenantId])
            .runOnce()
            .then((report) => report.changed),
      ],
    ];
    const locker = await client();
    try {
      for (const [name, work] of works) {
        await locker.query('BEGIN');
        await locker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`verax:findings:${tenantId}`]);
        let finished = false;
        const running = work().then((value) => {
          finished = true;
          return value;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(finished, name).toBe(false);
        // O outro cliente não espera.
        if (name === 'pedido') {
          await operate(app, otherWho, statusRequest({ caseIds: [elsewhere.caseId] }, 1));
        }
        await locker.query('COMMIT');
        expect(await running, name).toBeGreaterThan(0);
      }
    } finally {
      await locker.end();
    }
    expect(await operation(app, who, queuedOperation.id)).toMatchObject({ state: 'done', changed: 20 });
    expect(await operation(app, who, cancelable.id)).toMatchObject({ state: 'canceled', changed: 0 });
    await expectInvariants(tenantId);
  });

  it('a triagem de um alerta que chega no meio do lote espera por ele e vale depois', async () => {
    const { tenantId, who } = await customer('depois');
    limits.syncAlerts = 1;
    const { caseId } = await caseWith(prisma, tenantId, []);
    const ids = await manyFindings(prisma, tenantId, caseId, 40);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 40), 202);
    const blocker = await client();
    try {
      // O caso preso segura o lote com os alertas já mudados.
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM "AlertCase" WHERE "id" = $1 FOR UPDATE', [caseId]);
      const running = triageJob(prisma, [tenantId], { rowLockTimeoutMs: 20_000 }).runOnce();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const single = patch(app, who, `/v1/findings/${ids[5]}/status`, { status: 'investigating' });
      const answer = single.then((response) => response.status);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await blocker.query('COMMIT');
      expect(await running).toMatchObject({ changed: 40 });
      expect(await answer).toBe(200);
    } finally {
      await blocker.end();
    }
    expect((await findingsById(prisma, [ids[5] as string])).get(ids[5] as string)).toMatchObject({
      status: 'investigating',
      triageOpId: null,
    });
    const undone = await undo(app, who, made.id, 202);
    await drain(prisma, [tenantId]);
    expect(await operation(app, who, undone.id)).toMatchObject({ changed: 39, skipped: 1 });
    await expectInvariants(tenantId);
  });

  it('a atribuição no meio de uma operação: o alerta novo entra como pendente, sem ser tratado', async () => {
    const { tenantId, who } = await customer('atribuição');
    limits.syncAlerts = 1;
    await insertMixed(prisma, tenantId, 120, earlier());
    await assignAll(prisma, [tenantId]);
    const caseIds = (await casesOf(prisma, tenantId)).map((row) => row.id);
    const made = await operate(
      app,
      who,
      statusRequest({ caseIds }, 120, { includeCritical: true, reason: 'Teste' }),
      202,
    );
    await insertMixed(prisma, tenantId, 60, earlier(1_000));
    await Promise.all([
      drain(prisma, [tenantId], { batch: 10, pauseMs: 5 }),
      assignAll(prisma, [tenantId], { batch: 10 }),
    ]);
    expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', changed: 120, skipped: 0 });
    expect(await prisma.finding.count({ where: { tenantId, status: 'new', caseId: { not: null } } })).toBe(
      60,
    );
    await expectInvariants(tenantId);
  });

  it.each([11, 12, 13, 14])(
    'sequência aleatória %i: as contagens fecham a cada passo, e a conferência não acha diferença',
    { timeout: 120_000 },
    async (seed) => {
      const { tenantId, who } = await customer(`sequência ${seed}`);
      const next = random(seed);
      const chance = (share: number) => next() < share;
      const pick = <T>(values: readonly T[]): T | undefined => values[Math.floor(next() * values.length)];
      limits.syncAlerts = 8;
      limits.maxActive = 1_000;
      await insertMixed(prisma, tenantId, 60, earlier());
      await assignAll(prisma, [tenantId]);
      const made: string[] = [];
      const job = triageJob(prisma, [tenantId], { batch: 5, workMs: 0 });
      const findings = () =>
        prisma.finding.findMany({
          where: { tenantId },
          select: { id: true, caseId: true, incidentId: true },
          orderBy: { id: 'asc' },
        });
      const steps: Record<string, () => Promise<unknown>> = {
        insert: () => insertMixed(prisma, tenantId, 6, earlier(1_000)),
        assign: () => assignAll(prisma, [tenantId]),
        work: () => job.runOnce(),
        bulk: async () => {
          const rows = await findings();
          const cases = await casesOf(prisma, tenantId);
          const target = chance(0.4)
            ? { caseIds: [pick(cases)?.id ?? randomUUID()] }
            : chance(0.3)
              ? { filter: { severity: pick(SEVERITIES) } }
              : {
                  findingIds: [
                    ...new Set([pick(rows), pick(rows), pick(rows), pick(rows)].map((row) => row?.id)),
                  ],
                };
          const response = await post(
            app,
            who,
            '/v1/triage-operations',
            statusRequest(target, 5_000, { status: pick(STATUSES), includeCritical: chance(0.5) }),
          );
          expect([201, 202, 404, 409]).toContain(response.status);
          if (response.status <= 202) made.push((response.body as { id: string }).id);
        },
        incident: async () => {
          const free = (await findings()).filter((row) => row.incidentId === null);
          const findingIds = [
            ...new Set([pick(free), pick(free), pick(free)].flatMap((row) => row?.id ?? [])),
          ];
          if (findingIds.length === 0) return;
          const open = await prisma.incident.findFirst({
            where: { tenantId, status: 'open' },
            select: { id: true },
          });
          const action =
            open !== null && chance(0.6) ? { action: 'attach', incidentId: open.id } : { action: 'promote' };
          const response = await post(
            app,
            who,
            '/v1/triage-operations',
            statusRequest({ findingIds }, 100, { status: undefined, includeCritical: true, ...action }),
          );
          expect([201, 202, 409]).toContain(response.status);
          if (response.status <= 202) made.push((response.body as { id: string }).id);
        },
        patch: async () => {
          const row = pick(await findings());
          if (row)
            await patch(app, who, `/v1/findings/${row.id}/status`, { status: pick(STATUSES) }).expect(200);
        },
        severity: async () => {
          const row = pick(await findings());
          if (row)
            await prisma.finding.update({
              where: { id: row.id },
              data: { severity: pick(SEVERITIES) as FindingSeverity },
            });
        },
        detach: async () => {
          const row = pick((await findings()).filter((finding) => finding.incidentId !== null));
          if (row) {
            const response = await remove(who, `/v1/incidents/${row.incidentId}/findings/${row.id}`);
            expect([200, 409]).toContain(response.status);
          }
        },
        resolve: async () => {
          const row = await prisma.incident.findFirst({ where: { tenantId }, select: { id: true } });
          if (row)
            await patch(app, who, `/v1/incidents/${row.id}`, {
              status: chance(0.5) ? 'resolved' : 'open',
            }).expect(200);
        },
        undo: async () => {
          const id = pick(made);
          if (id === undefined) return;
          const response = await post(app, who, `/v1/triage-operations/${id}/undo`, {
            requestId: randomUUID(),
          });
          expect([201, 202, 409]).toContain(response.status);
          if (response.status <= 202) made.push((response.body as { id: string }).id);
        },
        cancel: async () => {
          const id = pick(made);
          if (id === undefined) return;
          expect([200, 409]).toContain((await post(app, who, `/v1/triage-operations/${id}/cancel`)).status);
        },
        continue: async () => {
          const id = pick(made);
          if (id === undefined) return;
          expect([202, 404, 409]).toContain(
            (await post(app, who, `/v1/triage-operations/${id}/continue`)).status,
          );
        },
        split: async () => {
          const row = pick((await findings()).filter((finding) => finding.caseId !== null));
          if (!row) return;
          const response = await post(app, who, `/v1/cases/${row.caseId}/split`, { findingIds: [row.id] });
          expect([201, 409]).toContain(response.status);
        },
        purge: async () => {
          const row = pick((await findings()).filter((finding) => finding.incidentId === null));
          if (row) await prisma.finding.delete({ where: { id: row.id } });
        },
      };
      const names = Object.keys(steps);
      const weights = [...names, 'bulk', 'bulk', 'bulk', 'undo', 'undo', 'work', 'work', 'incident'];
      for (let step = 0; step < 90; step += 1) {
        const name = pick(weights) as string;
        await steps[name]?.();
        if (step % 10 === 9) await expectExactCounters(prisma, [tenantId]);
      }
      await drain(prisma, [tenantId]);
      await assignAll(prisma, [tenantId]);
      await expectInvariants(tenantId);
      expect(made.length).toBeGreaterThan(10);
    },
  );
});
