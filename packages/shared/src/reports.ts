import { z } from 'zod';
import { ALERT_EXCEPTION_FIELDS } from './alert-exceptions.js';
import { CLOUD_PROVIDERS, cloudAccountRefSchema } from './cloud-accounts.js';
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  type FindingSeverity,
  type FindingStatus,
} from './findings.js';
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

export const REPORT_PERIODS = ['7d', '30d', '90d'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export const REPORT_PERIOD_DAYS: Readonly<Record<ReportPeriod, number>> = { '7d': 7, '30d': 30, '90d': 90 };

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
  /** Técnicas vistas nos achados desta tática, da mais frequente para a menos (até 10). */
  techniques: z.array(z.strictObject({ id: z.string().max(20), findings: count })).max(10),
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
  /** Achados por dia e severidade, do mais antigo ao mais recente. */
  daily: z.array(z.strictObject({ date: z.iso.date(), ...severityCounts.shape })).max(90),
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
  const from = new Date(now.getTime() - REPORT_PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
  return { period, from: from.toISOString(), to: now.toISOString() };
}

const inWindow = (at: string, window: ReportWindow) => at >= window.from && at <= window.to;
const zeroSeverities = () => ({ critical: 0, high: 0, medium: 0, low: 0 });
const mean = (values: readonly number[]) =>
  values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
const minutesBetween = (start: string, end: string) =>
  Math.max(0, (Date.parse(end) - Date.parse(start)) / 60_000);
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { critical: 3, high: 2, medium: 1, low: 0 };

/** Ranking de valores por contagem (desc), com o valor como desempate, até `limit`. */
function topCounts<T>(entries: Iterable<[string, T]>, score: (value: T) => number, limit: number) {
  return [...entries].sort((a, b) => score(b[1]) - score(a[1]) || a[0].localeCompare(b[0])).slice(0, limit);
}

/** Táticas e técnicas do MITRE ATT&CK nos achados e incidentes dados (a Torre e o relatório usam). */
export function mitreTactics(
  findings: readonly Pick<ReportFinding, 'mitreTactics' | 'mitreTechniques'>[],
  incidents: readonly Pick<ReportIncident, 'mitreTactics'>[],
): MitreTactic[] {
  return MITRE_TACTICS.map(({ id, name }) => {
    const matched = findings.filter((finding) => finding.mitreTactics.includes(name));
    const techniques = new Map<string, number>();
    for (const finding of matched) {
      for (const technique of new Set(finding.mitreTechniques)) {
        techniques.set(technique, (techniques.get(technique) ?? 0) + 1);
      }
    }
    return {
      id,
      name,
      findings: matched.length,
      incidents: incidents.filter((incident) => incident.mitreTactics.includes(name)).length,
      techniques: topCounts(techniques, (value) => value, 10).map(([technique, total]) => ({
        id: technique,
        findings: total,
      })),
    };
  });
}

/** Achados e incidentes que contam no período: achados e incidentes começados nele. */
function scoped(
  findings: readonly ReportFinding[],
  incidents: readonly ReportIncident[],
  window: ReportWindow,
) {
  return {
    findings: findings.filter((finding) => inWindow(finding.occurredAt, window)),
    incidents: incidents.filter((incident) => inWindow(incident.firstSeenAt, window)),
  };
}

export function summaryReport(
  allFindings: readonly ReportFinding[],
  allIncidents: readonly ReportIncident[],
  window: ReportWindow,
): SummaryReport {
  const { findings, incidents } = scoped(allFindings, allIncidents, window);
  const bySeverity = zeroSeverities();
  const byStatus: Record<FindingStatus, number> = Object.fromEntries(
    FINDING_STATUSES.map((s) => [s, 0]),
  ) as Record<FindingStatus, number>;
  const bySource = new Map<string, number>();
  const daily = new Map<string, ReturnType<typeof zeroSeverities>>();
  for (let day = Date.parse(window.from); day <= Date.parse(window.to); day += 24 * 60 * 60 * 1000) {
    daily.set(new Date(day).toISOString().slice(0, 10), zeroSeverities());
  }
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byStatus[finding.status] += 1;
    bySource.set(finding.source, (bySource.get(finding.source) ?? 0) + 1);
    const bucket = daily.get(finding.occurredAt.slice(0, 10));
    if (bucket) bucket[finding.severity] += 1;
  }
  const incidentSeverity = zeroSeverities();
  for (const incident of incidents) incidentSeverity[incident.severity] += 1;
  const resolvedInWindow = allIncidents.filter(
    (incident) => incident.resolvedAt !== null && inWindow(incident.resolvedAt, window),
  );
  return {
    ...window,
    findings: {
      total: findings.length,
      bySeverity,
      byStatus,
      bySource: topCounts(bySource, (value) => value, 20).map(([source, total]) => ({
        source,
        count: total,
      })),
    },
    incidents: {
      opened: incidents.length,
      resolved: resolvedInWindow.length,
      open: allIncidents.filter((incident) => incident.status !== 'resolved').length,
      bySeverity: incidentSeverity,
    },
    meanTimeToTriageMinutes: mean(
      findings.flatMap((finding) =>
        finding.triagedAt === null ? [] : [minutesBetween(finding.createdAt, finding.triagedAt)],
      ),
    ),
    meanTimeToResolveMinutes: mean(
      resolvedInWindow.map((incident) => minutesBetween(incident.createdAt, incident.resolvedAt as string)),
    ),
    daily: [...daily].map(([date, counts]) => ({ date, ...counts })).slice(-90),
  };
}

