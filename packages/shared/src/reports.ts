import { z } from 'zod';
import { ALERT_EXCEPTION_FIELDS } from './alert-exceptions.js';
import { CLOUD_PROVIDERS, cloudAccountRefSchema } from './cloud-accounts.js';
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  type FindingSeverity,
  type FindingStatus,
} from './findings.js';
import { HISTORY_PERIOD_DAYS, type HistoryPeriod, historyPeriodStart } from './history.js';
import { INCIDENT_STATUSES, type IncidentStatus } from './incidents.js';
import { authorSchema, type Author } from './protected-resources.js';

/**
 * Relatórios para especialistas (menu Relatórios) e o resumo MITRE ATT&CK da Torre. Os números saem de funções
 * puras deste arquivo, que a API e o modo de demonstração usam igual: o mesmo achado conta do mesmo jeito nos dois.
 */

/** As 14 táticas do MITRE ATT&CK (Enterprise), na ordem da cadeia de ataque. O nome é o que vem nos alertas. */
export const MITRE_TACTICS = [
  { id: 'TA0043', name: 'Reconnaissance' },
  { id: 'TA0042', name: 'Resource Development' },
  { id: 'TA0001', name: 'Initial Access' },
  { id: 'TA0002', name: 'Execution' },
  { id: 'TA0003', name: 'Persistence' },
  { id: 'TA0004', name: 'Privilege Escalation' },
  { id: 'TA0005', name: 'Defense Evasion' },
  { id: 'TA0006', name: 'Credential Access' },
  { id: 'TA0007', name: 'Discovery' },
  { id: 'TA0008', name: 'Lateral Movement' },
  { id: 'TA0009', name: 'Collection' },
  { id: 'TA0011', name: 'Command and Control' },
  { id: 'TA0010', name: 'Exfiltration' },
  { id: 'TA0040', name: 'Impact' },
] as const;

/** Períodos dos relatórios. A API recusa o mais longo que o histórico do plano do nó (PR-20): `12m` só com 365 dias. */
export const REPORT_PERIODS = ['7d', '30d', '90d', '12m'] as const satisfies readonly HistoryPeriod[];
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export const REPORT_PERIOD_DAYS: Readonly<Record<ReportPeriod, number>> = {
  '7d': HISTORY_PERIOD_DAYS['7d'],
  '30d': HISTORY_PERIOD_DAYS['30d'],
  '90d': HISTORY_PERIOD_DAYS['90d'],
  '12m': HISTORY_PERIOD_DAYS['12m'],
};

