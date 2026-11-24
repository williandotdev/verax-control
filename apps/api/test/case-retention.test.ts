import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { ResolvedPlan } from '@verax/shared';
import { RetentionJob } from '../src/retention/retention-job.js';
import { DAY_MS } from '../src/retention/retention-policy.js';
import {
  assignAll,
  casesOf,
  cleanCases,
  insertFinding,
  insertIncident,
  onlyTenantPhases,
} from './support/cases.js';

/** A etapa dos casos no expurgo diário: só sai o caso sem alerta, antigo e fora de incidente. */
describe('expurgo dos casos', () => {
  let prisma: PrismaService;
  const tenants: string[] = [];
  const HISTORY_DAYS = 90;
  /** O dia da execução, depois das 04:00 UTC, e o corte: o prazo mais um dia. */
  const now = new Date(new Date().setUTCHours(23, 59, 0, 0));
  const cutoff = new Date(now.getTime() - (HISTORY_DAYS + 1) * DAY_MS);
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
      data: { name: `Cliente Demo ${name} (expurgo de casos)` },
      select: { id: true },
    });
    tenants.push(id);
    return id;
  }

  const sealed = { openKey: null, sealedAt: old, sealReason: 'window' };
  async function insertCase(
    tenantId: string,
    overrides: Partial<Prisma.AlertCaseUncheckedCreateInput> = {},
  ): Promise<string> {
    const groupKey = randomBytes(32).toString('hex');
    const { id } = await prisma.alertCase.create({
      data: {
        tenantId,
        queue: 'detection',
        keyVersion: 1,
        groupKey,
        openKey: groupKey,
        family: 'cloudtrail',
        title: 'Caso de teste',
        keyParts: [],
        anchorFindingId: randomUUID(),
        openedAt: old,
        firstSeenAt: old,
        lastSeenAt: old,
        lastAlertAt: old,
        ...overrides,
      },
      select: { id: true },
    });
    return id;
  }

  const purge = (tenantIds: readonly string[], db: PrismaService = prisma, batch = 500) =>
    new RetentionJob(onlyTenantPhases(db), {
      historyDays: HISTORY_DAYS,
      name: `casos-${randomBytes(6).toString('hex')}`,
      batch,
      pauseMs: 0,
      tenantIds,
    }).maybeRun(now);

  const left = async (tenantId: string) => (await casesOf(prisma, tenantId)).map((row) => row.id).sort();
  const trail = async (tenantId: string) =>
    (
      await prisma.auditLog.findFirstOrThrow({
        where: { tenantId, action: 'retention.purge' },
        orderBy: { occurredAt: 'desc' },
      })
    ).after as { deleted: Record<string, number> };

  it('só sai o que não tem alerta, nem alerta novo desde o corte, e está fora de incidente', async () => {
    const tenantId = await customer('regra');
    const incidentId = await insertIncident(prisma, tenantId);
    const gone = [
      await insertCase(tenantId, sealed),
      await insertCase(tenantId, { ...sealed, sealReason: 'treated' }),
      await insertCase(tenantId, { ...sealed, sealReason: 'idle', queue: 'vulnerability' }),
    ];
    const recent = await insertCase(tenantId, { ...sealed, lastAlertAt: cutoff });
    const promoted = await insertCase(tenantId, { ...sealed, incidentId });
    const holding = await insertCase(tenantId, sealed);
    await insertFinding(prisma, tenantId, { caseId: holding, status: 'resolved' });
    const openHolding = await insertCase(tenantId);
    await insertFinding(prisma, tenantId, { caseId: openHolding });
    const openRecent = await insertCase(tenantId, { lastAlertAt: cutoff });

    expect(await purge([tenantId])).toMatchObject({ status: 'done', deleted: { cases: 3, findings: 0 } });
    expect(await left(tenantId)).toEqual([recent, promoted, holding, openHolding, openRecent].sort());
    for (const id of gone) expect(await prisma.alertCase.findUnique({ where: { id } })).toBeNull();
    expect((await trail(tenantId)).deleted).toMatchObject({ cases: 3 });
    // O aberto que tem alerta, ou que é recente, continua aberto.
    for (const id of [openHolding, openRecent]) {
      expect((await prisma.alertCase.findUniqueOrThrow({ where: { id } })).sealedAt).toBeNull();
    }
  });

  it('o aberto que ninguém mais vai selar (sem alerta e antigo) também sai, e o seguinte da chave começa do zero', async () => {
    const tenantId = await customer('aberto');
    await insertCase(tenantId, { queue: 'posture' });
    await insertCase(tenantId);
    expect(await purge([tenantId])).toMatchObject({ deleted: { cases: 2 } });
    expect(await left(tenantId)).toEqual([]);
  });

  it('o expurgo dos alertas leva o caso deles junto, na mesma execução e em lotes', async () => {
    const tenantId = await customer('junto');
    for (let index = 0; index < 7; index += 1) {
      await insertFinding(prisma, tenantId, {
        ruleId: `10030${index}`,
        occurredAt: old,
        createdAt: old,
        updatedAt: old,
        status: index % 2 === 0 ? 'new' : 'investigating',
      });
    }
    const kept = await insertFinding(prisma, tenantId, { ruleId: '100310' });
    await assignAll(prisma, [tenantId]);
    expect(await left(tenantId)).toHaveLength(8);
    // A atribuição não deu vida nova aos alertas antigos: saem todos, e os casos com eles.
    expect(await purge([tenantId], prisma, 2)).toMatchObject({
      status: 'done',
      deleted: { findings: 7, cases: 7 },
    });
    const { caseId } = await prisma.finding.findUniqueOrThrow({ where: { id: kept } });
    expect(await left(tenantId)).toEqual([caseId]);
  });

  it('o caso que voltou a ter alerta no meio fica', async () => {
    const tenantId = await customer('corrida');
    const [first, second] = [await insertCase(tenantId, sealed), await insertCase(tenantId, sealed)];
    // Entre a busca e o lote, um alerta volta para o primeiro caso.
    const racing = new Proxy(prisma, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property !== 'alertCase') return value;
        return new Proxy(value as object, {
          get(delegate, operation) {
            const run: unknown = Reflect.get(delegate, operation);
            if (operation !== 'findMany') return run;
            return async (args: unknown) => {
              const rows = await (run as (args: unknown) => Promise<{ id: string }[]>)(args);
              if (rows.some(({ id }) => id === first)) {
                await insertFinding(target, tenantId, { caseId: first });
              }
              return rows;
            };
          },
        });
      },
    });
    expect(await purge([tenantId], racing)).toMatchObject({ status: 'done', deleted: { cases: 1 } });
    expect(await left(tenantId)).toEqual([first]);
    expect(await prisma.alertCase.findUnique({ where: { id: second } })).toBeNull();
    // Se nenhum saiu, a trilha não fala de casos.
    const findings = await prisma.finding.deleteMany({ where: { tenantId } });
    expect(findings.count).toBe(1);
    const report = await purge([tenantId], racing);
    expect(report.status).toBe('done');
    expect(report.deleted).not.toHaveProperty('cases');
    expect((await trail(tenantId)).deleted).not.toHaveProperty('cases');
    expect(await left(tenantId)).toEqual([first]);
  });

  it('um cliente não mexe no caso do outro, e quem não tem limite de histórico não perde caso', async () => {
    const [a, b, unlimited] = [await customer('A'), await customer('B'), await customer('sem limite')];
    const caseB = await insertCase(b, sealed);
    const caseUnlimited = await insertCase(unlimited, sealed);
    await insertCase(a, sealed);
    expect(await purge([a])).toMatchObject({ deleted: { cases: 1 } });
    expect(await left(b)).toEqual([caseB]);
    const plan = (historyDays: number | null): ResolvedPlan => ({
      id: 'enterprise',
      label: 'Teste',
      limits: { maxCloudAccounts: null, maxUsers: null, monthlyGib: null, historyDays },
    });
    await new RetentionJob(onlyTenantPhases(prisma), {
      plans: { planOf: (tenantId) => Promise.resolve(plan(tenantId === unlimited ? null : HISTORY_DAYS)) },
      name: `casos-${randomBytes(6).toString('hex')}`,
      pauseMs: 0,
      tenantIds: [b, unlimited],
    }).maybeRun(now);
    expect(await left(b)).toEqual([]);
    expect(await left(unlimited)).toEqual([caseUnlimited]);
  });

  it('sem casos, o relatório e a trilha ficam como antes deles', async () => {
    const tenantId = await customer('nenhum');
    await insertFinding(prisma, tenantId, { occurredAt: old, createdAt: old, updatedAt: old });
    const report = await purge([tenantId]);
    expect(report).toMatchObject({ status: 'done', deleted: { findings: 1 } });
    expect(report.deleted).not.toHaveProperty('cases');
    expect(Object.keys((await trail(tenantId)).deleted).sort()).toEqual([
      'auditLogs',
      'comments',
      'findings',
      'incidents',
      'inventorySnapshots',
      'noticeDigests',
      'notifications',
      'postureFailures',
      'postureScans',
    ]);
  });
});
