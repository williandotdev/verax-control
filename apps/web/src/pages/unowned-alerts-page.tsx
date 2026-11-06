import {
  agentIdOfRef,
  UNOWNED_PERIODS,
  UNOWNED_REASONS,
  type UnownedAccounts,
  type UnownedAlert,
  type UnownedAlertListQuery,
} from '@verax/shared';
import { X } from 'lucide-react';
import { useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { ReportTable } from '@/features/reports/report-table';
import { UNOWNED_PERIOD_LABELS, UNOWNED_REASON_LABELS } from '@/features/unowned/labels';
import { useUnownedAccounts, useUnownedAlerts } from '@/features/unowned/unowned-api';
import { formatRelative, formatTimestamp } from '@/lib/format';

const PAGE_SIZE = 25;

const pick = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  values.find((candidate) => candidate === value);

/**
 * Fila de alertas sem dono (só a equipe da Verax): o que o sync não atribuiu a cliente nenhum, porque na dúvida o
 * alerta não é de ninguém. O resumo por conta responde à pergunta mais comum (qual conta falta cadastrar); a lista
 * traz cada alerta, com o motivo.
 */
export function UnownedAlertsPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  // Parâmetro vazio (`?conta=`) conta como ausente: a API recusaria a conta vazia.
  const account = params.get('conta') || undefined;
  const reason = pick(UNOWNED_REASONS, params.get('motivo'));
  const period = pick(UNOWNED_PERIODS, params.get('periodo'));
  const query: UnownedAlertListQuery = { reason, period, account, page, pageSize: PAGE_SIZE };
  const alerts = useUnownedAlerts(query);

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
  const hasFilters = reason !== undefined || period !== undefined || account !== undefined;
  const listHeading = useRef<HTMLHeadingElement>(null);
  /** Do resumo (30 dias) para a lista da mesma conta e do mesmo período, levando o foco até ela. */
  const showAccount = (item: string) => {
    update({ conta: item, periodo: '30d', motivo: null });
    listHeading.current?.focus();
    listHeading.current?.scrollIntoView({ block: 'start' });
  };

  const columns: Column<UnownedAlert>[] = [
    {
      key: 'quando',
      header: 'Quando',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <time dateTime={row.createdAt} title={formatTimestamp(row.createdAt)}>
          {formatRelative(row.createdAt)}
        </time>
      ),
    },
    { key: 'motivo', header: 'Motivo', cell: (row) => UNOWNED_REASON_LABELS[row.reason].label },
    {
      key: 'contas',
      header: 'Contas citadas',
      cell: (row) =>
        row.accounts.length === 0 ? (
          <span className="text-muted-foreground">Nenhuma</span>
        ) : (
          <ul className="space-y-0.5">
            {row.accounts.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  className="inline-flex min-h-6 items-center break-all py-0.5 text-left font-mono text-xs hover:underline"
                  title={
                    agentIdOfRef(item) === null
                      ? 'Ver só os alertas desta conta'
                      : 'Ver só os alertas deste agente'
                  }
                  onClick={() => update({ conta: item })}
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: 'alerta',
      header: 'Alerta',
      className: 'min-w-64',
      cell: (row) => (
        <>
          <span className="block">{row.title ?? 'Sem descrição'}</span>
          {row.ruleId && (
            <span className="block text-xs text-muted-foreground">
              Regra {row.ruleId}
              {row.ruleLevel !== null && ` · nível ${row.ruleLevel}`}
            </span>
          )}
        </>
      ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Alertas sem dono</h1>
        <p className="text-sm text-muted-foreground">
          Alertas que não foram atribuídos a nenhum cliente: na dúvida, um alerta não é de ninguém. Quase
          sempre falta cadastrar uma conta ou um bucket de log no cliente certo. Só a equipe da Verax vê esta
          fila.
        </p>
      </header>

      <AccountsSummary onPick={showAccount} />

      <section aria-labelledby="fila-alertas" className="space-y-3">
        <h2 id="fila-alertas" ref={listHeading} tabIndex={-1} className="text-lg font-semibold outline-none">
          Alertas
        </h2>
        {account !== undefined && (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {/* Nos alertas dos agentes, a fila cita o agente (`agent:<id>`) junto das contas. */}
            Só os alertas que citam {agentIdOfRef(account) === null ? 'a conta' : 'o agente'}{' '}
            <code className="font-mono text-xs">{agentIdOfRef(account) ?? account}</code>
            <Button variant="ghost" size="sm" onClick={() => update({ conta: null })}>
              <X aria-hidden />
              Ver de todas
            </Button>
          </p>
        )}
        {reason !== undefined && (
          <p className="text-sm text-muted-foreground">{UNOWNED_REASON_LABELS[reason].hint}</p>
        )}
        <DataTable
          caption="Alertas sem dono"
          columns={columns}
          rows={alerts.data?.items}
          rowKey={(row) => row.id}
          page={page}
          pageSize={PAGE_SIZE}
          total={alerts.data?.total ?? 0}
          onPageChange={(next) => update({ pagina: String(next) }, { keepPage: true })}
          loading={alerts.isPending}
          error={alerts.error}
          onRetry={() => void alerts.refetch()}
          emptyTitle={hasFilters ? 'Nenhum alerta com esses filtros' : 'Nenhum alerta sem dono'}
          emptyDescription={
            hasFilters
              ? 'Ajuste ou limpe os filtros.'
              : 'Todos os alertas recebidos foram atribuídos a um cliente.'
          }
          filters={
            <>
              <SelectField
                label="Motivo"
                value={reason ?? ''}
                onChange={(value) => update({ motivo: value || null })}
                options={[
                  { value: '', label: 'Todos' },
                  ...UNOWNED_REASONS.map((item) => ({
                    value: item,
                    label: UNOWNED_REASON_LABELS[item].label,
                  })),
                ]}
              />
              <SelectField
                label="Período"
                value={period ?? ''}
                onChange={(value) => update({ periodo: value || null })}
                options={[
                  { value: '', label: 'Todo o histórico' },
                  ...UNOWNED_PERIODS.map((item) => ({ value: item, label: UNOWNED_PERIOD_LABELS[item] })),
                ]}
              />
              {hasFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update({ motivo: null, periodo: null, conta: null })}
                >
                  Limpar filtros
                </Button>
              )}
            </>
          }
        />
      </section>
    </section>
  );
}

const NOT_REGISTERED = 'Não cadastrada';

/**
 * Onde a conta está cadastrada hoje. Um agente do Wazuh (`agent:<id>`, nos alertas das instâncias) não é conta: a
 * situação dele está no motivo de cada alerta.
 */
function situationOf(row: UnownedAccounts['items'][number]): string {
  if (agentIdOfRef(row.account) !== null) return 'Agente de instância';
  if (row.registeredIn === null) return NOT_REGISTERED;
  return `Cadastrada em ${row.registeredIn.tenantName}${row.registeredIn.active ? '' : ' (desativada)'}`;
}

/** As contas que mais aparecem na fila nos últimos 30 dias, e onde cada uma está cadastrada hoje. */
function AccountsSummary({ onPick }: { onPick: (account: string) => void }) {
  const accounts = useUnownedAccounts('30d');
  return (
    <section data-tour="sem-dono-contas" aria-labelledby="fila-contas" className="space-y-3">
      <div className="space-y-1">
        <h2 id="fila-contas" className="text-lg font-semibold">
          Contas que mais aparecem
        </h2>
        <p className="text-sm text-muted-foreground">
          Últimos 30 dias. Uma conta não cadastrada costuma ser a que falta cadastrar; uma já cadastrada
          explica alertas de antes do cadastro ou um bucket de log no cliente errado.
        </p>
      </div>
      {accounts.isError ? (
        <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : !accounts.data ? (
        <LoadingState rows={3} label="Carregando as contas" />
      ) : (
        <ReportTable
          caption="Contas citadas nos alertas sem dono"
          file="fila-sem-dono-contas"
          rows={accounts.data.items}
          rowKey={(row) => row.account}
          empty="Nenhuma conta citada nos alertas sem dono do período."
          columns={[
            {
              header: 'Conta',
              cell: (row) => <span className="break-all font-mono text-xs">{row.account}</span>,
              csv: (row) => row.account,
            },
            { header: 'Alertas', align: 'right', cell: (row) => row.alerts, csv: (row) => row.alerts },
            {
              header: 'Último',
              cell: (row) => (
                <time dateTime={row.lastSeenAt} title={formatTimestamp(row.lastSeenAt)}>
                  {formatRelative(row.lastSeenAt)}
                </time>
              ),
              csv: (row) => row.lastSeenAt,
            },
            {
              header: 'Situação',
              cell: (row) => (
                <span className={situationOf(row) === NOT_REGISTERED ? 'font-medium' : ''}>
                  {situationOf(row)}
                </span>
              ),
              csv: situationOf,
            },
            {
              header: 'O que fazer',
              cell: (row) => (
                <span className="flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onPick(row.account)}
                    aria-label={
                      agentIdOfRef(row.account) === null
                        ? `Ver alertas da conta ${row.account}`
                        : `Ver alertas do agente ${agentIdOfRef(row.account)}`
                    }
                  >
                    Ver alertas
                  </Button>
                  {/* Um agente não se cadastra em Contas cloud: ele entra na lista do nó pelo registro no manager. */}
                  {row.registeredIn === null && agentIdOfRef(row.account) === null && (
                    <Link
                      to="/cadastros/contas"
                      aria-label={`Cadastrar conta ${row.account}`}
                      className="inline-flex items-center text-sm font-medium underline-offset-4 hover:underline"
                    >
                      Cadastrar conta
                    </Link>
                  )}
                </span>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
