import { randomBytes, randomUUID } from 'node:crypto';
import type { CaseQueueName, FindingSeverity, FindingStatus } from '@verax/shared';
import type { PrismaService } from '../../src/common/prisma/prisma.service.js';
import type { AlertCase, Finding, Incident, Prisma } from '../../src/generated/prisma/client.js';
import { insertIncident, SEVERITIES, STATUSES } from './cases.js';

/**
 * Um cliente sorteado (a mesma semente dá o mesmo cliente): casos das três filas, com alertas de toda severidade e status,
 * dentro e fora de incidente, alertas sem caso, chegadas atrasadas e táticas repetidas ou desconhecidas. Para conferir as
 * contas em SQL contra as refeitas em código, alerta por alerta.
 */

const HOUR = 3_600_000;
const MINUTE = 60_000;
export const WORLD_QUEUES: readonly CaseQueueName[] = ['detection', 'vulnerability', 'posture'];

/** Um gerador com semente (mulberry32). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

const FAMILIES: Readonly<Record<CaseQueueName, readonly { family: string; ruleIds: string[] }[]>> = {
  detection: [
    { family: 'cloudtrail', ruleIds: ['100305'] },
    { family: 'gcp-audit', ruleIds: ['100500'] },
    { family: 'host', ruleIds: ['5710'] },
    { family: 'other', ruleIds: ['900001'] },
  ],
  vulnerability: [{ family: 'package', ruleIds: ['990511'] }],
  posture: [{ family: 'control', ruleIds: ['990501'] }],
};
const TACTICS = ['Impact', 'Discovery', 'Persistence', 'Tática que não existe'];
const TECHNIQUES = ['T1485', 'T1098', 'T9999'];

/** Longe das pontas das janelas (24 horas, 7 e 30 dias): o relógio anda entre o sorteio e as leituras. */
function awayFromEdges(at: Date, now: Date): Date {
  const age = now.getTime() - at.getTime();
  const close = [24 * HOUR, 7 * 24 * HOUR, 30 * 24 * HOUR].some((edge) => Math.abs(age - edge) < 3 * MINUTE);
  return close ? new Date(at.getTime() - 10 * MINUTE) : at;
}

export interface World {
  cases: AlertCase[];
  findings: Finding[];
  incidents: Incident[];
}

export interface WorldOptions {
  seed: number;
  now: Date;
  cases?: number;
  loose?: number;
  /** Quantos alertas, no máximo, em cada caso. */
  perCase?: number;
}

