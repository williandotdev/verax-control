import type { FindingSeverity } from '../alerts/finding-draft.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  type CorrelationKey,
  DEFAULT_GROUPING_WINDOW_MINUTES,
  type IncidentFinding,
  planIncident,
  summarizeIncident,
} from './correlation.js';

/** Os campos do achado que o agrupamento e o resumo do incidente usam. */
const groupingSelect = {
  id: true,
  tenantId: true,
  occurredAt: true,
  severity: true,
  actorUser: true,
  actorType: true,
  accessKeyId: true,
  sourceIp: true,
  resource: true,
  accountId: true,
  mitreTactics: true,
  mitreTechniques: true,
} as const satisfies Prisma.FindingSelect;

type GroupingRow = Prisma.FindingGetPayload<{ select: typeof groupingSelect }>;

function toIncidentFinding(row: GroupingRow): IncidentFinding {
  return { ...row, occurredAt: row.occurredAt.toISOString() };
}

/**
 * Itens da lista de proteção (T3.4) no formato dos campos do achado: o identificador como foi cadastrado e, para
 * bucket, instância e security group, também como `tipo:id` (`s3:`, `ec2:`, `sg:`), que é como o recurso aparece
 * no achado.
 */
export function protectedItemsOf(items: readonly { type: string; identifier: string }[]): Set<string> {
  const set = new Set<string>();
  for (const { type, identifier } of items) {
    set.add(identifier);
    if (type === 's3_bucket') set.add(`s3:${identifier}`);
    if (type === 'ec2_instance') set.add(`ec2:${identifier}`);
    if (type === 'security_group') set.add(`sg:${identifier}`);
  }
  return set;
}

/**
 * Onde o achado ficou: o resultado, o incidente e a severidade dele depois e antes do achado (`previousSeverity` só na
 * junção). É o que decide os avisos por e-mail (`notifications/finding-notices.ts`): abrir alto ou crítico, ou subir
 * para alto ou crítico.
 */
export type IncidentPlacement =
  | { outcome: 'none'; incidentId: null; severity: null; previousSeverity: null }
  | { outcome: 'opened'; incidentId: string; severity: FindingSeverity; previousSeverity: null }
  | { outcome: 'joined'; incidentId: string; severity: FindingSeverity; previousSeverity: FindingSeverity };

const NOT_PLACED: IncidentPlacement = {
  outcome: 'none',
  incidentId: null,
  severity: null,
  previousSeverity: null,
};

/** Cliente do banco já no escopo de um cliente; o sync passa o da transação que grava o achado. */
type ScopedDb = Prisma.TransactionClient;

/**
 * Agrupamento em incidentes (T5.6) gravado no banco, sempre pelo escopo de um cliente: um achado só entra em
 * incidente do próprio cliente (e um gatilho no banco garante o mesmo). A regra está em `correlation.ts`. Roda na
 * mesma transação que grava o achado: se algo falhar no meio, nem o achado fica, e a próxima execução refaz tudo.
 */
export class IncidentGrouping {
  constructor(private readonly windowMinutes = DEFAULT_GROUPING_WINDOW_MINUTES) {}

  /** Põe um achado novo num incidente aberto com chave em comum, abre um novo ou deixa só como achado. */
  async place(
    db: ScopedDb,
    findingId: string,
    protectedItems: ReadonlySet<string>,
  ): Promise<IncidentPlacement> {
    const finding = await db.finding.findUniqueOrThrow({ where: { id: findingId }, select: groupingSelect });
    const windowMs = this.windowMinutes * 60 * 1000;
    const at = finding.occurredAt.getTime();
    const candidates = await db.incident.findMany({
      where: {
        status: { not: 'resolved' },
        firstSeenAt: { lte: new Date(at + windowMs) },
        lastSeenAt: { gte: new Date(at - windowMs) },
      },
      select: { id: true, tenantId: true, keys: true, firstSeenAt: true, lastSeenAt: true, severity: true },
    });
    const plan = planIncident(
      toIncidentFinding(finding),
      candidates.map((incident) => ({
        ...incident,
        keys: incident.keys as CorrelationKey[],
        firstSeenAt: incident.firstSeenAt.toISOString(),
        lastSeenAt: incident.lastSeenAt.toISOString(),
      })),
      this.windowMinutes,
    );

    if (plan.action === 'none') return NOT_PLACED;
    if (plan.action === 'join') {
      const { incidentId } = plan;
      const previousSeverity = candidates.find((candidate) => candidate.id === incidentId)?.severity;
      if (previousSeverity === undefined) throw new Error('incidente da junção fora dos candidatos');
      await db.finding.update({ where: { id: findingId }, data: { incidentId } });
      const findings = await db.finding.findMany({ where: { incidentId }, select: groupingSelect });
      const data = summaryData(findings, protectedItems);
      await db.incident.update({ where: { id: incidentId }, data });
      return { outcome: 'joined', incidentId, severity: data.severity, previousSeverity };
    }
    const data = summaryData([finding], protectedItems);
    const incident = await db.incident.create({
      data: data as Prisma.IncidentUncheckedCreateInput,
      select: { id: true },
    });
    await db.finding.update({ where: { id: findingId }, data: { incidentId: incident.id } });
    return { outcome: 'opened', incidentId: incident.id, severity: data.severity, previousSeverity: null };
  }
}

function summaryData(findings: readonly GroupingRow[], protectedItems: ReadonlySet<string>) {
  const summary = summarizeIncident(findings.map(toIncidentFinding), protectedItems);
  return {
    severity: summary.severity,
    riskScore: summary.riskScore,
    findingCount: summary.findingCount,
    firstSeenAt: new Date(summary.firstSeenAt),
    lastSeenAt: new Date(summary.lastSeenAt),
    // O contrato aceita até 200 chaves e recursos e 50 contas por incidente.
    keys: summary.keys.slice(0, 200),
    accounts: summary.accounts.slice(0, 50),
    resources: summary.resources.slice(0, 200),
    mitreTactics: summary.mitreTactics.slice(0, 20),
    mitreTechniques: summary.mitreTechniques.slice(0, 50),
  };
}
