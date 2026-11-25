import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { lockTenantFindings } from '../src/alerts/finding-store.js';
import { caseTasks } from '../src/cases/case-tasks.js';
import { TRIAGE_MAX_FAILED } from '../src/cases/triage-engine.js';
import { TRIAGE_MAX_STALLS, TRIAGE_OPS_TASK } from '../src/cases/triage-ops-job.js';
import {
  DEFAULT_TRIAGE_LIMITS,
  TRIAGE_LIMITS,
  type TriageLimits,
} from '../src/cases/triage-operations.service.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { createTenant } from './support/auth-helpers.js';
import { cleanCases, expectExactCounters, HOUR_MS, insertIncident } from './support/cases.js';
import { createApp } from './support/create-app.js';
import {
  caseWith,
  drain,
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
  trail,
  triageJob,
  undo,
} from './support/triage.js';

type Transaction = (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => unknown;

const mentions = (values: ReadonlySet<string>, param: unknown): boolean =>
  param instanceof Prisma.Sql
    ? param.values.some((value) => mentions(values, value))
    : Array.isArray(param)
      ? param.some((item) => values.has(item as string))
      : values.has(param as string);

/** O banco com defeito: o comando com este trecho que leva um destes valores falha, dentro da transação do lote. */
function broken(
  prisma: PrismaService,
  values: ReadonlySet<string>,
  fail: (tx: Prisma.TransactionClient) => Promise<number>,
  fragment = 'INSERT INTO "TriageOperationItem"',
): PrismaService {
  const brokenTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property !== '$executeRaw') return value;
        return (strings: TemplateStringsArray, ...params: unknown[]) => {
          const hit = strings.join('?').includes(fragment) && params.some((param) => mentions(values, param));
          return hit ? fail(tx) : tx.$executeRaw(strings, ...params);
        };
      },
    });
  return new Proxy(prisma, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== '$transaction') return value;
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
        (value as Transaction).call(target, (tx) => work(brokenTx(tx)), options);
    },
  });
}

