import {
  type PostureAccount,
  type PostureCheck,
  POSTURE_SEVERITIES,
  type PostureSeverity,
} from '@verax/shared';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { ScoreMeter } from '@/components/security/score-meter';
import { ScoreTrend } from '@/components/security/score-trend';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectField } from '@/components/ui/select-field';
import { Sheet } from '@/components/ui/sheet';
import { DEFAULT_THRESHOLDS } from '@/design/score';
import { PostureSeverityBadge } from '@/features/posture/posture-severity-badge';
import { usePostureChecks, usePostureOverview } from '@/features/posture/posture-api';
import { useMe } from '@/features/session/session';
import { formatRelative } from '@/lib/format';

const PAGE_SIZE = 20;

const SEVERITY_NAMES: Record<PostureSeverity, { one: string; many: string }> = {
  critical: { one: 'Crítica', many: 'Críticas' },
  high: { one: 'Alta', many: 'Altas' },
  medium: { one: 'Média', many: 'Médias' },
  low: { one: 'Baixa', many: 'Baixas' },
  informational: { one: 'Informativa', many: 'Informativas' },
};

/** Postura cloud (T7.10): nota por conta com a evolução, e as checagens reprovadas com o passo de correção. */
export function PosturePage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const [params, setParams] = useSearchParams();
  const account = params.get('conta');
  const accountId = account && /^\d{12}$/.test(account) ? account : undefined;
  const severity = POSTURE_SEVERITIES.find((value) => value === params.get('severidade'));
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const overview = usePostureOverview(scope !== null);
  const checks = usePostureChecks({ accountId, severity, page, pageSize: PAGE_SIZE }, scope !== null);
  const openCheck = checks.data?.items.find((item) => item.id === params.get('checagem')) ?? null;

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
      <PostureShell>
        <EmptyState
          title="Escolha um cliente"
          description="A postura é de um cliente por vez. Escolha um no seletor do topo."
        />
      </PostureShell>
    );
  }
  if (overview.isError) {
    return (
      <PostureShell>
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      </PostureShell>
    );
  }
  if (!overview.data) {
    return (
      <PostureShell>
        <LoadingState rows={6} label="Carregando a postura" />
      </PostureShell>
    );
  }
  // Sem varredura é nenhuma conta com data de varredura. Uma varredura só com checagens informativas, manuais ou
  // silenciadas não gera nota, mas os resultados dela continuam visíveis.
  if (overview.data.accounts.every((item) => item.scannedAt === null)) {
    return (
      <PostureShell>
        <EmptyState
          title="Ainda sem varredura"
          description="O Prowler confere a configuração das contas uma vez por dia. A primeira nota aparece em até 24 horas depois de conectar a conta."
        />
      </PostureShell>
    );
  }

  const warningBelow = overview.data.warningBelow;
  const columns: Column<PostureCheck>[] = [
    {
      key: 'severidade',
      header: 'Gravidade',
      cell: (row) => <PostureSeverityBadge severity={row.severity} />,
    },
    {
      key: 'checagem',
      header: 'Checagem',
      className: 'min-w-64',
      cell: (row) => (
        <button
          type="button"
          className="text-left font-medium hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            update({ checagem: row.id }, { keepPage: true });
          }}
        >
          {row.title}
          <span className="block font-mono text-xs font-normal text-muted-foreground">{row.checkId}</span>
        </button>
      ),
    },
    {
      key: 'conta',
      header: 'Conta',
      cell: (row) => <span className="font-mono text-xs">{row.accountId}</span>,
    },
    { key: 'regiao', header: 'Região', cell: (row) => row.region },
    {
      key: 'recurso',
      header: 'Recurso',
      cell: (row) => <span className="break-all text-xs">{row.resource ?? '—'}</span>,
    },
  ];

  return (
    <PostureShell>
      <div className="grid gap-4 md:grid-cols-2">
        {overview.data.accounts.map((item) => (
          <AccountCard
            key={item.accountId}
            account={item}
            warningBelow={warningBelow}
            onShowChecks={() => update({ conta: item.accountId, severidade: null, checagem: null })}
          />
        ))}
      </div>

      <section aria-labelledby="postura-checagens" className="space-y-3">
        <h2 id="postura-checagens" className="text-lg font-semibold">
          O que corrigir, do mais grave ao menos grave
        </h2>
        <DataTable
          caption="Checagens reprovadas na última varredura"
          columns={columns}
          rows={checks.data?.items}
          rowKey={(row) => row.id}
          page={page}
          pageSize={PAGE_SIZE}
          total={checks.data?.total ?? 0}
          onPageChange={(next) => update({ pagina: String(next) }, { keepPage: true })}
          loading={checks.isPending}
          error={checks.error}
          onRetry={() => void checks.refetch()}
          onRowClick={(row) => update({ checagem: row.id }, { keepPage: true })}
          emptyTitle="Nenhuma checagem reprovada com esses filtros"
          filters={
            <>
              <SelectField
                label="Conta"
                value={accountId ?? ''}
                onChange={(value) => update({ conta: value || null })}
                options={[
                  { value: '', label: 'Todas' },
                  ...overview.data.accounts.map((item) => ({ value: item.accountId, label: item.accountId })),
                ]}
              />
              <SelectField
                label="Gravidade"
                value={severity ?? ''}
                onChange={(value) => update({ severidade: value || null })}
                options={[
                  { value: '', label: 'Todas' },
                  ...POSTURE_SEVERITIES.map((value) => ({ value, label: SEVERITY_NAMES[value].one })),
                ]}
              />
              {(accountId ?? severity) && (
                <Button variant="ghost" size="sm" onClick={() => update({ conta: null, severidade: null })}>
                  Limpar filtros
                </Button>
              )}
            </>
          }
        />
      </section>

      <Sheet
        open={openCheck !== null}
        onOpenChange={(open) => {
          if (!open) update({ checagem: null }, { keepPage: true });
        }}
        title={openCheck?.title ?? 'Checagem'}
        description={
          openCheck ? `${openCheck.checkId} · conta ${openCheck.accountId} · ${openCheck.region}` : undefined
        }
      >
        {openCheck && <CheckDetail check={openCheck} />}
      </Sheet>
    </PostureShell>
  );
}

