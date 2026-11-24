import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  CaseAssignJob,
  type CaseAssignOptions,
  type CaseAssignReport,
} from '../../src/cases/case-assign-job.js';
import { caseKeyOf } from '../../src/cases/case-key.js';
import type { PrismaService } from '../../src/common/prisma/prisma.service.js';
import type { AlertCase, FindingSeverity, FindingStatus, Prisma } from '../../src/generated/prisma/client.js';

/** Apoio dos testes de casos: alertas fictícios, a conta das contagens refeita em código e a tarefa presa aos clientes. */

export const CASE_ACCOUNT = '111122223333';
export const HOUR_MS = 60 * 60 * 1000;

export interface Counters {
  pending: boolean;
  total: number;
  pendingCritical: number;
  pendingHigh: number;
  pendingMedium: number;
  pendingLow: number;
  newCount: number;
  investigatingCount: number;
  legitimateCount: number;
  resolvedCount: number;
  incidentCount: number;
}

export const ZERO_COUNTERS: Counters = {
  pending: false,
  total: 0,
  pendingCritical: 0,
  pendingHigh: 0,
  pendingMedium: 0,
  pendingLow: 0,
  newCount: 0,
  investigatingCount: 0,
  legitimateCount: 0,
  resolvedCount: 0,
  incidentCount: 0,
};

/** A conta refeita em código, alerta por alerta: o que os gatilhos têm de dar. */
export function recount(
  findings: readonly { severity: FindingSeverity; status: FindingStatus; incidentId: string | null }[],
): Counters {
  const counters = { ...ZERO_COUNTERS };
  for (const { severity, status, incidentId } of findings) {
    counters.total += 1;
    if (incidentId !== null) {
      counters.incidentCount += 1;
      continue;
    }
    if (status === 'legitimate') counters.legitimateCount += 1;
    if (status === 'resolved') counters.resolvedCount += 1;
    if (status === 'new') counters.newCount += 1;
    if (status === 'investigating') counters.investigatingCount += 1;
    if (status !== 'new' && status !== 'investigating') continue;
    counters.pending = true;
    if (severity === 'critical') counters.pendingCritical += 1;
    if (severity === 'high') counters.pendingHigh += 1;
    if (severity === 'medium') counters.pendingMedium += 1;
    if (severity === 'low') counters.pendingLow += 1;
  }
  return counters;
}

export const countersOf = (row: AlertCase): Counters =>
  Object.fromEntries(
    Object.keys(ZERO_COUNTERS).map((name) => [name, row[name as keyof Counters]]),
  ) as unknown as Counters;

/** Um alerta do CloudTrail, alto e com ator: o caso da regra e do ator. */
export function findingData(
  tenantId: string,
  overrides: Partial<Prisma.FindingUncheckedCreateInput> = {},
): Prisma.FindingUncheckedCreateInput {
  const createdAt = (overrides.createdAt as Date | undefined) ?? new Date();
  return {
    tenantId,
    accountId: CASE_ACCOUNT,
    source: 'wazuh',
    sourceEventId: `caso-${randomUUID()}`,
    logSource: 'cloudtrail',
    occurredAt: createdAt,
    severity: 'high',
    ruleId: '100305',
    ruleLevel: 10,
    title: 'Permissão de administrador concedida',
    actorUser: `arn:aws:iam::${CASE_ACCOUNT}:user/maria`,
    mitreTactics: [],
    mitreTechniques: [],
    createdAt,
    ...overrides,
  };
}

export async function insertFinding(
  prisma: PrismaService,
  tenantId: string,
  overrides: Partial<Prisma.FindingUncheckedCreateInput> = {},
): Promise<string> {
  const { id } = await prisma.finding.create({
    data: findingData(tenantId, overrides),
    select: { id: true },
  });
  return id;
}

export async function insertIncident(
  prisma: PrismaService,
  tenantId: string,
  overrides: Partial<Prisma.IncidentUncheckedCreateInput> = {},
): Promise<string> {
  const now = new Date();
  const { id } = await prisma.incident.create({
    data: {
      tenantId,
      severity: 'high',
      riskScore: 50,
      findingCount: 0,
      firstSeenAt: now,
      lastSeenAt: now,
      keys: [],
      accounts: [],
      resources: [],
      mitreTactics: [],
      mitreTechniques: [],
      ...overrides,
    },
    select: { id: true },
  });
  return id;
}

/** A tarefa presa aos clientes do teste, com a linha dela no `SyncState` (outra por teste). */
export function assignJob(
  prisma: PrismaService,
  tenantIds: readonly string[],
  options: Partial<CaseAssignOptions> = {},
): CaseAssignJob {
  return new CaseAssignJob(prisma, {
    name: `caso-${randomBytes(6).toString('hex')}`,
    tenantIds,
    ...options,
  });
}

/** Uma passagem da tarefa, com tudo o que há na fila dos clientes. */
export async function assignAll(
  prisma: PrismaService,
  tenantIds: readonly string[],
  options: Partial<CaseAssignOptions> = {},
): Promise<CaseAssignReport> {
  const report = await assignJob(prisma, tenantIds, { workMs: 60_000, ...options }).runOnce();
  expect(report).toMatchObject({ status: 'done', failedTenants: 0, quarantined: 0 });
  return report;
}

/** Os casos de um cliente, na ordem de abertura. */
export const casesOf = (prisma: PrismaService, tenantId: string): Promise<AlertCase[]> =>
  prisma.alertCase.findMany({ where: { tenantId }, orderBy: [{ openedAt: 'asc' }, { id: 'asc' }] });

