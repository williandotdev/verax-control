import { type CaseSummary, type DetectionFilters, MAX_TRIAGE_CASES } from '@verax/shared';
import { CheckSquare, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import type { ListPage } from '@/features/detections/detection-list';
import {
  type CaseUrlState,
  type DetectionSelection,
  viewParam,
  withChanges,
} from '@/features/detections/url-state';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';
import { useMediaQuery } from '@/lib/use-media-query';
import { addPending, filterTarget, scopeOfCases, selectionNote, sumPending } from './bulk';
import { BulkBar } from './bulk-bar';
import { CaseTable, type OpenItem } from './case-list';
import { caseListQuery, casePage, groupedState, isGrouped } from './case-query';
import { useCaseGroups, useCases, useRecheckMode } from './cases-api';
import { useCasesContext } from './cases-context';
import { caseCount, severityApplies } from './labels';
import { useListSelection } from './use-list-selection';
import { VulnerabilityGroups } from './vulnerability-groups';

const PAGE_SIZE = 20;
/** Com o menu lateral, a lista fica estreita até esta largura: as colunas que não cabem vão para baixo do título. */
const NARROW_LIST_QUERY = '(max-width: 64rem)';
/** Quanto tempo um alerta pode esperar por um caso antes de a tela avisar. */
const LATE_MINUTES = 10;

interface ViewProps {
  filters: DetectionFilters;
  cases: CaseUrlState;
  page: number;
  /** O período ainda espera o histórico do plano: nada é pedido. */
  ready: boolean;
  compact: boolean;
  dense: boolean;
  selection: DetectionSelection;
  onOpen: OpenItem;
  onPageChange: (page: number) => void;
}

/** Os casos (detecção e postura) e a fila de vulnerabilidades: a lista, a seleção e a barra da triagem em massa. */
export function CasesView({ view, ...given }: ViewProps & { view: 'cases' | 'vulnerabilities' }) {
  const narrow = useMediaQuery(NARROW_LIST_QUERY);
  const props = { ...given, dense: given.dense || narrow, compact: given.compact || narrow };
  return (
    <div className="space-y-3">
      <CasesNotice />
      {isGrouped(view, props.cases) ? <GroupedView {...props} /> : <ListView view={view} {...props} />}
      <p className="text-xs text-muted-foreground">
        {view === 'cases'
          ? 'Um caso reúne os alertas pendentes com a mesma origem e o mesmo alvo. Trate o caso inteiro de uma vez ou abra-o para ver alerta por alerta.'
          : 'Cada caso é um pacote num recurso. Agrupe por pacote para atualizar em todo lugar de uma vez, ou por recurso para ver o que há em cada um.'}
      </p>
    </div>
  );
}

/** A medição e o atraso do agrupamento, quando há o que avisar. */
function CasesNotice() {
  const { mode, status } = useCasesContext();
  const late = status?.oldestUnassignedMinutes ?? null;
  if (mode !== 'shadow' && (late === null || late <= LATE_MINUTES)) return null;
  return (
    <div className="space-y-2">
      {mode === 'shadow' && (
        <Notice>
          Medição: só a equipe da Verax vê os casos, e ninguém trata em massa ainda. O cliente continua na
          lista de alertas.
        </Notice>
      )}
      {late !== null && late > LATE_MINUTES && (
        <Notice>
          Há alertas esperando um caso há {late} minutos. Eles já aparecem em Alertas.
          {status?.asOf && ` Última passagem do agrupamento: ${formatRelative(status.asOf)}.`}
        </Notice>
      )}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="flex items-start gap-2 rounded-md border p-2 text-sm text-foreground">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A seleção de casos, com o teto da API. Só o caso com pendência pode ser marcado. */
function useCaseSelection(resetKey: string, stale: boolean) {
  return useListSelection<CaseSummary>({
    limit: MAX_TRIAGE_CASES,
    resetKey,
    stale,
    blocked: (row) => (sumPending(row.pending) === 0 ? 'nada pendente' : null),
  });
}

/** No celular, o botão que mostra as caixas de seleção; no computador elas estão sempre lá. */
function SelectingButton({ selecting, onChange }: { selecting: boolean; onChange: (next: boolean) => void }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="h-11 md:hidden"
      aria-pressed={selecting}
      onClick={() => onChange(!selecting)}
    >
      <CheckSquare aria-hidden />
      {selecting ? 'Cancelar a seleção' : 'Selecionar'}
    </Button>
  );
}

function ListView({
  view,
  filters,
  cases,
  page,
  ready,
  compact,
  dense,
  selection,
  onOpen,
  onPageChange,
}: ViewProps & { view: 'cases' | 'vulnerabilities' }) {
  const { canTriage, openBulk, mode } = useCasesContext();
  const [params] = useSearchParams();
  const query = caseListQuery({ view, filters, cases, page, pageSize: PAGE_SIZE });
  const { page: _page, pageSize: _pageSize, sort: _sort, ...filter } = query;
  const list = useCases(query, ready);
  useRecheckMode(list.error);
  const selected = useCaseSelection(JSON.stringify(filter), list.isPlaceholderData);
  const rows = ready ? list.data?.items : undefined;
  const total = list.data?.total ?? 0;

  const target = severityApplies(cases.state) ? filterTarget({ ...filter, state: cases.state }) : null;
  const items = selected.items(rows ?? []);
  const onScreen = selected.filter || items.length > 0;
  const hasFilters = Object.entries(filter).some(
    ([key, value]) => value !== undefined && key !== 'queue' && key !== 'state',
  );
  const open = (action?: Parameters<typeof openBulk>[0]['action']) => {
    const extra = { ...(action && { action }), onAccepted: selected.clear };
    if (selected.filter && target !== null) {
      openBulk({ kind: 'filter', filter: target, label: 'casos do filtro', ...extra });
    } else if (items.length > 0) openBulk({ kind: 'scope', scope: scopeOfCases(items), ...extra });
  };

  const table: ListPage<CaseSummary> = {
    rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    loading: list.isFetching && list.isPlaceholderData,
    error: list.error,
    onRetry: () => void list.refetch(),
    onPageChange,
    compact,
    dense,
    ...emptyTexts(view, cases, hasFilters),
  };
  const selectAll = canTriage && target !== null && total > 0 && !selected.filter && (
    <Button
      variant="secondary"
      size="sm"
      className="max-md:h-11"
      // O número da lista anterior não é o deste filtro.
      disabled={list.isPlaceholderData}
      onClick={selected.selectFilter}
    >
      {total === 1 ? 'Selecionar o caso do filtro' : `Selecionar os ${caseCount(total)} do filtro`}
    </Button>
  );
  return (
    <>
      {canTriage && severityApplies(cases.state) && (
        <div className={cn('flex flex-wrap items-center gap-2', !selectAll && 'md:hidden')}>
          <SelectingButton selecting={selected.selecting} onChange={selected.setSelecting} />
          {selectAll}
        </div>
      )}
      <CaseTable
        page={table}
        label={view === 'cases' ? 'Lista de casos' : 'Lista de vulnerabilidades'}
        caption={view === 'cases' ? 'Casos do cliente' : 'Casos de vulnerabilidade do cliente'}
        selection={selection}
        onOpen={onOpen}
        select={canTriage && severityApplies(cases.state) ? selected.select : undefined}
      />
      {rows?.length === 0 && view === 'cases' && cases.state !== 'all' && (
        // O alerta tratado antes dos casos não tem caso: continua na lista de alertas.
        <p className="text-center text-sm text-muted-foreground">
          <Link
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'underline')}
            to={{
              search: withChanges(params, {
                view: viewParam('alerts', mode),
                caseState: null,
                queue: null,
                sort: null,
                case: null,
              }).toString(),
            }}
          >
            Ver a lista de alertas
          </Link>
        </p>
      )}
      {canTriage && onScreen && (
        <BulkBar
          summary={selected.filter ? `Todos os ${caseCount(total)} do filtro` : caseCount(items.length)}
          pending={selected.filter ? null : addPending(items.map((row) => row.pending))}
          note={
            selectionNote(selected.refused, MAX_TRIAGE_CASES, 'casos') ??
            (target === null && total > items.length
              ? 'Para selecionar todos de uma vez, use um filtro além da fila, da situação e do período.'
              : null)
          }
          onAction={open}
          onClear={selected.clear}
        />
      )}
    </>
  );
}

