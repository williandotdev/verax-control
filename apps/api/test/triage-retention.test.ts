import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { RetentionJob } from '../src/retention/retention-job.js';
import { DAY_MS, retentionCutoffs } from '../src/retention/retention-policy.js';
import { cleanCases, insertFinding, insertOperation, onlyTenantPhases } from './support/cases.js';

/** A etapa das operações de triagem em massa no expurgo: 13 meses, e só sem alerta guardado. */
describe('expurgo das operações de triagem em massa', () => {
  let prisma: PrismaService;
  const tenants: string[] = [];
  const now = new Date(new Date().setUTCHours(23, 59, 0, 0));
  /** O corte de 13 meses (com o dia de folga), o mesmo da auditoria. */
  const cutoff = retentionCutoffs(now, 30).audit as Date;
  const old = new Date(cutoff.getTime() - 1);

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await prisma.$disconnect();
  });

  async function customer(name: string): Promise<string> {
    const { id } = await prisma.tenant.create({
      data: { name: `Cliente Demo ${name} (expurgo de operações)` },
      select: { id: true },
    });
    tenants.push(id);
    return id;
  }

  const purge = (tenantIds: readonly string[], historyDays: number | null = 90, batch = 500) =>
    new RetentionJob(onlyTenantPhases(prisma), {
      historyDays,
      name: `lotes-${randomBytes(6).toString('hex')}`,
      batch,
      pauseMs: 0,
      tenantIds,
    }).maybeRun(now);

  const insert = (
    tenantId: string,
    overrides: Partial<Prisma.TriageOperationUncheckedCreateInput> = {},
  ): Promise<string> => insertOperation(prisma, tenantId, { createdAt: old, ...overrides });
  const left = async (tenantId: string) =>
    (await prisma.triageOperation.findMany({ where: { tenantId }, select: { id: true } }))
      .map((row) => row.id)
      .sort();
  const item = (tenantId: string, operationId: string, findingId: string) =>
    prisma.triageOperationItem.create({
      data: { tenantId, operationId, findingId, previousStatus: 'new' },
    });

  it('sai a antiga, terminada e sem alerta; a recente, a que está na fila e a que ainda tem alerta ficam', async () => {
    const tenantId = await customer('regra');
    for (const state of ['done', 'partial', 'failed', 'canceled', 'undone'])
      await insert(tenantId, { state });
    const recent = await insert(tenantId, { createdAt: cutoff });
    const queued = await insert(tenantId, { state: 'queued' });
    const running = await insert(tenantId, { state: 'running' });
    const holding = await insert(tenantId);
    const findingId = await insertFinding(prisma, tenantId, { status: 'resolved', triageOpId: holding });
    await item(tenantId, holding, findingId);
    expect(await purge([tenantId])).toMatchObject({ status: 'done', deleted: { triageOperations: 5 } });
    expect(await left(tenantId)).toEqual([recent, queued, running, holding].sort());
    const trail = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: 'retention.purge' } });
    expect((trail.after as { deleted: object }).deleted).toMatchObject({ triageOperations: 5 });
  });

  it('a desfeita sai junto com a que a desfez, e nenhuma antes da outra', async () => {
    const tenantId = await customer('desfeita');
    const undone = await insert(tenantId, { state: 'undone' });
    await insert(tenantId, { action: 'undo', status: null, undoOfId: undone });
    const kept = await insert(tenantId, { state: 'undone' });
    const newer = await insert(tenantId, { action: 'undo', status: null, undoOfId: kept, createdAt: now });
    expect(await purge([tenantId])).toMatchObject({ deleted: { triageOperations: 2 } });
    // A que desfez é recente: a desfeita espera por ela.
    expect(await left(tenantId)).toEqual([kept, newer].sort());
  });

  it('o alerta que sai leva o item dele, e a operação sai na mesma execução', async () => {
    const tenantId = await customer('cascata');
    const operationId = await insert(tenantId);
    for (let index = 0; index < 7; index += 1) {
      const findingId = await insertFinding(prisma, tenantId, {
        occurredAt: old,
        createdAt: old,
        updatedAt: old,
        status: 'resolved',
        triageOpId: operationId,
      });
      await item(tenantId, operationId, findingId);
    }
    expect(await purge([tenantId], 90, 3)).toMatchObject({ deleted: { findings: 7, triageOperations: 1 } });
    expect(await left(tenantId)).toEqual([]);
    expect(await prisma.triageOperationItem.count({ where: { tenantId } })).toBe(0);
  });

  it('a triagem em massa é atividade: o alerta antigo tratado agora não sai', async () => {
    const tenantId = await customer('atividade');
    const treated = await insertFinding(prisma, tenantId, {
      occurredAt: old,
      createdAt: old,
      updatedAt: now,
    });
    const untouched = await insertFinding(prisma, tenantId, {
      occurredAt: old,
      createdAt: old,
      updatedAt: old,
    });
    await purge([tenantId]);
    const rows = await prisma.finding.findMany({ where: { tenantId }, select: { id: true } });
    expect(rows.map((row) => row.id)).toEqual([treated]);
    expect(untouched).toBeDefined();
  });

  it('um cliente não mexe na operação do outro; sem limite de histórico, valem os mesmos 13 meses', async () => {
    const [a, b] = [await customer('A'), await customer('B')];
    await insert(a);
    const ofB = await insert(b);
    expect(await purge([a], null)).toMatchObject({ deleted: { triageOperations: 1 } });
    expect([await left(a), await left(b)]).toEqual([[], [ofB]]);
  });

  it('sem operação a apagar, o relatório e a trilha ficam como antes', async () => {
    const tenantId = await customer('sem nada');
    await insert(tenantId, { createdAt: now, requestId: randomUUID() });
    const report = await purge([tenantId]);
    expect(report.deleted).not.toHaveProperty('triageOperations');
    expect(now.getTime() - old.getTime()).toBeGreaterThan(390 * DAY_MS);
  });
});