export function mitreReport(
  findings: readonly ReportFinding[],
  incidents: readonly ReportIncident[],
  window: ReportWindow,
): MitreReport {
  const inPeriod = scoped(findings, incidents, window);
  return { ...window, tactics: mitreTactics(inPeriod.findings, inPeriod.incidents) };
}

export function rulesReport(allFindings: readonly ReportFinding[], window: ReportWindow): RulesReport {
  const rules = new Map<
    string,
    { title: string; severity: FindingSeverity; findings: number; accounts: Set<string>; lastSeenAt: string }
  >();
  for (const finding of allFindings.filter((item) => inWindow(item.occurredAt, window))) {
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
  }
  return {
    ...window,
    items: topCounts(rules, (rule) => rule.findings, 100).map(([ruleId, rule]) => ({
      ruleId,
      title: rule.title.slice(0, 500),
      severity: rule.severity,
      findings: rule.findings,
      accounts: rule.accounts.size,
      lastSeenAt: rule.lastSeenAt,
    })),
  };
}

export function entitiesReport(allFindings: readonly ReportFinding[], window: ReportWindow): EntitiesReport {
  const findings = allFindings.filter((item) => inWindow(item.occurredAt, window));
  const rank = (pick: (finding: ReportFinding) => string | null) => {
    const entities = new Map<string, { findings: number; incidents: Set<string> }>();
    for (const finding of findings) {
      const value = pick(finding);
      if (value === null) continue;
      const entity = entities.get(value) ?? { findings: 0, incidents: new Set<string>() };
      entity.findings += 1;
      if (finding.incidentId) entity.incidents.add(finding.incidentId);
      entities.set(value, entity);
    }
    return topCounts(entities, (entity) => entity.findings, 20).map(([value, entity]) => ({
      value: value.slice(0, 2048),
      findings: entity.findings,
      incidents: entity.incidents.size,
    }));
  };
  return {
    ...window,
    users: rank((finding) => finding.actorUser),
    ips: rank((finding) => finding.sourceIp),
    keys: rank((finding) => finding.accessKeyId),
    resources: rank((finding) => finding.resource),
  };
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

export function coverageReport(
  accounts: readonly ReportAccount[],
  allFindings: readonly ReportFinding[],
  window: ReportWindow,
): CoverageReport {
  const findings = allFindings.filter((item) => inWindow(item.occurredAt, window));
  return {
    ...window,
    accounts: accounts.slice(0, 200).map((account) => {
      const own = findings.filter((finding) => finding.accountId === account.accountId);
      const bySource = new Map<string, number>();
      for (const finding of own) bySource.set(finding.source, (bySource.get(finding.source) ?? 0) + 1);
      return {
        ...account,
        findings: own.length,
        bySource: topCounts(bySource, (value) => value, 20).map(([source, total]) => ({
          source,
          count: total,
        })),
      };
    }),
  };
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

export function exceptionsReport(
  exceptions: readonly ReportException[],
  allFindings: readonly ReportFinding[],
  window: ReportWindow,
): ExceptionsReport {
  const matched = new Map<string, number>();
  for (const finding of allFindings) {
    if (finding.exceptionId !== null && inWindow(finding.occurredAt, window)) {
      matched.set(finding.exceptionId, (matched.get(finding.exceptionId) ?? 0) + 1);
    }
  }
  return {
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
  };
}
