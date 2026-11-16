import { type DetectionFilters, FINDING_PERIODS, hasContentFilter, type Permission } from '@verax/shared';
import { Download } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DetectionDetailPanel } from '@/features/detections/detail-panel';
import { FindingsList, GroupedList } from '@/features/detections/detection-list';
import { useDetections } from '@/features/detections/detections-api';
import { EXPORT_MAX_ROWS, exportFindings, exportGrouped } from '@/features/detections/export';
import { FilterBar } from '@/features/detections/filter-bar';
import { SituationStrip } from '@/features/detections/situation-strip';
import {
  ANALYSIS_SLUGS,
  type DetectionAnalysis,
  type DetectionSelection,
  readDetectionState,
  withChanges,
} from '@/features/detections/url-state';
import { useFindings } from '@/features/findings/findings-api';
import { usePeriodFilter } from '@/features/plan/plan-history';
import { downloadCsv } from '@/features/reports/csv';
import { CoverageReportView, MitreReportView } from '@/features/reports/report-views';
import type { ReportRange } from '@/features/reports/reports-api';
import { useMe } from '@/features/session/session';
import { SIDE_PANEL_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';

const PAGE_SIZE = 20;

const ANALYSIS_TABS: readonly { value: DetectionAnalysis; label: string }[] = [
  { value: 'list', label: 'Lista' },
  { value: 'mitre', label: 'MITRE ATT&CK' },
  { value: 'coverage', label: 'Cobertura das fontes' },
];

/**
 * Detecções (decisão do responsável de 16/11/2026): a tela de operação, no lugar da Torre, de Incidentes, de Achados e
 * de Relatórios. No topo, o resumo da situação (recolhível); embaixo, uma lista só, agrupada por incidente ou com todos
 * os achados, com um filtro só e o detalhe ao lado para a triagem. As análises que vieram dos Relatórios (MITRE e
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
      canGrouped={can('incidents:read') && can('findings:read')}
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
            Os alertas de segurança do cliente, agrupados em incidentes quando têm o mesmo usuário, chave, IP
            ou recurso. Abra um item para ver o detalhe e decidir o que fazer.
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
  canGrouped,
  canFindings,
  canAnalysis,
}: {
  scope: string;
  userId: string;
  canTower: boolean;
  canGrouped: boolean;
  canFindings: boolean;
  canAnalysis: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const state = readDetectionState(params);
  const view = canGrouped ? state.view : 'findings';
  const analysis = canAnalysis ? state.analysis : 'list';
  const listing = analysis === 'list';
  // O período só vai para a API se couber no histórico do plano; o seletor só oferece os que cabem.
  const periods = usePeriodFilter(
    FINDING_PERIODS,
    state.periodChoice && state.periodChoice !== 'custom' ? state.periodChoice : null,
  );
  const filters: DetectionFilters = { ...state.filters, period: periods.period };
  const { unassigned: _unassigned, ...findingFilters } = filters;
  const ready = !periods.waiting;
  const grouped = useDetections(
    {
      ...filters,
      ...(state.sort === 'severity' && { sort: 'severity' as const }),
      page: state.page,
      pageSize: PAGE_SIZE,
    },
    ready && listing && view === 'grouped',
  );
  const findings = useFindings(
    { ...findingFilters, page: state.page, pageSize: PAGE_SIZE },
    ready && listing && view === 'findings' && canFindings,
  );

  const side = useMediaQuery(SIDE_PANEL_QUERY);
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
  const empty = {
    emptyTitle: hasFilters ? 'Nenhuma detecção com esses filtros' : 'Nenhuma detecção ainda',
    emptyDescription: hasFilters
      ? 'Ajuste ou limpe os filtros.'
      : 'Os alertas das contas conectadas aparecem aqui assim que chegam. Os ligados pelo mesmo usuário, chave, IP ou recurso viram um incidente.',
  };
  const onPageChange = (page: number) => update({ page: String(page) }, { keepPage: true });

  const range: ReportRange =
    state.periodChoice === 'custom' && filters.from && filters.to
      ? { from: filters.from, to: filters.to }
      : { period: periods.period ?? '30d' };

  return (
    <Shell
      actions={
        listing && (
          <ExportButton
            run={() => (view === 'grouped' ? exportGrouped(filters, state.sort) : exportFindings(filters))}
            file={view === 'grouped' ? 'deteccoes' : 'achados'}
          />
        )
      }
    >
      {canTower && <SituationStrip scope={scope} userId={userId} />}

      <Tabs.Root
        value={analysis}
        onValueChange={(value) =>
          update({ analysis: ANALYSIS_SLUGS[value as DetectionAnalysis], incident: null, finding: null })
        }
        className="space-y-4"
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          {canAnalysis && (
            <Tabs.List
              data-tour="deteccoes-analise"
              aria-label="Como ver as detecções"
              className="flex flex-wrap gap-1 border-b"
            >
              {ANALYSIS_TABS.map((tab) => (
                <Tabs.Trigger
                  key={tab.value}
                  value={tab.value}
                  className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground"
                >
                  {tab.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          )}
          {listing && canGrouped && (
            <div role="group" aria-label="Visão da lista" className="inline-flex rounded-md border p-0.5">
              {(
                [
                  ['grouped', 'Agrupar por incidente'],
                  ['findings', 'Todos os achados'],
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
                    update({ view: value === 'findings' ? 'achados' : null, unassigned: null, sort: null })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <FilterBar
          key={`${view}:${analysis}`}
          state={{ ...state, view }}
          params={params}
          periodOptions={periods.options}
          onChange={(changes) => update(changes)}
          analysis={!listing}
        />

        <Tabs.Content value="list" className="focus:outline-none">
          <div className={cn('grid gap-4', side && selection && 'grid-cols-[minmax(0,1fr)_minmax(0,28rem)]')}>
            <div className="min-w-0">
              {view === 'grouped' ? (
                <GroupedList
                  page={{
                    rows: periods.waiting ? undefined : grouped.data?.items,
                    total: grouped.data?.total ?? 0,
                    page: state.page,
                    pageSize: PAGE_SIZE,
                    loading: grouped.isFetching && grouped.isPlaceholderData,
                    error: grouped.error,
                    onRetry: () => void grouped.refetch(),
                    onPageChange,
                    compact: side && selection !== null,
                    ...empty,
                  }}
                  selection={selection}
                  onOpen={open}
                  filtered={hasContentFilter(filters)}
                />
              ) : (
                <FindingsList
                  page={{
                    rows: periods.waiting ? undefined : findings.data?.items,
                    total: findings.data?.total ?? 0,
                    page: state.page,
                    pageSize: PAGE_SIZE,
                    loading: findings.isFetching && findings.isPlaceholderData,
                    error: findings.error,
                    onRetry: () => void findings.refetch(),
                    onPageChange,
                    compact: side && selection !== null,
                    ...empty,
                  }}
                  selection={selection}
                  onOpen={open}
                />
              )}
            </div>
            {side && <DetectionDetailPanel selection={selection} side onClose={close} />}
          </div>
        </Tabs.Content>
        {canAnalysis && (
          <>
            <Tabs.Content value="mitre" className="focus:outline-none">
              {periods.waiting ? null : (
                <MitreReportView
                  range={range}
                  tacticHref={(tactic) =>
                    `?${withChanges(params, { analysis: null, tactic: tactic.name, incident: null, finding: null }).toString()}`
                  }
                />
              )}
            </Tabs.Content>
            <Tabs.Content value="coverage" className="focus:outline-none">
              {periods.waiting ? null : <CoverageReportView range={range} />}
            </Tabs.Content>
          </>
        )}
      </Tabs.Root>
      {!side && <DetectionDetailPanel selection={selection} side={false} onClose={close} />}
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
