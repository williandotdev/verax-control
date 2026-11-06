import {
  type AccessKeyAsset,
  ASSET_KINDS,
  type AssetKind,
  type AssetListQuery,
  type BucketAsset,
  type IamUserAsset,
  type InstanceAsset,
  type InventorySummary,
  type RiskReason,
  type SecurityGroupAsset,
} from '@verax/shared';
import { TriangleAlert } from 'lucide-react';
import { Tabs } from 'radix-ui';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { SeverityBadge } from '@/components/security/severity-badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { SelectField } from '@/components/ui/select-field';
import { SEVERITY_STYLES } from '@/design/severity';
import { useAssets, useInventorySummary } from '@/features/inventory/inventory-api';
import {
  ASSET_KIND_LABELS,
  bucketPublic,
  describeRule,
  describeSectionError,
  INVENTORY_ITEM_CAP,
  RISK_REASON_LABELS,
  RISK_SEVERITY,
} from '@/features/inventory/labels';
import { useMe } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { formatList, formatRelative, plural } from '@/lib/format';

const PAGE_SIZE = 20;
const DAY = 86_400_000;

/**
 * Ativos e identidades (T7.11 e PR-14'): uma aba por tipo, com o risco de cada item e o motivo, a partir do inventário
 * de cada conta AWS, refeito uma vez por dia pelo worker. Cliente sem conta AWS vê "em breve" (GCP e Cloudflare ainda
 * não têm inventário), e o retrato parcial de uma conta ganha a faixa de coleta parcial.
 */
export function AssetsPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const [params, setParams] = useSearchParams();
  const kind = ASSET_KINDS.find((value) => value === params.get('aba')) ?? 'users';
  const account = params.get('conta');
  const query: AssetListQuery = {
    accountId: account && /^\d{12}$/.test(account) ? account : undefined,
    atRisk: params.get('risco') === 'sim' ? 'true' : undefined,
    page: Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1),
    pageSize: PAGE_SIZE,
  };
  const summary = useInventorySummary(scope !== null);

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
      <AssetsShell>
        <EmptyState
          title="Escolha um cliente"
          description="Os ativos são de um cliente por vez. Escolha um no seletor do topo."
        />
      </AssetsShell>
    );
  }
  if (summary.isError) {
    return (
      <AssetsShell>
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      </AssetsShell>
    );
  }
  if (!summary.data) {
    return (
      <AssetsShell>
        <LoadingState rows={6} label="Carregando o inventário" />
      </AssetsShell>
    );
  }

  if (summary.data.accounts.length === 0) {
    return (
      <AssetsShell>
        <EmptyState
          title="Ativos de GCP e Cloudflare: em breve"
          description="Esta tela mostra hoje o que existe nas contas AWS, e este cliente ainda não tem conta AWS ativa. Cadastre uma em Contas cloud: o inventário aparece aqui depois que a conexão dela for verificada."
        />
      </AssetsShell>
    );
  }
  if (summary.data.accounts.every((item) => item.collectedAt === null)) {
    return (
      <AssetsShell>
        <EmptyState
          title="Ainda sem inventário"
          description="O inventário de uma conta AWS sai depois que a conexão dela é verificada em Contas cloud, e é refeito uma vez por dia."
        />
      </AssetsShell>
    );
  }

  const roots = summary.data.accounts.filter((item) => item.root && item.root.risk !== 'none');
  const collected = summary.data.accounts
    .map((item) => item.collectedAt)
    .filter((value) => value !== null)
    .sort();
  const { icon: CriticalIcon, tone, surface } = SEVERITY_STYLES.critical;

  return (
    <AssetsShell updatedAt={collected[collected.length - 1]}>
      {roots.map((item) => (
        <p
          key={item.accountId}
          role="alert"
          className={cn('flex items-start gap-2 rounded-md border p-3 text-sm', surface)}
        >
          <CriticalIcon aria-hidden className={cn('mt-0.5 size-4 shrink-0', tone)} />
          <span>
            <strong>Conta root de {item.accountId}:</strong>{' '}
            {formatList((item.root?.reasons ?? []).map((reason) => RISK_REASON_LABELS[reason]))}. Corrija
            antes de tudo: quem tem o root controla a conta inteira.
          </span>
        </p>
      ))}

      <PartialCollection accounts={summary.data.accounts} />

      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Conta"
          value={query.accountId ?? ''}
          onChange={(value) => update({ conta: value || null })}
          options={[
            { value: '', label: 'Todas' },
            ...summary.data.accounts.map((item) => ({ value: item.accountId, label: item.accountId })),
          ]}
        />
        <SelectField
          label="Mostrar"
          value={query.atRisk ? 'sim' : ''}
          onChange={(value) => update({ risco: value || null })}
          options={[
            { value: '', label: 'Todos os ativos' },
            { value: 'sim', label: 'Só os com risco' },
          ]}
        />
      </div>

      <Tabs.Root value={kind} onValueChange={(value) => update({ aba: value === 'users' ? null : value })}>
        <Tabs.List
          data-tour="ativos-abas"
          aria-label="Tipo de ativo"
          className="flex flex-wrap gap-1 border-b"
        >
          {ASSET_KINDS.map((value) => {
            const count = summary.data.counts[value];
            return (
              <Tabs.Trigger
                key={value}
                value={value}
                className="-mb-px flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground"
              >
                {ASSET_KIND_LABELS[value]} <span className="tabular-nums">{count.total}</span>
                {count.atRisk > 0 && (
                  <>
                    {' '}
                    <span className="rounded-full border border-high/60 bg-high/10 px-1.5 text-xs text-foreground">
                      {count.atRisk} com risco
                    </span>
                  </>
                )}
              </Tabs.Trigger>
            );
          })}
        </Tabs.List>
        <Tabs.Content value={kind} className="pt-4 focus:outline-none">
          <AssetTable
            key={kind}
            kind={kind}
            query={query}
            enabled={scope !== null}
            onPage={(page) => update({ pagina: String(page) }, { keepPage: true })}
          />
        </Tabs.Content>
      </Tabs.Root>
    </AssetsShell>
  );
}

