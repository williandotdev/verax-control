import {
  CLOUD_PROVIDERS,
  type CloudAccount,
  cloudAccountCreateSchema,
  cloudAccountUpdateSchema,
  cloudCredentialInputSchema,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  cloudflareTokenTemplateUrl,
  type CloudProvider,
  GCP_READER_ROLE,
  gcpReaderCommands,
  gcpReaderServiceAccountEmail,
  gcpReaderSubscription,
  gcpServiceAccountKeyFromJson,
  gcpSinkCommand,
  gcpSinkIdentityCommand,
  isCloudflareBlockingError,
  logBucketNames,
  normalizeSinkWriterIdentity,
  qualifyPubsubSubscription,
} from '@verax/shared';
import { ExternalLink } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { SEVERITY_STYLES } from '@/design/severity';
import {
  ADMIN_PAGE_SIZE,
  useCloudAccountList,
  useCloudCredential,
  useCreateCloudAccount,
  useUpdateCloudAccount,
} from '@/features/admin/admin-api';
import { AdminShell, FormError, SelectInput } from '@/features/admin/admin-ui';
import {
  type BucketRow,
  bucketRowErrors,
  bucketsFromRows,
  withoutBucketErrors,
} from '@/features/admin/aws-log-buckets';
import { AwsLogBuckets, LogBucketsEditor } from '@/features/admin/aws-log-buckets-editor';
import { AWS_DEFAULT_REGION, AWS_REGION_OPTIONS } from '@/features/admin/aws-onboarding-labels';
import { AwsOnboardingSection } from '@/features/admin/aws-onboarding-section';
import { CommandBlock } from '@/features/admin/command-block';
import { CredentialStep } from '@/features/admin/credential-step';
import {
  CREDENTIAL_TEXTS,
  type CredentialFormProps,
  credentialErrorText,
} from '@/features/admin/credential-texts';
import { fieldErrors } from '@/features/admin/forms';
import {
  ACCOUNT_NOUNS,
  awsCollectionErrorHint,
  cloudflareConnectionErrorHint,
  CONNECTION_LABELS,
  connectionHint,
  gcpConnectionErrorHint,
  PROVIDER_LABELS,
} from '@/features/admin/labels';
import { useAuthClientConfig } from '@/features/auth/client-config';
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

