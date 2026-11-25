import {
  type CaseFilterFields,
  type CaseGroup,
  type CaseSummary,
  type Finding,
  type FindingSeverity,
  FINDING_SEVERITIES,
  isMassTriageRole,
  MAX_TRIAGE_ALERTS,
  type Role,
  TRIAGE_ALERTS_PER_OPERATION,
  TRIAGE_EMPTY_CODE,
  TRIAGE_INCIDENT_RESOLVED_CODE,
  TRIAGE_QUEUE_FULL_CODE,
  TRIAGE_QUOTA_CODE,
  TRIAGE_REASON_MAX,
  TRIAGE_REASON_REQUIRED_CODE,
  TRIAGE_SCOPE_CHANGED_CODE,
  TRIAGE_TOO_LARGE_CODE,
  type TriageFilter,
  triageFilterSchema,
  type TriagePreview,
  type TriageTarget,
} from '@verax/shared';
import { ApiRequestError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { formatCount } from '@/lib/format';
import { alertCount, caseCount } from './labels';

/**
 * As regras do diálogo da triagem em massa, sem React: o alvo com as contas que a pessoa confirma, o corpo do pedido e o
 * que dizer de cada recusa. Quem decide é a API, em cada pedido; aqui é para a pessoa saber antes.
 */

export type PendingCounts = Readonly<Record<FindingSeverity, number>>;

export const NO_PENDING: PendingCounts = { critical: 0, high: 0, medium: 0, low: 0 };

export function sumPending(counts: PendingCounts): number {
  return FINDING_SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
}

export function addPending(all: readonly PendingCounts[]): PendingCounts {
  const total = { ...NO_PENDING };
  for (const counts of all) for (const severity of FINDING_SEVERITIES) total[severity] += counts[severity];
  return total;
}

/** As ações em massa, na ordem do diálogo. */
export const BULK_ACTIONS = ['investigating', 'legitimate', 'resolved', 'promote', 'attach'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
export const INCIDENT_ACTIONS: readonly BulkAction[] = ['promote', 'attach'];

export const BULK_ACTION_LABELS: Readonly<Record<BulkAction, { label: string; hint: string }>> = {
  investigating: { label: 'Em análise', hint: 'Alguém está olhando; os alertas continuam pendentes.' },
  legitimate: { label: 'Legítimo', hint: 'Comportamento esperado ou falso positivo.' },
  resolved: { label: 'Resolvido', hint: 'O que causou os alertas já foi corrigido.' },
  promote: {
    label: 'Promover a incidente',
    hint: 'Ameaça real: abre um incidente com os alertas e avisa por e-mail.',
  },
  attach: { label: 'Anexar a incidente', hint: 'Junta os alertas a um incidente em aberto.' },
};

/** O alvo de uma operação, com o que a pessoa vê antes de confirmar. */
export interface BulkScope {
  target: TriageTarget;
  /** De onde veio, para o título do diálogo: "3 casos", "grupo openssl". */
  label: string;
  /** Quantos casos; null quando o alvo são alertas da lista. */
  cases: number | null;
  /** Os alertas pendentes do alvo, por severidade. */
  pending: PendingCounts;
  /** Dos pendentes, os que já estão em análise; null se não se sabe. */
  investigating: number | null;
  /** Os pendentes ainda novos, por severidade; null se não se sabe (só a prévia de um filtro diz). */
  fresh?: PendingCounts | null;
  /** Os casos que tocam a lista de proteção; null se não se sabe quais (um filtro só diz quantos). */
  protectedTitles: readonly string[] | null;
  /** Quantos casos de um filtro tocam a lista de proteção; null se o nó não diz. */
  protectedCases?: number | null;
  /** Há filtro de severidade: ele escolhe casos, não alertas. */
  severityFiltered?: boolean;
}

export function scopeOfCases(rows: readonly CaseSummary[]): BulkScope {
  return {
    target: { caseIds: rows.map((row) => row.id) },
    label: rows.length === 1 ? (rows[0]?.title ?? '') : caseCount(rows.length),
    cases: rows.length,
    pending: addPending(rows.map((row) => row.pending)),
    investigating: rows.reduce((sum, row) => sum + row.counts.investigating, 0),
    protectedTitles: rows.filter((row) => row.protected).map((row) => row.title),
  };
}

/** Um subgrupo de um caso (o pacote, ou o recurso do controle), pelo valor inteiro. */
export function scopeOfCaseGroup(
  row: CaseSummary,
  group: { value: string; pending: PendingCounts },
): BulkScope {
  return {
    target: { caseIds: [row.id], group: group.value },
    label: `grupo ${group.value}`,
    cases: 1,
    pending: group.pending,
    investigating: null,
    protectedTitles: row.protected ? [row.title] : [],
  };
}

/** Alertas escolhidos na lista, um por um. */
export function scopeOfFindings(rows: readonly Finding[]): BulkScope {
  return {
    target: { findingIds: rows.map((row) => row.id) },
    label: alertCount(rows.length),
    cases: null,
    pending: addPending(rows.map((row) => ({ ...NO_PENDING, [row.severity]: 1 }))),
    investigating: rows.filter((row) => row.status === 'investigating').length,
    protectedTitles: null,
  };
}

/** Um filtro da lista, com a prévia da API (as contas são dela, de agora). */
export function scopeOfFilter(filter: TriageFilter, label: string, preview: TriagePreview): BulkScope {
  return {
    target: { filter },
    label,
    cases: preview.cases,
    pending: preview.pending,
    investigating: preview.investigating,
    fresh: preview.byStatus?.new ?? null,
    protectedTitles: null,
    protectedCases: preview.protectedCases ?? null,
    severityFiltered: filter.severity !== undefined,
  };
}

/** O alerta em que uma operação mexe: novo ou em análise, fora de incidente. */
export const isActionable = (finding: Pick<Finding, 'status' | 'incidentId'>): boolean =>
  finding.incidentId === null && (finding.status === 'new' || finding.status === 'investigating');

/**
 * O filtro da lista como alvo de uma operação, ou null se ele não estreita o bastante (a mesma regra da API, pelo
 * contrato): só a fila, o estado e o período são quase a tela inteira.
 */
export function filterTarget(
  filter: Partial<CaseFilterFields> & { state: 'pending' | 'investigating' },
): TriageFilter | null {
  const defined = Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined));
  const parsed = triageFilterSchema.safeParse(defined);
  return parsed.success ? parsed.data : null;
}