export const REPORT_KINDS = [
  'summary',
  'mitre',
  'rules',
  'entities',
  'incidents',
  'coverage',
  'exceptions',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const reportQuerySchema = z.strictObject({ period: z.enum(REPORT_PERIODS).default('30d') });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

const count = z.number().int().min(0);
const minutes = z.number().min(0).nullable();
const severityCounts = z.strictObject({ critical: count, high: count, medium: count, low: count });
const window = { period: z.enum(REPORT_PERIODS), from: z.iso.datetime(), to: z.iso.datetime() };

export const mitreTacticSchema = z.strictObject({
  id: z.string().regex(/^TA\d{4}$/),
  name: z.string().max(100),
  findings: count,
  incidents: count,
  /**
   * Técnicas vistas nos achados desta tática, da mais frequente para a menos (até 10). O id tem o mesmo limite da
   * leitura do alerta (32): um id fora do padrão não derruba a Torre.
   */
  techniques: z.array(z.strictObject({ id: z.string().max(32), findings: count })).max(10),
});
export type MitreTactic = z.infer<typeof mitreTacticSchema>;

export const summaryReportSchema = z.strictObject({
  ...window,
  findings: z.strictObject({
    total: count,
    bySeverity: severityCounts,
    byStatus: z.strictObject({ new: count, investigating: count, legitimate: count, resolved: count }),
    bySource: z.array(z.strictObject({ source: z.string().max(32), count })).max(20),
  }),
  incidents: z.strictObject({ opened: count, resolved: count, open: count, bySeverity: severityCounts }),
  /** Tempo médio do achado até a primeira triagem e do incidente até a resolução, em minutos. */
  meanTimeToTriageMinutes: minutes,
  meanTimeToResolveMinutes: minutes,
  /**
   * Achados por dia (UTC) e severidade, do mais antigo ao mais recente: todo dia que o período toca, com as duas
   * pontas, então 90 dias têm 91 linhas, e 12 meses, 366.
   */
  daily: z
    .array(z.strictObject({ date: z.iso.date(), ...severityCounts.shape }))
    .max(REPORT_PERIOD_DAYS['12m'] + 1),
});
export type SummaryReport = z.infer<typeof summaryReportSchema>;

export const mitreReportSchema = z.strictObject({
  ...window,
  tactics: z.array(mitreTacticSchema).length(MITRE_TACTICS.length),
});
export type MitreReport = z.infer<typeof mitreReportSchema>;

export const rulesReportSchema = z.strictObject({
  ...window,
  items: z
    .array(
      z.strictObject({
        ruleId: z.string().max(6),
        title: z.string().max(500),
        severity: z.enum(FINDING_SEVERITIES),
        findings: count,
        accounts: count,
        lastSeenAt: z.iso.datetime(),
      }),
    )
    .max(100),
});
export type RulesReport = z.infer<typeof rulesReportSchema>;

const entityList = z
  .array(z.strictObject({ value: z.string().max(2048), findings: count, incidents: count }))
  .max(20);
export const entitiesReportSchema = z.strictObject({
  ...window,
  users: entityList,
  ips: entityList,
  keys: entityList,
  resources: entityList,
});
export type EntitiesReport = z.infer<typeof entitiesReportSchema>;

export const incidentsReportSchema = z.strictObject({
  ...window,
  bySeverity: z
    .array(
      z.strictObject({
        severity: z.enum(FINDING_SEVERITIES),
        opened: count,
        resolved: count,
        meanTimeToResolveMinutes: minutes,
      }),
    )
    .length(FINDING_SEVERITIES.length),
  byAssignee: z
    .array(z.strictObject({ assignee: authorSchema.nullable(), open: count, resolved: count }))
    .max(100),
  /** Incidentes abertos no período, da maior nota para a menor (até 200). */
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        severity: z.enum(FINDING_SEVERITIES),
        status: z.enum(INCIDENT_STATUSES),
        riskScore: z.number().int().min(0).max(100),
        firstSeenAt: z.iso.datetime(),
        resolvedAt: z.iso.datetime().nullable(),
        assignee: authorSchema.nullable(),
      }),
    )
    .max(200),
});
export type IncidentsReport = z.infer<typeof incidentsReportSchema>;

export const coverageReportSchema = z.strictObject({
  ...window,
  accounts: z
    .array(
      z.strictObject({
        provider: z.enum(CLOUD_PROVIDERS),
        accountId: cloudAccountRefSchema,
        active: z.boolean(),
        lastEventAt: z.iso.datetime().nullable(),
        findings: count,
        bySource: z.array(z.strictObject({ source: z.string().max(32), count })).max(20),
      }),
    )
    .max(200),
});
export type CoverageReport = z.infer<typeof coverageReportSchema>;

export const exceptionsReportSchema = z.strictObject({
  ...window,
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        ruleId: z.string().max(6),
        field: z.enum(ALERT_EXCEPTION_FIELDS),
        value: z.string().max(256),
        reason: z.string().max(500),
        active: z.boolean(),
        expiresAt: z.iso.datetime().nullable(),
        /** Achados do período marcados como esperados por esta exceção. */
        matchedInPeriod: count,
        matchedTotal: count,
        lastMatchedAt: z.iso.datetime().nullable(),
      }),
    )
    .max(500),
});
export type ExceptionsReport = z.infer<typeof exceptionsReportSchema>;

export const reportSchemas = {
  summary: summaryReportSchema,
  mitre: mitreReportSchema,
  rules: rulesReportSchema,
  entities: entitiesReportSchema,
  incidents: incidentsReportSchema,
  coverage: coverageReportSchema,
  exceptions: exceptionsReportSchema,
} as const satisfies Record<ReportKind, z.ZodType>;

