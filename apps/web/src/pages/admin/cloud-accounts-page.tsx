import {
  CLOUD_PROVIDERS,
  type CloudAccount,
  cloudAccountCreateSchema,
  cloudAccountUpdateSchema,
  type CloudProvider,
} from '@verax/shared';
import { Copy, ExternalLink } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { SEVERITY_STYLES } from '@/design/severity';
import {
  ADMIN_PAGE_SIZE,
  useCloudAccountList,
  useCreateCloudAccount,
  useUpdateCloudAccount,
} from '@/features/admin/admin-api';
import { AdminShell, FormError, SelectInput } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import {
  ACCOUNT_NOUNS,
  CONNECTOR_GUIDE_URL,
  CONNECTOR_TEMPLATE_URL,
  connectionLabel,
  PROVIDER_LABELS,
} from '@/features/admin/labels';
import { useMe } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';

const NEW = 'nova';
const PROVIDER_OPTIONS = CLOUD_PROVIDERS.map((provider) => ({
  value: provider,
  label: PROVIDER_LABELS[provider],
}));

/** "a, b , c" → ["a", "b", "c"]: regiões e zonas são digitadas separadas por vírgula. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** O que a conta monitora: regiões (AWS), a assinatura do Pub/Sub (GCP) ou as zonas (Cloudflare). */
function scopeOf(account: CloudAccount): string | null {
  if (account.provider === 'aws') return account.regions.join(', ');
  if (account.provider === 'gcp') return account.pubsubSubscription;
  return account.zones.length > 0 ? account.zones.join(', ') : null;
}

const SCOPE_LABELS: Readonly<Record<CloudProvider, string>> = {
  aws: 'Regiões',
  gcp: 'Assinatura do Pub/Sub',
  cloudflare: 'Zonas',
};

const MISSING_SCOPE: Readonly<Record<CloudProvider, string>> = {
  aws: '—',
  gcp: 'assinatura não informada',
  cloudflare: 'nenhuma zona informada',
};

/**
 * Contas cloud (T7.3): AWS, GCP e Cloudflare. Cadastrar, ver o que configurar em cada provedor e acompanhar a
 * conexão. Nenhum formulário pede credencial.
 */
export function CloudAccountsPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const canWrite = me?.permissions.includes('cloud_accounts:write') === true;
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const list = useCloudAccountList(page, scope !== null);
  const open = params.get('conta');
  const setOpen = (value: string | null) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set('conta', value);
      else next.delete('conta');
      return next;
    });
  const selected = list.data?.items.find((account) => account.id === open) ?? null;

  const columns: Column<CloudAccount>[] = [
    {
      key: 'conta',
      header: 'Conta',
      cell: (row) => (
        <button type="button" className="text-left hover:underline" onClick={() => setOpen(row.id)}>
          <span className="block text-xs text-muted-foreground">{PROVIDER_LABELS[row.provider]}</span>
          <span className="break-all font-mono text-sm">{row.accountId}</span>
        </button>
      ),
    },
    {
      key: 'escopo',
      header: 'Monitorando',
      cell: (row) =>
        scopeOf(row) ?? <span className="text-muted-foreground">{MISSING_SCOPE[row.provider]}</span>,
    },
    { key: 'conexao', header: 'Conexão', cell: (row) => <ConnectionBadge account={row} /> },
    {
      key: 'evento',
      header: 'Último evento',
      className: 'whitespace-nowrap',
      cell: (row) =>
        row.lastEventAt ? (
          formatRelative(row.lastEventAt)
        ) : (
          <span className="text-muted-foreground">nenhum ainda</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.status === 'active' ? 'Ativa' : <span className="text-muted-foreground">Inativa</span>,
    },
  ];

  return (
    <AdminShell
      title="Contas cloud"
      description="Contas AWS, projetos da GCP e contas do Cloudflare monitorados. O Verax Control só lê, e nenhum cadastro guarda credencial."
      action={canWrite && <Button onClick={() => setOpen(NEW)}>Cadastrar conta</Button>}
    >
      <DataTable
        caption="Contas cloud do cliente"
        columns={columns}
        rows={list.data?.items}
        rowKey={(row) => row.id}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        total={list.data?.total ?? 0}
        onPageChange={(next) => setParams({ pagina: String(next) })}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyTitle="Nenhuma conta cadastrada"
        emptyDescription="Cadastre a primeira conta do cliente (AWS, GCP ou Cloudflare) para começar o monitoramento."
      />
      <Sheet
        open={open === NEW || selected !== null}
        onOpenChange={(value) => {
          if (!value) setOpen(null);
        }}
        title={
          open === NEW
            ? 'Cadastrar conta'
            : selected
              ? `${ACCOUNT_NOUNS[selected.provider].noun} ${selected.accountId}`
              : 'Conta'
        }
      >
        {open === NEW ? (
          <CreateAccount />
        ) : (
          selected && <AccountDetail key={selected.id} account={selected} canWrite={canWrite} />
        )}
      </Sheet>
    </AdminShell>
  );
}

