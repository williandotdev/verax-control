import {
  CASE_GROUPINGS,
  type CaseGrouping,
  type CaseMode,
  type CaseQueueName,
  type CaseSort,
  type CaseState,
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
 * visão: os casos (o padrão, com eles ligados), os alertas (o padrão sem eles), os incidentes ou as vulnerabilidades, a
 * análise, os filtros, a página e o item aberto no painel. Valor desconhecido é ignorado, nunca enviado à API. Os
 * endereços de antes de 17/11/2026 continuam valendo: `visao=achados` é a visão dos alertas, e `achado=<id>` abre o
 * alerta. Com os casos desligados, a tela é a de sempre, seja qual for o endereço.
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
  finding: 'alerta',
  case: 'caso',
  caseState: 'estado',
  queue: 'fila',
  groupBy: 'agrupar',
} as const;

/** O nome de antes do parâmetro do alerta aberto (`?achado=<id>`), ainda lido. */
export const LEGACY_FINDING_PARAM = 'achado';
/** O valor de `visao` da lista de incidentes. */
export const INCIDENTS_VIEW = 'incidentes';
/** Os valores de `visao` das outras listas; sem `visao`, a padrão (os casos, com eles ligados; senão, os alertas). */
export const ALERTS_VIEW = 'alertas';
export const CASES_VIEW = 'casos';
export const VULNERABILITIES_VIEW = 'vulnerabilidades';

/**
 * "Casos": os alertas pendentes agrupados; "Alertas": todos, um por um, os a validar e os já validados; "Incidentes": só
 * os confirmados; "Vulnerabilidades": os casos dessa fila, por pacote, recurso ou conta. Sem os casos, só as do meio.
 */
export type DetectionView = 'cases' | 'alerts' | 'incidents' | 'vulnerabilities';
/** A lista (o padrão) ou uma das análises que vieram dos Relatórios. */
export type DetectionAnalysis =
  'list' | 'summary' | 'mitre' | 'rules' | 'entities' | 'response' | 'coverage' | 'exceptions';

export const ANALYSIS_SLUGS: Readonly<Record<DetectionAnalysis, string | null>> = {
  list: null,
  summary: 'resumo',
  mitre: 'mitre',
  rules: 'regras',
  entities: 'entidades',
  response: 'resposta',
  coverage: 'cobertura',
  exceptions: 'excecoes',
};

const ANALYSIS_BY_SLUG: ReadonlyMap<string, DetectionAnalysis> = new Map(
  (Object.entries(ANALYSIS_SLUGS) as [DetectionAnalysis, string | null][]).flatMap(([analysis, slug]) =>
    slug === null ? [] : [[slug, analysis] as const],
  ),
);

/** O período do seletor: um dos períodos, o personalizado ou nenhum (todo o histórico). */
export type PeriodChoice = FindingPeriod | 'custom' | undefined;
export const CUSTOM_PERIOD = 'personalizado';
export const NO_ASSIGNEE = 'nenhum';

/** O item aberto no painel de detalhe. */
export type DetectionSelection = { kind: 'incident' | 'finding' | 'case'; id: string } | null;

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
/** O id de um item na URL; null sem ele ou fora do formato. */
const itemId = (value: string | null): string | null => (value !== null && UUID.test(value) ? value : null);
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

/**
 * A lista que a URL pede. Com os casos ligados (`on`), sem `visao`, são eles: menos no endereço com `status`, que só a lista
 * de alertas tem (um favorito ou um atalho de antes). Na medição (`shadow`), o padrão continua a ser os alertas.
 */
function viewOf(params: URLSearchParams, mode: CaseMode): DetectionView {
  const asked = params.get(DETECTION_PARAMS.view);
  if (asked === INCIDENTS_VIEW) return 'incidents';
  if (mode === 'off') return 'alerts';
  if (asked === CASES_VIEW) return 'cases';
  if (asked === VULNERABILITIES_VIEW) return 'vulnerabilities';
  if (asked !== null || mode === 'shadow') return 'alerts';
  return params.get(DETECTION_PARAMS.status) ? 'alerts' : 'cases';
}

/** A URL já diz que lista é, sem depender de os casos estarem ligados. */
export function viewIsDecided(params: URLSearchParams): boolean {
  const asked = params.get(DETECTION_PARAMS.view);
  return asked !== null && asked !== CASES_VIEW && asked !== VULNERABILITIES_VIEW;
}

/** Lê a URL. `mode`: os casos, como a API diz (`useCaseMode`); desligados, os parâmetros deles não valem. */
export function readDetectionState(params: URLSearchParams, mode: CaseMode = 'off'): DetectionState {
  const get = (key: keyof typeof DETECTION_PARAMS) => params.get(DETECTION_PARAMS[key]);
  const periodParam = get('period');
  const periodChoice: PeriodChoice =
    periodParam === CUSTOM_PERIOD ? 'custom' : pick(FINDING_PERIODS, periodParam);
  const customDates = { from: get('from') ?? '', to: get('to') ?? '' };
  const range = periodChoice === 'custom' ? customRange(customDates.from, customDates.to) : undefined;
  const account = findingFilterShape.accountId.safeParse(get('accountId') ?? undefined);
  const technique = get('technique')?.trim().toUpperCase();
  const q = findingFilterShape.q.safeParse(get('q') ?? undefined);
  const incident = itemId(get('incident'));
  const finding = itemId(get('finding') ?? params.get(LEGACY_FINDING_PARAM));
  const openCase = caseIdOf(params);
  const analysisParam = get('analysis');
  return {
    view: viewOf(params, mode),
    analysis: (analysisParam !== null && ANALYSIS_BY_SLUG.get(analysisParam)) || 'list',
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
    // Um item por vez: o alerta, se os dois vierem (o link de um alerta dentro do incidente); o caso por último (o
    // alerta aberto de dentro dele).
    selection:
      finding !== null
        ? { kind: 'finding', id: finding }
        : incident !== null
          ? { kind: 'incident', id: incident }
          : mode !== 'off' && openCase !== null
            ? { kind: 'case', id: openCase }
            : null,
  };
}