// ---------------------------------------------------------------------------------------------------------------
// Cálculo. Entradas mínimas, que a API lê do banco e o modo de demonstração monta das fixtures.

export interface ReportFinding {
  occurredAt: string;
  /** Quando o achado foi gravado (o tempo até a triagem conta daqui). */
  createdAt: string;
  triagedAt: string | null;
  severity: FindingSeverity;
  status: FindingStatus;
  source: string;
  ruleId: string;
  title: string;
  accountId: string;
  actorUser: string | null;
  accessKeyId: string | null;
  sourceIp: string | null;
  resource: string | null;
  mitreTactics: readonly string[];
  mitreTechniques: readonly string[];
  incidentId: string | null;
  exceptionId: string | null;
}

export interface ReportIncident {
  id: string;
  severity: FindingSeverity;
  status: IncidentStatus;
  riskScore: number;
  firstSeenAt: string;
  createdAt: string;
  resolvedAt: string | null;
  assignee: Author | null;
  mitreTactics: readonly string[];
}

export interface ReportWindow {
  period: ReportPeriod;
  from: string;
  to: string;
}

export function reportWindow(period: ReportPeriod, now: Date): ReportWindow {
  return { period, from: historyPeriodStart(period, now).toISOString(), to: now.toISOString() };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const inWindow = (at: string, window: ReportWindow) => at >= window.from && at <= window.to;
const zeroSeverities = () => ({ critical: 0, high: 0, medium: 0, low: 0 });
const mean = (values: readonly number[]) =>
  values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
const minutesBetween = (start: string, end: string) =>
  Math.max(0, (Date.parse(end) - Date.parse(start)) / 60_000);
const increment = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { critical: 3, high: 2, medium: 1, low: 0 };

/** Ranking de valores por contagem (desc), com o valor como desempate, até `limit`. */
function topCounts<T>(entries: Iterable<[string, T]>, score: (value: T) => number, limit: number) {
  return [...entries].sort((a, b) => score(b[1]) - score(a[1]) || a[0].localeCompare(b[0])).slice(0, limit);
}

/**
 * Um relatório calculado achado por achado. A API passa os achados do período em lotes, sem teto e sem guardar todos
 * na memória; o modo de demonstração e os testes passam a lista inteira pelas funções `*Report`. Cada `add` ignora o
 * que está fora do período.
 */
export interface FindingsFold<R, F = ReportFinding> {
  add(finding: F): void;
  result(): R;
}

export function foldFindings<R, F>(fold: FindingsFold<R, F>, findings: Iterable<F>): R {
  for (const finding of findings) fold.add(finding);
  return fold.result();
}

export type MitreFinding = Pick<ReportFinding, 'mitreTactics' | 'mitreTechniques'>;

/** Táticas e técnicas do MITRE ATT&CK nos achados e incidentes dados, sem olhar o período. */
export function mitreTacticsFold(
  incidents: readonly Pick<ReportIncident, 'mitreTactics'>[],
): FindingsFold<MitreTactic[], MitreFinding> {
  const tallies = MITRE_TACTICS.map(({ id, name }) => ({
    id,
    name,
    findings: 0,
    techniques: new Map<string, number>(),
  }));
  const byName = new Map<string, (typeof tallies)[number]>(tallies.map((tally) => [tally.name, tally]));
  return {
    add(finding) {
      for (const name of new Set(finding.mitreTactics)) {
        const tally = byName.get(name);
        if (!tally) continue;
        tally.findings += 1;
        for (const technique of new Set(finding.mitreTechniques)) increment(tally.techniques, technique);
      }
    },
    result: () =>
      tallies.map(({ id, name, findings, techniques }) => ({
        id,
        name,
        findings,
        incidents: incidents.filter((incident) => incident.mitreTactics.includes(name)).length,
        techniques: topCounts(techniques, (value) => value, 10).map(([technique, total]) => ({
          id: technique,
          findings: total,
        })),
      })),
  };
}

/** Táticas e técnicas do MITRE ATT&CK nos achados e incidentes dados (a Torre e o relatório usam). */
export function mitreTactics(
  findings: Iterable<MitreFinding>,
  incidents: readonly Pick<ReportIncident, 'mitreTactics'>[],
): MitreTactic[] {
  return foldFindings(mitreTacticsFold(incidents), findings);
}

/** Todo dia de calendário (UTC) que o período toca, com as duas pontas: um período de 90 dias toca 91 datas. */
function dailyBuckets(window: ReportWindow) {
  const daily = new Map<string, ReturnType<typeof zeroSeverities>>();
  const last = Date.parse(window.to.slice(0, 10));
  for (let day = Date.parse(window.from.slice(0, 10)); day <= last; day += DAY_MS) {
    daily.set(new Date(day).toISOString().slice(0, 10), zeroSeverities());
  }
  return daily;
}

/**
 * Resumo do período. Contam os achados e incidentes começados nele; os incidentes vêm todos os que importam (os
 * começados, os resolvidos no período e os ainda abertos).
 */
export function summaryFold(
  allIncidents: readonly ReportIncident[],
  window: ReportWindow,
): FindingsFold<SummaryReport> {
  let total = 0;
  const bySeverity = zeroSeverities();
  const byStatus = Object.fromEntries(FINDING_STATUSES.map((status) => [status, 0])) as Record<
    FindingStatus,
    number
  >;
  const bySource = new Map<string, number>();
  const daily = dailyBuckets(window);
  const triage = { minutes: 0, count: 0 };
  return {
    add(finding) {
      if (!inWindow(finding.occurredAt, window)) return;
      total += 1;
      bySeverity[finding.severity] += 1;
      byStatus[finding.status] += 1;
      increment(bySource, finding.source);
      const bucket = daily.get(finding.occurredAt.slice(0, 10));
      if (bucket) bucket[finding.severity] += 1;
      if (finding.triagedAt !== null) {
        triage.minutes += minutesBetween(finding.createdAt, finding.triagedAt);
        triage.count += 1;
      }
    },
    result() {
      const incidents = allIncidents.filter((incident) => inWindow(incident.firstSeenAt, window));
      const incidentSeverity = zeroSeverities();
      for (const incident of incidents) incidentSeverity[incident.severity] += 1;
      const resolvedInWindow = allIncidents.filter(
        (incident) => incident.resolvedAt !== null && inWindow(incident.resolvedAt, window),
      );
      return {
        ...window,
        findings: {
          total,
          bySeverity: { ...bySeverity },
          byStatus: { ...byStatus },
          bySource: topCounts(bySource, (value) => value, 20).map(([source, count]) => ({ source, count })),
        },
        incidents: {
          opened: incidents.length,
          resolved: resolvedInWindow.length,
          open: allIncidents.filter((incident) => incident.status !== 'resolved').length,
          bySeverity: incidentSeverity,
        },
        meanTimeToTriageMinutes: triage.count === 0 ? null : Math.round(triage.minutes / triage.count),
        meanTimeToResolveMinutes: mean(
          resolvedInWindow.map((incident) =>
            minutesBetween(incident.createdAt, incident.resolvedAt as string),
          ),
        ),
        daily: [...daily].map(([date, counts]) => ({ date, ...counts })),
      };
    },
  };
}

export function summaryReport(
  findings: Iterable<ReportFinding>,
  incidents: readonly ReportIncident[],
  window: ReportWindow,
): SummaryReport {
  return foldFindings(summaryFold(incidents, window), findings);
}

/** MITRE ATT&CK do período: achados e incidentes começados nele. */
export function mitreFold(
  incidents: readonly ReportIncident[],
  window: ReportWindow,
): FindingsFold<MitreReport, MitreFinding & Pick<ReportFinding, 'occurredAt'>> {
  const tactics = mitreTacticsFold(incidents.filter((incident) => inWindow(incident.firstSeenAt, window)));
  return {
    add(finding) {
      if (inWindow(finding.occurredAt, window)) tactics.add(finding);
    },
    result: () => ({ ...window, tactics: tactics.result() }),
  };
}

export function mitreReport(
  findings: Iterable<ReportFinding>,
  incidents: readonly ReportIncident[],
  window: ReportWindow,
): MitreReport {
  return foldFindings(mitreFold(incidents, window), findings);
}

export function rulesFold(window: ReportWindow): FindingsFold<RulesReport> {
  const rules = new Map<
    string,
    { title: string; severity: FindingSeverity; findings: number; accounts: Set<string>; lastSeenAt: string }
  >();
  return {
    add(finding) {
      if (!inWindow(finding.occurredAt, window)) return;
      const rule = rules.get(finding.ruleId) ?? {
        title: finding.title,
        severity: finding.severity,
        findings: 0,
        accounts: new Set<string>(),
        lastSeenAt: finding.occurredAt,
      };
      rule.findings += 1;
      rule.accounts.add(finding.accountId);
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[rule.severity]) rule.severity = finding.severity;
      if (finding.occurredAt > rule.lastSeenAt) rule.lastSeenAt = finding.occurredAt;
      rules.set(finding.ruleId, rule);
    },
    result: () => ({
      ...window,
      items: topCounts(rules, (rule) => rule.findings, 100).map(([ruleId, rule]) => ({
        ruleId,
        title: rule.title.slice(0, 500),
        severity: rule.severity,
        findings: rule.findings,
        accounts: rule.accounts.size,
        lastSeenAt: rule.lastSeenAt,
      })),
    }),
  };
}

