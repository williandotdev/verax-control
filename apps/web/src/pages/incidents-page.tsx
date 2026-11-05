import { agentIdOfRef, FINDING_SEVERITIES, type Incident, INCIDENT_STATUSES } from '@verax/shared';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { SeverityBadge } from '@/components/security/severity-badge';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { SEVERITY_STYLES } from '@/design/severity';
import { findingOriginLabel } from '@/features/findings/labels';
import { IncidentStatusBadge } from '@/features/incidents/incident-status-badge';
import { useIncidents } from '@/features/incidents/incidents-api';
import { INCIDENT_FILTER_PARAMS, INCIDENT_STATUS_LABELS } from '@/features/incidents/labels';
import { incidentTitle } from '@/features/incidents/narrative';
import { useMe } from '@/features/session/session';
import { formatRelative, formatTimestamp, plural } from '@/lib/format';

const PAGE_SIZE = 20;
const NO_ASSIGNEE = 'nenhum';

const pick = <T extends string>(allowed: readonly T[], value: string | null): T | undefined =>
  allowed.find((candidate) => candidate === value);

/** Incidentes do cliente (T7.8): ordenados pela nota de risco, com severidade, ativos e tempo aberto. */
export function IncidentsPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const [params, setParams] = useSearchParams();
  const status = pick(INCIDENT_STATUSES, params.get(INCIDENT_FILTER_PARAMS.status));
  const severity = pick(FINDING_SEVERITIES, params.get(INCIDENT_FILTER_PARAMS.severity));
  const unassigned = params.get(INCIDENT_FILTER_PARAMS.unassigned) === NO_ASSIGNEE ? 'true' : undefined;
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const incidents = useIncidents({ status, severity, unassigned, page, pageSize: PAGE_SIZE }, scope !== null);
  const hasFilters = Boolean(status ?? severity ?? unassigned);

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

  if (me && scope === null) {
    return (
      <IncidentsShell>
        <EmptyState
          title="Escolha um cliente"
          description="Os incidentes são de um cliente por vez. Escolha um no seletor do topo."
        />
      </IncidentsShell>
    );
  }

  const columns: Column<Incident>[] = [
    {
      key: 'nota',
      header: 'Nota',
      cell: (row) => (
        <span className="text-lg font-semibold" aria-label={`Nota de risco ${row.riskScore} de 100`}>
          {row.riskScore}
        </span>
      ),
    },
    {
      key: 'incidente',
      header: 'Incidente',
      className: 'min-w-64',
      cell: (row) => (
        <div>
          <Link to={`/incidentes/${row.id}`} className="font-medium hover:underline">
            {incidentTitle(row)}
          </Link>
          <span className="block text-xs text-muted-foreground">
            {plural(row.findingCount, 'achado', 'achados')} ·{' '}
            {row.accounts.length === 1
              ? findingOriginLabel(row.accounts[0] ?? '')
              : row.accounts.some((origin) => agentIdOfRef(origin) !== null)
                ? plural(row.accounts.length, 'origem', 'origens')
                : plural(row.accounts.length, 'conta', 'contas')}
          </span>
        </div>
      ),
    },
    { key: 'severidade', header: 'Severidade', cell: (row) => <SeverityBadge severity={row.severity} /> },
    {
      key: 'ativos',
      header: 'Ativos',
      cell: (row) =>
        row.resources.length === 0 ? (
          '—'
        ) : (
          <span className="break-all text-xs">
            {row.resources[0]}
            {row.resources.length > 1 && ` e mais ${row.resources.length - 1}`}
          </span>
        ),
    },
    {
      key: 'aberto',
      header: 'Aberto',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <time dateTime={row.firstSeenAt} title={formatTimestamp(row.firstSeenAt)}>
          {formatRelative(row.firstSeenAt)}
        </time>
      ),
    },
    {
      key: 'responsavel',
      header: 'Responsável',
      cell: (row) => row.assignee?.name ?? <span className="text-muted-foreground">Ninguém</span>,
    },
    { key: 'status', header: 'Status', cell: (row) => <IncidentStatusBadge status={row.status} /> },
  ];

  return (
    <IncidentsShell>
      <DataTable
        caption="Incidentes do cliente, pela nota de risco"
        columns={columns}
        rows={incidents.data?.items}
        rowKey={(row) => row.id}
        page={page}
        pageSize={PAGE_SIZE}
        total={incidents.data?.total ?? 0}
        onPageChange={(next) => update({ pagina: String(next) }, { keepPage: true })}
        loading={incidents.isPending}
        error={incidents.error}
        onRetry={() => void incidents.refetch()}
        emptyTitle={hasFilters ? 'Nenhum incidente com esses filtros' : 'Nenhum incidente'}
        emptyDescription={
          hasFilters
            ? 'Ajuste ou limpe os filtros.'
            : 'Achados ligados pelo mesmo usuário, chave, IP ou recurso viram um incidente.'
        }
        filters={
          <>
            <SelectField
              label="Status"
              value={status ?? ''}
              onChange={(value) => update({ [INCIDENT_FILTER_PARAMS.status]: value || null })}
              options={[
                { value: '', label: 'Todos' },
                ...INCIDENT_STATUSES.map((value) => ({ value, label: INCIDENT_STATUS_LABELS[value].label })),
              ]}
            />
            <SelectField
              label="Severidade"
              value={severity ?? ''}
              onChange={(value) => update({ [INCIDENT_FILTER_PARAMS.severity]: value || null })}
              options={[
                { value: '', label: 'Todas' },
                ...FINDING_SEVERITIES.map((value) => ({ value, label: SEVERITY_STYLES[value].label })),
              ]}
            />
            <SelectField
              label="Responsável"
              value={unassigned ? NO_ASSIGNEE : ''}
              onChange={(value) => update({ [INCIDENT_FILTER_PARAMS.unassigned]: value || null })}
              options={[
                { value: '', label: 'Todos' },
                { value: NO_ASSIGNEE, label: 'Sem responsável' },
              ]}
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  update({
                    [INCIDENT_FILTER_PARAMS.status]: null,
                    [INCIDENT_FILTER_PARAMS.severity]: null,
                    [INCIDENT_FILTER_PARAMS.unassigned]: null,
                  })
                }
              >
                Limpar filtros
              </Button>
            )}
          </>
        }
      />
    </IncidentsShell>
  );
}

function IncidentsShell({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Incidentes</h1>
        <p className="text-sm text-muted-foreground">
          Achados do mesmo usuário, chave de acesso, IP ou recurso, agrupados. Os de maior risco vêm primeiro.
        </p>
      </header>
      {children}
    </section>
  );
}
