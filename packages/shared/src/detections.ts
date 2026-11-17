import { z } from 'zod';
import {
  type Finding,
  findingFilterShape,
  type FindingListQuery,
  findingSchema,
  type FindingSeverity,
  type FindingStatus,
} from './findings.js';
import { checkCustomRange, historyPeriodStart } from './history.js';
import { type Incident, incidentSchema, type IncidentStatus } from './incidents.js';
import { paginatedSchema, withPagination } from './pagination.js';

/**
 * Tela Detecções (decisão do responsável de 16/11/2026): uma lista só no lugar da Torre, de Incidentes, de Achados e de
 * Relatórios. Desde 17/11/2026 (alerta → validação → incidente), a tela tem duas visões: "Alertas" (o padrão) é o
 * `GET /v1/findings`, todos os alertas; "Incidentes" é o `GET /v1/detections?kind=incident`. Sem `kind`, o
 * `GET /v1/detections` ainda mistura os incidentes e os alertas fora de incidente, numa ordem só e com paginação na API,
 * com os mesmos filtros. As regras de filtro ficam aqui, em funções puras, para a API e a demonstração filtrarem igual.
 */

/** Ordem da lista: a atividade mais recente primeiro, ou a severidade mais alta primeiro (e a mais recente dentro dela). */
export const DETECTION_SORTS = ['recent', 'severity'] as const;
export type DetectionSort = (typeof DETECTION_SORTS)[number];

/**
 * Filtros da visão agrupada: os mesmos dos achados, mais "sem responsável" (só incidentes têm responsável: com ele, os
 * achados avulsos saem da lista) e a ordem.
 */
export const detectionListQuerySchema = withPagination({
  ...findingFilterShape,
  unassigned: z.enum(['true']).optional(),
  sort: z.enum(DETECTION_SORTS).optional(),
  /** `incident`: só os incidentes (a visão "Incidentes" da tela Detecções); sem ele, incidentes e alertas avulsos. */
  kind: z.enum(['incident']).optional(),
}).superRefine(checkCustomRange);
export type DetectionListQuery = z.infer<typeof detectionListQuerySchema>;

/** Os filtros, sem a paginação nem a ordem. */
export type DetectionFilters = Omit<DetectionListQuery, 'page' | 'pageSize' | 'sort' | 'kind'>;

const count = z.number().int().min(0);

/**
 * Uma linha da visão agrupada: um incidente (com quantos dos achados dele batem com os filtros de conteúdo) ou um
 * achado que não está em nenhum incidente.
 */
export const detectionRowSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('incident'), incident: incidentSchema, matchedFindings: count }),
  z.strictObject({ kind: z.literal('finding'), finding: findingSchema }),
]);
export type DetectionRow = z.infer<typeof detectionRowSchema>;

export const detectionPageSchema = paginatedSchema(detectionRowSchema);
export type DetectionPage = z.infer<typeof detectionPageSchema>;

/**
 * O status do filtro vale para os dois: o achado pelo próprio status, o incidente pelo equivalente (novo é o aberto).
 * "Legítimo" é só de achado: nenhum incidente entra.
 */
export const INCIDENT_STATUS_OF_FILTER: Readonly<Record<FindingStatus, IncidentStatus | null>> = {
  new: 'open',
  investigating: 'investigating',
  legitimate: null,
  resolved: 'resolved',
};

/** A janela de tempo dos filtros: o período (até agora) ou o intervalo personalizado; sem nenhum, todo o histórico. */
export function filterWindow(
  filters: Pick<FindingListQuery, 'period' | 'from' | 'to'>,
  now: Date,
): { from: Date | null; to: Date | null } {
  if (filters.from !== undefined && filters.to !== undefined) {
    return { from: new Date(filters.from), to: new Date(filters.to) };
  }
  return { from: filters.period ? historyPeriodStart(filters.period, now) : null, to: null };
}

/** Os filtros que olham o conteúdo dos achados (no incidente, basta um achado dele bater). */
export function hasContentFilter(filters: DetectionFilters): boolean {
  return (
    filters.accountId !== undefined ||
    filters.source !== undefined ||
    filters.tactic !== undefined ||
    filters.technique !== undefined ||
    filters.q !== undefined
  );
}

