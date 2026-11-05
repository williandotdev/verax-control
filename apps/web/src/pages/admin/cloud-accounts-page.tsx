import {
  AWS_READER_AUDIENCE,
  AWS_READER_STACK_NAME,
  AWS_READER_TEMPLATE_FILE,
  awsLogBucketArns,
  awsReaderDeployCommand,
  CLOUD_PROVIDERS,
  type CloudAccount,
  cloudAccountCreateSchema,
  cloudAccountUpdateSchema,
  type CloudCredentialStatus,
  cloudCredentialInputSchema,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  cloudflareTokenTemplateUrl,
  cloudFormationConsoleUrl,
  type CloudProvider,
  daysUntilExpiry,
  gcpSinkCommand,
  gcpSinkIdentityCommand,
  isCloudflareBlockingError,
  logBucketNames,
  normalizeSinkWriterIdentity,
  qualifyPubsubSubscription,
} from '@verax/shared';
import { Copy, Download, ExternalLink } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { SEVERITY_STYLES } from '@/design/severity';
import {
  ADMIN_PAGE_SIZE,
  useCloudAccountList,
  useCloudCredential,
  useCreateCloudAccount,
  useUpdateCloudAccount,
  useVerifyAwsAccount,
} from '@/features/admin/admin-api';
import { AdminShell, ConfirmButton, FormError, SelectInput } from '@/features/admin/admin-ui';
import {
  type BucketRow,
  bucketRowErrors,
  bucketsFromRows,
  withoutBucketErrors,
} from '@/features/admin/aws-log-buckets';
import { AwsLogBuckets, LogBucketsEditor } from '@/features/admin/aws-log-buckets-editor';
import { AWS_READER_TEMPLATE_URL } from '@/features/admin/aws-reader-template';
import { fieldErrors } from '@/features/admin/forms';
import {
  ACCOUNT_NOUNS,
  AWS_READER_GUIDE_URL,
  awsConnectionErrorHint,
  cloudflareConnectionErrorHint,
  CONNECTION_LABELS,
  connectionHint,
  CREDENTIAL_STATUS_LABELS,
  PROVIDER_LABELS,
} from '@/features/admin/labels';
import { useMe } from '@/features/session/session';
import { ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatDay, formatRelative, plural } from '@/lib/format';

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
 * conexão. O cadastro não pede credencial: na AWS, o cliente cria o papel de leitura sem chave com o template e clica
 * em "Verificar"; o token do Cloudflare tem formulário próprio no detalhe da conta e vai cifrado para o cofre do nó
 * (fase 2).
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
 * fica junto do "Verificar".
 */
function ConnectionErrorDetail({ account, code }: { account: CloudAccount; code: string }) {
  const cloudflare = account.provider === 'cloudflare';
  const hint = cloudflare ? cloudflareConnectionErrorHint(code) : null;
  const stopped = cloudflare && isCloudflareBlockingError(code);
  return (
    <>
      {hint && ` ${hint}`}
      {stopped && ' A coleta está parada até um token válido ser colado abaixo.'} Tipo do erro:{' '}
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

interface CreateValues {
  provider: CloudProvider;
  accountId: string;
  regions: string;
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
        regions: splitList(values.regions),
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
    regions: 'sa-east-1',
    pubsubSubscription: '',
    zones: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bucketRows, setBucketRows] = useState<BucketRow[]>([]);
  const [bucketErrors, setBucketErrors] = useState<Record<number, string>>({});
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
            ? 'Falta criar o papel de leitura nela e verificar.'
            : create.data.provider === 'cloudflare'
              ? 'Falta colar o token de leitura do Cloudflare.'
              : 'Falta configurar a leitura no nó.'}
        </p>
        <ProviderSteps account={create.data} canWrite />
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
      return;
    }
    setErrors({});
    setBucketErrors({});
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
          <Field
            label="Regiões monitoradas"
            hint="Separadas por vírgula, por exemplo: sa-east-1, us-east-1."
            value={values.regions}
            onChange={set('regions')}
            error={listError('regions')}
          />
          <LogBucketsEditor
            rows={bucketRows}
            onChange={setBucketRows}
            errors={bucketErrors}
            legend="Buckets de log (opcional)"
            note="Pode deixar para depois: a lista muda no detalhe da conta."
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
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Conexão</dt>
        <dd className="space-y-0.5">
          <ConnectionBadge account={account} />
          <p className="text-xs text-muted-foreground">
            {connectionHint(account)}
            {account.connection === 'error' && account.connectionError && (
              <ConnectionErrorDetail account={account} code={account.connectionError} />
            )}
          </p>
        </dd>
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
      {account.provider === 'aws' && <AwsLogBuckets account={account} canWrite={canWrite} />}
      <ProviderSteps account={account} canWrite={canWrite} />
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
      />
      <FormError error={update.error} />
      <Button type="submit" variant="secondary" disabled={update.isPending}>
        {gcp ? 'Salvar assinatura' : 'Salvar zonas'}
      </Button>
    </form>
  );
}

