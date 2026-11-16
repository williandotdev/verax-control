import {
  DETECTION_SORTS,
  type DetectionFilters,
  type DetectionSort,
  FINDING_PERIODS,
  FINDING_SEVERITIES,
  FINDING_SOURCES,
  FINDING_STATUSES,
  type FindingPeriod,
  findingFilterShape,
  MITRE_TACTIC_NAMES,
  MITRE_TECHNIQUE_PATTERN,
} from '@verax/shared';

/**
 * Estado da tela Detecções na URL (em português), para o link de um e-mail, do tour ou de um favorito abrir a mesma
 * visão: a lista agrupada ou todos os achados, a análise, os filtros, a página e o item aberto no painel. Valor
 * desconhecido é ignorado, nunca enviado à API.
 */
export const DETECTION_PARAMS = {
  view: 'visao',
  analysis: 'analise',
  period: 'periodo',
  from: 'de',
  to: 'ate',
  severity: 'severidade',
  status: 'status',
  source: 'fonte',
  accountId: 'conta',
  tactic: 'tatica',
  technique: 'tecnica',
  q: 'busca',
  unassigned: 'responsavel',
  sort: 'ordem',
  page: 'pagina',
  incident: 'incidente',
  finding: 'achado',
} as const;

/** "Agrupar por incidente" (o padrão, sem parâmetro) ou "Todos os achados". */
export type DetectionView = 'grouped' | 'findings';
/** A lista (o padrão) ou uma das análises que vieram dos Relatórios. */
export type DetectionAnalysis = 'list' | 'mitre' | 'coverage';

export const ANALYSIS_SLUGS: Readonly<Record<DetectionAnalysis, string | null>> = {
  list: null,
  mitre: 'mitre',
  coverage: 'cobertura',
};

/** O período do seletor: um dos períodos, o personalizado ou nenhum (todo o histórico). */
export type PeriodChoice = FindingPeriod | 'custom' | undefined;
export const CUSTOM_PERIOD = 'personalizado';
export const NO_ASSIGNEE = 'nenhum';

/** O item aberto no painel de detalhe. */
export type DetectionSelection = { kind: 'incident' | 'finding'; id: string } | null;

export interface DetectionState {
  view: DetectionView;
  analysis: DetectionAnalysis;
  /** O período pedido na URL (o plano ainda decide se ele vale; ver `usePeriodFilter`). */
  periodChoice: PeriodChoice;
  /** As datas do intervalo personalizado, como vieram (AAAA-MM-DD), para os campos. */
  customDates: { from: string; to: string };
  /** Os filtros da API, menos o período (que depende do plano). */
  filters: Omit<DetectionFilters, 'period'>;
  sort: DetectionSort;
  page: number;
  selection: DetectionSelection;
}

const pick = <T extends string>(allowed: readonly T[], value: string | null): T | undefined =>
  allowed.find((candidate) => candidate === value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** AAAA-MM-DD, conferido caractere a caractere (sem expressão regular sobre a URL). */
function isDay(value: string): boolean {
  if (value.length !== 10) return false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (i === 4 || i === 7 ? ch !== '-' : ch < '0' || ch > '9') return false;
  }
  return true;
}

/** A data do campo (AAAA-MM-DD) no começo ou no fim do dia, no fuso de quem escolheu, em ISO. */
export function dayBoundary(day: string, edge: 'start' | 'end'): string | undefined {
  if (!isDay(day)) return undefined;
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const value =
    edge === 'start'
      ? new Date(year, month - 1, date, 0, 0, 0, 0)
      : new Date(year, month - 1, date, 23, 59, 59, 999);
  // Uma data impossível (31 de fevereiro) rola para o mês seguinte: recusada.
  if (Number.isNaN(value.getTime()) || value.getMonth() !== month - 1) return undefined;
  return value.toISOString();
}

/** O intervalo personalizado válido (as duas pontas, o começo antes do fim), ou nada. */
function customRange(from: string, to: string): { from: string; to: string } | undefined {
  const start = dayBoundary(from, 'start');
  const end = dayBoundary(to, 'end');
  if (!start || !end || start > end) return undefined;
  return { from: start, to: end };
}