/** O filtro de um grupo da fila de vulnerabilidades; o valor nulo é o dos casos sem grupo. */
export function groupFilter(
  by: NonNullable<CaseFilterFields['groupBy']>,
  group: Pick<CaseGroup, 'value'>,
  filters: {
    state: 'pending' | 'investigating';
    severity?: FindingSeverity | undefined;
    accountId?: string | undefined;
  },
): TriageFilter | null {
  return filterTarget({
    queue: 'vulnerability',
    groupBy: by,
    ...(group.value !== null && { group: group.value }),
    state: filters.state,
    severity: filters.severity,
    accountId: filters.accountId,
  });
}

/**
 * Quantos alertas a operação alcança: sem os críticos, se eles não foram incluídos; e, para "em análise", sem os que já
 * estão (a prévia de um filtro diz os novos por severidade). `exact: false` quando não dá para saber quantos dos críticos que
 * saem já estavam em análise: é um teto, e a API só recusa o conjunto que veio maior que o confirmado.
 */
export function expectedCount(
  scope: Pick<BulkScope, 'pending' | 'investigating' | 'fresh'>,
  includeCritical: boolean,
  action: BulkAction,
): { count: number; exact: boolean } {
  const total = sumPending(scope.pending);
  const count = includeCritical ? total : total - scope.pending.critical;
  if (action !== 'investigating' || scope.investigating === 0) return { count, exact: true };
  if (scope.fresh) {
    const fresh = sumPending(scope.fresh);
    return { count: includeCritical ? fresh : fresh - scope.fresh.critical, exact: true };
  }
  if (scope.investigating === null || count !== total) return { count, exact: false };
  return { count: total - scope.investigating, exact: true };
}

/** O motivo é obrigatório para tirar da fila mais de um alerta. */
export function reasonRequired(action: BulkAction, count: number): boolean {
  return (action === 'legitimate' || action === 'resolved') && count > 1;
}

/** Acima disto, a pessoa digita a quantidade para confirmar. */
export const TYPED_CONFIRMATION_ALERTS = 1_000;
export const needsTypedConfirmation = (count: number): boolean => count > TYPED_CONFIRMATION_ALERTS;

/** A quantidade digitada, com ou sem o ponto de milhar. */
export function typedMatches(text: string, count: number): boolean {
  const digits = [...text].filter((char) => char !== '.' && char.trim() !== '').join('');
  return digits === String(count);
}

/** O motivo como a API o aceita: aparado, sem caractere de controle (fora a quebra de linha e a tabulação), no tamanho. */
export function cleanReason(text: string): string {
  const kept = [...text].filter((char) => {
    const code = char.charCodeAt(0);
    return char === '\n' || char === '\t' || (code >= 32 && code !== 127);
  });
  return kept.join('').trim().slice(0, TRIAGE_REASON_MAX).toWellFormed();
}

/** Por que o pedido nem deve sair; null se pode. Os limites de quem não administra são conferidos de novo pela API. */
export function limitProblem(count: number, role: Role): string | null {
  if (count === 0) return 'Não há alerta pendente para mudar.';
  if (count > MAX_TRIAGE_ALERTS) {
    return `São alertas demais para uma operação (o máximo é ${formatCount(MAX_TRIAGE_ALERTS)}). Estreite o filtro.`;
  }
  if (!isMassTriageRole(role) && count > TRIAGE_ALERTS_PER_OPERATION) {
    return `Acima de ${formatCount(TRIAGE_ALERTS_PER_OPERATION)} alertas de uma vez, só um administrador.`;
  }
  return null;
}