function AccountCard({
  account,
  warningBelow,
  onShowChecks,
}: {
  account: PostureAccount;
  warningBelow: number;
  onShowChecks: () => void;
}) {
  const failed = POSTURE_SEVERITIES.filter((severity) => account.failedBySeverity[severity] > 0);
  return (
    <Card aria-labelledby={`postura-${account.accountId}`}>
      <CardHeader>
        <CardTitle id={`postura-${account.accountId}`}>Conta {account.accountId}</CardTitle>
        {account.scannedAt && (
          <span className="text-xs text-muted-foreground">varredura {formatRelative(account.scannedAt)}</span>
        )}
      </CardHeader>
      {account.scannedAt === null ? (
        <p className="text-sm text-muted-foreground">Ainda sem varredura nesta conta.</p>
      ) : (
        <div className="space-y-4">
          {account.score === null ? (
            <p className="text-sm text-muted-foreground">
              Sem nota nesta varredura: nenhuma checagem que conta para a nota (só informativas, manuais ou
              silenciadas).
            </p>
          ) : (
            <ScoreMeter score={account.score} thresholds={{ ...DEFAULT_THRESHOLDS, warning: warningBelow }} />
          )}
          <ScoreTrend
            points={account.history}
            warningBelow={warningBelow}
            label={`Evolução da nota da conta ${account.accountId}`}
          />
          <p className="text-sm text-muted-foreground">
            {account.passed} aprovadas e {account.failed} reprovadas
            {failed.length > 0 &&
              `: ${failed
                .map((severity) => {
                  const count = account.failedBySeverity[severity];
                  const name = SEVERITY_NAMES[severity];
                  return `${count} ${(count === 1 ? name.one : name.many).toLowerCase()}`;
                })
                .join(', ')}`}
            .
          </p>
          {account.failed > 0 && (
            <Button variant="secondary" size="sm" onClick={onShowChecks}>
              Ver o que corrigir nesta conta
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function CheckDetail({ check }: { check: PostureCheck }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <PostureSeverityBadge severity={check.severity} />
        {check.resource && <span className="break-all font-mono text-xs">{check.resource}</span>}
      </div>
      {check.risk && (
        <section aria-label="Por que importa" className="space-y-1">
          <h3 className="text-sm font-semibold">Por que importa</h3>
          <p className="text-sm">{check.risk}</p>
        </section>
      )}
      <section aria-label="Como corrigir" className="space-y-1">
        <h3 className="text-sm font-semibold">Como corrigir</h3>
        {check.remediation ? (
          <div className="space-y-2 rounded-md border bg-foreground/[0.03] p-3 text-sm">
            {check.remediation.split('\n').map((line, index) =>
              // Linha de comando da AWS em fonte monoespaçada, para copiar sem erro.
              line.startsWith('aws ') ? (
                <code key={index} className="block break-all font-mono text-xs">
                  {line}
                </code>
              ) : (
                <p key={index} className="break-words">
                  {line}
                </p>
              ),
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            O Prowler não informou o passo de correção desta checagem.
          </p>
        )}
      </section>
      {check.references.length > 0 && (
        <section aria-label="Referências" className="space-y-1">
          <h3 className="text-sm font-semibold">Referências</h3>
          <ul className="space-y-1 text-sm">
            {check.references.map((reference) => (
              <li key={reference}>
                <a
                  href={reference}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${new URL(reference).hostname} (abre em outra aba)`}
                  className="inline-flex items-center gap-1 break-all underline"
                >
                  {new URL(reference).hostname}
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function PostureShell({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Postura cloud</h1>
        <p className="text-sm text-muted-foreground">
          A configuração das contas AWS, conferida pelo Prowler todo dia. A nota é a taxa de aprovação das
          checagens, ponderada pela gravidade.
        </p>
      </header>
      {children}
    </section>
  );
}