/** O caso aberto no painel, ou o que está por trás do alerta aberto a partir dele. */
function caseIdOf(params: URLSearchParams): string | null {
  return itemId(params.get(DETECTION_PARAMS.case));
}

/** O caso para onde o "Voltar ao caso" leva: o do alerta (ou do incidente) aberto a partir dele. */
export function parentCaseOf(params: URLSearchParams, selection: DetectionSelection): string | null {
  return selection === null || selection.kind === 'case' ? null : caseIdOf(params);
}

// ---------------------------------------------------------------------------------------------------
// Casos e vulnerabilidades
// ---------------------------------------------------------------------------------------------------

const CASE_STATE_SLUGS: Readonly<Record<CaseState, string | null>> = {
  pending: null,
  investigating: 'em-analise',
  treated: 'tratados',
  all: 'todos',
};
const CASE_SORT_SLUGS: Readonly<Record<CaseSort, string | null>> = {
  priority: null,
  recent: 'recentes',
  volume: 'volume',
};
/** As filas da visão de casos; a de vulnerabilidades tem a própria. */
export type CasesQueue = Exclude<CaseQueueName, 'vulnerability'>;
const CASE_QUEUE_SLUGS: Readonly<Record<CasesQueue, string | null>> = {
  detection: null,
  posture: 'postura',
};
/** Por onde a fila de vulnerabilidades é agrupada, ou a lista corrida dos casos. */
export type VulnerabilityGrouping = CaseGrouping | 'none';
const GROUPING_SLUGS: Readonly<Record<VulnerabilityGrouping, string | null>> = {
  package: null,
  resource: 'recurso',
  account: 'conta',
  none: 'sem-grupo',
};
export const VULNERABILITY_GROUPINGS: readonly VulnerabilityGrouping[] = [...CASE_GROUPINGS, 'none'];

const bySlug = <T extends string>(
  slugs: Readonly<Record<T, string | null>>,
  value: string | null,
  fallback: T,
): T =>
  value === null
    ? fallback
    : ((Object.keys(slugs) as T[]).find((candidate) => slugs[candidate] === value) ?? fallback);

export const caseStateSlug = (state: CaseState) => CASE_STATE_SLUGS[state];
export const caseSortSlug = (sort: CaseSort) => CASE_SORT_SLUGS[sort];
export const caseQueueSlug = (queue: CasesQueue) => CASE_QUEUE_SLUGS[queue];
export const groupingSlug = (grouping: VulnerabilityGrouping) => GROUPING_SLUGS[grouping];

/** O que só os casos têm na URL. Os filtros em comum com as outras listas ficam em `DetectionState.filters`. */
export interface CaseUrlState {
  state: CaseState;
  sort: CaseSort;
  queue: CasesQueue;
  grouping: VulnerabilityGrouping;
}

export function readCaseState(params: URLSearchParams): CaseUrlState {
  const get = (key: keyof typeof DETECTION_PARAMS) => params.get(DETECTION_PARAMS[key]);
  return {
    state: bySlug(CASE_STATE_SLUGS, get('caseState'), 'pending'),
    sort: bySlug(CASE_SORT_SLUGS, get('sort'), 'priority'),
    queue: bySlug(CASE_QUEUE_SLUGS, get('queue'), 'detection'),
    grouping: bySlug(GROUPING_SLUGS, get('groupBy'), 'package'),
  };
}

/** O `visao` de uma lista: sem parâmetro na que é a padrão, para o endereço ficar curto (e o de sempre, sem os casos). */
export function viewParam(view: DetectionView, mode: CaseMode): string | null {
  switch (view) {
    case 'incidents':
      return INCIDENTS_VIEW;
    case 'vulnerabilities':
      return VULNERABILITIES_VIEW;
    case 'cases':
      return mode === 'on' ? null : CASES_VIEW;
    case 'alerts':
      return mode === 'on' ? ALERTS_VIEW : null;
  }
}

/** Os filtros que a pessoa escolheu nos casos: o "Limpar filtros" tira estes (a fila e o agrupamento ficam). */
export const CASE_FILTER_KEYS = [
  'period',
  'from',
  'to',
  'severity',
  'source',
  'accountId',
  'tactic',
  'technique',
  'q',
  'caseState',
] as const satisfies readonly (keyof typeof DETECTION_PARAMS)[];

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
    // Quem muda o alerta aberto também tira o nome de antes do parâmetro.
    if (key === 'finding') next.delete(LEGACY_FINDING_PARAM);
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
      // O alerta ou o incidente aberto de dentro do caso volta para ele; sem nada aberto, o caso também sai.
      ...((selection === null || selection.kind === 'case') && { case: selection?.id ?? null }),
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
