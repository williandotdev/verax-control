import { type Finding, FINDING_PERIODS, FINDING_SEVERITIES, FINDING_STATUSES } from '@verax/shared';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { SeverityBadge } from '@/components/security/severity-badge';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { SEVERITY_STYLES } from '@/design/severity';
import { FindingPanel } from '@/features/findings/finding-panel';
import { FindingStatusBadge } from '@/features/findings/finding-status-badge';
import { useCloudAccounts, useFindings } from '@/features/findings/findings-api';
import {
  FINDING_PERIOD_LABELS,
  FINDING_SOURCE_LABELS,
  FINDING_STATUS_LABELS,
  findingOriginId,
} from '@/features/findings/labels';
import {
  FINDING_FILTER_PARAMS,
  type FindingFilterKey,
  readFindingFilters,
} from '@/features/findings/filters';
import { usePeriodFilter } from '@/features/plan/plan-history';
import { useMe } from '@/features/session/session';
import { formatRelative, formatTimestamp } from '@/lib/format';

const PAGE_SIZE = 20;

/** Achados do cliente (T7.7): tabela com filtros e detalhe lateral com o evento bruto. */
export function FindingsPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const [params, setParams] = useSearchParams();
  // O período só vai para a API se couber no histórico do plano; o seletor só oferece os que cabem.
  const periods = usePeriodFilter(FINDING_PERIODS, params.get(FINDING_FILTER_PARAMS.period));
  const filters = { ...readFindingFilters(params), period: periods.period };
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const findings = useFindings({ ...filters, page, pageSize: PAGE_SIZE }, scope !== null && !periods.waiting);
  const accounts = useCloudAccounts(scope !== null);

  const update = (changes: Record<string, string | null>, { keepPage = false } = {}) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (!keepPage) next.delete('pagina');
      return next;
    });
  const setFilter = (key: FindingFilterKey, value: string) =>
    update({ [FINDING_FILTER_PARAMS[key]]: value || null });
  const hasFilters = Object.values(filters).some((value) => value !== undefined);

  if (me && scope === null) {
    return (
      <FindingsShell>
        <EmptyState
          title="Escolha um cliente"
          description="Os achados são de um cliente por vez. Escolha um no seletor do topo."
        />
      </FindingsShell>
    );
  }

  const columns: Column<Finding>[] = [
    { key: 'severidade', header: 'Severidade', cell: (row) => <SeverityBadge severity={row.severity} /> },
    {
      key: 'achado',
      header: 'Achado',
      className: 'min-w-64',
      cell: (row) => (
        <button
          type="button"
          className="text-left font-medium hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            update({ achado: row.id }, { keepPage: true });
          }}
        >
          {row.title}
          {row.eventName && (
            <span className="block text-xs font-normal text-muted-foreground">{row.eventName}</span>
          )}
        </button>
      ),
    },
    {
      key: 'conta',
      header: 'Conta',
      // Nos alertas das instâncias, a origem é o agente do Wazuh (`agente 001`).
      cell: (row) => <span className="font-mono text-xs">{findingOriginId(row.accountId)}</span>,
    },
    { key: 'origem', header: 'Origem', cell: (row) => FINDING_SOURCE_LABELS[row.source] },
    {
      key: 'ator',
      header: 'Usuário ou IP',
      cell: (row) => <span className="break-all">{row.actor.user ?? row.actor.ip ?? '—'}</span>,
    },
    {
      key: 'quando',
      header: 'Quando',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <time dateTime={row.occurredAt} title={formatTimestamp(row.occurredAt)}>
          {formatRelative(row.occurredAt)}
        </time>
      ),
    },
    { key: 'status', header: 'Status', cell: (row) => <FindingStatusBadge status={row.status} /> },
  ];

  return (
    <FindingsShell>
      <DataTable
        caption="Achados do cliente"
        columns={columns}
        rows={findings.data?.items}
        rowKey={(row) => row.id}
        page={page}
        pageSize={PAGE_SIZE}
        total={findings.data?.total ?? 0}
        onPageChange={(next) => update({ pagina: String(next) }, { keepPage: true })}
        loading={findings.isPending}
        error={findings.error}
        onRetry={() => void findings.refetch()}
        onRowClick={(row) => update({ achado: row.id }, { keepPage: true })}
        emptyTitle={hasFilters ? 'Nenhum achado com esses filtros' : 'Nenhum achado ainda'}
        emptyDescription={
          hasFilters
            ? 'Ajuste ou limpe os filtros.'
            : 'Os alertas aparecem aqui assim que chegam das contas conectadas.'
        }
        filters={
          <>
            <SelectField
              label="Severidade"
              value={filters.severity ?? ''}
              onChange={(value) => setFilter('severity', value)}
              options={[
                { value: '', label: 'Todas' },
                ...FINDING_SEVERITIES.map((severity) => ({
                  value: severity,
                  label: SEVERITY_STYLES[severity].label,
                })),
              ]}
            />
            <SelectField
              label="Status"
              value={filters.status ?? ''}
              onChange={(value) => setFilter('status', value)}
              options={[
                { value: '', label: 'Todos' },
                ...FINDING_STATUSES.map((status) => ({
                  value: status,
                  label: FINDING_STATUS_LABELS[status].label,
                })),
              ]}
            />
            <SelectField
              label="Conta"
              value={filters.accountId ?? ''}
              onChange={(value) => setFilter('accountId', value)}
              options={[
                { value: '', label: 'Todas' },
                ...(accounts.data ?? []).map((account) => ({
                  value: account.accountId,
                  label: account.accountId,
                })),
              ]}
            />
            <SelectField
              label="Período"
              value={filters.period ?? ''}
              onChange={(value) => setFilter('period', value)}
              options={[
                { value: '', label: 'Todo o histórico' },
                ...periods.options.map((period) => ({ value: period, label: FINDING_PERIOD_LABELS[period] })),
              ]}
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => update({ severidade: null, status: null, conta: null, periodo: null })}
              >
                Limpar filtros
              </Button>
            )}
          </>
        }
      />
      <FindingPanel id={params.get('achado')} onClose={() => update({ achado: null }, { keepPage: true })} />
    </FindingsShell>
  );
}

function FindingsShell({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Achados</h1>
        <p className="text-sm text-muted-foreground">
          Alertas de segurança das contas do cliente, já vinculados a ele. Abra um achado para ver o evento
          completo e decidir o que fazer.
        </p>
      </header>
      {children}
    </section>
  );
}