export async function seedWorld(
  prisma: PrismaService,
  tenantId: string,
  { seed, now, cases = 30, loose = 25, perCase = 7 }: WorldOptions,
): Promise<World> {
  const random = seeded(seed);
  const int = (max: number) => Math.floor(random() * max);
  const pick = <T>(values: readonly T[]): T => values[int(values.length)] as T;
  const incidents: string[] = [];
  for (const status of ['open', 'investigating', 'resolved'] as const) {
    const createdAt = new Date(now.getTime() - int(20 * 24) * HOUR);
    incidents.push(
      await insertIncident(prisma, tenantId, {
        status,
        severity: pick(SEVERITIES),
        createdAt,
        firstSeenAt: createdAt,
        mitreTactics: [pick(TACTICS)],
        ...(status === 'resolved' && { resolvedAt: now }),
      }),
    );
  }
  const finding = (caseId: string | null): Prisma.FindingCreateManyInput => {
    // Metade nas últimas 24 horas; a outra, até 40 dias atrás. Alguns chegam bem depois do evento.
    const age = random() < 0.5 ? random() * 24 * HOUR : random() * 40 * 24 * HOUR;
    const occurredAt = awayFromEdges(new Date(now.getTime() - Math.floor(age) - 1), now);
    const delay = random() < 0.8 ? random() * 10 * MINUTE : random() * 30 * HOUR;
    const arrived = new Date(Math.min(occurredAt.getTime() + Math.floor(delay), now.getTime() - 1));
    const createdAt = awayFromEdges(arrived, now);
    const status: FindingStatus = random() < 0.45 ? 'new' : pick(STATUSES);
    return {
      id: randomUUID(),
      tenantId,
      accountId: '111122223333',
      source: 'wazuh',
      sourceEventId: `mundo-${randomUUID()}`,
      logSource: pick(['cloudtrail', 'gcp_audit', 'wazuh_agent', 'inspector']),
      occurredAt,
      createdAt,
      severity: pick(SEVERITIES),
      status,
      triagedAt: status === 'new' ? null : new Date(createdAt.getTime() + int(600) * MINUTE),
      ruleId: '100305',
      ruleLevel: 10,
      title: 'Alerta fictício',
      mitreTactics: random() < 0.4 ? [] : [...new Set([pick(TACTICS), pick(TACTICS)])],
      mitreTechniques: random() < 0.5 ? [] : [pick(TECHNIQUES)],
      incidentId: random() < 0.15 ? pick(incidents) : null,
      caseId,
    };
  };
  const rows: Prisma.FindingCreateManyInput[] = [];
  const caseRows: Prisma.AlertCaseCreateManyInput[] = [];
  for (let index = 0; index < cases; index += 1) {
    const id = randomUUID();
    const queue = pick(WORLD_QUEUES);
    const own = Array.from({ length: index % 11 === 0 ? 0 : 1 + int(perCase) }, () => finding(id));
    // Um em cada três casos é inteiro de um status só: pendente de verdade ou tratado.
    if (index % 3 === 0) {
      const status = pick(STATUSES);
      for (const row of own) {
        row.status = status;
        row.triagedAt =
          status === 'new' ? null : new Date((row.createdAt as Date).getTime() + int(900) * MINUTE);
      }
    }
    rows.push(...own);
    const occurred = own.map((row) => (row.occurredAt as Date).getTime());
    const arrived = own.map((row) => (row.createdAt as Date).getTime());
    const openedAt = new Date(own.length === 0 ? now.getTime() - HOUR : Math.min(...arrived));
    const groupKey = randomBytes(32).toString('hex');
    caseRows.push({
      id,
      tenantId,
      queue,
      keyVersion: 1,
      groupKey,
      openKey: groupKey,
      ...pick(FAMILIES[queue]),
      title: 'Caso fictício',
      keyParts: [],
      anchorFindingId: randomUUID(),
      openedAt,
      firstSeenAt: new Date(own.length === 0 ? openedAt : Math.min(...occurred)),
      lastSeenAt: new Date(own.length === 0 ? openedAt : Math.max(...occurred)),
      lastAlertAt: new Date(own.length === 0 ? openedAt : Math.max(...arrived)),
      accounts: ['111122223333'],
      incidentId: random() < 0.1 ? pick(incidents) : null,
      resources: index % 5 === 0 ? ['bucket-protegido'] : [],
    });
  }
  for (let index = 0; index < loose; index += 1) rows.push(finding(null));
  await prisma.alertCase.createMany({ data: caseRows });
  await prisma.finding.createMany({ data: rows });
  return readWorld(prisma, tenantId);
}

/** O cliente como está no banco. */
export async function readWorld(prisma: PrismaService, tenantId: string): Promise<World> {
  return {
    cases: await prisma.alertCase.findMany({ where: { tenantId } }),
    findings: await prisma.finding.findMany({ where: { tenantId } }),
    incidents: await prisma.incident.findMany({ where: { tenantId } }),
  };
}

type Tally = Record<FindingSeverity, number>;
export const noTally = (): Tally => ({ critical: 0, high: 0, medium: 0, low: 0 });

export const findingsOfCase = (world: World, caseId: string): Finding[] =>
  world.findings.filter((row) => row.caseId === caseId);