/** O aviso do teto da seleção: o que não coube não foi marcado. */
export function selectionNote(refused: number, limit: number, noun: string): string | null {
  return refused > 0
    ? `Até ${formatCount(limit)} ${noun} por vez: ${formatCount(refused)} ficaram de fora. Trate em partes.`
    : null;
}

/** O corpo do pedido, sem o `requestId` (que é por conteúdo; ver `useRequestId`). */
export function requestBody(input: {
  scope: BulkScope;
  action: BulkAction;
  incidentId: string | null;
  includeCritical: boolean;
  expected: number;
  reason: string;
}) {
  const reason = cleanReason(input.reason);
  const common = {
    target: input.scope.target,
    expectedCount: input.expected,
    includeCritical: input.includeCritical,
    ...(reason !== '' && { reason }),
  };
  switch (input.action) {
    case 'promote':
      return { action: 'promote' as const, ...common };
    case 'attach':
      return { action: 'attach' as const, incidentId: input.incidentId ?? '', ...common };
    default:
      return { action: 'status' as const, status: input.action, ...common };
  }
}
export type BulkRequestBody = ReturnType<typeof requestBody>;

/** O que uma recusa pede da pessoa. */
export type BulkProblem =
  /** O conjunto mudou: confirme de novo, com a contagem nova. */
  | { kind: 'scope_changed'; count: number; message: string }
  /** Só há críticos: eles precisam entrar, ou não há o que fazer. */
  | { kind: 'only_critical'; excluded: number; message: string }
  | { kind: 'empty'; message: string }
  /** Falta o motivo. */
  | { kind: 'reason'; message: string }
  /** Limite, fila cheia, alvo grande demais, incidente resolvido, item que não existe mais: não adianta repetir já. */
  | { kind: 'refused'; message: string }
  /** Banco ocupado ou sem conexão: nada se sabe do pedido; repetir é seguro (o mesmo `requestId`). */
  | { kind: 'retry'; message: string };

export function bulkProblem(error: unknown): BulkProblem {
  if (!(error instanceof ApiRequestError)) {
    return { kind: 'retry', message: errorMessage(error) };
  }
  const count = error.details?.['count'];
  const excluded = error.details?.['excludedCritical'] ?? 0;
  const limit = error.details?.['limit'];
  switch (error.code) {
    case TRIAGE_SCOPE_CHANGED_CODE:
      return count === undefined
        ? { kind: 'refused', message: 'O alvo mudou. Feche, confira a lista e tente de novo.' }
        : {
            kind: 'scope_changed',
            count,
            message: `O alvo mudou enquanto você confirmava: agora são ${alertCount(count)}. Confira e confirme de novo.`,
          };
    case TRIAGE_EMPTY_CODE:
      return excluded > 0
        ? {
            kind: 'only_critical',
            excluded,
            message: `Só ${excluded === 1 ? 'há 1 alerta crítico pendente' : `há ${formatCount(excluded)} alertas críticos pendentes`} no alvo. Para tratá-${excluded === 1 ? 'lo' : 'los'}, inclua os críticos.`,
          }
        : { kind: 'empty', message: 'Não há mais alerta pendente no alvo: alguém já tratou.' };
    case TRIAGE_REASON_REQUIRED_CODE:
      return {
        kind: 'reason',
        message: 'Explique o motivo para marcar mais de um alerta como legítimo ou resolvido.',
      };
    case TRIAGE_QUOTA_CODE:
      return {
        kind: 'refused',
        message:
          limit === undefined
            ? 'Passou do limite de alertas para o seu papel. Peça a um administrador.'
            : `Passou do limite de ${alertCount(limit)} para o seu papel (por operação ou em 24 horas). Peça a um administrador.`,
      };
    case TRIAGE_QUEUE_FULL_CODE:
      return {
        kind: 'refused',
        message: 'Já há operações demais na fila. Espere uma terminar ou cancele uma em Operações recentes.',
      };
    case TRIAGE_TOO_LARGE_CODE:
      return { kind: 'refused', message: 'São alertas demais para uma operação. Estreite o filtro.' };
    case TRIAGE_INCIDENT_RESOLVED_CODE:
      return {
        kind: 'refused',
        message:
          'Esse incidente já foi resolvido e não muda de alertas. Escolha outro ou reabra o incidente.',
      };
    default:
      break;
  }
  if (error.status === 404) {
    return {
      kind: 'refused',
      message: 'Um dos itens do alvo não existe mais. Feche, confira a lista e tente de novo.',
    };
  }
  if (error.status === 503 || error.status === 0) {
    return { kind: 'retry', message: 'O banco está ocupado, e nada mudou. Tente de novo em instantes.' };
  }
  if (error.status >= 500) {
    return {
      kind: 'retry',
      message:
        'O servidor não conseguiu concluir. Tentar de novo é seguro: o mesmo pedido não vale duas vezes.',
    };
  }
  return { kind: 'refused', message: errorMessage(error) };
}
