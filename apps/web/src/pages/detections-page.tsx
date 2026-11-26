import { type DetectionFilters, FINDING_PERIODS, hasContentFilter, type Permission } from '@verax/shared';
import { Download, SlidersHorizontal, X } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Explainer } from '@/components/ui/explainer';
import { Sheet } from '@/components/ui/sheet';
import { SEVERITY_STYLES } from '@/design/severity';
import { FINDING_SOURCE_LABELS, FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { BulkAlertsList } from '@/features/cases/alerts-bulk';
import { CaseFilterBar } from '@/features/cases/case-filter-bar';
import { caseListQuery } from '@/features/cases/case-query';
import { type CaseModeState, useCaseMode } from '@/features/cases/cases-api';
import { CasesProvider } from '@/features/cases/cases-provider';
import { CasesView } from '@/features/cases/cases-view';
import { OperationsPanel } from '@/features/cases/operations-panel';
import { VIEW_LABELS, viewsOf } from '@/features/cases/views';
import { DetectionDetailPanel } from '@/features/detections/detail-panel';
import { FILL_COLUMN, IncidentsList } from '@/features/detections/detection-list';
import { useDetections } from '@/features/detections/detections-api';
import { EXPORT_MAX_ROWS, exportCases, exportFindings, exportIncidents } from '@/features/detections/export';
import { FilterBar } from '@/features/detections/filter-bar';
import { OriginBand } from '@/features/detections/origin-band';
import { SituationStrip } from '@/features/detections/situation-strip';
import { useStripPreference } from '@/features/detections/strip-preference';
import {
  ANALYSIS_SLUGS,
  CUSTOM_PERIOD,
  DETECTION_PARAMS,
  type DetectionAnalysis,
  FILTER_KEYS,
  PERIOD_CHOICE_LABELS,
  type DetectionSelection,
  type DetectionView,
  parentCaseOf,
  readCaseState,
  readDetectionState,
  viewIsDecided,
  viewParam,
  withChanges,
} from '@/features/detections/url-state';
import { useFindings } from '@/features/findings/findings-api';
import { usePeriodFilter } from '@/features/plan/plan-history';
import { downloadCsv } from '@/features/reports/csv';
import {
  CoverageReportView,
  EntitiesReportView,
  ExceptionsReportView,
  IncidentsReportView,
  MitreReportView,
  RulesReportView,
  SummaryReportView,
} from '@/features/reports/report-views';
import type { ReportRange } from '@/features/reports/reports-api';
import { useMe } from '@/features/session/session';
import { NARROW_QUERY, SIDE_PANEL_QUERY, useMediaQuery, WIDE_LIST_QUERY } from '@/lib/use-media-query';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';

const PAGE_SIZE = 20;

/** O nome do arquivo do CSV de cada visão. */
const EXPORT_FILES: Readonly<Record<DetectionView, string>> = {
  cases: 'casos',
  alerts: 'alertas',
  incidents: 'incidentes',
  vulnerabilities: 'vulnerabilidades',
};

const ANALYSIS_TABS: readonly { value: DetectionAnalysis; label: string }[] = [
  { value: 'list', label: 'Lista' },
  { value: 'summary', label: 'Resumo' },
  { value: 'mitre', label: 'MITRE ATT&CK' },
  { value: 'rules', label: 'Regras' },
  { value: 'entities', label: 'Entidades' },
  { value: 'response', label: 'Resposta a incidentes' },
  { value: 'coverage', label: 'Cobertura das fontes' },
  { value: 'exceptions', label: 'Exceções' },
];

/**
 * Detecções (decisão do responsável de 16/11/2026): a tela de operação, no lugar da Torre, de Incidentes, de Achados e
 * de Relatórios. No topo, o resumo da situação (recolhível); embaixo, a lista de alertas (o padrão) ou a de incidentes,
 * com um filtro só e o detalhe ao lado para a validação. No computador (23/11/2026), a lista fica ao lado do radar, com o
 * detalhe no lugar do radar enquanto está aberto, e as análises ficam embaixo, a começar pelo Resumo. Desde 17/11/2026 (taxonomia de SOC), o evento vira alerta, a
 * pessoa valida o alerta, e só a confirmação dela (promover) abre um incidente. Acima de tudo, para quem tem balanceador com
 * a leitura autorizada, o mapa de origens das requisições (24/11/2026, `origin-band.tsx`). As análises que vieram dos Relatórios (MITRE e
 * cobertura) usam o mesmo período. Cada parte aparece para quem tem a permissão dela (a API decide de qualquer forma).
 */
export function DetectionsPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const can = (permission: Permission) => me?.permissions.includes(permission) === true;
  // Os casos (docs/ARQUITETURA.md, "Casos"): desligados, ou num nó de antes, a tela é a de sempre.
  const cases = useCaseMode(scope, can('findings:read'));

  if (me && scope === null) {
    return (
      <Shell>
        <EmptyState
          title="Escolha um cliente"
          description="As detecções são de um cliente por vez. Escolha um no seletor do topo da tela."
        />
      </Shell>
    );
  }
  if (!me || scope === null) return null;
  return (
    <CasesProvider cases={cases} me={me}>
      <DetectionsContent
        cases={cases}
        scope={scope}
        userId={me.userId}
        canTower={can('tower:read')}
        canIncidents={can('incidents:read') && can('findings:read')}
        canFindings={can('findings:read')}
        canAnalysis={can('reports:read')}
      />
    </CasesProvider>
  );
}