/** Os campos do achado que os filtros leem (a técnica só vem no detalhe; a lista da API filtra pelo banco). */
export type FilterableFinding = Pick<
  Finding,
  | 'accountId'
  | 'occurredAt'
  | 'severity'
  | 'status'
  | 'title'
  | 'source'
  | 'eventName'
  | 'resource'
  | 'actor'
  | 'mitreTactics'
> & { mitreTechniques?: readonly string[] };

/** A busca de texto: no título, no evento, no recurso, no usuário, no IP, na chave de acesso e na conta. */
export function findingTextMatches(finding: FilterableFinding, q: string): boolean {
  const needle = q.toLocaleLowerCase('pt-BR');
  return [
    finding.title,
    finding.eventName,
    finding.resource,
    finding.actor.user,
    finding.actor.ip,
    finding.actor.accessKeyId,
    finding.accountId,
  ].some((value) => value?.toLocaleLowerCase('pt-BR').includes(needle) === true);
}

/** Os filtros de conteúdo (conta, fonte, tática, técnica e busca). */
export function findingContentMatches(finding: FilterableFinding, filters: DetectionFilters): boolean {
  return (
    (filters.accountId === undefined || finding.accountId === filters.accountId) &&
    (filters.source === undefined || finding.source === filters.source) &&
    (filters.tactic === undefined || finding.mitreTactics.includes(filters.tactic)) &&
    (filters.technique === undefined || (finding.mitreTechniques ?? []).includes(filters.technique)) &&
    (filters.q === undefined || findingTextMatches(finding, filters.q))
  );
}

/** O achado bate com todos os filtros (a lista "Todos os achados" e os achados avulsos da visão agrupada). */
export function findingMatchesFilters(
  finding: FilterableFinding,
  filters: DetectionFilters,
  now: Date,
): boolean {
  const window = filterWindow(filters, now);
  const at = Date.parse(finding.occurredAt);
  return (
    (filters.severity === undefined || finding.severity === filters.severity) &&
    (filters.status === undefined || finding.status === filters.status) &&
    (window.from === null || at >= window.from.getTime()) &&
    (window.to === null || at <= window.to.getTime()) &&
    findingContentMatches(finding, filters)
  );
}

/**
 * O incidente bate com os filtros: a severidade, o status (pelo equivalente), o responsável e a janela pelo próprio
 * incidente (ativo em algum momento da janela: o último achado depois do começo, o primeiro antes do fim); os filtros de
 * conteúdo, por pelo menos um dos achados dele.
 */
export function incidentMatchesFilters(
  incident: Pick<Incident, 'severity' | 'status' | 'assignee' | 'firstSeenAt' | 'lastSeenAt'>,
  findings: readonly FilterableFinding[],
  filters: DetectionFilters,
  now: Date,
): boolean {
  const window = filterWindow(filters, now);
  const status = filters.status === undefined ? undefined : INCIDENT_STATUS_OF_FILTER[filters.status];
  return (
    status !== null &&
    (filters.severity === undefined || incident.severity === filters.severity) &&
    (status === undefined || incident.status === status) &&
    (filters.unassigned === undefined || incident.assignee === null) &&
    (window.from === null || Date.parse(incident.lastSeenAt) >= window.from.getTime()) &&
    (window.to === null || Date.parse(incident.firstSeenAt) <= window.to.getTime()) &&
    (!hasContentFilter(filters) || findings.some((finding) => findingContentMatches(finding, filters)))
  );
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { critical: 3, high: 2, medium: 1, low: 0 };

/** O que ordena uma linha: a severidade, a última atividade (o último achado do incidente) e o id, para desempate. */
export interface DetectionSortKey {
  severity: FindingSeverity;
  at: string;
  id: string;
}

export function detectionSortKey(row: DetectionRow): DetectionSortKey {
  return row.kind === 'incident'
    ? { severity: row.incident.severity, at: row.incident.lastSeenAt, id: row.incident.id }
    : { severity: row.finding.severity, at: row.finding.occurredAt, id: row.finding.id };
}

/** Compara duas linhas na ordem pedida (negativo: `a` vem antes). A API e a demonstração usam a mesma. */
export function compareDetections(sort: DetectionSort, a: DetectionSortKey, b: DetectionSortKey): number {
  if (sort === 'severity') {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
  }
  const byTime = Date.parse(b.at) - Date.parse(a.at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
