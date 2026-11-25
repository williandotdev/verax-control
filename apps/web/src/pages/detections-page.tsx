import { type DetectionFilters, FINDING_PERIODS, hasContentFilter, type Permission } from '@verax/shared';
import { Download } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DetectionDetailPanel } from '@/features/detections/detail-panel';
import { AlertsList, IncidentsList } from '@/features/detections/detection-list';
import { useDetections } from '@/features/detections/detections-api';
import { EXPORT_MAX_ROWS, exportFindings, exportIncidents } from '@/features/detections/export';
import { FilterBar } from '@/features/detections/filter-bar';
import { OriginBand } from '@/features/detections/origin-band';
import { SituationStrip } from '@/features/detections/situation-strip';
import { useStripPreference } from '@/features/detections/strip-preference';
import {
  ANALYSIS_SLUGS,
  type DetectionAnalysis,
  type DetectionSelection,
  type DetectionView,
  INCIDENTS_VIEW,
  readDetectionState,
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
import { SIDE_PANEL_QUERY, useMediaQuery, WIDE_LIST_QUERY } from '@/lib/use-media-query';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';

const PAGE_SIZE = 20;

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
    <DetectionsContent
      scope={scope}
      userId={me.userId}
      canTower={can('tower:read')}
      canIncidents={can('incidents:read') && can('findings:read')}
      canFindings={can('findings:read')}
      canAnalysis={can('reports:read')}
    />
  );
}

function Shell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Detecções</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Cada evento suspeito vira um alerta para validar: pode ser falso positivo. Quando a ameaça é real,
            quem opera promove o alerta, com os relacionados, a um incidente. Abra um item para ver o detalhe
            e decidir o que fazer.
          </p>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

function DetectionsContent({
  scope,
  userId,
  canTower,
  canIncidents,
  canFindings,
  canAnalysis,
}: {
  scope: string;
  userId: string;
  canTower: boolean;
  canIncidents: boolean;
  canFindings: boolean;
  canAnalysis: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const state = readDetectionState(params);
  const view: DetectionView = canIncidents ? state.view : 'alerts';
  const side = useMediaQuery(SIDE_PANEL_QUERY);
  const wide = useMediaQuery(WIDE_LIST_QUERY);
  const [stripExpanded, setStripExpanded] = useStripPreference(userId);
  // No computador a lista está sempre na tela, e as abas são só as análises: sem nenhuma na URL, o Resumo.
  const asked = canAnalysis ? state.analysis : 'list';
  const analysis: DetectionAnalysis = side && asked === 'list' ? 'summary' : asked;
  const listing = side || analysis === 'list';
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
    ready && listing && view === 'alerts' && canFindings,
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
  const analysisRef = useRef<HTMLDivElement>(null);
  // Quem chega por um link direto vem pelo que ele abre: o mapa do topo começa recolhido, só desta vez.
  const [deepLink] = useState(selection !== null || (canAnalysis && state.analysis !== 'list'));
  // Um link para uma análise abre nela, que no computador fica abaixo da lista.
  const linkedAnalysis = useRef(side && asked !== 'list');
  useEffect(() => {
    if (linkedAnalysis.current) analysisRef.current?.scrollIntoView({ block: 'start' });
  }, []);
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
      },
      { keepPage: true },
    );
  };
  const close = () => update({ incident: null, finding: null }, { keepPage: true });

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
  const dense = besideRadar && !wide;
  const compact = side && (selection !== null || dense);
  const tabs = side ? ANALYSIS_TABS.filter((tab) => tab.value !== 'list') : ANALYSIS_TABS;

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
  const viewToggle = listing && canIncidents && (
    <div
      data-tour="deteccoes-visao"
      role="group"
      aria-label="Visão da lista"
      className="inline-flex rounded-md border p-0.5"
    >
      {(
        [
          ['alerts', 'Alertas'],
          ['incidents', 'Incidentes'],
        ] as const
      ).map(([value, label]) => (
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
              view: value === 'incidents' ? INCIDENTS_VIEW : null,
              unassigned: null,
              sort: null,
            })
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
  const filterBar = (
    <FilterBar
      key={side ? view : `${view}:${analysis}`}
      state={{ ...state, view }}
      params={params}
      periodOptions={periods.options}
      onChange={(changes) => update(changes)}
      analysis={!listing}
    />
  );
  const list =
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
      <AlertsList
        page={{
          rows: periods.waiting ? undefined : findings.data?.items,
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
  const tabList = (
    <Tabs.List
      data-tour="deteccoes-analise"
      aria-label={side ? 'Análises das detecções' : 'Como ver as detecções'}
      className="flex flex-wrap gap-1 border-b"
    >
      {tabs.map((tab) => (
        <Tabs.Trigger
          key={tab.value}
          value={tab.value}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground"
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
                // No computador, a lista já está na tela: a análise continua aberta embaixo.
                ...(!side && { analysis: null }),
                tactic: tactic.name,
                incident: null,
                finding: null,
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

  return (
    <Shell
      actions={
        listing && (
          <ExportButton
            run={() =>
              view === 'incidents' ? exportIncidents(filters, state.sort) : exportFindings(filters)
            }
            file={view === 'incidents' ? 'incidentes' : 'alertas'}
          />
        )
      }
    >
      {originBand}
      {side ? (
        <>
          <div
            className={cn(
              'grid items-start gap-4',
              besideRadar &&
                'grid-cols-[minmax(0,24rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]',
            )}
          >
            {besideRadar && selection ? (
              <DetectionDetailPanel selection={selection} side onClose={close} />
            ) : (
              strip
            )}
            <div ref={listRef} className="min-w-0 scroll-mt-4 space-y-4">
              {viewToggle}
              {filterBar}
              <div
                className={cn(
                  'grid gap-4',
                  !besideRadar && selection && 'grid-cols-[minmax(0,1fr)_minmax(0,28rem)]',
                )}
              >
                <div className="min-w-0">{list}</div>
                {!besideRadar && <DetectionDetailPanel selection={selection} side onClose={close} />}
              </div>
            </div>
          </div>
          {canAnalysis && (
            <div ref={analysisRef} className="scroll-mt-4">
              <Tabs.Root
                value={analysis}
                onValueChange={(value) =>
                  update({ analysis: ANALYSIS_SLUGS[value as DetectionAnalysis] }, { keepPage: true })
                }
                className="space-y-4"
              >
                <div className="space-y-2">
                  {tabList}
                  <p className="text-xs text-muted-foreground">
                    As análises usam o período do filtro da lista; sem período, os últimos 30 dias.
                  </p>
                </div>
                {analyses}
              </Tabs.Root>
            </div>
          )}
        </>
      ) : (
        <>
          {strip}
          <Tabs.Root
            value={analysis}
            onValueChange={(value) =>
              update({
                analysis: ANALYSIS_SLUGS[value as DetectionAnalysis],
                incident: null,
                finding: null,
              })
            }
            className="space-y-4"
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              {canAnalysis && tabList}
              {viewToggle}
            </div>
            {filterBar}
            <Tabs.Content value="list" className="focus:outline-none">
              {list}
            </Tabs.Content>
            {canAnalysis && analyses}
          </Tabs.Root>
          <DetectionDetailPanel selection={selection} side={false} onClose={close} />
        </>
      )}
    </Shell>
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