export function rulesReport(findings: Iterable<ReportFinding>, window: ReportWindow): RulesReport {
  return foldFindings(rulesFold(window), findings);
}

type EntityTally = Map<string, { findings: number; incidents: Set<string> }>;

/** Cada lista do relatório de entidades e o campo do achado de onde ela sai. */
const ENTITY_FIELDS = [
  ['users', 'actorUser'],
  ['ips', 'sourceIp'],
  ['keys', 'accessKeyId'],
  ['resources', 'resource'],
] as const;

function rankEntities(entities: EntityTally) {
  return topCounts(entities, (entity) => entity.findings, 20).map(([value, entity]) => ({
    value: value.slice(0, 2048),
    findings: entity.findings,
    incidents: entity.incidents.size,
  }));
}

export function entitiesFold(window: ReportWindow): FindingsFold<EntitiesReport> {
  const tally = (): EntityTally => new Map();
  const tallies = { users: tally(), ips: tally(), keys: tally(), resources: tally() };
  return {
    add(finding) {
      if (!inWindow(finding.occurredAt, window)) return;
      for (const [list, field] of ENTITY_FIELDS) {
        const value = finding[field];
        if (value === null) continue;
        const entity = tallies[list].get(value) ?? { findings: 0, incidents: new Set<string>() };
        entity.findings += 1;
        if (finding.incidentId) entity.incidents.add(finding.incidentId);
        tallies[list].set(value, entity);
      }
    },
    result: () => ({
      ...window,
      users: rankEntities(tallies.users),
      ips: rankEntities(tallies.ips),
      keys: rankEntities(tallies.keys),
      resources: rankEntities(tallies.resources),
    }),
  };
}

