import type { FindingDraft, FindingSeverity } from '../alerts/finding-draft.js';

/**
 * Agrupamento de achados em incidentes (T5.6, regra v1): achados do mesmo cliente que compartilham usuário, chave
 * de acesso, IP ou recurso, dentro de uma janela de tempo, viram um incidente.
 *
 * - Um achado entra num incidente aberto do **mesmo cliente** que tenha uma chave em comum e cujo período, alargado
 *   pela janela, contenha o horário do achado. Incidente de outro cliente nunca é candidato, nem com o mesmo IP.
 * - Sem incidente para entrar, um achado médio ou mais grave abre um incidente; um achado baixo fica só como achado
 *   (entra num incidente se um dia houver um com chave em comum). Achado sem nenhuma chave nunca abre incidente.
 */

export type CorrelationKind = 'user' | 'key' | 'ip' | 'resource';
export type CorrelationKey = `${CorrelationKind}:${string}`;

export const DEFAULT_GROUPING_WINDOW_MINUTES = 60;
export const OPENING_SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium'];

const SEVERITY_ORDER: readonly FindingSeverity[] = ['low', 'medium', 'high', 'critical'];

type CorrelatedFields = Pick<FindingDraft, 'actorUser' | 'accessKeyId' | 'sourceIp' | 'resource'>;

export function correlationKeys(finding: CorrelatedFields): CorrelationKey[] {
  const keys: CorrelationKey[] = [];
  if (finding.actorUser !== null) keys.push(`user:${finding.actorUser}`);
  if (finding.accessKeyId !== null) keys.push(`key:${finding.accessKeyId}`);
  if (finding.sourceIp !== null) keys.push(`ip:${finding.sourceIp}`);
  if (finding.resource !== null) keys.push(`resource:${finding.resource}`);
  return keys;
}

export interface IncidentCandidate {
  id: string;
  tenantId: string;
  keys: readonly CorrelationKey[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export type IncidentPlan = { action: 'join'; incidentId: string } | { action: 'open' } | { action: 'none' };

export function planIncident(
  finding: Pick<FindingDraft, 'tenantId' | 'occurredAt' | 'severity'> & CorrelatedFields,
  openIncidents: readonly IncidentCandidate[],
  windowMinutes = DEFAULT_GROUPING_WINDOW_MINUTES,
): IncidentPlan {
  const at = Date.parse(finding.occurredAt);
  const window = windowMinutes * 60 * 1000;
  const keys = new Set<string>(correlationKeys(finding));
  const matches = openIncidents
    .filter(
      (incident) =>
        incident.tenantId === finding.tenantId &&
        incident.keys.some((key) => keys.has(key)) &&
        at >= Date.parse(incident.firstSeenAt) - window &&
        at <= Date.parse(incident.lastSeenAt) + window,
    )
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.id.localeCompare(b.id));

  const [best] = matches;
  if (best !== undefined) return { action: 'join', incidentId: best.id };
  // Sem usuário, chave, IP nem recurso, não há o que agrupar: o achado fica sozinho, e um incidente sem chave nem
  // caberia no contrato.
  if (keys.size === 0) return { action: 'none' };
  return OPENING_SEVERITIES.includes(finding.severity) ? { action: 'open' } : { action: 'none' };
}

/** Root da conta ou identidade com "admin" no nome (usuário, papel ou sessão). Heurística da regra v1. */
export function isPrivilegedIdentity(finding: Pick<FindingDraft, 'actorUser' | 'actorType'>): boolean {
  if (finding.actorType === 'Root') return true;
  const user = finding.actorUser ?? '';
  return user.endsWith(':root') || /(^|[^a-z])admin/i.test(user);
}

const BASE_SCORE: Readonly<Record<FindingSeverity, number>> = { critical: 70, high: 50, medium: 30, low: 10 };

/**
 * Nota de risco de 0 a 100: base pela severidade mais alta (crítica 70, alta 50, média 30, baixa 10), +15 se
 * envolver item da lista de proteção do cliente, +10 se envolver identidade root ou admin e +3 por achado além do
 * primeiro, até +15.
 */
export function incidentRiskScore(input: {
  severities: readonly FindingSeverity[];
  touchesProtected: boolean;
  privilegedIdentity: boolean;
}): number {
  if (input.severities.length === 0) return 0;
  const volume = Math.min(15, (input.severities.length - 1) * 3);
  const score =
    BASE_SCORE[highestSeverity(input.severities)] +
    (input.touchesProtected ? 15 : 0) +
    (input.privilegedIdentity ? 10 : 0) +
    volume;
  return Math.min(100, score);
}

export function highestSeverity(severities: readonly FindingSeverity[]): FindingSeverity {
  return severities.reduce<FindingSeverity>(
    (highest, severity) =>
      SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(highest) ? severity : highest,
    'low',
  );
}

export type IncidentFinding = Pick<
  FindingDraft,
  | 'tenantId'
  | 'occurredAt'
  | 'severity'
  | 'actorUser'
  | 'actorType'
  | 'accessKeyId'
  | 'sourceIp'
  | 'resource'
  | 'accountId'
  | 'mitreTactics'
  | 'mitreTechniques'
>;

export interface IncidentSummary {
  severity: FindingSeverity;
  riskScore: number;
  findingCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  keys: CorrelationKey[];
  accounts: string[];
  resources: string[];
  mitreTactics: string[];
  mitreTechniques: string[];
}

const sortedUnique = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/**
 * Resumo de um incidente a partir dos achados dele. `protectedItems` é a lista de proteção do cliente, no mesmo
 * formato dos campos do achado (recursos `tipo:id`, ARNs de identidade e chaves de acesso).
 */
export function summarizeIncident(
  findings: readonly IncidentFinding[],
  protectedItems: ReadonlySet<string> = new Set(),
): IncidentSummary {
  if (findings.length === 0) throw new RangeError('incidente sem achados');
  // Um incidente nunca mistura clientes: se acontecer, é erro de quem montou a lista, não algo a resumir.
  if (new Set(findings.map((finding) => finding.tenantId)).size > 1) {
    throw new RangeError('achados de clientes diferentes no mesmo incidente');
  }
  const times = findings.map((finding) => finding.occurredAt).sort();
  const severities = findings.map((finding) => finding.severity);
  const touchesProtected = findings.some((finding) =>
    [finding.resource, finding.actorUser, finding.accessKeyId].some(
      (item) => item !== null && protectedItems.has(item),
    ),
  );
  return {
    severity: highestSeverity(severities),
    riskScore: incidentRiskScore({
      severities,
      touchesProtected,
      privilegedIdentity: findings.some(isPrivilegedIdentity),
    }),
    findingCount: findings.length,
    firstSeenAt: times[0] ?? '',
    lastSeenAt: times[times.length - 1] ?? '',
    keys: sortedUnique(findings.flatMap(correlationKeys)),
    accounts: sortedUnique(findings.map((finding) => finding.accountId)),
    resources: sortedUnique(
      findings.flatMap((finding) => (finding.resource === null ? [] : [finding.resource])),
    ),
    mitreTactics: sortedUnique(findings.flatMap((finding) => finding.mitreTactics)),
    mitreTechniques: sortedUnique(findings.flatMap((finding) => finding.mitreTechniques)),
  };
}