function ConnectionBadge({ account }: { account: CloudAccount }) {
  const connection = account.connection ?? 'pending';
  const severity = connection === 'ok' ? 'ok' : connection === 'error' ? 'critical' : 'medium';
  const { icon: Icon, tone } = SEVERITY_STYLES[severity];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-sm">
      <Icon aria-hidden className={cn('size-4', tone)} />
      {connectionLabel(account.provider, connection)}
    </span>
  );
}

interface CreateValues {
  provider: CloudProvider;
  accountId: string;
  regions: string;
  pubsubSubscription: string;
  zones: string;
}

/** Monta o corpo do cadastro com só os campos do provedor escolhido. */
function createInput(values: CreateValues) {
  const accountId = values.accountId.trim();
  switch (values.provider) {
    case 'aws':
      return { provider: 'aws', accountId, regions: splitList(values.regions) };
    case 'gcp':
      return { provider: 'gcp', accountId, pubsubSubscription: values.pubsubSubscription.trim() || null };
    case 'cloudflare':
      return { provider: 'cloudflare', accountId, zones: splitList(values.zones) };
  }
}

function CreateAccount() {
  const [values, setValues] = useState<CreateValues>({
    provider: 'aws',
    accountId: '',
    regions: 'sa-east-1',
    pubsubSubscription: '',
    zones: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateCloudAccount();
  const set = (key: keyof CreateValues) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  if (create.data) {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-md border border-ok/50 bg-ok/10 p-3 text-sm">
          {ACCOUNT_NOUNS[create.data.provider].noun} {create.data.accountId}{' '}
          {ACCOUNT_NOUNS[create.data.provider].registered}.{' '}
          {create.data.provider === 'aws'
            ? 'Falta o cliente criar o conector nela.'
            : 'Falta configurar a leitura no nó.'}
        </p>
        <ProviderSteps account={create.data} />
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = cloudAccountCreateSchema.safeParse(createInput(values));
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    create.mutate(input.data);
  };

  const listError = (key: string) =>
    errors[key] ?? Object.entries(errors).find(([field]) => field.startsWith(`${key}.`))?.[1];

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <SelectInput
        label="Provedor"
        value={values.provider}
        onChange={(event) => {
          setErrors({});
          setValues({ ...values, provider: event.target.value as CloudProvider });
        }}
        options={PROVIDER_OPTIONS}
      />
      {values.provider === 'aws' && (
        <>
          <Field
            label="ID da conta AWS"
            hint="12 dígitos (canto superior direito do console da AWS)."
            inputMode="numeric"
            value={values.accountId}
            onChange={set('accountId')}
            error={errors['accountId']}
          />
          <Field
            label="Regiões monitoradas"
            hint="Separadas por vírgula, por exemplo: sa-east-1, us-east-1."
            value={values.regions}
            onChange={set('regions')}
            error={listError('regions')}
          />
        </>
      )}
      {values.provider === 'gcp' && (
        <>
          <Field
            label="ID do projeto da GCP"
            hint="Como aparece no seletor de projetos do console, por exemplo: minha-empresa-prod (não é o número do projeto)."
            value={values.accountId}
            onChange={set('accountId')}
            error={errors['accountId']}
          />
          <Field
            label="Assinatura do Pub/Sub (opcional)"
            hint="A que recebe os logs de segurança do projeto. Pode ser informada depois."
            value={values.pubsubSubscription}
            onChange={set('pubsubSubscription')}
            error={errors['pubsubSubscription']}
          />
        </>
      )}
      {values.provider === 'cloudflare' && (
        <>
          <Field
            label="ID da conta do Cloudflare"
            hint="32 caracteres, na página inicial da conta no painel do Cloudflare."
            value={values.accountId}
            onChange={set('accountId')}
            error={errors['accountId']}
          />
          <Field
            label="Zonas monitoradas (opcional)"
            hint="Domínios separados por vírgula, por exemplo: exemplo.com.br, loja.exemplo.com.br."
            value={values.zones}
            onChange={set('zones')}
            error={listError('zones')}
          />
        </>
      )}
      <FormError error={create.error} />
      <Button type="submit" disabled={create.isPending}>
        {values.provider === 'aws' ? 'Cadastrar e gerar o ExternalId' : 'Cadastrar conta'}
      </Button>
    </form>
  );
}

function AccountDetail({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const update = useUpdateCloudAccount(account.id);
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Conexão</dt>
        <dd>
          <ConnectionBadge account={account} />
        </dd>
        <dt className="text-muted-foreground">Último evento</dt>
        <dd>{account.lastEventAt ? formatRelative(account.lastEventAt) : 'nenhum ainda'}</dd>
        <dt className="text-muted-foreground">{SCOPE_LABELS[account.provider]}</dt>
        <dd className="break-all">{scopeOf(account) ?? MISSING_SCOPE[account.provider]}</dd>
        {account.roleArn && (
          <>
            <dt className="text-muted-foreground">Papel de leitura</dt>
            <dd className="break-all font-mono text-xs">{account.roleArn}</dd>
          </>
        )}
      </dl>
      {account.provider === 'aws' && !account.externalId ? (
        <p className="text-sm text-muted-foreground">
          O ExternalId só aparece para quem configura o conector.
        </p>
      ) : (
        <ProviderSteps account={account} />
      )}
      {canWrite && account.provider !== 'aws' && <EditSource account={account} />}
      {canWrite && (
        <div className="space-y-2">
          <Button
            variant="secondary"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: account.status === 'active' ? 'inactive' : 'active' })}
          >
            {account.status === 'active' ? 'Desativar monitoramento' : 'Reativar monitoramento'}
          </Button>
          <FormError error={update.error} />
        </div>
      )}
    </div>
  );
}