function AssetTable({
  kind,
  query,
  enabled,
  onPage,
}: {
  kind: AssetKind;
  query: AssetListQuery;
  enabled: boolean;
  onPage: (page: number) => void;
}) {
  const assets = useAssets(kind, query, enabled);
  const common = {
    caption: ASSET_KIND_LABELS[kind],
    page: query.page,
    pageSize: PAGE_SIZE,
    total: assets.data?.total ?? 0,
    onPageChange: onPage,
    loading: assets.isPending,
    error: assets.error,
    onRetry: () => void assets.refetch(),
    emptyTitle: query.atRisk ? 'Nenhum ativo com risco' : 'Nenhum ativo deste tipo',
    emptyDescription: 'O inventário de cada conta AWS é refeito uma vez por dia.',
  };
  const rows = assets.data?.items;
  switch (kind) {
    case 'users':
      return (
        <DataTable
          {...common}
          columns={USER_COLUMNS}
          rows={rows as IamUserAsset[] | undefined}
          rowKey={(row) => row.arn}
        />
      );
    case 'keys':
      return (
        <DataTable
          {...common}
          columns={KEY_COLUMNS}
          rows={rows as AccessKeyAsset[] | undefined}
          rowKey={(row) => row.id}
        />
      );
    case 'instances':
      return (
        <DataTable
          {...common}
          columns={INSTANCE_COLUMNS}
          rows={rows as InstanceAsset[] | undefined}
          rowKey={(row) => row.instanceId}
        />
      );
    case 'buckets':
      return (
        <DataTable
          {...common}
          columns={BUCKET_COLUMNS}
          rows={rows as BucketAsset[] | undefined}
          rowKey={(row) => row.name}
        />
      );
    case 'security-groups':
      return (
        <DataTable
          {...common}
          columns={GROUP_COLUMNS}
          rows={rows as SecurityGroupAsset[] | undefined}
          rowKey={(row) => `${row.accountId}:${row.groupId}`}
        />
      );
  }
}

