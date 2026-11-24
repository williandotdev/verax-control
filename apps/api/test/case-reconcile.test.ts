import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  CaseReconcileJob,
  type CaseReconcileOptions,
  reconcileCase,
} from '../src/cases/case-reconcile-job.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { FindingSeverity, FindingStatus } from '../src/generated/prisma/client.js';
import { DAY_MS } from '../src/retention/retention-policy.js';
import {
  assignAll,
  casesOf,
  cleanCases,
  countersOf,
  expectExactCounters,
  insertFinding,
  insertIncident,
} from './support/cases.js';

/** A conferência semanal das contagens dos casos (`case-reconcile`), no banco real. */
describe('case-reconcile', () => {
  let prisma: PrismaService;
  const tenants: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await prisma.$disconnect();
  });

  async function customer(name: string): Promise<string> {
    const { id } = await prisma.tenant.create({
      data: { name: `Cliente Demo ${name} (conferência)` },
      select: { id: true },
    });
    tenants.push(id);
    return id;
  }

  const taskName = () => `conf-${randomBytes(6).toString('hex')}`;
  const job = (tenantIds: readonly string[], options: CaseReconcileOptions = {}) =>
    new CaseReconcileJob(prisma, { tenantIds, name: taskName(), ...options });

  /** Um caso com um alerta de cada severidade e status, dentro e fora de incidente. */
  async function seeded(tenantId: string): Promise<string> {
    await insertFinding(prisma, tenantId, {
      logSource: 'inspector',
      ruleId: '990511',
      caseGroup: 'openssl',
      resource: 'ec2:i-0abc1234def567890',
    });
    await assignAll(prisma, [tenantId]);
    const [row] = await casesOf(prisma, tenantId);
    const caseId = row?.id as string;
    const incidentId = await insertIncident(prisma, tenantId);
    for (const severity of ['critical', 'high', 'medium', 'low'] as FindingSeverity[]) {
      for (const status of ['new', 'investigating', 'legitimate', 'resolved'] as FindingStatus[]) {
        await insertFinding(prisma, tenantId, { severity, status, caseId });
        await insertFinding(prisma, tenantId, { severity, status, caseId, incidentId });
      }
    }
    return caseId;
  }

  const drift = {
    total: 999,
    pendingCritical: -3,
    pendingHigh: 7,
    pendingMedium: 7,
    pendingLow: 7,
    newCount: 0,
    investigatingCount: 50,
    legitimateCount: 1,
    resolvedCount: 0,
    incidentCount: 2,
    pending: false,
  };

  it('acha e corrige toda contagem errada, diz quais e não mexe em mais nada', async () => {
    const tenantId = await customer('desvio');
    const caseId = await seeded(tenantId);
    const right = await prisma.alertCase.findUniqueOrThrow({ where: { id: caseId } });
    // Certo: nada a corrigir.
    expect(await reconcileCase(prisma, tenantId, caseId)).toEqual([]);
    expect(await prisma.alertCase.findUniqueOrThrow({ where: { id: caseId } })).toEqual(right);
    // Uma contagem por vez, e depois todas.
    for (const [name, value] of Object.entries(drift)) {
      await prisma.alertCase.update({ where: { id: caseId }, data: { [name]: value } });
      expect(await reconcileCase(prisma, tenantId, caseId)).toEqual([name]);
      expect(await prisma.alertCase.findUniqueOrThrow({ where: { id: caseId } })).toEqual(right);
    }
    await prisma.alertCase.update({ where: { id: caseId }, data: drift });
    const updatedAt = (await prisma.finding.findMany({ where: { tenantId }, orderBy: { id: 'asc' } })).map(
      (row) => row.updatedAt,
    );
    const warnings: Record<string, unknown>[] = [];
    const logger = { warn: (fields: object) => void warnings.push({ ...fields }), error: () => undefined };
    expect(await job([tenantId], { logger }).runOnce()).toEqual({
      status: 'done',
      checked: 1,
      drifted: 1,
      failed: 0,
    });
    expect(warnings).toEqual([
      { tenantId, caseId, counters: expect.arrayContaining(Object.keys(drift)) as unknown },
      { drifted: 1, checked: 1 },
    ]);
    expect(await prisma.alertCase.findUniqueOrThrow({ where: { id: caseId } })).toEqual(right);
    // Os alertas ficam como estavam.
    expect(
      (await prisma.finding.findMany({ where: { tenantId }, orderBy: { id: 'asc' } })).map(
        (row) => row.updatedAt,
      ),
    ).toEqual(updatedAt);
    await expectExactCounters(prisma, [tenantId]);
  });

  it('o caso sem alerta nenhum zera, e o que já saiu não é erro', async () => {
    const tenantId = await customer('vazio');
    const caseId = await seeded(tenantId);
    await prisma.finding.deleteMany({ where: { tenantId } });
    await prisma.alertCase.update({ where: { id: caseId }, data: drift });
    expect(await reconcileCase(prisma, tenantId, caseId)).toContain('total');
    const row = await prisma.alertCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(countersOf(row)).toMatchObject({ total: 0, pending: false, newCount: 0, incidentCount: 0 });
    await prisma.alertCase.delete({ where: { id: caseId } });
    expect(await reconcileCase(prisma, tenantId, caseId)).toEqual([]);
  });

  it('só conta os alertas do próprio caso e do próprio cliente', async () => {
    const [a, b] = [await customer('A'), await customer('B')];
    const [caseA, caseB] = [await seeded(a), await seeded(b)];
    await prisma.finding.deleteMany({ where: { tenantId: b, status: { in: ['new', 'investigating'] } } });
    expect(await job([a, b]).runOnce()).toEqual({ status: 'done', checked: 2, drifted: 0, failed: 0 });
    // Com o cliente trocado, o caso não existe: nada é lido nem gravado.
    await prisma.alertCase.update({ where: { id: caseA }, data: { total: 5 } });
    expect(await reconcileCase(prisma, b, caseA)).toEqual([]);
    expect((await prisma.alertCase.findUniqueOrThrow({ where: { id: caseA } })).total).toBe(5);
    expect(await reconcileCase(prisma, a, caseA)).toEqual(['total']);
    expect(await reconcileCase(prisma, b, caseB)).toEqual([]);
    await expectExactCounters(prisma, [a, b]);
  });

  it('uma volta por semana', async () => {
    const tenantId = await customer('semana');
    await seeded(tenantId);
    const name = taskName();
    const at = (ms: number) => ({ name, now: () => new Date(Date.UTC(2026, 10, 2) + ms) });
    expect(await job([tenantId], at(0)).runOnce()).toMatchObject({ status: 'done', checked: 1 });
    expect(await job([tenantId], at(7 * DAY_MS - 1)).runOnce()).toMatchObject({
      status: 'not_due',
      checked: 0,
    });
    expect(await job([tenantId], at(7 * DAY_MS)).runOnce()).toMatchObject({ status: 'done', checked: 1 });
    await prisma.syncState.update({
      where: { name },
      data: { leaseOwner: 'outra', leaseUntil: new Date(Date.now() + 60_000) },
    });
    expect(await job([tenantId], at(20 * DAY_MS)).runOnce()).toMatchObject({ status: 'locked', checked: 0 });
  });

  it('a volta que não cabe no tempo continua de onde parou, e a parada do worker interrompe entre dois casos', async () => {
    const ids = [await customer('V1'), await customer('V2'), await customer('V3'), await customer('V4')];
    for (const tenantId of ids) await seeded(tenantId);
    const name = taskName();
    let elapsed = 0;
    const options: CaseReconcileOptions = {
      name,
      page: 1,
      maxRunMs: 1_000,
      elapsed: () => (elapsed += 400),
    };
    const first = await job(ids, options).runOnce();
    expect(first.status).toBe('partial');
    expect(first.checked).toBeGreaterThan(0);
    expect(first.checked).toBeLessThan(4);
    const state = await prisma.syncState.findUniqueOrThrow({ where: { name } });
    expect(state.cursorId).not.toBeNull();
    expect(state.lastSuccessAt).toBeNull();
    // Um desvio num caso já conferido nesta volta espera a próxima; num que falta, é corrigido agora.
    const rest = await job(ids, { name, page: 1 }).runOnce();
    expect(rest).toMatchObject({ status: 'done', checked: 4 - first.checked });
    expect(await prisma.syncState.findUniqueOrThrow({ where: { name } })).toMatchObject({
      cursorId: null,
      leaseOwner: null,
    });
    const controller = new AbortController();
    const reason = new DOMException('o worker está parando', 'AbortError');
    controller.abort(reason);
    await expect(job(ids).runOnce(controller.signal)).rejects.toBe(reason);
  });

  it('um caso com erro não para os outros', async () => {
    const ids = [await customer('E1'), await customer('E2'), await customer('E3')];
    const cases: string[] = [];
    for (const tenantId of ids) cases.push(await seeded(tenantId));
    for (const id of cases) await prisma.alertCase.update({ where: { id }, data: { total: 1 } });
    let calls = 0;
    const once = new Proxy(prisma, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property !== '$transaction') return value;
        return (...args: unknown[]) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('falhou'));
          return (value as (...args: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const errors: object[] = [];
    const report = await new CaseReconcileJob(once, {
      tenantIds: ids,
      name: taskName(),
      logger: { warn: () => undefined, error: (fields) => void errors.push(fields) },
    }).runOnce();
    expect(report).toEqual({ status: 'done', checked: 2, drifted: 2, failed: 1 });
    expect(errors).toHaveLength(1);
    const totals = await prisma.alertCase.findMany({ where: { id: { in: cases } }, select: { total: true } });
    expect(totals.map(({ total }) => total).sort((x, y) => x - y)).toEqual([1, 33, 33]);
  });
});