/** Confere as contagens de todos os casos dos clientes contra os alertas. */
export async function expectExactCounters(
  prisma: PrismaService,
  tenantIds: readonly string[],
): Promise<void> {
  for (const tenantId of tenantIds) {
    const findings = await prisma.finding.findMany({
      where: { tenantId, caseId: { not: null } },
      select: { severity: true, status: true, incidentId: true, caseId: true },
    });
    for (const row of await casesOf(prisma, tenantId)) {
      expect(countersOf(row), row.title).toEqual(
        recount(findings.filter((finding) => finding.caseId === row.id)),
      );
    }
  }
}

export const SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low'];
export const STATUSES: readonly FindingStatus[] = ['new', 'investigating', 'legitimate', 'resolved'];

/** A espera longa por uma trava devolve o lote (é o esperado sob carga); qualquer outro erro reprova. */
export function watchedLogger() {
  const errors: { sqlState?: unknown }[] = [];
  return {
    errors,
    logger: { warn: () => undefined, error: (fields: object) => void errors.push(fields) },
  };
}

/** Alertas de 12 chaves, em toda severidade. */
export const insertMixed = (prisma: PrismaService, tenantId: string, count: number, at: Date) =>
  prisma.finding.createMany({
    data: Array.from({ length: count }, (_, index) =>
      findingData(tenantId, {
        severity: SEVERITIES[index % 4] as FindingSeverity,
        ruleId: `10030${index % 3}`,
        actorUser: `pessoa-${index % 4}`,
        occurredAt: at,
        createdAt: at,
        updatedAt: at,
      }),
    ),
  });

/** Repete um trabalho até o teste acabar o resto. */
export function loops(...works: (() => Promise<unknown>)[]) {
  let running = true;
  const ending = works.map(async (work) => {
    while (running) {
      await work();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  return {
    stop: async () => {
      running = false;
      await Promise.all(ending);
    },
  };
}

/** No fim: ninguém pendente sem caso, cada alerta no caso da chave dele, um aberto por chave e as contagens certas. */
export async function expectSettled(prisma: PrismaService, tenantId: string, total: number): Promise<void> {
  const findings = await prisma.finding.findMany({ where: { tenantId }, include: { alertCase: true } });
  expect(findings).toHaveLength(total);
  const waiting = findings.filter(
    (row) =>
      row.caseId === null &&
      row.incidentId === null &&
      (row.status === 'new' || row.status === 'investigating'),
  );
  expect(waiting).toEqual([]);
  for (const row of findings) {
    if (row.alertCase !== null) {
      expect(row.alertCase).toMatchObject({ tenantId, groupKey: caseKeyOf(row).groupKey });
    }
  }
  const open = (await casesOf(prisma, tenantId)).flatMap((row) =>
    row.openKey === null ? [] : [row.openKey],
  );
  expect(new Set(open).size).toBe(open.length);
  await expectExactCounters(prisma, [tenantId]);
}

/** Os alertas de depois de um instante. */
export const recentIds = async (prisma: PrismaService, tenantId: string, since: Date): Promise<string[]> =>
  (
    await prisma.finding.findMany({
      where: { tenantId, occurredAt: { gt: since } },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
  ).map((row) => row.id);

/** Os avisos destes clientes fora da fila: outra suíte lê a fila inteira, os pendentes mais antigos primeiro. */
export async function muteNotices(prisma: PrismaService, tenantIds: readonly string[]): Promise<void> {
  await prisma.notification.updateMany({
    where: { tenantId: { in: [...tenantIds] }, status: 'pending' },
    data: { status: 'skipped' },
  });
}

/**
 * O banco para o expurgo dos testes de casos: as fases sem cliente (a fila sem dono, as tabelas de operação e a
 * auditoria) não acham nada, porque valem para o nó inteiro, e as outras suítes contam o que elas apagam.
 */
export function onlyTenantPhases(prisma: PrismaService): PrismaService {
  const quiet = new Set([
    'unownedAlert',
    'session',
    'verification',
    'loginAttempt',
    'usedTotpCode',
    'rateLimit',
  ]);
  return new Proxy(prisma, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      const global = typeof property === 'string' && quiet.has(property);
      if (!global && property !== 'auditLog') return value;
      return new Proxy(value as object, {
        get(delegate, operation) {
          if (global && operation === 'findMany') return () => Promise.resolve([]);
          if (!global && operation === 'findFirst') return () => Promise.resolve(null);
          return Reflect.get(delegate, operation) as unknown;
        },
      });
    },
  });
}

/** Apaga só o que é dos clientes do teste. Quem tem comentário fica: o banco não o deixa sair, nem o alerta dele. */
export async function cleanCases(prisma: PrismaService, tenantIds: readonly string[]): Promise<void> {
  const commented = new Set(
    (
      await prisma.findingComment.findMany({
        where: { tenantId: { in: [...tenantIds] } },
        select: { tenantId: true },
        distinct: ['tenantId'],
      })
    ).map((row) => row.tenantId),
  );
  await prisma.notification.deleteMany({ where: { tenantId: { in: [...tenantIds] } } });
  const where = { tenantId: { in: tenantIds.filter((id) => !commented.has(id)) } };
  await prisma.triageOperationItem.deleteMany({ where });
  await prisma.triageOperation.deleteMany({ where });
  await prisma.finding.deleteMany({ where });
  await prisma.alertCase.deleteMany({ where });
  await prisma.incident.deleteMany({ where });
  await prisma.alertException.deleteMany({ where });
  await prisma.protectedResource.deleteMany({ where });
}