function GroupedView({ filters, cases, page, ready, selection, onOpen, onPageChange }: ViewProps) {
  const { canTriage, openBulk } = useCasesContext();
  const by = cases.grouping === 'none' ? 'package' : cases.grouping;
  const state = groupedState(cases);
  const own = { state, severity: filters.severity, accountId: filters.accountId } as const;
  const groups = useCaseGroups(
    { queue: 'vulnerability', by, ...own, q: filters.q, page: casePage(page), pageSize: PAGE_SIZE },
    ready,
  );
  useRecheckMode(groups.error);
  const selected = useCaseSelection(JSON.stringify([by, own, filters.q]), groups.isPlaceholderData);
  const items = selected.items([]);
  const hasFilters = [filters.severity, filters.accountId, filters.q].some((value) => value !== undefined);
  return (
    <>
      {canTriage && (
        <div className="flex md:hidden">
          <SelectingButton selecting={selected.selecting} onChange={selected.setSelecting} />
        </div>
      )}
      <VulnerabilityGroups
        key={by}
        page={{
          rows: groups.data?.items,
          total: groups.data?.total ?? 0,
          page,
          pageSize: PAGE_SIZE,
          loading: groups.isFetching && groups.isPlaceholderData,
          error: groups.error,
          onRetry: () => void groups.refetch(),
          onPageChange,
          // As colunas da tabela de grupos cabem em qualquer largura.
          dense: true,
          ...emptyTexts('vulnerabilities', cases, hasFilters),
        }}
        by={by}
        filters={own}
        stale={groups.isPlaceholderData}
        selection={selection}
        onOpen={onOpen}
        select={canTriage ? selected.select : undefined}
      />
      {canTriage && items.length > 0 && (
        <BulkBar
          summary={caseCount(items.length)}
          pending={addPending(items.map((row) => row.pending))}
          note={selectionNote(selected.refused, MAX_TRIAGE_CASES, 'casos')}
          onAction={(action) =>
            openBulk({
              kind: 'scope',
              scope: scopeOfCases(items),
              ...(action && { action }),
              onAccepted: selected.clear,
            })
          }
          onClear={selected.clear}
        />
      )}
    </>
  );
}