const riskColumn = <T extends { risk: IamUserAsset['risk'] }>(): Column<T> => ({
  key: 'risco',
  header: 'Risco',
  cell: (row) => <SeverityBadge severity={RISK_SEVERITY[row.risk]} />,
});

const reasonsColumn = <T extends { reasons: RiskReason[] }>(): Column<T> => ({
  key: 'motivos',
  header: 'Por quê',
  className: 'min-w-48',
  cell: (row) =>
    row.reasons.length === 0 ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <ul className="flex flex-wrap gap-1">
        {row.reasons.map((reason) => (
          <li key={reason} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs">
            <TriangleAlert aria-hidden className="size-3 text-high" />
            {RISK_REASON_LABELS[reason]}
          </li>
        ))}
      </ul>
    ),
});

const accountColumn = <T extends { accountId: string }>(): Column<T> => ({
  key: 'conta',
  header: 'Conta',
  cell: (row) => <span className="font-mono text-xs">{row.accountId}</span>,
});

/** Sim ou não, destacando o valor que representa risco. */
function YesNo({ value, risky }: { value: boolean | null; risky: boolean | null }) {
  if (value === null) return <span className="text-muted-foreground">não lido</span>;
  return (
    <span className={cn(value === risky && 'font-semibold text-critical-text')}>{value ? 'Sim' : 'Não'}</span>
  );
}

const USER_COLUMNS: Column<IamUserAsset>[] = [
  riskColumn(),
  {
    key: 'usuario',
    header: 'Usuário',
    cell: (row) => (
      <span>
        <span className="font-medium">{row.userName}</span>
        <span className="block break-all text-xs text-muted-foreground">{row.arn}</span>
      </span>
    ),
  },
  accountColumn(),
  { key: 'console', header: 'Console', cell: (row) => (row.consoleAccess ? 'Sim' : 'Não') },
  {
    key: 'mfa',
    header: 'MFA',
    cell: (row) => <YesNo value={row.mfaEnabled} risky={row.consoleAccess ? false : null} />,
  },
  { key: 'chaves', header: 'Chaves ativas', cell: (row) => row.activeKeys },
  reasonsColumn(),
];

function ageDays(createdAt: string | null): number | null {
  return createdAt === null ? null : Math.floor((Date.now() - Date.parse(createdAt)) / DAY);
}

const KEY_COLUMNS: Column<AccessKeyAsset>[] = [
  riskColumn(),
  { key: 'chave', header: 'Chave', cell: (row) => <span className="font-mono text-xs">{row.id}</span> },
  { key: 'usuario', header: 'Usuário', cell: (row) => row.userName },
  accountColumn(),
  {
    key: 'idade',
    header: 'Idade',
    className: 'whitespace-nowrap',
    cell: (row) => {
      const age = ageDays(row.createdAt);
      if (age === null) return '—';
      return (
        <span className={cn(age > 90 && 'font-semibold text-critical-text')}>
          {plural(age, 'dia', 'dias')}
        </span>
      );
    },
  },
  {
    key: 'uso',
    header: 'Último uso',
    className: 'whitespace-nowrap',
    cell: (row) =>
      row.lastUsedAt ? formatRelative(row.lastUsedAt) : <span className="text-muted-foreground">nunca</span>,
  },
  { key: 'status', header: 'Status', cell: (row) => (row.status === 'Active' ? 'Ativa' : 'Inativa') },
  reasonsColumn(),
];

const INSTANCE_COLUMNS: Column<InstanceAsset>[] = [
  riskColumn(),
  {
    key: 'instancia',
    header: 'Instância',
    cell: (row) => <span className="font-mono text-xs">{row.instanceId}</span>,
  },
  accountColumn(),
  { key: 'regiao', header: 'Região', cell: (row) => row.region },
  {
    key: 'estado',
    header: 'Estado',
    cell: (row) =>
      row.state === 'running' ? 'Ligada' : row.state === 'stopped' ? 'Desligada' : (row.state ?? '—'),
  },
  { key: 'ip', header: 'IP público', cell: (row) => row.publicIp ?? '—' },
  {
    key: 'imds',
    header: 'IMDSv2 obrigatório',
    cell: (row) => <YesNo value={row.imdsV2Required} risky={false} />,
  },
  reasonsColumn(),
];