export function entitiesReport(findings: Iterable<ReportFinding>, window: ReportWindow): EntitiesReport {
  return foldFindings(entitiesFold(window), findings);
}

export function incidentsReport(
  allIncidents: readonly ReportIncident[],
  window: ReportWindow,
): IncidentsReport {
  const opened = allIncidents.filter((incident) => inWindow(incident.firstSeenAt, window));
  const resolved = allIncidents.filter(
    (incident) => incident.resolvedAt !== null && inWindow(incident.resolvedAt, window),
  );
  const assignees = new Map<string, { assignee: Author | null; open: number; resolved: number }>();
  for (const incident of allIncidents) {
    const key = incident.assignee?.id ?? '';
    const row = assignees.get(key) ?? { assignee: incident.assignee, open: 0, resolved: 0 };
    if (incident.status !== 'resolved') row.open += 1;
    else if (incident.resolvedAt !== null && inWindow(incident.resolvedAt, window)) row.resolved += 1;
    assignees.set(key, row);
  }
  return {
    ...window,
    bySeverity: FINDING_SEVERITIES.map((severity) => {
      const done = resolved.filter((incident) => incident.severity === severity);
      return {
        severity,
        opened: opened.filter((incident) => incident.severity === severity).length,
        resolved: done.length,
        meanTimeToResolveMinutes: mean(
          done.map((incident) => minutesBetween(incident.createdAt, incident.resolvedAt as string)),
        ),
      };
    }),
    byAssignee: [...assignees.values()]
      .filter((row) => row.open + row.resolved > 0)
      .sort(
        (a, b) =>
          b.open + b.resolved - (a.open + a.resolved) ||
          (a.assignee?.name ?? '').localeCompare(b.assignee?.name ?? ''),
      )
      .slice(0, 100),
    items: [...opened]
      .sort((a, b) => b.riskScore - a.riskScore || b.firstSeenAt.localeCompare(a.firstSeenAt))
      .slice(0, 200)
      .map((incident) => ({
        id: incident.id,
        severity: incident.severity,
        status: incident.status,
        riskScore: incident.riskScore,
        firstSeenAt: incident.firstSeenAt,
        resolvedAt: incident.resolvedAt,
        assignee: incident.assignee,
      })),
  };
}