function emptyTexts(
  view: 'cases' | 'vulnerabilities',
  cases: CaseUrlState,
  hasFilters: boolean,
): { emptyTitle: string; emptyDescription: string } {
  if (hasFilters) {
    return {
      emptyTitle:
        view === 'cases' ? 'Nenhum caso com esses filtros' : 'Nenhuma vulnerabilidade com esses filtros',
      emptyDescription: 'Ajuste ou limpe os filtros.',
    };
  }
  switch (cases.state) {
    case 'pending':
      return view === 'cases'
        ? {
            emptyTitle: 'Nenhum caso pendente nesta fila',
            emptyDescription:
              'Tudo o que chegou já foi tratado. Os alertas novos entram em casos em poucos segundos.',
          }
        : {
            emptyTitle: 'Nenhuma vulnerabilidade pendente',
            emptyDescription: 'Tudo o que o Inspector e os agentes acusaram já foi tratado.',
          };
    case 'investigating':
      return {
        emptyTitle: 'Nada em análise nesta fila',
        emptyDescription: 'Os casos com algum alerta em análise aparecem aqui.',
      };
    case 'treated':
      return {
        emptyTitle: 'Nenhum caso tratado',
        emptyDescription: 'O caso aparece aqui quando não sobra nenhum alerta pendente nele.',
      };
    case 'all':
      return { emptyTitle: 'Nenhum caso nesta fila', emptyDescription: 'Os alertas novos entram em casos.' };
  }
}