/** A assinatura no próprio projeto aparece só pelo ID; noutro projeto (coletor agregado), pelo nome completo. */
function subscriptionLabel(account: CloudAccount): string | null {
  const prefix = `projects/${account.accountId}/subscriptions/`;
  const name = account.pubsubSubscription;
  return name?.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** O que a conta monitora: regiões (AWS), a assinatura do Pub/Sub (GCP) ou as zonas (Cloudflare). */
/** A conta que a Verax cadastrou pelo console (a sincronização do nó com o plano de controle). */
const isManagedByVerax = (account: CloudAccount) => account.managedBy === 'verax';

/** O selo da conta do console. */
function ManagedBadge() {
  return (
    <span className="inline-block rounded-full border px-1.5 py-0.5 text-[0.7rem] font-medium leading-none">
      Cadastrada pela Verax
    </span>
  );
}

function scopeOf(account: CloudAccount): string | null {
  if (account.provider === 'aws') return account.regions.join(', ');
  if (account.provider === 'gcp') return subscriptionLabel(account);
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
 * conexão. O cadastro não pede credencial: na AWS, o cliente clica em "Conectar com AWS", cria o papel de leitura sem
 * chave no CloudFormation e autoriza as fontes de log que o Verax descobre (`features/admin/aws-onboarding-section`);
 * o token do Cloudflare tem formulário próprio no detalhe da conta e vai cifrado para o cofre do nó (fase 2).
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
          {isManagedByVerax(row) && (
            <span className="mt-1 block">
              <ManagedBadge />
            </span>
          )}
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
      description="Contas AWS, projetos da GCP e contas do Cloudflare monitorados. O Verax Control só lê: na AWS, por um papel de leitura sem chave; o token do Cloudflare fica cifrado no cofre do nó, nunca no cadastro."
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
        // A conta AWS tem a tabela das fontes e a lista de grupos de logs: o painel abre mais largo.
        size={open === NEW || selected?.provider === 'aws' ? 'wide' : 'default'}
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

const CONNECTION_SEVERITY = {
  waiting: 'medium',
  connected: 'ok',
  error: 'critical',
} as const satisfies Record<CloudAccount['connection'], keyof typeof SEVERITY_STYLES>;

/**
 * O erro da última coleta: no Cloudflare, a explicação (quando há uma) e, nos erros do token, que a coleta está parada
 * até outro token ser colado (o worker não chama mais o Cloudflare com ele); em todos, o código. Na AWS, a explicação
 * fica junto do "Verificar", e uma conta conectada pode ter um aviso (que não para a coleta): o código aparece como
 * tipo do aviso.
 */
function ConnectionErrorDetail({ account, code }: { account: CloudAccount; code: string }) {
  const cloudflare = account.provider === 'cloudflare';
  const hint = cloudflare
    ? cloudflareConnectionErrorHint(code)
    : account.provider === 'gcp'
      ? gcpConnectionErrorHint(code)
      : null;
  const stopped = cloudflare && isCloudflareBlockingError(code);
  return (
    <>
      {hint && ` ${hint}`}
      {stopped && ' A coleta está parada até um token válido ser colado abaixo.'}{' '}
      {account.connection === 'connected' ? 'Tipo do aviso:' : 'Tipo do erro:'}{' '}
      <code className="font-mono">{code}</code>.
    </>
  );
}

/** Selo "Aguardando / Conectada / Erro": a cor vem com ícone e texto, nunca só a cor. */
function ConnectionBadge({ account }: { account: CloudAccount }) {
  const { icon: Icon, tone } = SEVERITY_STYLES[CONNECTION_SEVERITY[account.connection]];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-sm">
      <Icon aria-hidden className={cn('size-4', tone)} />
      {CONNECTION_LABELS[account.connection]}
    </span>
  );
}

/**
 * AWS: o aviso da coleta pelo Wazuh do nó (o token do Google do host, a configuração do manager), ao lado da conexão e à
 * parte dela: a conta pode estar conectada e a coleta do nó ter um problema. Sem aviso, nada aparece.
 */
function CollectionWarning({ account }: { account: CloudAccount }) {
  const hint = awsCollectionErrorHint(account.collectionError);
  if (account.provider !== 'aws' || hint === null) return null;
  const { icon: Icon, tone } = SEVERITY_STYLES.medium;
  return (
    <>
      <dt className="text-muted-foreground">Coleta no nó</dt>
      <dd className="space-y-0.5">
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-sm">
          <Icon aria-hidden className={cn('size-4', tone)} />
          Aviso
        </span>
        <p className="text-xs text-muted-foreground">
          {hint} Tipo do aviso: <code className="font-mono">{account.collectionError}</code>.
        </p>
      </dd>
    </>
  );
}

interface CreateValues {
  provider: CloudProvider;
  accountId: string;
  /** AWS: a região principal da conta. As outras, a descoberta acha sozinha depois de conectar. */
  region: string;
  pubsubSubscription: string;
  zones: string;
}

/** Monta o corpo do cadastro com só os campos do provedor escolhido (na AWS, os buckets da lista, se houver). */
function createInput(values: CreateValues, bucketRows: readonly BucketRow[]) {
  const accountId = values.accountId.trim();
  switch (values.provider) {
    case 'aws':
      return {
        provider: 'aws',
        accountId,
        regions: [values.region],
        ...(bucketRows.length > 0 && { buckets: bucketsFromRows(bucketRows) }),
      };
    case 'gcp':
      return {
        provider: 'gcp',
        accountId,
        pubsubSubscription: values.pubsubSubscription.trim()
          ? qualifyPubsubSubscription(accountId, values.pubsubSubscription)
          : null,
      };
    case 'cloudflare':
      return { provider: 'cloudflare', accountId, zones: splitList(values.zones) };
  }
}

function CreateAccount() {
  const [values, setValues] = useState<CreateValues>({
    provider: 'aws',
    accountId: '',
    region: AWS_DEFAULT_REGION,
    pubsubSubscription: '',
    zones: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bucketRows, setBucketRows] = useState<BucketRow[]>([]);
  const [bucketErrors, setBucketErrors] = useState<Record<number, string>>({});
  // Os buckets fora do padrão ficam recolhidos; quem abre é a pessoa, ou um erro numa linha (que não pode ficar escondido).
  const [advancedOpen, setAdvancedOpen] = useState(false);
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
            ? 'Falta conectar a conta: é o próximo passo, abaixo.'
            : create.data.provider === 'cloudflare'
              ? 'Falta colar o token de leitura do Cloudflare.'
              : 'Falta configurar a leitura no nó.'}
        </p>
        {create.data.provider === 'aws' ? (
          <AwsOnboardingSection account={create.data} canWrite />
        ) : (
          <ProviderSteps account={create.data} canWrite canEditSource />
        )}
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = cloudAccountCreateSchema.safeParse(createInput(values, bucketRows));
    const schemaErrors = input.success ? {} : fieldErrors(input.error);
    const rowErrors = values.provider === 'aws' ? bucketRowErrors(bucketRows, schemaErrors) : {};
    if (!input.success || Object.keys(rowErrors).length > 0) {
      setErrors(withoutBucketErrors(schemaErrors));
      setBucketErrors(rowErrors);
      if (Object.keys(rowErrors).length > 0) setAdvancedOpen(true);
      return;
    }
    setErrors({});
    setBucketErrors({});
    create.mutate(input.data);
  };

  const listError = (key: string) =>
    errors[key] ?? Object.entries(errors).find(([field]) => field.startsWith(`${key}.`))?.[1];

  return (
    <form onSubmit={submit} noValidate className="max-w-xl space-y-4">
      <SelectInput
        label="Provedor"
        value={values.provider}
        onChange={(event) => {
          setErrors({});
          setBucketErrors({});
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
          <SelectInput
            label="Região principal"
            value={values.region}
            onChange={set('region')}
            options={AWS_REGION_OPTIONS}
            error={listError('regions')}
          />
          <p className="text-xs text-muted-foreground">
            Onde fica a maior parte dos recursos da conta. As outras regiões o Verax encontra sozinho depois
            de conectar: não é preciso informar buckets, ARNs nem nomes de grupos.
          </p>
          <details
            className="space-y-3"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary className="cursor-pointer text-sm font-medium">Avançado: buckets fora do padrão</summary>
            <p className="text-xs text-muted-foreground">
              Só para exceções. O Verax lê sozinho os logs que a AWS grava em AWSLogs/&lt;conta&gt;/. Cadastre
              um bucket aqui apenas se os logs ficam fora desse padrão: um prefixo antes de AWSLogs/, entregas
              do Firehose ou um bucket central com logs de várias contas.
            </p>
            <LogBucketsEditor
              rows={bucketRows}
              onChange={setBucketRows}
              errors={bucketErrors}
              legend="Buckets fora do padrão (opcional)"
              note="Pode deixar para depois: a lista muda no detalhe da conta."
            />
          </details>
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
            hint="O nome da assinatura, se ela estiver no próprio projeto, ou o nome completo (projects/<projeto>/subscriptions/<nome>), se estiver noutro. Num projeto de cliente, deixe em branco: a Verax informa depois do sink."
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
        Cadastrar conta
      </Button>
    </form>
  );
}

function AccountDetail({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const update = useUpdateCloudAccount(account.id);
  // A conta do console: a fonte e o monitoramento só mudam pela Verax (a API recusa com 409 CONSOLE_MANAGED). A
  // credencial e o "Verificar" continuam com o cliente.
  const managed = isManagedByVerax(account);
  const canEditSource = canWrite && !managed;
  return (
    <div className="space-y-5">
      {managed && (
        <div className="space-y-1 rounded-md border p-3 text-sm">
          <ManagedBadge />
          <p className="text-muted-foreground">
            A Verax cadastrou esta conta: peça à Verax para alterar a fonte ou o monitoramento. A credencial,
            a verificação e, na AWS, a conexão e a autorização das fontes continuam aqui.
          </p>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Conexão</dt>
        <dd className="space-y-0.5">
          <ConnectionBadge account={account} />
          <p className="text-xs text-muted-foreground">
            {connectionHint(account)}
            {account.connectionError && (
              <ConnectionErrorDetail account={account} code={account.connectionError} />
            )}
          </p>
        </dd>
        <CollectionWarning account={account} />
        <dt className="text-muted-foreground">Última coleta</dt>
        <dd>{account.lastCollectedAt ? formatRelative(account.lastCollectedAt) : 'nenhuma ainda'}</dd>
        <dt className="text-muted-foreground">Último evento</dt>
        <dd>{account.lastEventAt ? formatRelative(account.lastEventAt) : 'nenhum ainda'}</dd>
        <dt className="text-muted-foreground">{SCOPE_LABELS[account.provider]}</dt>
        <dd className="break-all">{scopeOf(account) ?? MISSING_SCOPE[account.provider]}</dd>
        {account.readerRoleArn && (
          <>
            <dt className="text-muted-foreground">Papel de leitura</dt>
            <dd className="break-all font-mono text-xs">{account.readerRoleArn}</dd>
          </>
        )}
      </dl>
      {account.provider === 'aws' ? (
        <>
          {/* Conectar, descobrir e autorizar as fontes são do cliente também na conta que a Verax cadastrou. */}
          <AwsOnboardingSection account={account} canWrite={canWrite} />
          <AwsAdvancedBuckets account={account} canWrite={canEditSource} managed={managed} />
        </>
      ) : (
        <ProviderSteps account={account} canWrite={canWrite} canEditSource={canEditSource} />
      )}
      {canWrite && account.provider !== 'aws' && <EditSource account={account} disabled={managed} />}
      {canWrite && (
        <div className="space-y-2">
          <Button
            variant="secondary"
            disabled={managed || update.isPending}
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

/** O endereço da seção dos buckets fora do padrão: as fontes que dependem dela apontam para cá. */
const ADVANCED_BUCKETS_ID = 'aws-buckets';

/**
 * "Avançado: buckets fora do padrão", no detalhe da conta AWS: os buckets cadastrados à mão, só para o que fica fora de
 * `AWSLogs/<conta>/`. Começa aberto na conta que já tem bucket cadastrado e fechado nas outras; depois disso, quem abre
 * e fecha é a pessoa (salvar a lista vazia não fecha a seção com o aviso dentro). Um link da tela que aponta para cá
 * (a fonte com prefixo antes de `AWSLogs/`, a fonte de um bucket cadastrado) abre a seção.
 */
function AwsAdvancedBuckets({
  account,
  canWrite,
  managed,
}: {
  account: CloudAccount;
  canWrite: boolean;
  managed: boolean;
}) {
  const [open, setOpen] = useState(() => logBucketNames(account.buckets).length > 0);
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === `#${ADVANCED_BUCKETS_ID}`) setOpen(true);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return (
    <details
      id={ADVANCED_BUCKETS_ID}
      className="space-y-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">Avançado: buckets fora do padrão</summary>
      <AwsLogBuckets account={account} canWrite={canWrite} managed={managed} />
    </details>
  );
}

/**
 * GCP: a assinatura do Pub/Sub; Cloudflare: as zonas. Os dois podem chegar depois do cadastro. Na conta que a Verax
 * cadastrou, o campo fica desligado.
 */
function EditSource({ account, disabled = false }: { account: CloudAccount; disabled?: boolean }) {
  const gcp = account.provider === 'gcp';
  const [value, setValue] = useState(gcp ? (subscriptionLabel(account) ?? '') : account.zones.join(', '));
  const [error, setError] = useState<string>();
  const update = useUpdateCloudAccount(account.id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = cloudAccountUpdateSchema.safeParse(
      gcp
        ? { pubsubSubscription: value.trim() ? qualifyPubsubSubscription(account.accountId, value) : null }
        : { zones: splitList(value) },
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
        hint={
          gcp
            ? 'O nome, ou o nome completo (projects/<projeto>/subscriptions/<nome>) se estiver noutro projeto.'
            : 'Domínios separados por vírgula.'
        }
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={error}
        disabled={disabled}
      />
      <FormError error={update.error} />
      <Button type="submit" variant="secondary" disabled={disabled || update.isPending}>
        {gcp ? 'Salvar assinatura' : 'Salvar zonas'}
      </Button>
    </form>
  );
}

/**
 * O que configurar na GCP e no Cloudflare (a AWS tem a seção dela, `AwsOnboardingSection`). Na VM própria do cliente
 * (`nodePlatform: vm` do `GET /v1/auth/client-config`), o nó não tem identidade do Google: a GCP é lida com a chave de
 * uma identidade só de leitura, colada aqui. A API recusa as chaves nos outros nós; a escolha aqui é só a das
 * instruções.
 */
function ProviderSteps({
  account,
  canWrite,
  canEditSource,
}: {
  account: CloudAccount;
  canWrite: boolean;
  /** Alterar a fonte (a identidade do sink): não na conta que a Verax cadastrou. A credencial segue `canWrite`. */
  canEditSource: boolean;
}) {
  const config = useAuthClientConfig();
  const vm = config.data?.nodePlatform === 'vm';
  if (account.provider === 'gcp') {
    return vm ? (
      <GcpKeySteps account={account} canWrite={canWrite} />
    ) : (
      <GcpSteps account={account} canWrite={canEditSource} />
    );
  }
  if (account.provider === 'cloudflare') return <CloudflareSteps account={account} canWrite={canWrite} />;
  return null;
}

/** No nó que não informa o próprio tópico (ambiente local), o comando sai com este no lugar. */
const SINK_TOPIC_PLACEHOLDER = 'projects/PROJETO-DO-NO/topics/TOPICO-DO-NO';

/**
 * O que configurar no projeto da GCP do cliente: um sink que só copia os eventos de segurança para o tópico do nó. A
 * Verax não recebe nenhum papel no projeto, e nenhuma chave de conta de serviço é criada. A identidade do sink, que o
 * cliente cola aqui, é a única que a Verax deixa publicar no tópico.
 */
function GcpSteps({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const command = gcpSinkCommand(account.accountId, account.sinkTopic ?? SINK_TOPIC_PLACEHOLDER);
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Leitura do projeto {account.accountId}
      </h3>
      <p className="text-sm text-muted-foreground">
        O projeto só envia uma cópia dos eventos de segurança para o nó do Verax: ninguém da Verax ganha
        acesso a ele, os logs originais não mudam e nenhuma chave de conta de serviço é criada.
      </p>
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li className="space-y-2">
          <p>
            No Cloud Shell do projeto, com permissão para criar coletores de logs (papel{' '}
            <code className="font-mono text-xs">roles/logging.configWriter</code> ou dono do projeto), rode:
          </p>
          <CommandBlock command={command} label="Copiar o comando do sink" />
          {!account.sinkTopic && (
            <p className="text-xs text-muted-foreground">
              Este nó não informa o próprio tópico: troque {SINK_TOPIC_PLACEHOLDER} pelo tópico que a Verax
              passar.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Se o projeto está em <code className="font-mono text-xs">monitored_projects</code> do nó (um
            projeto da própria Verax), o sink já existe, criado pelo Terraform: não rode o comando, ou o
            projeto ganha um segundo sink e conta em dobro no uso.
          </p>
        </li>
        <li className="space-y-2">
          <p>
            O comando termina mostrando a identidade do coletor (sink), que acaba em
            @gcp-sa-logging.iam.gserviceaccount.com; este comando a mostra de novo:
          </p>
          <CommandBlock
            command={gcpSinkIdentityCommand(account.accountId)}
            label="Copiar o comando que mostra a identidade do sink"
          />
          <p>{canWrite ? 'Cole a identidade aqui:' : 'Quem administra as contas cola a identidade aqui.'}</p>
          {canWrite ? (
            <SinkIdentityForm account={account} />
          ) : (
            <p className="break-all font-mono text-xs">
              {account.sinkWriterIdentity ?? 'ainda não informada'}
            </p>
          )}
        </li>
        <li>
          A Verax libera a publicação no tópico só para essa identidade e informa a assinatura do Pub/Sub. A
          conexão muda para "Conectada" quando o primeiro evento chegar.
        </li>
      </ol>
    </section>
  );
}

/**
 * A identidade do sink que o cliente colou. Não é segredo: é a quem o Terraform do nó dá a publicação no tópico. O
 * aviso do gcloud (entre crases) ou só o e-mail viram a forma completa antes de conferir.
 */
function SinkIdentityForm({ account }: { account: CloudAccount }) {
  const [value, setValue] = useState(account.sinkWriterIdentity ?? '');
  const [error, setError] = useState<string>();
  const update = useUpdateCloudAccount(account.id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = cloudAccountUpdateSchema.safeParse({
      sinkWriterIdentity: value.trim() ? normalizeSinkWriterIdentity(value) : null,
    });
    if (!input.success) {
      setError(Object.values(fieldErrors(input.error))[0]);
      return;
    }
    setError(undefined);
    update.mutate(input.data, {
      onSuccess: (saved) => setValue(saved.sinkWriterIdentity ?? ''),
    });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-2">
      <Field
        label="Identidade do sink"
        hint="Como o comando mostra: serviceAccount:service-<número>@gcp-sa-logging.iam.gserviceaccount.com."
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={error}
        spellCheck={false}
        autoComplete="off"
      />
      <FormError error={update.error} />
      {update.isSuccess && (
        <p role="status" className="text-xs text-muted-foreground">
          {update.data.sinkWriterIdentity
            ? 'Identidade salva. A Verax libera a publicação no tópico só para ela.'
            : 'Identidade apagada.'}
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={update.isPending}>
        Salvar identidade
      </Button>
    </form>
  );
}

/**
 * O que configurar no Cloudflare: um token de conta só de leitura, criado pelo link com as permissões já marcadas,
 * restrito ao IP de saída do nó e colado aqui. Ele vai cifrado para o cofre do nó e nunca volta para a tela: o cartão
 * mostra só o fim do ID do token (`…abcd`), a validade e a última conferência.
 */
function CloudflareSteps({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Leitura da conta {account.accountId}
      </h3>
      <p className="text-sm text-muted-foreground">
        O Verax lê a auditoria e os eventos de segurança da conta com um token só de leitura. O token fica
        cifrado no cofre do nó: não volta para esta tela, nem para a auditoria ou o log.
      </p>
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li className="space-y-2">
          <p>
            No Cloudflare, crie um token de conta com as permissões já marcadas, todas só de leitura:{' '}
            <a
              href={cloudflareTokenTemplateUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              criar o token no Cloudflare
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
            .
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {CLOUDFLARE_TOKEN_PERMISSIONS.map((permission) => (
              <li key={permission.key}>
                {permission.scope} · {permission.name} · Read
              </li>
            ))}
          </ul>
        </li>
        <li className="space-y-2">
          <p>
            Em <span lang="en">Client IP Address Filtering</span>, libere só o IP de saída do nó
            {account.egressIps.length > 0 ? ':' : ', que a Verax informa.'}
          </p>
          {account.egressIps.length > 0 && (
            <CommandBlock command={account.egressIps.join(', ')} label="Copiar o IP de saída do nó" />
          )}
          <p className="text-xs text-muted-foreground">
            Se definir uma validade (TTL), o painel avisa 14 dias antes de o token vencer.
          </p>
        </li>
        <li className="space-y-2">
          <CredentialStep
            account={account}
            canWrite={canWrite}
            texts={CREDENTIAL_TEXTS.cloudflare}
            renderForm={(props) => <CloudflareTokenForm account={account} {...props} />}
          />
        </li>
        <li>
          Informe as zonas monitoradas. A conexão muda para "Conectada" na primeira leitura bem-sucedida,
          mesmo sem nenhum evento.
        </li>
      </ol>
    </section>
  );
}

/**
 * O campo do token: tipo senha, sem preenchimento automático nem correção, e zerado no envio (antes da resposta). O
 * valor colado vai do campo para a requisição e não fica em nenhum estado da tela depois disso.
 */
function CloudflareTokenForm({
  account,
  replacing = false,
  focusOnMount = false,
  onCancel,
  onSaved,
}: CredentialFormProps & { account: CloudAccount }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const credential = useCloudCredential(account.id);
  useEffect(() => {
    if (focusOnMount) input.current?.focus();
  }, [focusOnMount]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // O que o Cloudflare mostra costuma vir com espaço ou quebra de linha nas pontas ao copiar.
    const parsed = cloudCredentialInputSchema.safeParse({
      kind: 'cloudflare_api_token',
      token: value.trim(),
    });
    setValue('');
    if (!parsed.success) {
      credential.reset();
      setError(parsed.error.issues[0]?.message ?? 'Token inválido.');
      return;
    }
    setError(undefined);
    const saved = await credential.save(parsed.data);
    if (saved?.keyStatus) onSaved(saved.keyStatus);
  };

  const apiError = credential.error ? credentialErrorText(credential.error) : undefined;
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-2">
      <Field
        ref={input}
        label="Token de API do Cloudflare"
        hint="O Cloudflare mostra o token uma vez só, ao criá-lo. Depois de guardado, ele não volta para esta tela."
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        error={error ?? apiError}
      />
      {credential.pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Conferindo o token no Cloudflare…
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={credential.pending}>
          {replacing ? 'Trocar token' : 'Guardar token'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * A leitura de um projeto da GCP na VM própria do cliente: sem a conta de serviço da VM, o cliente cria no projeto dele
 * o tópico, a assinatura e o sink (o filtro de segurança do gerenciado), e uma conta de serviço com
 * `roles/pubsub.subscriber` só na assinatura. Cadastra a assinatura e cola a chave JSON da conta de serviço, que vai
 * cifrada para o cofre do nó.
 */
function GcpKeySteps({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const subscription = gcpReaderSubscription(account.accountId);
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Leitura do projeto {account.accountId}
      </h3>
      <p className="text-sm text-muted-foreground">
        Este ambiente roda numa VM sua, sem identidade de nuvem: o projeto envia uma cópia dos eventos de
        segurança para uma assinatura do Pub/Sub no próprio projeto, e o Verax a lê com a chave de uma conta
        de serviço que só pode ler essa assinatura. Os logs originais não mudam, e a chave fica cifrada no
        cofre do nó, na sua VM.
      </p>
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li className="space-y-2">
          <p>
            No Cloud Shell do projeto, como dono do projeto (ou com permissão para criar tópicos, assinaturas,
            coletores de logs e contas de serviço), rode:
          </p>
          <CommandBlock command={gcpReaderCommands(account.accountId)} label="Copiar os comandos" />
          <p className="text-xs text-muted-foreground">
            A conta de serviço{' '}
            <code className="font-mono">{gcpReaderServiceAccountEmail(account.accountId)}</code> recebe só o
            papel <code className="font-mono">{GCP_READER_ROLE}</code>, e só na assinatura: nenhum papel no
            projeto. O último comando grava a chave num arquivo JSON; depois de colar, apague o arquivo.
          </p>
        </li>
        <li className="space-y-2">
          <p>
            Cadastre a assinatura <code className="break-all font-mono text-xs">{subscription}</code> no campo
            &ldquo;Assinatura do Pub/Sub&rdquo; desta conta
            {account.pubsubSubscription ? ' (já cadastrada)' : ''}.
          </p>
        </li>
        <li className="space-y-2">
          {account.pubsubSubscription || account.keyStatus ? (
            <CredentialStep
              account={account}
              canWrite={canWrite}
              texts={CREDENTIAL_TEXTS.gcp}
              renderForm={(props) => <GcpKeyForm account={account} {...props} />}
            />
          ) : (
            <p>Cadastrada a assinatura, cole aqui a chave da conta de serviço.</p>
          )}
        </li>
        <li>A conexão muda para &ldquo;Conectada&rdquo; quando o primeiro evento chegar.</li>
      </ol>
    </section>
  );
}

/**
 * O arquivo JSON da chave, colado inteiro: lido aqui, só os quatro campos que o nó usa vão para a API (o resto, como o
 * `token_uri`, nunca sai do navegador). O campo é zerado no envio.
 */
function GcpKeyForm({
  account,
  replacing = false,
  focusOnMount = false,
  onCancel,
  onSaved,
}: CredentialFormProps & { account: CloudAccount }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const credential = useCloudCredential(account.id);
  const fieldId = useId();
  useEffect(() => {
    if (focusOnMount) input.current?.focus();
  }, [focusOnMount]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = gcpServiceAccountKeyFromJson(value.trim());
    setValue('');
    if (!read.ok) {
      credential.reset();
      setError(read.message);
      return;
    }
    const parsed = cloudCredentialInputSchema.safeParse({ kind: 'gcp_service_account_key', ...read.fields });
    if (!parsed.success) {
      credential.reset();
      setError(parsed.error.issues[0]?.message ?? 'Chave inválida.');
      return;
    }
    setError(undefined);
    const saved = await credential.save(parsed.data);
    if (saved?.keyStatus) onSaved(saved.keyStatus);
  };

  const apiError = credential.error ? credentialErrorText(credential.error, CREDENTIAL_TEXTS.gcp) : undefined;
  const shown = error ?? apiError;
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-2">
      <div className="space-y-1">
        <label htmlFor={fieldId} className="text-sm font-medium">
          Chave da conta de serviço (JSON)
        </label>
        <Textarea
          id={fieldId}
          ref={input}
          rows={4}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono text-xs [-webkit-text-security:disc]"
          aria-invalid={shown ? true : undefined}
          aria-describedby={`${fieldId}-dica${shown ? ` ${fieldId}-erro` : ''}`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <p id={`${fieldId}-dica`} className="text-xs text-muted-foreground">
          O conteúdo inteiro do arquivo {'{'}…{'}'} que o Google baixou. Depois de guardada, a chave não volta
          para esta tela.
        </p>
        {shown && (
          <p id={`${fieldId}-erro`} className="text-xs text-critical-text">
            {shown}
          </p>
        )}
      </div>
      {credential.pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Conferindo a chave no Google…
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={credential.pending}>
          {replacing ? 'Trocar chave' : 'Guardar chave'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