export interface ReportAccount {
  provider: (typeof CLOUD_PROVIDERS)[number];
  accountId: string;
  active: boolean;
  lastEventAt: string | null;
}

export function coverageFold(
  allAccounts: readonly ReportAccount[],
  window: ReportWindow,
): FindingsFold<CoverageReport> {
  const accounts = allAccounts.slice(0, 200);
  const tallies = new Map(
    accounts.map((account) => [account.accountId, { findings: 0, bySource: new Map<string, number>() }]),
  );
  return {
    add(finding) {
      if (!inWindow(finding.occurredAt, window)) return;
      const tally = tallies.get(finding.accountId);
      if (!tally) return;
      tally.findings += 1;
      increment(tally.bySource, finding.source);
    },
    result: () => ({
      ...window,
      accounts: accounts.map((account) => {
        const tally = tallies.get(account.accountId);
        return {
          ...account,
          findings: tally?.findings ?? 0,
          bySource: topCounts(tally?.bySource ?? [], (value) => value, 20).map(([source, count]) => ({
            source,
            count,
          })),
        };
      }),
    }),
  };
}

export function coverageReport(
  accounts: readonly ReportAccount[],
  findings: Iterable<ReportFinding>,
  window: ReportWindow,
): CoverageReport {
  return foldFindings(coverageFold(accounts, window), findings);
}

export interface ReportException {
  id: string;
  ruleId: string;
  field: (typeof ALERT_EXCEPTION_FIELDS)[number];
  value: string;
  reason: string;
  expiresAt: string | null;
  matchedCount: number;
  lastMatchedAt: string | null;
}

export function exceptionsFold(
  exceptions: readonly ReportException[],
  window: ReportWindow,
): FindingsFold<ExceptionsReport> {
  const matched = new Map<string, number>();
  return {
    add(finding) {
      if (finding.exceptionId !== null && inWindow(finding.occurredAt, window)) {
        increment(matched, finding.exceptionId);
      }
    },
    result: () => ({
      ...window,
      items: exceptions
        .map((exception) => ({
          id: exception.id,
          ruleId: exception.ruleId,
          field: exception.field,
          value: exception.value,
          reason: exception.reason,
          active: exception.expiresAt === null || exception.expiresAt > window.to,
          expiresAt: exception.expiresAt,
          matchedInPeriod: matched.get(exception.id) ?? 0,
          matchedTotal: exception.matchedCount,
          lastMatchedAt: exception.lastMatchedAt,
        }))
        .sort((a, b) => b.matchedInPeriod - a.matchedInPeriod || a.ruleId.localeCompare(b.ruleId))
        .slice(0, 500),
    }),
  };
}

export function exceptionsReport(
  exceptions: readonly ReportException[],
  findings: Iterable<ReportFinding>,
  window: ReportWindow,
): ExceptionsReport {
  return foldFindings(exceptionsFold(exceptions, window), findings);
}