function ProviderSteps({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  if (account.provider === 'gcp') return <GcpSteps account={account} canWrite={canWrite} />;
  if (account.provider === 'cloudflare') return <CloudflareSteps account={account} canWrite={canWrite} />;
  return <AwsSteps account={account} canWrite={canWrite} />;
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

/** Comando pronto, com o botão de copiar: quebra a linha na tela, mas a cópia é o texto exato. */
function CommandBlock({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(command).then(() => setCopied(true));
  return (
    <div className="space-y-1">
      <pre className="whitespace-pre-wrap break-all rounded bg-foreground/5 p-2 font-mono text-xs">
        <code>{command}</code>
      </pre>
      <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={label}>
        <Copy aria-hidden />
        {copied ? 'Copiado' : 'Copiar'}
      </Button>
    </div>
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
  // A última escrita feita aqui vale só até chegar um estado mais novo da conta: no detalhe, a lista relida depois dela
  // ou depois de outra escrita (desativar o monitoramento apaga o token); no cadastro, a conta da resposta não é
  // relida, e a escrita daqui continua valendo. Só os metadados; o token nunca fica guardado.
  const [local, setLocal] = useState<LocalCredential | null>(null);
  const current = local !== null && local.accountUpdatedAt === account.updatedAt ? local : null;
  const keyStatus = current ? current.keyStatus : account.keyStatus;
  // Os avisos seguem o que está na tela: "guardado" só com o mesmo token, "removido" só sem token.
  const justSaved = local?.event === 'saved' && keyStatus?.keyIdSuffix === local.keyStatus?.keyIdSuffix;
  const justRemoved = local?.event === 'removed' && keyStatus === null;
  const remember = (next: Omit<LocalCredential, 'accountUpdatedAt'>) =>
    setLocal({ ...next, accountUpdatedAt: account.updatedAt });
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
          {keyStatus ? (
            <CredentialCard
              account={account}
              status={keyStatus}
              canWrite={canWrite}
              justSaved={justSaved}
              onChange={remember}
            />
          ) : canWrite && account.status !== 'active' ? (
            <p>Reative o monitoramento para colar o token: a conta desativada não guarda credencial.</p>
          ) : canWrite ? (
            <>
              {justRemoved && (
                <p role="status" className="text-muted-foreground">
                  Token removido do cofre do nó. Apague-o também no Cloudflare.
                </p>
              )}
              <p>Cole o token aqui:</p>
              <CloudflareTokenForm
                account={account}
                focusOnMount={justRemoved}
                onSaved={(saved) => remember({ keyStatus: saved, event: 'saved' })}
              />
            </>
          ) : (
            <p>Quem administra as contas cola o token aqui. Nenhum token guardado ainda.</p>
          )}
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
 * O que esta tela acabou de fazer com a credencial: guardou (com os metadados da resposta) ou removeu, e sobre qual
 * versão da conta (`updatedAt`). Chegando outra versão, vale a da conta.
 */
interface LocalCredential {
  keyStatus: CloudCredentialStatus | null;
  event: 'saved' | 'removed' | 'idle';
  accountUpdatedAt: string;
}

const CREDENTIAL_SEVERITY = {
  active: 'ok',
  expiring: 'medium',
  expired: 'critical',
} as const satisfies Record<CloudCredentialStatus['status'], keyof typeof SEVERITY_STYLES>;

/** O erro da API em texto, para ficar junto do campo ou do cartão (o 503 é o Cloudflare que não respondeu). */
function credentialErrorText(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 503) {
    return 'O Cloudflare não respondeu a tempo. Tente de novo em instantes.';
  }
  // 404 aqui é a conta ou o token que outra pessoa já tirou: a mensagem da API diz qual.
  if (error instanceof ApiRequestError && error.status === 404) return error.message;
  return errorMessage(error);
}

/**
 * O token guardado: só os metadados. Vencendo em até 14 dias, o aviso pede a troca; vencido, a coleta parou. Quem
 * administra troca (cola outro) ou remove.
 */
function CredentialCard({
  account,
  status,
  canWrite,
  justSaved,
  onChange,
}: {
  account: CloudAccount;
  status: CloudCredentialStatus;
  canWrite: boolean;
  justSaved: boolean;
  onChange: (local: Omit<LocalCredential, 'accountUpdatedAt'>) => void;
}) {
  const titleId = useId();
  const title = useRef<HTMLParagraphElement>(null);
  const [replacing, setReplacing] = useState(false);
  const credential = useCloudCredential(account.id);
  const { icon: Icon, tone } = SEVERITY_STYLES[CREDENTIAL_SEVERITY[status.status]];
  const days = daysUntilExpiry(status.expiresAt);
  // Guardado o token, o formulário sai da tela: o foco vai para o título do cartão, ao lado da confirmação.
  useEffect(() => {
    if (justSaved) title.current?.focus();
  }, [justSaved, status.keyIdSuffix]);

  const remove = async () => {
    if (await credential.remove()) onChange({ keyStatus: null, event: 'removed' });
  };

  return (
    <div role="group" aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
      <p id={titleId} ref={title} tabIndex={-1} className="font-semibold">
        Token de API guardado
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">Token</dt>
        <dd>
          <code className="font-mono">…{status.keyIdSuffix}</code>
        </dd>
        <dt className="text-muted-foreground">Situação</dt>
        <dd className="inline-flex items-center gap-1">
          <Icon aria-hidden className={cn('size-4', tone)} />
          {CREDENTIAL_STATUS_LABELS[status.status]}
        </dd>
        <dt className="text-muted-foreground">Validade</dt>
        <dd>{status.expiresAt ? `vence em ${formatDate(status.expiresAt)}` : 'sem data de vencimento'}</dd>
        <dt className="text-muted-foreground">Conferido</dt>
        <dd>{formatRelative(status.verifiedAt)}</dd>
      </dl>
      {status.status === 'expiring' && days !== null && (
        <p className="rounded-md border border-medium/70 bg-medium/15 p-2">
          O token vence em {plural(days, 'dia', 'dias')}. Crie outro no Cloudflare e cole aqui antes disso, ou
          a coleta para.
        </p>
      )}
      {status.status === 'expired' && (
        <p className="rounded-md border border-critical/50 bg-critical/10 p-2">
          O token venceu e a coleta parou. Crie outro no Cloudflare e cole aqui.
        </p>
      )}
      {justSaved && (
        <p role="status" className="text-muted-foreground">
          Token conferido no Cloudflare e guardado no cofre do nó (…{status.keyIdSuffix}).
        </p>
      )}
      {canWrite && !replacing && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              credential.reset();
              onChange({ keyStatus: status, event: 'idle' });
              setReplacing(true);
            }}
          >
            Trocar token
          </Button>
          <ConfirmButton
            label="Remover token"
            confirmLabel="Confirmar remoção"
            busy={credential.pending}
            warning="A coleta do Cloudflare para até outro token ser colado. Apague o token no Cloudflare também."
            onConfirm={() => void remove()}
          />
        </div>
      )}
      {!replacing && credential.error ? (
        <p role="alert" className="text-critical-text">
          {credentialErrorText(credential.error)}
        </p>
      ) : null}
      {replacing && (
        <CloudflareTokenForm
          account={account}
          replacing
          focusOnMount
          onCancel={() => setReplacing(false)}
          onSaved={(saved) => {
            setReplacing(false);
            onChange({ keyStatus: saved, event: 'saved' });
          }}
        />
      )}
    </div>
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
}: {
  account: CloudAccount;
  replacing?: boolean;
  focusOnMount?: boolean;
  onCancel?: () => void;
  onSaved: (keyStatus: CloudCredentialStatus) => void;
}) {
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

/** Um valor da pilha, com o nome do parâmetro no template e o botão de copiar; sem valor, o que fazer. */
function StackValue({
  label,
  parameter,
  value,
  missing,
  hint,
}: {
  label: string;
  parameter: string;
  value: string | null;
  missing: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (value !== null) void navigator.clipboard?.writeText(value).then(() => setCopied(true));
  };
  return (
    <>
      <dt className="text-muted-foreground">
        {label} <code className="font-mono text-xs">({parameter})</code>
      </dt>
      <dd className="space-y-1">
        {value === null ? (
          <p className="text-critical-text">{missing}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-foreground/5 px-2 py-1 font-mono text-xs">{value}</code>
            <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label={`Copiar: ${label}`}>
              <Copy aria-hidden />
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        )}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </dd>
    </>
  );
}

/**
 * Conectar AWS (fase 2, PR-V3'): o papel de leitura sem chave. O cliente baixa o template (o arquivo revisado do
 * repositório, que o painel serve), cria a pilha no console da AWS com os três valores do nó e clica em "Verificar".
 * Nada é colado aqui: não há chave nem ExternalId, e nenhum dos valores é segredo.
 */
function AwsSteps({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const buckets = logBucketNames(account.buckets);
  const bucketArns = awsLogBucketArns(buckets).join(',');
  const audience = account.webIdentityAudience ?? AWS_READER_AUDIENCE;
  const egressIps = account.egressIps.length > 0 ? account.egressIps.join(',') : null;
  const command = awsReaderDeployCommand({
    nodeServiceAccountId: account.nodeServiceAccountId,
    egressIps: account.egressIps,
    audience,
    buckets,
  });
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Conectar a conta {account.accountId}
      </h3>
      <p className="text-sm text-muted-foreground">
        O Verax lê a conta por um papel IAM somente leitura, sem chave: não há nada para criar, copiar ou
        guardar. Só o nó do Verax entra no papel, com um token de até 1 hora que o Google assina, e só a
        partir do IP de saída do nó.
      </p>
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li className="space-y-2">
          <p>
            <a
              href={AWS_READER_TEMPLATE_URL}
              download={AWS_READER_TEMPLATE_FILE}
              className="inline-flex items-center gap-1 font-medium underline"
            >
              <Download aria-hidden className="size-3.5" />
              Baixar o template ({AWS_READER_TEMPLATE_FILE})
            </a>
          </p>
          <p className="text-xs text-muted-foreground">
            É o arquivo revisado do repositório, sem nada preenchido. O que a pilha cria e o que o papel pode
            fazer estão no{' '}
            <a
              href={AWS_READER_GUIDE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              passo a passo
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
            .
          </p>
        </li>
        <li className="space-y-2">
          <p>
            No console da AWS, abra o{' '}
            <a
              href={cloudFormationConsoleUrl(account.regions[0])}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              CloudFormation
              <ExternalLink aria-hidden className="size-3.5" />
            </a>{' '}
            em <span lang="en">Create stack</span> → <span lang="en">Upload a template file</span>, envie o
            arquivo e dê o nome <code className="font-mono text-xs">{AWS_READER_STACK_NAME}</code> à pilha.
            Preencha os três valores do nó (nenhum é segredo):
          </p>
          <dl className="grid grid-cols-1 gap-y-1.5">
            <StackValue
              label="ID da conta de serviço do nó"
              parameter="NodeServiceAccountId"
              value={account.nodeServiceAccountId}
              missing="Este nó ainda não informa o ID. Peça à Verax antes de criar a pilha."
            />
            <StackValue
              label="IP de saída do nó"
              parameter="NodeEgressIps"
              value={egressIps}
              missing="Este nó ainda não informa o IP. Peça à Verax antes de criar a pilha."
            />
            <StackValue
              label="Audience"
              parameter="Audience"
              value={audience}
              missing=""
              hint="Já vem preenchido no template: só confira."
            />
          </dl>
          {bucketArns ? (
            <>
              <p>
                Em <code className="font-mono text-xs">LogBucketArns</code>, os buckets de log cadastrados:
              </p>
              <CommandBlock command={bucketArns} label="Copiar os ARNs dos buckets de log" />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Nenhum bucket de log cadastrado nesta conta: o{' '}
              <code className="font-mono text-xs">LogBucketArns</code> fica vazio, e o papel não lê nenhum
              log. Os buckets do CloudTrail, do export do GuardDuty e do WAF que o Verax vai ler entram em
              &ldquo;Buckets de log&rdquo;, no detalhe da conta.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Se os buckets usam SSE-KMS (o export do GuardDuty sempre usa), informe também as chaves em{' '}
            <code className="font-mono text-xs">LogKmsKeyArns</code>. Na revisão, marque a confirmação do IAM
            (recursos com nomes personalizados) e crie a pilha: leva 1 ou 2 minutos.
          </p>
          <p className="text-xs text-muted-foreground">
            A pilha já existe e os buckets mudaram aqui? Atualize-a: no CloudFormation, selecione{' '}
            <code className="font-mono text-xs">{AWS_READER_STACK_NAME}</code> →{' '}
            <span lang="en">Update stack</span> → <span lang="en">Use existing template</span>, troque o{' '}
            <code className="font-mono text-xs">LogBucketArns</code> pela lista acima (e o{' '}
            <code className="font-mono text-xs">LogKmsKeyArns</code>, se um bucket novo usa SSE-KMS) e
            confirme. Depois, clique em Verificar conexão.
          </p>
          <details className="space-y-1">
            <summary className="cursor-pointer">Prefere a CLI?</summary>
            <p className="text-xs text-muted-foreground">
              No terminal ou no AWS CloudShell, na pasta do arquivo baixado. O mesmo comando cria a pilha ou
              atualiza a que já existe, com a lista de buckets desta tela:
            </p>
            <CommandBlock command={command} label="Copiar o comando da CLI" />
          </details>
        </li>
        <li className="space-y-2">
          <AwsVerify account={account} canWrite={canWrite} />
        </li>
      </ol>
      <p className="text-xs text-muted-foreground">
        Para desconectar: desative o monitoramento aqui e apague a pilha{' '}
        <code className="font-mono text-xs">{AWS_READER_STACK_NAME}</code>. Para cortar na hora as sessões já
        emitidas (cada uma vale até 1 hora), use <span lang="en">Revoke active sessions</span> no papel. Não
        há chave para apagar.
      </p>
    </section>
  );
}

/**
 * "Verificar": o pedido vai para o worker, o único processo do nó que entra no papel; a tela relê a conta enquanto ele
 * não responde (`useCloudAccountList`) e mostra o resultado, com o que fazer em cada erro.
 */
function AwsVerify({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const verify = useVerifyAwsAccount(account.id);
  const pending = account.checkRequestedAt !== null;
  const active = account.status === 'active';
  const errorHint =
    account.connection === 'error' && account.connectionError
      ? (awsConnectionErrorHint(account.connectionError) ?? `Erro: ${account.connectionError}.`)
      : null;
  return (
    <>
      <p>
        Criada a pilha, clique em Verificar: o Verax entra no papel e lê um objeto de cada bucket cadastrado.
      </p>
      {canWrite && active && (
        <Button type="button" onClick={() => verify.mutate()} disabled={pending || verify.isPending}>
          {pending ? 'Verificando…' : 'Verificar conexão'}
        </Button>
      )}
      {canWrite && !active && <p>Reative o monitoramento para verificar a conta.</p>}
      {!canWrite && <p className="text-muted-foreground">Quem administra as contas pede a verificação.</p>}
      <FormError error={verify.error} />
      <div role="status" className="text-sm">
        {pending ? (
          <p>
            Verificação pedida {formatRelative(account.checkRequestedAt ?? '')}. Logo depois de criar a pilha,
            o papel pode levar alguns minutos para valer: o Verax tenta de novo por até 10 minutos.
          </p>
        ) : account.connection === 'connected' ? (
          <p>
            Conectada: o Verax entrou no papel de leitura.
            {account.ingestFrom && <> Os logs são lidos a partir de {formatDay(account.ingestFrom)}.</>}
          </p>
        ) : errorHint ? (
          <p className="text-critical-text">{errorHint} Corrija e clique em Verificar de novo.</p>
        ) : null}
      </div>
    </>
  );
}
