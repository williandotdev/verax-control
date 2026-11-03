import {
  AUDIT_OUTCOMES,
  AUDIT_PERIODS,
  AUDIT_RESOURCE_TYPES,
  type AuditEntry,
  type AuditListQuery,
} from '@verax/shared';
import { X } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { AuditActorName } from '@/features/audit/audit-actor';
import { useAuditEntries } from '@/features/audit/audit-api';
import { AuditOutcomeBadge } from '@/features/audit/audit-outcome-badge';
import { AuditPanel } from '@/features/audit/audit-panel';
import {
  actionLabel,
  AUDIT_OUTCOME_LABELS,
  AUDIT_PERIOD_LABELS,
  AUDIT_RESOURCE_LABELS,
  resourceLabel,
} from '@/features/audit/labels';
import { useMe } from '@/features/session/session';
import { formatRelative, formatTimestamp } from '@/lib/format';

const PAGE_SIZE = 25;

const pick = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  values.find((candidate) => candidate === value);

/**
 * Auditoria: a trilha de quem fez o quê, quando e de onde. Os administradores leem; ninguém altera nem apaga. Os
 * filtros e o registro aberto ficam na URL, para um link levar à mesma visão.
 */
export function AuditPage() {
  const { data: me } = useMe();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  // Parâmetro vazio (`?pessoa=`) conta como ausente: a API recusaria a pessoa vazia.
  const actorId = params.get('pessoa') || undefined;
  const filters = {
    period: pick(AUDIT_PERIODS, params.get('periodo')),
    resourceType: pick(AUDIT_RESOURCE_TYPES, params.get('area')),
    outcome: pick(AUDIT_OUTCOMES, params.get('resultado')),
  };
  const query: AuditListQuery = { ...filters, actorId, page, pageSize: PAGE_SIZE };
  const entries = useAuditEntries(query);

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
  const hasFilters = Object.values(filters).some((value) => value !== undefined) || actorId !== undefined;
  const veraxTrail = me?.role === 'admin_verax' && me.scopeTenantId === null;
  const actorName = entries.data?.items.find((entry) => entry.actor.id === actorId)?.actor.name;

  const columns: Column<AuditEntry>[] = [
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
    {
      key: 'quem',
      header: 'Quem',
      cell: (row) =>
        row.actor.id === null ? (
          <AuditActorName actor={row.actor} />
        ) : (
          <button
            type="button"
            className="text-left hover:underline"
            title="Ver só as ações desta pessoa"
            onClick={(event) => {
              event.stopPropagation();
              update({ pessoa: row.actor.id });
            }}
          >
            <AuditActorName actor={row.actor} />
          </button>
        ),
    },
    {
      key: 'acao',
      header: 'Ação',
      className: 'min-w-56',
      cell: (row) => (
        <button
          type="button"
          className="text-left font-medium hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            update({ registro: row.id }, { keepPage: true });
          }}
        >
          {actionLabel(row.action)}
          {row.resourceType && (
            <span className="block text-xs font-normal text-muted-foreground">
              {resourceLabel(row.resourceType)}
            </span>
          )}
        </button>
      ),
    },
    { key: 'resultado', header: 'Resultado', cell: (row) => <AuditOutcomeBadge outcome={row.outcome} /> },
    {
      key: 'origem',
      header: 'Origem',
      cell: (row) => <span className="break-all font-mono text-xs">{row.ip ?? '—'}</span>,
    },
  ];

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Auditoria</h1>
        <p className="text-sm text-muted-foreground">
          {veraxTrail
            ? 'Trilha da Verax: logins da equipe da Verax, o que ela faz sem tocar dados de um cliente (como cuidar dos usuários da Verax) e tentativas de login de quem não chegou a se identificar. O que a Verax faz num cliente, inclusive o cadastro dele, fica na trilha do cliente: escolha-o no seletor do topo.'
            : 'Tudo o que foi feito no painel deste cliente: quem fez, o quê, quando e de onde. Os registros não podem ser alterados nem apagados.'}
        </p>
      </header>
      {actorId !== undefined && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          Só as ações de <strong>{actorName ?? 'uma pessoa'}</strong>
          <Button variant="ghost" size="sm" onClick={() => update({ pessoa: null })}>
            <X aria-hidden />
            Ver de todos
          </Button>
        </p>
      )}
      <DataTable
        caption="Trilha de auditoria"
        columns={columns}
        rows={entries.data?.items}
        rowKey={(row) => row.id}
        page={page}
        pageSize={PAGE_SIZE}
        total={entries.data?.total ?? 0}
        onPageChange={(next) => update({ pagina: String(next) }, { keepPage: true })}
        loading={entries.isPending}
        error={entries.error}
        onRetry={() => void entries.refetch()}
        onRowClick={(row) => update({ registro: row.id }, { keepPage: true })}
        emptyTitle={hasFilters ? 'Nenhum registro com esses filtros' : 'Nenhum registro ainda'}
        emptyDescription={
          hasFilters ? 'Ajuste ou limpe os filtros.' : 'Cada login e cada alteração no painel aparecem aqui.'
        }
        filters={
          <>
            <SelectField
              label="Período"
              value={filters.period ?? ''}
              onChange={(value) => update({ periodo: value || null })}
              options={[
                { value: '', label: 'Todo o histórico' },
                ...AUDIT_PERIODS.map((period) => ({ value: period, label: AUDIT_PERIOD_LABELS[period] })),
              ]}
            />
            <SelectField
              label="Área"
              value={filters.resourceType ?? ''}
              onChange={(value) => update({ area: value || null })}
              options={[
                { value: '', label: 'Todas' },
                ...AUDIT_RESOURCE_TYPES.map((type) => ({ value: type, label: AUDIT_RESOURCE_LABELS[type] })),
              ]}
            />
            <SelectField
              label="Resultado"
              value={filters.outcome ?? ''}
              onChange={(value) => update({ resultado: value || null })}
              options={[
                { value: '', label: 'Todos' },
                ...AUDIT_OUTCOMES.map((outcome) => ({
                  value: outcome,
                  label: AUDIT_OUTCOME_LABELS[outcome].label,
                })),
              ]}
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => update({ periodo: null, area: null, resultado: null, pessoa: null })}
              >
                Limpar filtros
              </Button>
            )}
          </>
        }
      />
      <AuditPanel
        id={params.get('registro')}
        onClose={() => update({ registro: null }, { keepPage: true })}
      />
    </section>
  );
}