/** Um erro de dado do banco, como o de uma linha que não cabe; e a queda da conexão. */
const dataError = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT 1 / 0`;
const down = () => Promise.reject(new Error('conexão caiu'));

/** A tarefa do worker que executa as operações grandes: lotes, retomada, réplicas e falhas. */
describe('triage-ops', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];
  const limits: TriageLimits = { ...DEFAULT_TRIAGE_LIMITS };

  async function customer(name: string): Promise<{ tenantId: string; who: Operator }> {
    const tenantId = await createTenant(app, `Cliente Demo (fila: ${name})`);
    tenants.push(tenantId);
    return { tenantId, who: await operatorFor(app, tenantId, 'admin_cliente') };
  }

  /** Um caso com muitos alertas e o pedido de resolvê-los, na fila. */
  async function queued(name: string, count: number) {
    const { tenantId, who } = await customer(name);
    const { caseId } = await caseWith(prisma, tenantId, []);
    const ids = await manyFindings(prisma, tenantId, caseId, count);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, count), 202);
    return { tenantId, who, caseId, ids, id: made.id };
  }

  const items = (operationId: string) => prisma.triageOperationItem.count({ where: { operationId } });
  const resolved = (tenantId: string) =>
    prisma.finding.count({ where: { tenantId, status: 'resolved', triageOpId: { not: null } } });
  const client = async () => {
    const connection = new pg.Client({ connectionString: inject('testDatabaseUrl') });
    await connection.connect();
    return connection;
  };

  beforeAll(async () => {
    app = await createApp({
      casesMode: 'on',
      overrideProviders: [{ provide: TRIAGE_LIMITS, useValue: limits }],
    });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
  }, 60_000);

  beforeEach(() => {
    Object.assign(limits, { ...DEFAULT_TRIAGE_LIMITS, syncAlerts: 1 });
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  it('só existe com os casos ligados', () => {
    const { logger } = memoryLogger();
    const names = (mode: 'off' | 'shadow' | 'on') => caseTasks(mode, prisma, logger).map((task) => task.name);
    expect(names('off')).toEqual([]);
    expect(names('shadow')).not.toContain(TRIAGE_OPS_TASK);
    expect(names('on')).toEqual([...names('shadow'), TRIAGE_OPS_TASK]);
    expect(caseTasks('on', prisma, logger).at(-1)).toMatchObject({ intervalMs: 5_000 });
  });

  it('sem nada na fila, não toma a concessão nem grava nada', async () => {
    const { tenantId } = await customer('vazia');
    const name = `lote-${randomBytes(6).toString('hex')}`;
    const job = triageJob(prisma, [tenantId], { name });
    // A primeira passagem só faz a faxina de hora em hora.
    expect(await job.runOnce()).toMatchObject({ status: 'done', batches: 0 });
    await prisma.syncState.deleteMany({ where: { name } });
    expect(await job.runOnce()).toMatchObject({ status: 'done', batches: 0 });
    expect(await prisma.syncState.count({ where: { name } })).toBe(0);
  });

  it('uma operação de cada cliente por vez, na ordem do pedido, e os clientes se revezam', async () => {
    const a = await queued('ordem A', 9);
    const second = await caseWith(prisma, a.tenantId, [{}, {}]);
    const next = await operate(app, a.who, statusRequest({ caseIds: [second.caseId] }, 2), 202);
    const b = await queued('ordem B', 3);
    const order: string[] = [];
    await drain(prisma, [a.tenantId, b.tenantId], {
      batch: 3,
      onBatch: ({ operationId, seen }) => void order.push(`${operationId}:${seen}`),
    });
    const ofA = order.filter((entry) => !entry.startsWith(b.id));
    expect(ofA).toEqual([`${a.id}:3`, `${a.id}:3`, `${a.id}:3`, `${next.id}:2`]);
    // O outro cliente, com uma operação pequena, não espera a grande terminar.
    expect(order.findIndex((entry) => entry.startsWith(b.id))).toBeLessThan(2);
    for (const [who, id] of [
      [a.who, a.id],
      [a.who, next.id],
      [b.who, b.id],
    ] as const) {
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', skipped: 0 });
    }
    await expectExactCounters(prisma, [a.tenantId, b.tenantId]);
  });

  it('o andamento aparece a cada lote, os piores primeiro', async () => {
    const { tenantId, who, id, ids } = await queued('andamento', 30);
    const job = triageJob(prisma, [tenantId], { batch: 10, workMs: 0 });
    const seen: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      await job.runOnce();
      const row = await operation(app, who, id);
      seen.push(row.changed);
      const done = await prisma.finding.findMany({
        where: { id: { in: ids }, status: 'resolved' },
        select: { severity: true },
      });
      if (round === 0) expect(done.every((finding) => finding.severity === 'high')).toBe(true);
      if (round === 1) expect(done.some((finding) => finding.severity === 'low')).toBe(false);
      expect(row.remaining).toBe(30 - row.changed);
    }
    expect(seen).toEqual([10, 20, 30]);
    expect(await trail(prisma, tenantId, 'triage.bulk.finish')).toHaveLength(1);
  });

  describe('exatamente uma vez', () => {
    it('a queda no meio de um lote desfaz o lote inteiro, e a retomada termina sem repetir nada', async () => {
      const { tenantId, who, id, caseId, ids } = await queued('queda', 60);
      await triageJob(prisma, [tenantId], { batch: 20, workMs: 0 }).runOnce();
      expect(await operation(app, who, id)).toMatchObject({ state: 'running', changed: 20 });
      const killer = await client();
      const blocker = await client();
      try {
        // O caso preso segura o lote já com os alertas mudados, esperando no gatilho.
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM "AlertCase" WHERE "id" = $1 FOR UPDATE', [caseId]);
        const { rows: self } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const running = triageJob(prisma, [tenantId], {
          batch: 20,
          workMs: 0,
          rowLockTimeoutMs: 30_000,
        }).runOnce();
        let killed = 0;
        for (let tries = 0; killed === 0 && tries < 400; tries += 1) {
          // O texto do comando e quem espera por quem são lidos em instantes diferentes: só vale quem já está no comando esperado.
          const { rows } = await killer.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE $1::int = ANY(pg_blocking_pids(pid)) AND position($2::text in query) > 0`,
            [self[0]?.pid, '"TriageOperationItem"'],
          );
          for (const waiting of rows) {
            await killer.query('SELECT pg_terminate_backend($1::int)', [waiting.pid]);
            killed += 1;
          }
          if (killed === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(killed).toBe(1);
        expect(await running).toMatchObject({ stalled: 1, changed: 0 });
        await blocker.query('ROLLBACK');
      } finally {
        await Promise.all([killer.end(), blocker.end()]);
      }
      // Nada do lote que caiu ficou: nem alerta, nem item, nem cursor.
      expect(await operation(app, who, id)).toMatchObject({ state: 'running', changed: 20, skipped: 0 });
      expect([await items(id), await resolved(tenantId)]).toEqual([20, 20]);
      // Outro processo (sem memória nenhuma do anterior) termina.
      await drain(prisma, [tenantId], { batch: 20 });
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 60, skipped: 0 });
      expect(await items(id)).toBe(60);
      const rows = [...(await findingsById(prisma, ids)).values()];
      expect(rows.every((row) => row.status === 'resolved' && row.triageOpId === id)).toBe(true);
      expect(await trail(prisma, tenantId, 'triage.bulk.finish')).toHaveLength(1);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('a parada do worker entre dois lotes: o resto fica para o seguinte', async () => {
      const { tenantId, who, id } = await queued('parada', 30);
      const controller = new AbortController();
      const reason = new DOMException('o worker está parando', 'AbortError');
      const job = triageJob(prisma, [tenantId], {
        batch: 10,
        pauseMs: 1,
        onBatch: () => controller.abort(reason),
      });
      await expect(job.runOnce(controller.signal)).rejects.toBe(reason);
      expect(await operation(app, who, id)).toMatchObject({ state: 'running', changed: 10 });
      // A concessão foi devolvida.
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 30 });
    });

    it('duas réplicas sem a concessão entre elas: cada alerta muda uma vez, e o fim é um só', async () => {
      const { tenantId, who, id } = await queued('réplicas', 200);
      const { lines, logger } = memoryLogger();
      const replicas = Array.from({ length: 3 }, () =>
        triageJob(prisma, [tenantId], { batch: 7, logger, rowLockTimeoutMs: 20_000 }),
      );
      const reports = await Promise.all(replicas.map((job) => job.runOnce()));
      expect(lines).toEqual([]);
      expect(reports.reduce((sum, report) => sum + report.changed, 0)).toBe(200);
      expect(reports.filter((report) => report.changed > 0).length).toBeGreaterThan(1);
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 200, skipped: 0 });
      expect(await items(id)).toBe(200);
      expect(await trail(prisma, tenantId, 'triage.bulk.finish')).toHaveLength(1);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('com a concessão de outra réplica, não roda; perdida no meio, para', async () => {
      const { tenantId, who, id } = await queued('concessão', 30);
      const name = `lote-${randomBytes(6).toString('hex')}`;
      await prisma.syncState.create({
        data: { name, leaseOwner: 'outra', leaseUntil: new Date(Date.now() + 60_000) },
      });
      expect(await triageJob(prisma, [tenantId], { name }).runOnce()).toMatchObject({
        status: 'locked',
        batches: 0,
      });
      await prisma.syncState.update({ where: { name }, data: { leaseOwner: null, leaseUntil: null } });
      // Outra réplica toma a concessão depois do primeiro lote: a renovação não acha mais a linha deste worker.
      let lost = false;
      const losing = new Proxy(prisma, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (property !== 'syncState') return value;
          return new Proxy(value as object, {
            get(delegate, operationName) {
              if (lost && operationName === 'updateMany') return () => Promise.resolve({ count: 0 });
              return Reflect.get(delegate, operationName) as unknown;
            },
          });
        },
      });
      let clock = 0;
      const job = triageJob(losing, [tenantId], {
        name,
        batch: 10,
        elapsed: () => clock,
        onBatch: () => {
          clock += 60_000;
          lost = true;
        },
      });
      expect(await job.runOnce()).toMatchObject({ status: 'lease_lost', batches: 1, changed: 10 });
      await prisma.syncState.update({ where: { name }, data: { leaseOwner: null, leaseUntil: null } });
      await drain(prisma, [tenantId], { name });
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 30 });
    });
  });

  describe('o que muda no meio', () => {
    it('o alerta que outra pessoa tratou, promoveu ou que saiu conta como pulado, e não é tocado', async () => {
      const { tenantId, who, id, ids } = await queued('mudou', 20);
      const incidentId = await insertIncident(prisma, tenantId);
      await patch(app, who, `/v1/findings/${ids[0]}/status`, { status: 'legitimate' }).expect(200);
      await patch(app, who, `/v1/findings/${ids[1]}/status`, { status: 'resolved' }).expect(200);
      await prisma.finding.update({ where: { id: ids[2] as string }, data: { incidentId } });
      await prisma.finding.delete({ where: { id: ids[3] as string } });
      // Em análise ainda é pendente: entra.
      await patch(app, who, `/v1/findings/${ids[4]}/status`, { status: 'investigating' }).expect(200);
      const frozen = await findingsById(prisma, ids.slice(0, 3));
      await drain(prisma, [tenantId], { batch: 6 });
      expect(await operation(app, who, id)).toMatchObject({
        state: 'done',
        matched: 20,
        changed: 16,
        skipped: 4,
        remaining: 0,
      });
      const after = await findingsById(prisma, ids);
      for (const [key, row] of frozen) expect(after.get(key)).toEqual(row);
      const item = await prisma.triageOperationItem.findUniqueOrThrow({
        where: { operationId_findingId: { operationId: id, findingId: ids[4] as string } },
      });
      expect(item.previousStatus).toBe('investigating');
      const [finish] = await trail(prisma, tenantId, 'triage.bulk.finish');
      expect(finish?.after).toMatchObject({ state: 'done', changed: 16, skipped: 4 });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('uma triagem em curso num alerta segura só o lote, e ele volta na passagem seguinte', async () => {
      const { tenantId, who, id, ids } = await queued('presa', 20);
      const { lines, logger } = memoryLogger();
      const blocker = await client();
      const job = triageJob(prisma, [tenantId], { logger, rowLockTimeoutMs: 100 });
      try {
        await blocker.query('BEGIN');
        await blocker.query('UPDATE "Finding" SET "status" = $2, "triageOpId" = NULL WHERE "id" = $1', [
          ids[7],
          'legitimate',
        ]);
        expect(await job.runOnce()).toMatchObject({ batches: 0, stalled: 1, isolated: 0 });
        expect(lines).toEqual([
          expect.objectContaining({ operationId: id, tenantId, sqlState: '55P03', count: 1 }),
        ]);
        // O coletor passa enquanto isso: o lock do cliente não ficou com ninguém.
        await prisma.$transaction((tx) => lockTenantFindings(tx, tenantId));
        await blocker.query('COMMIT');
      } finally {
        await blocker.end();
      }
      expect(await job.runOnce()).toMatchObject({ changed: 19, finished: 1, stalled: 0 });
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 19, skipped: 1 });
      expect((await findingsById(prisma, [ids[7] as string])).get(ids[7] as string)).toMatchObject({
        status: 'legitimate',
        triageOpId: null,
      });
    });

    it('cancelada por uma pessoa com o worker no meio: o lote em curso termina, e nenhum outro começa', async () => {
      const { tenantId, who, id } = await queued('cancelada no meio', 60);
      const answers: Promise<number>[] = [];
      const job = triageJob(prisma, [tenantId], {
        batch: 10,
        pauseMs: 30,
        onBatch: () => {
          if (answers.length > 0) return;
          answers.push(
            post(app, who, `/v1/triage-operations/${id}/cancel`).then((response) => response.status),
          );
        },
      });
      const report = await job.runOnce();
      expect(await Promise.all(answers)).toEqual([200]);
      const row = await operation(app, who, id);
      expect(row).toMatchObject({ state: 'canceled', changed: report.changed });
      expect(report.changed).toBeGreaterThanOrEqual(10);
      expect(report.changed).toBeLessThan(60);
      expect([await items(id), await resolved(tenantId)]).toEqual([report.changed, report.changed]);
    });
  });

  describe('falhas', () => {
    it('um alerta que o banco não grava é isolado: os outros entram, a operação termina parcial, e o continuar o recupera', async () => {
      const { tenantId, who, id, ids } = await queued('envenenado', 40);
      const poison = new Set([ids[3] as string, ids[25] as string]);
      const { lines, logger } = memoryLogger();
      const job = triageJob(broken(prisma, poison, dataError), [tenantId], { batch: 16, logger });
      const report = await job.runOnce();
      expect(report).toMatchObject({ status: 'done', changed: 38, isolated: 2, finished: 1, stalled: 0 });
      expect(await operation(app, who, id)).toMatchObject({
        state: 'partial',
        stop: 'failed_alerts',
        changed: 38,
        skipped: 2,
        failed: 2,
        remaining: 0,
        can: { cancel: true, continue: true, undo: true },
      });
      expect(lines.every((line) => line['sqlState'] === '22012' && line['operationId'] === id)).toBe(true);
      // O log não leva nada do alerta.
      expect(JSON.stringify(lines)).not.toContain('pessoa-');
      const [finish] = await trail(prisma, tenantId, 'triage.bulk.finish');
      expect(finish).toMatchObject({
        outcome: 'failure',
        after: { state: 'partial', stop: 'failed_alerts', changed: 38, skipped: 2, failed: 2 },
      });
      const resumed = await post(app, who, `/v1/triage-operations/${id}/continue`).expect(202);
      expect(resumed.body).toMatchObject({
        state: 'queued',
        changed: 38,
        skipped: 0,
        failed: 0,
        stop: null,
        remaining: 2,
      });
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, id)).toMatchObject({
        state: 'done',
        changed: 40,
        skipped: 0,
        failed: 0,
      });
      expect(await items(id)).toBe(40);
      const [record] = await trail(prisma, tenantId, 'triage.bulk.continue');
      expect(record).toMatchObject({
        actorId: who.userId,
        before: { state: 'partial', stop: 'failed_alerts', failed: 2 },
        after: { state: 'queued', matched: 40, changed: 38 },
      });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('falhas demais param a operação, e a seguinte da fila roda', async () => {
      const { tenantId, who, id, ids } = await queued('tudo envenenado', 120);
      const other = await caseWith(prisma, tenantId, [{}, {}]);
      const next = await operate(app, who, statusRequest({ caseIds: [other.caseId] }, 2), 202);
      const job = triageJob(broken(prisma, new Set(ids), dataError), [tenantId], { batch: 32 });
      const report = await job.runOnce();
      expect(report).toMatchObject({ status: 'done', isolated: TRIAGE_MAX_FAILED, changed: 2, finished: 2 });
      expect(await operation(app, who, id)).toMatchObject({
        state: 'failed',
        stop: 'too_many_failures',
        changed: 0,
        skipped: TRIAGE_MAX_FAILED,
        failed: TRIAGE_MAX_FAILED,
        remaining: 120 - TRIAGE_MAX_FAILED,
        can: { continue: true, undo: false },
      });
      expect(await operation(app, who, next.id)).toMatchObject({ state: 'done', changed: 2 });
      await post(app, who, `/v1/triage-operations/${id}/continue`).expect(202);
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 120, skipped: 0 });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('o banco que falha não isola ninguém: tenta de novo, e depois de muitas passagens dá lugar à seguinte', async () => {
      const { tenantId, who, id, ids } = await queued('banco', 20);
      const other = await caseWith(prisma, tenantId, [{}, {}]);
      const next = await operate(app, who, statusRequest({ caseIds: [other.caseId] }, 2), 202);
      const job = triageJob(broken(prisma, new Set(ids), down), [tenantId], { batch: 5, maxStalls: 3 });
      expect(TRIAGE_MAX_STALLS).toBe(10);
      for (let round = 0; round < 2; round += 1) {
        expect(await job.runOnce()).toMatchObject({ stalled: 1, isolated: 0, changed: 0 });
        expect(await operation(app, who, id)).toMatchObject({ state: 'queued' });
      }
      // A terceira falha seguida encerra a operação, e a seguinte roda na mesma passagem.
      expect(await job.runOnce()).toMatchObject({ stalled: 1, changed: 2, finished: 2 });
      expect(await operation(app, who, id)).toMatchObject({
        state: 'failed',
        stop: 'unavailable',
        changed: 0,
        remaining: 20,
      });
      expect(await operation(app, who, next.id)).toMatchObject({ state: 'done' });
      await post(app, who, `/v1/triage-operations/${id}/continue`).expect(202);
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 20 });
    });

    it('a falha de um cliente não segura os outros, e um lote bom zera a conta das falhas', async () => {
      const a = await queued('falha A', 20);
      const b = await queued('falha B', 10);
      const stuck = new Set(a.ids);
      const job = triageJob(broken(prisma, stuck, down), [a.tenantId, b.tenantId], {
        batch: 4,
        maxStalls: 2,
      });
      expect(await job.runOnce()).toMatchObject({ stalled: 1, changed: 10, finished: 1 });
      // Um lote bom no meio: a falha seguinte volta a ser a primeira.
      stuck.clear();
      const one = triageJob(broken(prisma, stuck, down), [a.tenantId], { batch: 4, maxStalls: 2, workMs: 0 });
      for (const id of a.ids) stuck.add(id);
      expect(await one.runOnce()).toMatchObject({ stalled: 1 });
      stuck.clear();
      expect(await one.runOnce()).toMatchObject({ stalled: 0, changed: 4 });
      for (const id of a.ids) stuck.add(id);
      expect(await one.runOnce()).toMatchObject({ stalled: 1 });
      expect(await operation(app, a.who, a.id)).toMatchObject({ state: 'running', changed: 4 });
      expect(await one.runOnce()).toMatchObject({ stalled: 1 });
      expect(await operation(app, a.who, a.id)).toMatchObject({
        stop: 'unavailable',
        state: 'partial',
        changed: 4,
      });
    });

    it('a operação que nem encerrar deixa sai da vez por um tempo, e a fila anda', async () => {
      const { tenantId, who, id, ids } = await queued('nem encerra', 5);
      const other = await caseWith(prisma, tenantId, [{}, {}]);
      const next = await operate(app, who, statusRequest({ caseIds: [other.caseId] }, 2), 202);
      // Nem o lote nem o encerramento gravam.
      const values = new Set([...ids, id]);
      const bad = broken(broken(prisma, values, down), values, down, 'UPDATE "TriageOperation"');
      let clock = 0;
      const job = triageJob(bad, [tenantId], { maxStalls: 1, elapsed: () => clock, workMs: 1_000 });
      expect(await job.runOnce()).toMatchObject({ stalled: 1, finished: 0 });
      expect(await job.runOnce()).toMatchObject({ changed: 2, finished: 1 });
      expect(await operation(app, who, next.id)).toMatchObject({ state: 'done' });
      expect(await operation(app, who, id)).toMatchObject({ state: 'queued' });
      // Passado o tempo, volta a ser tentada; consertado o banco, termina.
      clock += 11 * 60_000;
      expect(await job.runOnce()).toMatchObject({ stalled: 1 });
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 5 });
    });

    it('o desfazer com um alerta que não grava também termina parcial, e continua', async () => {
      const { tenantId, who, id, ids } = await queued('desfazer envenenado', 30);
      await drain(prisma, [tenantId]);
      const undone = await undo(app, who, id, 202);
      const poison = new Set([ids[11] as string]);
      const job = triageJob(broken(prisma, poison, dataError), [tenantId], { batch: 8 });
      expect(await job.runOnce()).toMatchObject({ changed: 29, isolated: 1, finished: 1 });
      expect(await operation(app, who, undone.id)).toMatchObject({
        state: 'partial',
        changed: 29,
        skipped: 1,
        failed: 1,
        can: { continue: true, undo: false },
      });
      expect(await operation(app, who, id)).toMatchObject({ state: 'undoing' });
      await post(app, who, `/v1/triage-operations/${undone.id}/continue`).expect(202);
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, undone.id)).toMatchObject({
        state: 'done',
        changed: 30,
        skipped: 0,
        failed: 0,
      });
      expect(await operation(app, who, id)).toMatchObject({ state: 'undone' });
      expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(30);
      await expectExactCounters(prisma, [tenantId]);
    });
  });

  describe('continuar', () => {
    it('só a que parou antes do fim, no prazo; e o conjunto parado sai depois dele', async () => {
      const { tenantId, who, id, ids } = await queued('prazo', 10);
      const refuse = async (target: string) => {
        const response = await post(app, who, `/v1/triage-operations/${target}/continue`);
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'TRIAGE_NOT_RESUMABLE' });
      };
      await refuse(id);
      const job = triageJob(broken(prisma, new Set([ids[0] as string]), dataError), [tenantId], { batch: 4 });
      await job.runOnce();
      const stopped = await operation(app, who, id);
      expect(stopped.state).toBe('partial');
      const hasIds = async () => {
        const { target } = await prisma.triageOperation.findUniqueOrThrow({ where: { id } });
        return 'ids' in (target as object);
      };
      expect(await hasIds()).toBe(true);
      await triageJob(prisma, [tenantId]).runOnce();
      expect(await hasIds()).toBe(true);
      const after = new Date(Date.parse(stopped.undoUntil as string) + 1);
      limits.now = () => after;
      expect((await operation(app, who, id)).can).toEqual({ cancel: true, continue: false, undo: false });
      await refuse(id);
      await triageJob(prisma, [tenantId], { now: () => after }).runOnce();
      expect(await hasIds()).toBe(false);
      limits.now = DEFAULT_TRIAGE_LIMITS.now;
      // Terminada, também não.
      const done = await queued('terminada', 5);
      await drain(prisma, [done.tenantId]);
      const response = await post(app, done.who, `/v1/triage-operations/${done.id}/continue`);
      expect(response.body).toMatchObject({ code: 'TRIAGE_NOT_RESUMABLE' });
    });

    it('desistir da que parou: cancelada, sem conjunto, com o prazo de desfazer que já tinha', async () => {
      const { tenantId, who, id, ids } = await queued('desistir', 10);
      await triageJob(broken(prisma, new Set([ids[0] as string]), dataError), [tenantId]).runOnce();
      const stopped = await operation(app, who, id);
      expect(stopped).toMatchObject({ state: 'partial', changed: 9 });
      limits.now = () => new Date(Date.now() + 5 * HOUR_MS);
      const canceled = await post(app, who, `/v1/triage-operations/${id}/cancel`).expect(200);
      expect(canceled.body).toMatchObject({
        state: 'canceled',
        changed: 9,
        undoUntil: stopped.undoUntil,
        can: { cancel: false, continue: false, undo: true },
      });
      const { target } = await prisma.triageOperation.findUniqueOrThrow({ where: { id } });
      expect('ids' in (target as object)).toBe(false);
      expect((await post(app, who, `/v1/triage-operations/${id}/continue`)).body).toMatchObject({
        code: 'TRIAGE_NOT_RESUMABLE',
      });
      // Fora do prazo, cancelar não abre o desfazer de novo.
      const other = await queued('desistir tarde', 10);
      limits.now = DEFAULT_TRIAGE_LIMITS.now;
      await triageJob(broken(prisma, new Set([other.ids[0] as string]), dataError), [
        other.tenantId,
      ]).runOnce();
      limits.now = () => new Date(Date.now() + 30 * HOUR_MS);
      const late = await post(app, other.who, `/v1/triage-operations/${other.id}/cancel`).expect(200);
      expect((late.body as { can: object }).can).toEqual({ cancel: false, continue: false, undo: false });
    });

    it('desistir de um desfazer que parou: a operação volta ao que era, e pode ser desfeita de novo', async () => {
      const { tenantId, who, id, ids } = await queued('desistir do desfazer', 10);
      await drain(prisma, [tenantId]);
      const first = await undo(app, who, id, 202);
      await triageJob(broken(prisma, new Set([ids[4] as string]), dataError), [tenantId]).runOnce();
      expect(await operation(app, who, first.id)).toMatchObject({ state: 'partial', changed: 9 });
      expect(await operation(app, who, id)).toMatchObject({ state: 'undoing', can: { undo: false } });
      await post(app, who, `/v1/triage-operations/${first.id}/cancel`).expect(200);
      expect(await operation(app, who, first.id)).toMatchObject({ state: 'canceled', undoUntil: null });
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', can: { undo: true } });
      const second = await undo(app, who, id, 202);
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, second.id)).toMatchObject({ state: 'done', changed: 1, skipped: 9 });
      expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(10);
    });

    it('continuar respeita o tamanho da fila', async () => {
      const { tenantId, who, id, ids } = await queued('fila cheia', 10);
      await triageJob(broken(prisma, new Set([ids[0] as string]), dataError), [tenantId]).runOnce();
      limits.maxActive = 1;
      const other = await caseWith(prisma, tenantId, [{}, {}]);
      await operate(app, who, statusRequest({ caseIds: [other.caseId] }, 2), 202);
      const full = await post(app, who, `/v1/triage-operations/${id}/continue`);
      expect(full.status).toBe(409);
      expect(full.body).toMatchObject({ code: 'TRIAGE_QUEUE_FULL' });
      await drain(prisma, [tenantId]);
      await post(app, who, `/v1/triage-operations/${id}/continue`).expect(202);
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 10 });
    });
  });

  it('a passagem para no tempo de trabalho e a seguinte continua', async () => {
    const { tenantId, who, id } = await queued('tempo', 20);
    let clock = 0;
    const job = triageJob(prisma, [tenantId], {
      batch: 5,
      workMs: 2 * HOUR_MS,
      leaseMs: 10 * HOUR_MS,
      elapsed: () => clock,
      onBatch: () => {
        clock += HOUR_MS;
      },
    });
    expect(await job.runOnce()).toMatchObject({ status: 'partial', batches: 2, changed: 10 });
    expect(await operation(app, who, id)).toMatchObject({ state: 'running', changed: 10 });
    expect(await job.runOnce()).toMatchObject({ changed: 10, finished: 1 });
  });

  it('um alvo gravado por outra versão, com campos a mais ou sem o andamento, não quebra a leitura nem a fila', async () => {
    const { tenantId, who } = await customer('outra versão');
    const id = randomUUID();
    await prisma.triageOperation.create({
      data: {
        id,
        tenantId,
        requestId: randomUUID(),
        action: 'status',
        status: 'resolved',
        target: { algo: 'novo', run: { excludedCritical: 'x', failed: 7, novo: true } },
        cutoffAt: new Date(),
        expectedCount: 3,
        matched: 3,
        createdById: who.userId,
      },
    });
    expect(await operation(app, who, id)).toMatchObject({
      state: 'queued',
      target: { kind: 'findings', count: 0 },
      excludedCritical: 0,
      failed: 0,
    });
    // E uma ação que esta versão não executa em lotes fica onde está, sem prender a fila.
    const unknown = await prisma.triageOperation.create({
      data: {
        tenantId,
        requestId: randomUUID(),
        action: 'undo_all_of',
        target: {},
        cutoffAt: new Date(),
        expectedCount: 0,
        createdAt: new Date(Date.now() - HOUR_MS),
      },
      select: { id: true },
    });
    await drain(prisma, [tenantId]);
    expect(await operation(app, who, id)).toMatchObject({ state: 'done', changed: 0 });
    expect(await operation(app, who, unknown.id)).toMatchObject({ state: 'queued' });
  });
});
