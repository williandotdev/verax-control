import {
  CLOUD_PROVIDERS,
  type CloudAccount,
  cloudAccountCreateSchema,
  cloudAccountUpdateSchema,
  type CloudCredentialStatus,
  cloudCredentialInputSchema,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  cloudflareTokenTemplateUrl,
  type CloudProvider,
  daysUntilExpiry,
  gcpSinkCommand,
  gcpSinkIdentityCommand,
  isCloudflareBlockingError,
  normalizeSinkWriterIdentity,
  qualifyPubsubSubscription,
} from '@verax/shared';
import { Copy, ExternalLink } from 'lucide-react';
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
} from '@/features/admin/admin-api';
import { AdminShell, ConfirmButton, FormError, SelectInput } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import {
  ACCOUNT_NOUNS,
  CONNECTION_LABELS,
  CONNECTOR_GUIDE_URL,
  CONNECTOR_TEMPLATE_URL,
  connectionErrorHint,
  connectionHint,
  CREDENTIAL_STATUS_LABELS,
  PROVIDER_LABELS,
} from '@/features/admin/labels';
import { useMe } from '@/features/session/session';
import { ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatRelative, plural } from '@/lib/format';

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
 * conexão. O cadastro não pede credencial; o token do Cloudflare tem formulário próprio no detalhe da conta e vai
 * cifrado para o cofre do nó (fase 2).
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
      description="Contas AWS, projetos da GCP e contas do Cloudflare monitorados. O Verax Control só lê. O token do Cloudflare fica cifrado no cofre do nó, nunca no cadastro."
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

/** Selo "Aguardando / Conectada / Erro": a cor vem com ícone e texto, nunca só a cor. */
/**
 * O erro da última coleta: a explicação, quando há uma, e o código. No Cloudflare, os erros do token param a coleta
 * até outro token ser colado (o worker não chama mais o Cloudflare com ele).
 */
function ConnectionErrorDetail({ account, code }: { account: CloudAccount; code: string }) {
  const hint = connectionErrorHint(code);
  const stopped = account.provider === 'cloudflare' && isCloudflareBlockingError(code);
  return (
    <>
      {hint && ` ${hint}`}
      {stopped && ' A coleta está parada até um token válido ser colado abaixo.'} Tipo do erro:{' '}
      <code className="font-mono">{code}</code>.
    </>
  );
}

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

/** Monta o corpo do cadastro com só os campos do provedor escolhido. */
function createInput(values: CreateValues) {
  const accountId = values.accountId.trim();
  switch (values.provider) {
    case 'aws':
      return { provider: 'aws', accountId, regions: splitList(values.regions) };
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
        <dd className="space-y-0.5">
          <ConnectionBadge account={account} />
          <p className="text-xs text-muted-foreground">
            {connectionHint(account.provider, account.connection)}
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
        <ProviderSteps account={account} canWrite={canWrite} />
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
  return <ConnectorSteps account={account} />;
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
        <li>A conexão muda para "Conectada" quando o primeiro evento da conta chegar.</li>
      </ol>
    </section>
  );
}