function Shell({
  children,
  actions,
  casesOn = false,
}: {
  children: ReactNode;
  actions?: ReactNode;
  /** Com os casos (ligados ou em medição), o "Como funciona" explica também os casos e as vulnerabilidades. */
  casesOn?: boolean;
}) {
  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        {/* R-03: a explicação lida uma vez sai da frente e fica em "Como funciona", ao lado do título. */}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold">Detecções</h1>
          <Explainer about="Detecções" className="open:basis-full">
            <p>
              Cada evento suspeito vira um alerta para validar: pode ser falso positivo. Quando a ameaça é
              real, quem opera promove o alerta, com os relacionados, a um incidente. Abra um item para ver o
              detalhe e decidir o que fazer.
            </p>
            {casesOn && (
              <>
                <p>
                  Um caso reúne os alertas pendentes com a mesma origem e o mesmo alvo. Trate o caso inteiro
                  de uma vez ou abra-o para ver alerta por alerta.
                </p>
                <p>
                  Nas vulnerabilidades, cada caso é um pacote num recurso. Agrupe por pacote para atualizar em
                  todo lugar de uma vez, ou por recurso para ver o que há em cada um.
                </p>
              </>
            )}
          </Explainer>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

function DetectionsContent({
  cases,
  scope,
  userId,
  canTower,
  canIncidents,
  canFindings,
  canAnalysis,
}: {
  cases: CaseModeState;
  scope: string;
  userId: string;
  canTower: boolean;
  canIncidents: boolean;
  canFindings: boolean;
  canAnalysis: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const state = readDetectionState(params, cases.mode);
  const caseState = readCaseState(params);
  const view: DetectionView = state.view === 'incidents' && !canIncidents ? 'alerts' : state.view;
  // Sem saber ainda se há casos, a lista padrão espera: pedir os alertas para trocar em seguida seria à toa.
  const decided = !cases.loading || viewIsDecided(params);
  const casesShown = view === 'cases' || view === 'vulnerabilities';
  const side = useMediaQuery(SIDE_PANEL_QUERY);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const wide = useMediaQuery(WIDE_LIST_QUERY);
  const [stripExpanded, setStripExpanded] = useStripPreference(userId);
  // As análises são abas no mesmo nível de "Lista" em toda largura (E-07): escolher uma troca a área da lista; o radar e a
  // situação ficam onde estão. Sem nenhuma na URL, a lista.
  const analysis: DetectionAnalysis = canAnalysis ? state.analysis : 'list';
  const listing = analysis === 'list';
  const besideRadar = side && canTower && stripExpanded;
  // O período só vai para a API se couber no histórico do plano; o seletor só oferece os que cabem.
  const periods = usePeriodFilter(
    FINDING_PERIODS,
    state.periodChoice && state.periodChoice !== 'custom' ? state.periodChoice : null,
  );
  const filters: DetectionFilters = { ...state.filters, period: periods.period };
  const { unassigned: _unassigned, ...findingFilters } = filters;
  const ready = !periods.waiting;
  const incidents = useDetections(
    {
      ...filters,
      ...(state.sort === 'severity' && { sort: 'severity' as const }),
      kind: 'incident',
      page: state.page,
      pageSize: PAGE_SIZE,
    },
    ready && listing && view === 'incidents',
  );
  const findings = useFindings(
    { ...findingFilters, page: state.page, pageSize: PAGE_SIZE },
    ready && decided && listing && view === 'alerts' && canFindings,
  );

  const opener = useRef<HTMLElement | null>(null);
  const selection = state.selection;
  // Ao fechar o painel ao lado, o foco volta para quem o abriu (na gaveta, o próprio diálogo devolve).
  const previous = useRef<DetectionSelection>(selection);
  useEffect(() => {
    if (previous.current !== null && selection === null && side && opener.current?.isConnected) {
      opener.current.focus();
    }
    previous.current = selection;
  }, [selection, side]);

  const listRef = useRef<HTMLDivElement>(null);
  // Quem chega por um link direto vem pelo que ele abre: o mapa do topo começa recolhido, só desta vez. Um link para uma
  // análise abre nela, na aba ao lado de "Lista", perto do topo: não precisa rolar (R-05, resolvido pela E-07).
  const [deepLink] = useState(selection !== null || (canAnalysis && state.analysis !== 'list'));
  // A tática escolhida na análise filtra a lista, que pode estar fora da tela, acima.
  const tactic = useRef(state.filters.tactic);
  useEffect(() => {
    if (tactic.current === state.filters.tactic) return;
    tactic.current = state.filters.tactic;
    const element = listRef.current;
    if (side && element && element.getBoundingClientRect().top < 0)
      element.scrollIntoView({ block: 'start' });
  }, [side, state.filters.tactic]);

  const update = (changes: Parameters<typeof withChanges>[1], options?: { keepPage?: boolean }) =>
    setParams((current) => withChanges(current, changes, options));
  const open = (next: NonNullable<DetectionSelection>, element: HTMLElement) => {
    opener.current = element;
    update(
      {
        incident: next.kind === 'incident' ? next.id : null,
        finding: next.kind === 'finding' ? next.id : null,
        case: next.kind === 'case' ? next.id : null,
      },
      { keepPage: true },
    );
  };
  const close = () => update({ incident: null, finding: null, case: null }, { keepPage: true });
  // O alerta (ou o incidente) aberto de dentro de um caso volta para ele.
  const back =
    cases.mode !== 'off' && parentCaseOf(params, selection) !== null
      ? () => update({ incident: null, finding: null }, { keepPage: true })
      : undefined;

  const hasFilters = Object.values(filters).some((value) => value !== undefined);
  const empty =
    view === 'incidents'
      ? {
          emptyTitle: hasFilters ? 'Nenhum incidente com esses filtros' : 'Nenhum incidente confirmado',
          emptyDescription: hasFilters
            ? 'Ajuste ou limpe os filtros.'
            : 'Um incidente nasce quando alguém valida um alerta e confirma a ameaça. Abra um alerta e use "Promover a incidente".',
        }
      : {
          emptyTitle: hasFilters ? 'Nenhum alerta com esses filtros' : 'Nenhum alerta ainda',
          emptyDescription: hasFilters
            ? 'Ajuste ou limpe os filtros.'
            : 'Os alertas das contas conectadas aparecem aqui assim que chegam, para validar.',
        };
  const onPageChange = (page: number) => update({ page: String(page) }, { keepPage: true });

  const range: ReportRange =
    state.periodChoice === 'custom' && filters.from && filters.to
      ? { from: filters.from, to: filters.to }
      : { period: periods.period ?? '30d' };

  // Com o detalhe ou o radar ao lado, a tabela esconde as colunas que não cabem; numa tela muito larga, cabem com o radar.
  // Abaixo de 1280 px (R-08), o mesmo arranjo enxuto: a conta, a origem, quem e quando numa linha embaixo do título, e a
  // severidade, o status e o incidente como colunas, sem rolar de lado.
  const dense = (besideRadar && !wide) || !side;
  const compact = !side || selection !== null || dense;

  const strip = canTower && (
    <SituationStrip
      scope={scope}
      expanded={stripExpanded}
      onExpandedChange={setStripExpanded}
      stacked={besideRadar}
    />
  );
  const originBand = canTower && (
    <OriginBand key={scope} scope={scope} userId={userId} startCollapsed={deepLink} />
  );
  const views = viewsOf(cases.mode, canIncidents);
  const viewToggle = listing && views.length > 1 && (
    <div
      data-tour="deteccoes-visao"
      role="group"
      aria-label="Visão da lista"
      className={cn(
        'inline-flex self-start rounded-md border p-0.5',
        // Quatro visões não cabem numa linha do celular: duas a duas, com a área de toque inteira.
        cases.mode !== 'off' && 'max-sm:grid max-sm:w-full max-sm:grid-cols-2 max-md:[&>button]:min-h-11',
      )}
    >
      {views.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          className={cn(
            'rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
            view === value && 'bg-foreground/10 font-medium text-foreground',
          )}
          onClick={() =>
            update({
              view: viewParam(value, cases.mode),
              unassigned: null,
              sort: null,
              caseState: null,
              queue: null,
              groupBy: null,
              // O status é só dos alertas e dos incidentes.
              ...((value === 'cases' || value === 'vulnerabilities') && { status: null }),
            })
          }
        >
          {VIEW_LABELS[value]}
        </button>
      ))}
    </div>
  );
  const commonFilterBar = (
    <FilterBar
      key={`${view}:${analysis}`}
      state={{ ...state, view }}
      params={params}
      periodOptions={periods.options}
      onChange={(changes) => update(changes)}
      analysis={!listing}
    />
  );
  const fullFilterBar =
    casesShown && listing ? (
      <CaseFilterBar
        key={view}
        view={view}
        state={state}
        cases={caseState}
        params={params}
        periodOptions={periods.options}
        onChange={(changes) => update(changes)}
      />
    ) : (
      commonFilterBar
    );
  const exportButton = listing && (
    <ExportButton
      run={() =>
        casesShown
          ? exportCases(caseListQuery({ view, filters, cases: caseState, page: 1, pageSize: PAGE_SIZE }))
          : view === 'incidents'
            ? exportIncidents(filters, state.sort)
            : exportFindings(filters)
      }
      file={EXPORT_FILES[view]}
    />
  );
  const filterBar = narrow ? (
    <MobileFilters
      params={params}
      open={filtersOpen}
      onOpenChange={setFiltersOpen}
      onRemove={(key) => update({ [key]: null, ...(key === 'period' && { from: null, to: null }) })}
      exportButton={exportButton}
    >
      {fullFilterBar}
    </MobileFilters>
  ) : (
    fullFilterBar
  );
  const commonList =
    view === 'incidents' ? (
      <IncidentsList
        page={{
          rows: periods.waiting ? undefined : incidents.data?.items,
          total: incidents.data?.total ?? 0,
          page: state.page,
          pageSize: PAGE_SIZE,
          loading: incidents.isFetching && incidents.isPlaceholderData,
          error: incidents.error,
          onRetry: () => void incidents.refetch(),
          onPageChange,
          compact,
          dense,
          ...empty,
        }}
        selection={selection}
        onOpen={open}
        filtered={hasContentFilter(filters)}
      />
    ) : (
      <BulkAlertsList
        resetKey={JSON.stringify(findingFilters)}
        stale={findings.isPlaceholderData}
        page={{
          // Sem saber se há casos, a tabela não aparece: com eles, ela ganha a coluna da seleção.
          rows: periods.waiting || cases.loading ? undefined : findings.data?.items,
          total: findings.data?.total ?? 0,
          page: state.page,
          pageSize: PAGE_SIZE,
          loading: findings.isFetching && findings.isPlaceholderData,
          error: findings.error,
          onRetry: () => void findings.refetch(),
          onPageChange,
          compact,
          dense,
          ...empty,
        }}
        selection={selection}
        onOpen={open}
      />
    );
  const list = casesShown ? (
    <CasesView
      view={view}
      filters={filters}
      cases={caseState}
      page={state.page}
      ready={ready}
      compact={compact}
      dense={dense}
      selection={selection}
      onOpen={open}
      onPageChange={onPageChange}
    />
  ) : (
    commonList
  );
  const tabList = (
    <Tabs.List
      data-tour="deteccoes-analise"
      aria-label="Como ver as detecções"
      // E-02: no celular, uma fileira só, que desliza de lado (a última aba aparece cortada, de propósito).
      className="flex gap-1 border-b max-md:-mx-4 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-4 md:flex-wrap"
    >
      {ANALYSIS_TABS.map((tab) => (
        <Tabs.Trigger
          key={tab.value}
          value={tab.value}
          className="-mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground max-md:min-h-11"
        >
          {tab.label}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );
  const analyses = (
    <>
      <Tabs.Content value="summary" className="focus:outline-none">
        {periods.waiting ? null : <SummaryReportView range={range} />}
      </Tabs.Content>
      <Tabs.Content value="mitre" className="focus:outline-none">
        {periods.waiting ? null : (
          <MitreReportView
            range={range}
            tacticHref={(tactic) =>
              `?${withChanges(params, {
                // A tática volta para a lista, já filtrada.
                analysis: null,
                tactic: tactic.name,
                incident: null,
                finding: null,
                case: null,
                // A análise conta alertas, e o atalho diz isso: dos casos, ele vai para a lista de alertas.
                ...(casesShown && { view: viewParam('alerts', cases.mode) }),
                // A lista sem período mostra todo o histórico: o atalho leva a janela que a análise contou.
                ...('period' in range ? { period: range.period } : {}),
              }).toString()}`
            }
          />
        )}
      </Tabs.Content>
      <Tabs.Content value="rules" className="focus:outline-none">
        {periods.waiting ? null : <RulesReportView range={range} />}
      </Tabs.Content>
      <Tabs.Content value="entities" className="focus:outline-none">
        {periods.waiting ? null : <EntitiesReportView range={range} />}
      </Tabs.Content>
      <Tabs.Content value="response" className="focus:outline-none">
        {periods.waiting ? null : <IncidentsReportView range={range} />}
      </Tabs.Content>
      <Tabs.Content value="coverage" className="focus:outline-none">
        {periods.waiting ? null : <CoverageReportView range={range} />}
      </Tabs.Content>
      <Tabs.Content value="exceptions" className="focus:outline-none">
        {periods.waiting ? null : <ExceptionsReportView range={range} />}
      </Tabs.Content>
    </>
  );

  const operations = listing && cases.mode !== 'off' && view !== 'incidents' && <OperationsPanel />;
  return (
    <Shell casesOn={cases.mode !== 'off'} actions={!narrow && exportButton}>
      {originBand}
      <div
        className={cn(
          'grid items-start gap-4',
          besideRadar &&
            'grid-cols-[minmax(0,24rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]',
        )}
      >
        {besideRadar && selection ? (
          <DetectionDetailPanel selection={selection} side onClose={close} onBack={back} />
        ) : (
          strip
        )}
        {/* Ao lado do radar, a lista ocupa a altura dele (`data-fill`); uma análise cresce com o próprio conteúdo. */}
        <div
          ref={listRef}
          data-fill={besideRadar && listing}
          className={cn('min-w-0 scroll-mt-4', besideRadar && listing && 'flex flex-col self-stretch')}
        >
          <Tabs.Root
            value={analysis}
            onValueChange={(value) =>
              update(
                {
                  analysis: ANALYSIS_SLUGS[value as DetectionAnalysis],
                  // O detalhe no lugar do radar fica; o que fica ao lado da lista (ou na gaveta) sai com ela.
                  ...(!besideRadar && { incident: null, finding: null, case: null }),
                },
                { keepPage: true },
              )
            }
            className={cn(
              'space-y-4',
              FILL_COLUMN,
              'in-data-[fill=true]:gap-4 in-data-[fill=true]:space-y-0',
            )}
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              {canAnalysis && tabList}
              {viewToggle}
            </div>
            {filterBar}
            {operations}
            <Tabs.Content value="list" className={cn('focus:outline-none', FILL_COLUMN)}>
              <div
                className={cn(
                  'grid gap-4',
                  besideRadar && 'grow grid-rows-[minmax(0,1fr)]',
                  side && !besideRadar && selection && 'grid-cols-[minmax(0,1fr)_minmax(0,28rem)]',
                )}
              >
                <div className={cn('min-w-0', besideRadar && 'flex flex-col')}>{list}</div>
                {side && !besideRadar && (
                  <DetectionDetailPanel selection={selection} side onClose={close} onBack={back} />
                )}
              </div>
            </Tabs.Content>
            {canAnalysis && analyses}
          </Tabs.Root>
        </div>
      </div>
      {!side && <DetectionDetailPanel selection={selection} side={false} onClose={close} onBack={back} />}
    </Shell>
  );
}

/** O rótulo de um filtro ativo, para a etiqueta que dá para remover (celular). */
function filterChipLabel(key: (typeof FILTER_KEYS)[number], value: string): string {
  switch (key) {
    case 'period':
      return value === CUSTOM_PERIOD
        ? 'Período personalizado'
        : (PERIOD_CHOICE_LABELS[value as keyof typeof PERIOD_CHOICE_LABELS] ?? value);
    case 'severity':
      return `Severidade: ${SEVERITY_STYLES[value as keyof typeof SEVERITY_STYLES]?.label ?? value}`;
    case 'status':
      return `Status: ${FINDING_STATUS_LABELS[value as keyof typeof FINDING_STATUS_LABELS]?.label ?? value}`;
    case 'source':
      return `Fonte: ${FINDING_SOURCE_LABELS[value as keyof typeof FINDING_SOURCE_LABELS] ?? value}`;
    case 'accountId':
      return `Conta: ${value}`;
    case 'tactic':
      return `Tática: ${value}`;
    case 'technique':
      return `Técnica: ${value}`;
    case 'q':
      return `Busca: ${value}`;
    case 'unassigned':
      return 'Sem responsável';
    default:
      return value;
  }
}

/**
 * Os filtros no celular (E-02): um botão "Filtros" abre os mesmos campos numa folha, com o "Exportar CSV"; os filtros
 * ativos ficam à vista como etiquetas que dá para remover. Nada some: "Limpar filtros" continua na folha.
 */
function MobileFilters({
  params,
  open,
  onOpenChange,
  onRemove,
  exportButton,
  children,
}: {
  params: URLSearchParams;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: (key: (typeof FILTER_KEYS)[number]) => void;
  exportButton: ReactNode;
  children: ReactNode;
}) {
  const active = FILTER_KEYS.filter((key) => key !== 'from' && key !== 'to').flatMap((key) => {
    const value = params.get(DETECTION_PARAMS[key]);
    return value ? [{ key, label: filterChipLabel(key, value) }] : [];
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          className="min-h-11"
          aria-haspopup="dialog"
          onClick={() => onOpenChange(true)}
        >
          <SlidersHorizontal aria-hidden />
          Filtros{active.length > 0 && ` (${active.length})`}
        </Button>
        {active.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className="inline-flex min-h-11 items-center gap-1 rounded-full border px-3 text-sm hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onRemove(key)}
          >
            {label}
            <X aria-hidden className="size-4" />
            <span className="sr-only">: remover o filtro</span>
          </button>
        ))}
      </div>
      <Sheet open={open} onOpenChange={onOpenChange} title="Filtros">
        <div className="space-y-4">
          {children}
          {exportButton}
        </div>
      </Sheet>
    </div>
  );
}

/** Exporta em CSV a lista filtrada de agora (até 2 000 linhas), sem passar por servidor além da própria API. */
function ExportButton({
  run,
  file,
}: {
  run: () => Promise<{ csv: string; rows: number; total: number }>;
  file: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const exportNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await run();
      const day = new Date().toISOString().slice(0, 10);
      downloadCsv(`verax-${file}-${day}.csv`, result.csv);
      setMessage({
        text:
          result.total > result.rows
            ? `Exportadas as primeiras ${result.rows.toLocaleString('pt-BR')} de ${plural(result.total, 'linha', 'linhas')}. Filtre para exportar o resto (o limite é de ${EXPORT_MAX_ROWS.toLocaleString('pt-BR')}).`
            : `${plural(result.rows, 'linha exportada', 'linhas exportadas')}.`,
      });
    } catch (error) {
      setMessage({ text: errorMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" disabled={busy} aria-busy={busy} onClick={() => void exportNow()}>
        <Download aria-hidden />
        {busy ? 'Exportando…' : 'Exportar CSV'}
      </Button>
      <p
        role={message?.error ? 'alert' : 'status'}
        className={cn(
          'max-w-xs text-right text-xs',
          message?.error ? 'text-critical-text' : 'text-muted-foreground',
        )}
      >
        {message?.text}
      </p>
    </div>
  );
}