const BUCKET_COLUMNS: Column<BucketAsset>[] = [
  riskColumn(),
  {
    key: 'bucket',
    header: 'Bucket',
    className: 'min-w-44',
    cell: (row) => <span className="break-all font-medium">{row.name}</span>,
  },
  accountColumn(),
  { key: 'regiao', header: 'Região', cell: (row) => row.region ?? '—' },
  {
    key: 'publico',
    header: 'Público',
    cell: (row) => <YesNo value={bucketPublic(row)} risky={true} />,
  },
  {
    key: 'bloqueio',
    header: 'Bloqueio de acesso público',
    cell: (row) => <YesNo value={row.publicAccessBlocked} risky={false} />,
  },
  reasonsColumn(),
];

const GROUP_COLUMNS: Column<SecurityGroupAsset>[] = [
  riskColumn(),
  {
    key: 'grupo',
    header: 'Grupo',
    cell: (row) => (
      <span>
        <span className="font-mono text-xs">{row.groupId}</span>
        {row.name && <span className="block text-xs text-muted-foreground">{row.name}</span>}
      </span>
    ),
  },
  accountColumn(),
  { key: 'regiao', header: 'Região', cell: (row) => row.region },
  {
    key: 'aberto',
    header: 'Aberto para a internet',
    cell: (row) =>
      row.openToWorld.length === 0 ? (
        <span className="text-muted-foreground">nada</span>
      ) : (
        <span
          className={cn(
            row.risk === 'critical' || row.risk === 'high' ? 'font-semibold text-critical-text' : undefined,
          )}
        >
          {formatList(row.openToWorld.map(describeRule))}
        </span>
      ),
  },
  reasonsColumn(),
];

/**
 * A faixa de coleta parcial: as contas cujo retrato mais recente não tem tudo (uma parte recusada pela AWS, itens fora
 * do formato ou o teto de itens). O resto do retrato continua nas abas.
 */
function PartialCollection({ accounts }: { accounts: InventorySummary['accounts'] }) {
  const partial = accounts.filter((item) => item.errors.length > 0 || item.truncated);
  if (partial.length === 0) return null;
  const { icon: Icon, tone, surface } = SEVERITY_STYLES.medium;
  return (
    <section
      aria-labelledby="ativos-coleta-parcial"
      className={cn('space-y-2 rounded-md border p-3 text-sm', surface)}
    >
      <h2 id="ativos-coleta-parcial" className="flex items-center gap-2 font-semibold">
        <Icon aria-hidden className={cn('size-4 shrink-0', tone)} />
        Coleta parcial
      </h2>
      <ul className="space-y-2">
        {partial.map((item) => (
          <li key={item.accountId}>
            <span className="font-medium">Conta {item.accountId}</span>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {item.errors.map((error) => (
                <li key={`${error.section}:${error.region ?? ''}:${error.code}`}>
                  {describeSectionError(error)}.
                </li>
              ))}
              {item.truncated && (
                <li>
                  Alguma parte passou do teto de {INVENTORY_ITEM_CAP.toLocaleString('pt-BR')} itens por tipo:
                  os itens além dele não aparecem.
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>
      <p>
        O que foi lido está nas abas. Uma recusa costuma vir da política do papel verax-control-reader ou de
        uma SCP da organização; a próxima coleta, em até 24 horas, tenta de novo.
      </p>
    </section>
  );
}

function AssetsShell({ children, updatedAt }: { children: ReactNode; updatedAt?: string | null }) {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Ativos e identidades</h1>
        <p className="text-sm text-muted-foreground">
          O que existe em cada conta AWS do cliente, lido pelo papel somente leitura uma vez por dia, com o
          risco de cada item.
          {updatedAt && ` Inventário atualizado ${formatRelative(updatedAt)}.`}
        </p>
      </header>
      {children}
    </section>
  );
}