/** Lê a URL. */
export function readDetectionState(params: URLSearchParams): DetectionState {
  const get = (key: keyof typeof DETECTION_PARAMS) => params.get(DETECTION_PARAMS[key]);
  const periodParam = get('period');
  const periodChoice: PeriodChoice =
    periodParam === CUSTOM_PERIOD ? 'custom' : pick(FINDING_PERIODS, periodParam);
  const customDates = { from: get('from') ?? '', to: get('to') ?? '' };
  const range = periodChoice === 'custom' ? customRange(customDates.from, customDates.to) : undefined;
  const account = findingFilterShape.accountId.safeParse(get('accountId') ?? undefined);
  const technique = get('technique')?.trim().toUpperCase();
  const q = findingFilterShape.q.safeParse(get('q') ?? undefined);
  const incident = get('incident');
  const finding = get('finding');
  const analysisParam = get('analysis');
  return {
    view: get('view') === 'achados' ? 'findings' : 'grouped',
    analysis: analysisParam === 'mitre' ? 'mitre' : analysisParam === 'cobertura' ? 'coverage' : 'list',
    periodChoice,
    customDates,
    filters: {
      severity: pick(FINDING_SEVERITIES, get('severity')),
      status: pick(FINDING_STATUSES, get('status')),
      source: pick(FINDING_SOURCES, get('source')),
      accountId: account.success ? account.data : undefined,
      tactic: pick(MITRE_TACTIC_NAMES, get('tactic')),
      technique: technique && MITRE_TECHNIQUE_PATTERN.test(technique) ? technique : undefined,
      q: q.success ? q.data : undefined,
      unassigned: get('unassigned') === NO_ASSIGNEE ? 'true' : undefined,
      ...range,
    },
    sort: pick(DETECTION_SORTS, get('sort') === 'severidade' ? 'severity' : null) ?? 'recent',
    page: Math.max(1, Number.parseInt(get('page') ?? '1', 10) || 1),
    // Um item por vez: o achado, se os dois vierem (o link de um achado dentro do incidente).
    selection:
      finding && UUID.test(finding)
        ? { kind: 'finding', id: finding }
        : incident && UUID.test(incident)
          ? { kind: 'incident', id: incident }
          : null,
  };
}

/** Os filtros que a pessoa escolheu (sem a visão, a análise, a página nem a seleção): o "Limpar filtros" tira estes. */
export const FILTER_KEYS = [
  'period',
  'from',
  'to',
  'severity',
  'status',
  'source',
  'accountId',
  'tactic',
  'technique',
  'q',
  'unassigned',
] as const satisfies readonly (keyof typeof DETECTION_PARAMS)[];

/** Quantos filtros estão em uso (o período conta uma vez). */
export function activeFilterCount(params: URLSearchParams): number {
  return FILTER_KEYS.filter((key) => key !== 'from' && key !== 'to' && params.get(DETECTION_PARAMS[key]))
    .length;
}

/**
 * A URL com as mudanças: `null` tira o parâmetro. Mudar um filtro, a visão ou a ordem volta para a primeira página
 * (a não ser com `keepPage`).
 */
export function withChanges(
  previous: URLSearchParams,
  changes: Partial<Record<keyof typeof DETECTION_PARAMS, string | null>>,
  { keepPage = false }: { keepPage?: boolean } = {},
): URLSearchParams {
  const next = new URLSearchParams(previous);
  for (const [key, value] of Object.entries(changes) as [keyof typeof DETECTION_PARAMS, string | null][]) {
    if (value) next.set(DETECTION_PARAMS[key], value);
    else next.delete(DETECTION_PARAMS[key]);
  }
  if (!keepPage) next.delete(DETECTION_PARAMS.page);
  return next;
}

/** O link que abre um item no painel, mantendo a visão e os filtros de agora. */
export function selectionSearch(previous: URLSearchParams, selection: DetectionSelection): string {
  const next = withChanges(
    previous,
    {
      incident: selection?.kind === 'incident' ? selection.id : null,
      finding: selection?.kind === 'finding' ? selection.id : null,
    },
    { keepPage: true },
  );
  const text = next.toString();
  return text ? `?${text}` : '';
}

/** Rótulo do período (o mesmo do seletor). */
export const PERIOD_CHOICE_LABELS: Readonly<Record<FindingPeriod | 'custom', string>> = {
  '24h': 'Últimas 24 horas',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
  '12m': 'Últimos 12 meses',
  custom: 'Personalizado',
};