export const isPendingFinding = (row: Pick<Finding, 'incidentId' | 'status'>): boolean =>
  row.incidentId === null && (row.status === 'new' || row.status === 'investigating');
export const isSerious = (row: Pick<Finding, 'severity'>): boolean =>
  row.severity === 'critical' || row.severity === 'high';

/** A pior severidade pendente de um caso, alerta por alerta. */
export function worstOf(rows: readonly Finding[]): FindingSeverity | null {
  const pending = rows.filter(isPendingFinding);
  return SEVERITIES.find((severity) => pending.some((row) => row.severity === severity)) ?? null;
}

/** Os casos pendentes por fila, pela pior severidade pendente, e o mais antigo de cada fila. */
export function expectedTowerCases(world: World) {
  const tallies = { detection: noTally(), vulnerability: noTally(), posture: noTally() };
  const oldest: Record<CaseQueueName, string | null> = {
    detection: null,
    vulnerability: null,
    posture: null,
  };
  for (const row of world.cases) {
    const worst = worstOf(findingsOfCase(world, row.id));
    if (worst === null) continue;
    tallies[row.queue][worst] += 1;
    const at = row.openedAt.toISOString();
    const known = oldest[row.queue];
    if (known === null || at < known) oldest[row.queue] = at;
  }
  return { ...tallies, oldestPendingAt: oldest };
}

/** O que falta validar, pelos casos: cada alerta alto ou crítico em "novo" num lugar só. */
export function expectedValidation(world: World) {
  const serious = world.findings.filter((row) => row.status === 'new' && isSerious(row));
  const covered = serious.filter((row) => row.caseId !== null && row.incidentId === null);
  const queueOf = new Map(world.cases.map((row) => [row.id, row.queue]));
  const ids = [...new Set(covered.map((row) => row.caseId as string))];
  const vulnerability = ids.filter((id) => queueOf.get(id) === 'vulnerability').length;
  return {
    total: serious.length,
    cases: ids.length - vulnerability,
    vulnerabilityCases: vulnerability,
    uncovered: serious.length - covered.length,
  };
}

/** Os casos de um período e o tempo até tratar, alerta por alerta. */
export function expectedOutcomes(world: World, from: Date, to: Date) {
  const opened = world.cases.filter(
    (row) => row.openedAt >= from && row.openedAt <= to && findingsOfCase(world, row.id).length > 0,
  );
  const incidentAt = new Map(world.incidents.map((row) => [row.id, row.createdAt.getTime()]));
  const treated = opened.filter((row) => !findingsOfCase(world, row.id).some(isPendingFinding));
  const minutes = treated
    .flatMap((row) => {
      const times = findingsOfCase(world, row.id).flatMap((finding) => {
        if (finding.incidentId === null)
          return finding.triagedAt === null ? [] : [finding.triagedAt.getTime()];
        return [Math.max(incidentAt.get(finding.incidentId) ?? 0, finding.createdAt.getTime())];
      });
      return times.length === 0 ? [] : [Math.max(0, (Math.max(...times) - row.openedAt.getTime()) / MINUTE)];
    })
    .sort((a, b) => a - b);
  const middle = minutes.length / 2;
  const median =
    minutes.length === 0
      ? null
      : minutes.length % 2 === 1
        ? (minutes[Math.floor(middle)] as number)
        : ((minutes[middle - 1] as number) + (minutes[middle] as number)) / 2;
  return {
    opened: opened.length,
    treated: treated.length,
    pending: opened.length - treated.length,
    medianMinutesToTreat: median,
  };
}

/** Os casos com alerta de uma tática num período. */
export function expectedTacticCases(world: World, tactic: string, from: Date, to: Date): number {
  return new Set(
    world.findings
      .filter(
        (row) =>
          row.caseId !== null &&
          row.occurredAt >= from &&
          row.occurredAt <= to &&
          row.mitreTactics.includes(tactic),
      )
      .map((row) => row.caseId),
  ).size;
}
