import { canWriteScopedExceptions, type Role, type ScopedException } from '@verax/shared';
import { useState } from 'react';
import { type Column, DataTable } from '@/components/data-table';
import { ConfirmButton, FormError } from '@/features/admin/admin-ui';
import { SCOPED_PAGE_SIZE, useRevokeScoped, useScopedList } from '@/features/cases/case-exceptions-api';
import { useCaseMode } from '@/features/cases/cases-api';
import { ApiRequestError } from '@/lib/api-client';
import { formatRelative, plural } from '@/lib/format';

const dayFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const SEVERITY_WORDS = { low: 'baixa', medium: 'média', high: 'alta' } as const;

/** O alvo da exceção ampla, em texto: tudo o que veio do log é texto. */
function targetOf(row: ScopedException): string {
  const parts = [row.logSource, `conta ${row.accountId}`];
  if (row.eventName !== null) parts.push(row.eventName);
  if (row.resourcePrefix !== null) parts.push(`recurso começa com ${row.resourcePrefix}`);
  return parts.join(' · ');
}

function stateOf(row: ScopedException): string {
  if (row.revokedAt !== null) {
    return `Revogada em ${dayFormat.format(new Date(row.revokedAt))}${row.revokedBy ? ` por ${row.revokedBy.name}` : ''}`;
  }
  if (!row.active) return `Vencida em ${dayFormat.format(new Date(row.expiresAt))}`;
  return `até ${dayFormat.format(new Date(row.expiresAt))}`;
}

/**
 * As exceções amplas (casos, PR-9) na tela Exceções. Só aparecem com os casos ligados e com o nó que as conhece: com os
 * casos desligados, ou um nó de antes (404), a tela é a de sempre. Revogar, só administradores; quem decide é a API.
 */
export function ScopedExceptionsSection({ scope, role }: { scope: string | null; role: Role | null }) {
  const { mode } = useCaseMode(scope);
  const [page, setPage] = useState(1);
  const list = useScopedList(page, mode === 'on');
  const revoke = useRevokeScoped();
  const canRevoke = role !== null && canWriteScopedExceptions(role);
  if (mode !== 'on') return null;
  if (list.error instanceof ApiRequestError && list.error.status === 404) return null;

  const columns: Column<ScopedException>[] = [
    {
      key: 'regra',
      card: 'title',
      header: 'Regra',
      cell: (row) => <span className="font-mono text-sm">{row.ruleId}</span>,
    },
    {
      key: 'alvo',
      header: 'Quando',
      className: 'min-w-64',
      cell: (row) => <span className="text-xs wrap-anywhere">{targetOf(row)}</span>,
    },
    { key: 'severidade', header: 'Severidade', cell: (row) => `Até ${SEVERITY_WORDS[row.maxSeverity]}` },
    {
      key: 'motivo',
      header: 'Motivo',
      className: 'min-w-48',
      cell: (row) => <span className="wrap-anywhere">{row.reason}</span>,
    },
    {
      key: 'marcou',
      header: 'Já marcou',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <span>
          {plural(row.matchedCount, 'alerta', 'alertas')}
          {row.lastMatchedAt && (
            <span className="block text-xs text-muted-foreground">
              último {formatRelative(row.lastMatchedAt)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'validade',
      header: 'Validade',
      cell: (row) => (
        <span className={row.active ? undefined : 'font-medium text-critical-text'}>{stateOf(row)}</span>
      ),
    },
    ...(canRevoke
      ? [
          {
            key: 'acao',
            header: 'Ações',
            cell: (row: ScopedException) =>
              row.revokedAt === null && row.active ? (
                <ConfirmButton
                  size="sm"
                  label="Revogar"
                  ariaLabel={`Revogar a exceção ampla da regra ${row.ruleId}`}
                  confirmLabel="Confirmar"
                  busy={revoke.isPending}
                  onConfirm={() => revoke.mutate(row.id)}
                />
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <section aria-labelledby="excecoes-amplas" className="mt-8 space-y-3">
      <h2 id="excecoes-amplas" className="text-lg font-semibold">
        Exceções amplas
      </h2>
      <p className="text-sm text-muted-foreground">
        Criadas a partir de um caso, por administradores: um alerta novo da regra, na fonte e na conta (e no
        evento ou no recurso, se informados) entra como legítimo até a severidade escolhida. Valem por até 90
        dias e nunca para críticos.
      </p>
      <FormError error={revoke.error} />
      <DataTable
        caption="Exceções amplas do cliente"
        columns={columns}
        rows={list.data?.items}
        rowKey={(row) => row.id}
        page={page}
        pageSize={SCOPED_PAGE_SIZE}
        total={list.data?.total ?? 0}
        onPageChange={setPage}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyTitle="Nenhuma exceção ampla"
        emptyDescription="No detalhe de um caso, use Criar exceção."
      />
    </section>
  );
}
