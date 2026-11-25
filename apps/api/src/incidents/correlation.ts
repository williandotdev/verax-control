import type { FindingDraft, FindingSeverity } from '../alerts/finding-draft.js';

/**
 * Correlação de alertas (achados) e resumo de incidentes (T5.6, regra v1). Desde a decisão de 17/11/2026 (alerta →
 * validação → incidente), a correlação só **sugere**: alertas do mesmo cliente que compartilham usuário, chave de
 * acesso, IP ou recurso, dentro de uma janela de tempo, aparecem como relacionados, e o painel os pré-seleciona quando
 * uma pessoa promove um alerta a incidente. Nenhum incidente é aberto ou alimentado sem uma pessoa.
 *
 * - Só alertas do **mesmo cliente** são candidatos, nem com o mesmo IP um de outro cliente entra.
 * - Alerta sem nenhuma chave não tem relacionado.
 */

export type CorrelationKind = 'user' | 'key' | 'ip' | 'resource';
export type CorrelationKey = `${CorrelationKind}:${string}`;

export const DEFAULT_GROUPING_WINDOW_MINUTES = 60;

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

/** Um alerta candidato a relacionado: o id, o cliente, o horário e os campos que viram chave. */
export type RelatedCandidate = { id: string } & Pick<FindingDraft, 'tenantId' | 'occurredAt'> &
  CorrelatedFields;

/**
 * Os alertas relacionados a `anchor` (a sugestão ao promover): do mesmo cliente, outro que não ele, com uma chave em
 * comum e o horário a até `windowMinutes` dele, para os dois lados. Os mais recentes primeiro; empate pelo id.
 */
export function relatedFindings<T extends RelatedCandidate>(
  anchor: RelatedCandidate,
  candidates: readonly T[],
  windowMinutes = DEFAULT_GROUPING_WINDOW_MINUTES,
): T[] {
  const keys = new Set<string>(correlationKeys(anchor));
  if (keys.size === 0) return [];
  const at = Date.parse(anchor.occurredAt);
  const window = windowMinutes * 60 * 1000;
  return candidates
    .filter((candidate) => {
      const when = Date.parse(candidate.occurredAt);
      return (
        candidate.id !== anchor.id &&
        candidate.tenantId === anchor.tenantId &&
        Math.abs(when - at) <= window &&
        correlationKeys(candidate).some((key) => keys.has(key))
      );
    })
    .sort(
      (a, b) =>
        Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** Root da conta ou identidade com "admin" no nome (usuário, papel ou sessão). Heurística da regra v1. */
export function isPrivilegedIdentity(finding: Pick<FindingDraft, 'actorUser' | 'actorType'>): boolean {
  if (finding.actorType === 'Root') return true;
  const user = finding.actorUser ?? '';
  return user.endsWith(':root') || /(^|[^a-z])admin/i.test(user);
}

const BASE_SCORE: Readonly<Record<FindingSeverity, number>> = { critical: 70, high: 50, medium: 30, low: 10 };
const PROTECTED_SCORE = 15;
const PRIVILEGED_SCORE = 10;
const volumeScore = (count: number): number => Math.min(15, (count - 1) * 3);

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
  const score =
    BASE_SCORE[highestSeverity(input.severities)] +
    (input.touchesProtected ? PROTECTED_SCORE : 0) +
    (input.privilegedIdentity ? PRIVILEGED_SCORE : 0) +
    volumeScore(input.severities.length);
  return Math.min(100, score);
}

/**
 * O caminho de volta: o que uma nota diz do item protegido e da identidade privilegiada. Null se ela não diz: a nota no
 * teto (nem precisa: com mais alertas, continua nele) ou a que não é desta conta.
 */
export function riskFlags(
  score: number,
  severity: FindingSeverity,
  count: number,
): { touchesProtected: boolean; privilegedIdentity: boolean } | null {
  const rest = score - BASE_SCORE[severity] - volumeScore(count);
  if (
    score >= 100 ||
    ![0, PRIVILEGED_SCORE, PROTECTED_SCORE, PRIVILEGED_SCORE + PROTECTED_SCORE].includes(rest)
  ) {
    return null;
  }
  return {
    touchesProtected: rest >= PROTECTED_SCORE,
    privilegedIdentity: rest === PRIVILEGED_SCORE || rest > PROTECTED_SCORE,
  };
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

/**
 * Byte a byte em UTF-8, a ordem do banco com `COLLATE "C"`: o resumo feito no banco (`incident-summary-store.ts`) corta
 * as mesmas chaves que este. Só difere do `sort()` padrão em textos com caracteres fora do plano básico.
 */
const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const sortedUnique = <T extends string>(values: Iterable<T>): T[] =>
  [...new Set(values)].sort(byBytes);

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