/** GCP: a assinatura do Pub/Sub; Cloudflare: as zonas. Os dois podem chegar depois do cadastro. */
function EditSource({ account }: { account: CloudAccount }) {
  const gcp = account.provider === 'gcp';
  const [value, setValue] = useState(gcp ? (account.pubsubSubscription ?? '') : account.zones.join(', '));
  const [error, setError] = useState<string>();
  const update = useUpdateCloudAccount(account.id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = cloudAccountUpdateSchema.safeParse(
      gcp ? { pubsubSubscription: value.trim() || null } : { zones: splitList(value) },
    );
    if (!input.success) {
      setError(Object.values(fieldErrors(input.error))[0]);
      return;
    }
    setError(undefined);
    update.mutate(input.data);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-2">
      <Field
        label={gcp ? 'Assinatura do Pub/Sub' : 'Zonas monitoradas'}
        hint={gcp ? undefined : 'Domínios separados por vírgula.'}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={error}
      />
      <FormError error={update.error} />
      <Button type="submit" variant="secondary" disabled={update.isPending}>
        {gcp ? 'Salvar assinatura' : 'Salvar zonas'}
      </Button>
    </form>
  );
}

function ProviderSteps({ account }: { account: CloudAccount }) {
  if (account.provider === 'gcp') return <GcpSteps account={account} />;
  if (account.provider === 'cloudflare') return <CloudflareSteps account={account} />;
  return <ConnectorSteps account={account} />;
}

/** O que configurar no projeto da GCP: o nó lê uma assinatura do Pub/Sub, sem chave de conta de serviço. */
function GcpSteps({ account }: { account: CloudAccount }) {
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Leitura do projeto {account.accountId}
      </h3>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          No projeto, crie um coletor de logs (sink) do Cloud Logging que publique só os eventos de segurança
          num tópico do Pub/Sub, e uma assinatura nesse tópico.
        </li>
        <li>
          Dê à conta de serviço do nó do Verax a permissão de assinante nessa assinatura e a de revisor de
          segurança no projeto. Nenhuma chave de conta de serviço é criada: o nó usa a identidade da própria
          VM.
        </li>
        <li>
          Informe aqui o nome da assinatura. A conexão muda para "Conectada" quando o primeiro evento chegar.
        </li>
      </ol>
    </section>
  );
}

/** O que configurar no Cloudflare: o token só de leitura fica no cofre do nó, nunca neste cadastro. */
function CloudflareSteps({ account }: { account: CloudAccount }) {
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Leitura da conta {account.accountId}
      </h3>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>No Cloudflare, crie um token de API só de leitura, com acesso a Analytics e Logs das zonas.</li>
        <li>
          Grave o token no cofre de segredos do nó. Ele nunca entra neste cadastro, nem passa por e-mail ou
          chat.
        </li>
        <li>
          Informe as zonas monitoradas. A conexão muda para "Conectada" quando o primeiro evento chegar.
        </li>
      </ol>
    </section>
  );
}

/** O que o cliente faz na conta AWS dele: o template do conector com o ExternalId desta conta. */
function ConnectorSteps({ account }: { account: CloudAccount }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!account.externalId) return;
    void navigator.clipboard?.writeText(account.externalId).then(() => setCopied(true));
  };
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Conector na conta {account.accountId}
      </h3>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          Baixe o{' '}
          <a
            href={CONNECTOR_TEMPLATE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            template do conector
            <ExternalLink aria-hidden className="size-3.5" />
          </a>{' '}
          e siga o{' '}
          <a
            href={CONNECTOR_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            passo a passo
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
          .
        </li>
        <li>
          No CloudFormation da conta, crie a pilha com este ExternalId (é secreto: envie ao cliente por um
          canal seguro):
          <div className="mt-1 flex items-center gap-2">
            <code className="break-all rounded bg-foreground/5 px-2 py-1 font-mono text-xs">
              {account.externalId}
            </code>
            <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label="Copiar o ExternalId">
              <Copy aria-hidden />
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        </li>
        <li>A conexão muda para "Conectada" na primeira leitura bem-sucedida do papel.</li>
      </ol>
    </section>
  );
}
