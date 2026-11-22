import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DraftForm } from '@/form/draft-form';
import { ErrorSummary } from '@/form/error-summary';
import { FieldShell, Grid, INPUT, type Option, SelectField, TextField } from '@/form/fields';
import { useField } from '@/form/form-context';
import { ApiError, logSourcesApi } from '@/lib/api';
import type {
  CredentialKind,
  LogSourceProvider,
  LogSourceView,
  LogSourceWriteResult,
  NodeSyncOverview,
  TenantDetail,
  ValidationIssue,
} from '@/lib/api-types';
import { cn } from '@/lib/cn';
import type { Path } from '@/lib/paths';
import {
  ACCOUNT_LABELS,
  CREDENTIAL_KIND_LABELS,
  logSourceErrorMessage,
  PROVIDER_CREDENTIAL_KINDS,
  PROVIDER_LABELS,
} from './log-source-labels';
import {
  buildCredential,
  buildSpec,
  buildUpdate,
  type CredentialDraft,
  draftOf,
  EMPTY_CREDENTIAL,
  GCP_DEFAULT_SUBSCRIPTION,
  issuesForForm,
  isProvider,
  sealBlockReason,
  type SpecDraft,
} from './log-source-spec';

/**
 * Os formulários das fontes de log no detalhe do cliente: cadastrar (o provedor, a conta, os campos dele e, opcional,
 * a chave), alterar (só os campos do provedor) e enviar a chave. A chave colada fica no estado deste formulário, vai
 * por chamada direta à API (fora do cache das consultas e das mutações) e é apagada dos campos depois do envio, dê
 * certo ou não. Quando o servidor do cliente ainda não pode recebê-la (sem sincronizar, sem o cofre), os campos ficam
 * desligados, com o motivo.
 */

/** O resultado de uma escrita e o aviso para a tela. */
export type WriteDone = (result: LogSourceWriteResult, notice: string) => void;

const TEXTAREA =
  'min-h-20 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 font-mono text-sm placeholder:text-subtle-foreground disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-critical';

/** Uma lista digitada uma por linha (regiões, zonas): o texto fica no rascunho e vira lista no envio. */
function LinesField({ path, label, hint }: { path: Path; label: string; hint?: string }) {
  const binding = useField(path);
  return (
    <FieldShell binding={binding} label={label} hint={hint}>
      {(describedBy, invalid) => (
        <textarea
          id={binding.id}
          className={TEXTAREA}
          rows={3}
          autoComplete="off"
          spellCheck={false}
          value={typeof binding.value === 'string' ? binding.value : ''}
          disabled={binding.readOnly}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => binding.set(event.target.value === '' ? undefined : event.target.value)}
        />
      )}
    </FieldShell>
  );
}

/** Um campo da chave: fora do rascunho, sem preenchimento automático nem corretor; o segredo, oculto. */
function SecretField({
  id,
  label,
  hint,
  value,
  onChange,
  issues,
  disabled,
  kind,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  issues: readonly string[];
  disabled: boolean;
  kind: 'password' | 'text' | 'textarea';
}) {
  const binding = { id: `campo-${id}`, value, set: () => undefined, issues, readOnly: disabled };
  return (
    <FieldShell binding={binding} label={label} hint={hint}>
      {(describedBy, invalid) =>
        kind === 'textarea' ? (
          <textarea
            id={binding.id}
            className={cn(TEXTAREA, 'min-h-32')}
            rows={6}
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <input
            id={binding.id}
            className={cn(INPUT, 'font-mono')}
            type={kind}
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
        )
      }
    </FieldShell>
  );
}

function issuesAt(issues: readonly ValidationIssue[], path: string): string[] {
  return issues.filter((issue) => issue.path === path).map((issue) => issue.message);
}

/** Os campos da chave do tipo do provedor. */
function CredentialFields({
  kind,
  draft,
  onChange,
  issues,
  disabled,
}: {
  kind: CredentialKind;
  draft: CredentialDraft;
  onChange: (next: CredentialDraft) => void;
  issues: readonly ValidationIssue[];
  disabled: boolean;
}) {
  switch (kind) {
    case 'cloudflare_api_token':
      return (
        <SecretField
          id="credential.token"
          label="Token de API do Cloudflare"
          hint="O token só de leitura (nunca a Global API Key)."
          kind="password"
          value={draft.token}
          onChange={(token) => onChange({ ...draft, token })}
          issues={issuesAt(issues, 'credential.token')}
          disabled={disabled}
        />
      );
    case 'aws_access_key':
      return (
        <Grid className="lg:grid-cols-2">
          <SecretField
            id="credential.accessKeyId"
            label="ID da chave de acesso"
            hint="Do usuário IAM de leitura (20 caracteres)."
            kind="text"
            value={draft.accessKeyId}
            onChange={(accessKeyId) => onChange({ ...draft, accessKeyId })}
            issues={issuesAt(issues, 'credential.accessKeyId')}
            disabled={disabled}
          />
          <SecretField
            id="credential.secretAccessKey"
            label="Chave secreta"
            kind="password"
            value={draft.secretAccessKey}
            onChange={(secretAccessKey) => onChange({ ...draft, secretAccessKey })}
            issues={issuesAt(issues, 'credential.secretAccessKey')}
            disabled={disabled}
          />
        </Grid>
      );
    case 'gcp_service_account_key':
      return (
        <SecretField
          id="credential.json"
          label="Arquivo JSON da chave da conta de serviço"
          hint="Cole o conteúdo inteiro do arquivo. Só o projeto, o e-mail, o ID e a chave saem do navegador."
          kind="textarea"
          value={draft.json}
          onChange={(json) => onChange({ ...draft, json })}
          issues={issuesAt(issues, 'credential.json')}
          disabled={disabled}
        />
      );
  }
}

/**
 * A parte da chave num formulário: os campos do tipo do provedor quando ele vale neste cliente; desligados, com o
 * motivo, quando o servidor ainda não pode recebê-la; e, quando o provedor não leva chave aqui, o porquê.
 */
function CredentialSection({
  provider,
  overview,
  draft,
  onChange,
  issues,
  busy,
  optional,
}: {
  provider: LogSourceProvider;
  overview: NodeSyncOverview;
  draft: CredentialDraft;
  onChange: (next: CredentialDraft) => void;
  issues: readonly ValidationIssue[];
  busy: boolean;
  optional: boolean;
}) {
  const ids = useId();
  const kind = PROVIDER_CREDENTIAL_KINDS[provider];
  if (!overview.credentialKinds.includes(kind)) {
    return (
      <p role="note" className="rounded-lg border p-3 text-sm text-muted-foreground">
        {provider === 'aws'
          ? 'No ambiente da Verax, a AWS é lida pelo papel sem chave: não há chave a colar. Depois de cadastrar, mande ao cliente a pilha do CloudFormation.'
          : 'Este provedor não leva chave no servidor deste cliente.'}
      </p>
    );
  }
  const blocked = sealBlockReason(overview);
  const hintId = `${ids}-dica`;
  return (
    <fieldset
      className="space-y-3 rounded-xl border bg-surface p-4"
      disabled={blocked !== undefined || busy}
      aria-describedby={hintId}
    >
      <legend className="px-1 text-sm font-semibold">
        {CREDENTIAL_KIND_LABELS[kind]}
        {optional ? ' (opcional)' : ''}
      </legend>
      <p id={hintId} className="-mt-1 text-sm text-muted-foreground">
        {blocked ??
          (optional
            ? 'Opcional: o cliente também pode colar a chave no painel dele.'
            : 'A chave é cifrada aqui para o cofre do servidor do cliente e nunca aparece de novo. Vale a mais nova: uma colada no painel depois vence até a próxima enviada daqui.')}
      </p>
      <CredentialFields
        kind={kind}
        draft={draft}
        onChange={onChange}
        issues={issues}
        disabled={blocked !== undefined || busy}
      />
    </fieldset>
  );
}

/** Os campos do cadastro do provedor (na alteração, o provedor e a conta não mudam). */
function SpecFields({ provider }: { provider: LogSourceProvider }) {
  switch (provider) {
    case 'aws':
      return (
        <>
          <LinesField
            path={['spec', 'regions']}
            label="Regiões monitoradas"
            hint="Uma por linha (ou separadas por vírgula), como sa-east-1. A primeira abre o CloudFormation."
          />
          <Grid>
            <TextField
              path={['spec', 'buckets', 'cloudtrail']}
              label="Bucket do CloudTrail (opcional)"
              mono
              hint="Só o nome: s3:// e o ARN saem sozinhos."
            />
            <TextField path={['spec', 'buckets', 'guardduty']} label="Bucket do GuardDuty (opcional)" mono />
            <TextField
              path={['spec', 'buckets', 'waf']}
              label="Bucket do WAF (opcional)"
              mono
              hint="Começa com aws-waf-logs-."
            />
          </Grid>
        </>
      );
    case 'cloudflare':
      return (
        <LinesField
          path={['spec', 'zones']}
          label="Zonas (opcional)"
          hint="Os domínios, um por linha, como exemplo.com.br."
        />
      );
    case 'gcp':
      return (
        <TextField
          path={['spec', 'pubsubSubscription']}
          label="Assinatura do Pub/Sub (opcional)"
          mono
          hint={`O nome completo (projects/<projeto>/subscriptions/<nome>) ou só o nome, no projeto. Os comandos da VM do cliente criam a ${GCP_DEFAULT_SUBSCRIPTION}.`}
        />
      );
  }
}

/** Os provedores do cadastro: AWS e Cloudflare sempre; a GCP só na VM do cliente. */
function providerOptions(overview: NodeSyncOverview): Option[] {
  return [
    { value: 'aws', label: PROVIDER_LABELS.aws },
    { value: 'cloudflare', label: PROVIDER_LABELS.cloudflare },
    ...(overview.hosting === 'customer' ? [{ value: 'gcp', label: PROVIDER_LABELS.gcp }] : []),
  ];
}

/** O erro de uma escrita: os problemas por campo, ou a mensagem do código. */
function splitError(caught: unknown, prefix = ''): { issues: ValidationIssue[]; message?: string } {
  if (caught instanceof ApiError && caught.issues.length > 0) {
    return {
      issues: issuesForForm(caught.issues, prefix),
      ...(caught.code === 'invalid_request' ? {} : { message: logSourceErrorMessage(caught) }),
    };
  }
  return { issues: [], message: logSourceErrorMessage(caught) };
}

function FormError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
      {message}
    </div>
  );
}

function FormShell({
  title,
  description,
  children,
  onSubmit,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const ids = useId();
  return (
    <form
      noValidate
      aria-labelledby={`${ids}-titulo`}
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-border-strong p-4"
    >
      <div className="space-y-1">
        <h3 id={`${ids}-titulo`} className="text-base font-semibold">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </form>
  );
}

/** "Cadastrar fonte…": o provedor, a conta, os campos dele e a chave opcional. */
export function AddSourceForm({
  tenant,
  overview,
  onDone,
  onCancel,
}: {
  tenant: TenantDetail;
  overview: NodeSyncOverview;
  onDone: WriteDone;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<unknown>({ spec: {} });
  const [credential, setCredential] = useState<CredentialDraft>(EMPTY_CREDENTIAL);
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const spec: SpecDraft = (draft as { spec?: SpecDraft }).spec ?? {};
  const provider = isProvider(spec.provider) ? spec.provider : undefined;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (provider === undefined) {
      setIssues([{ path: 'spec.provider', message: 'Escolha o provedor.' }]);
      return;
    }
    const built = buildSpec(provider, spec);
    const kind = PROVIDER_CREDENTIAL_KINDS[provider];
    const sealable = overview.credentialKinds.includes(kind) && sealBlockReason(overview) === undefined;
    const key = sealable ? buildCredential(kind, credential, false) : { issues: [] };
    const found = [...built.issues, ...key.issues];
    if (found.length > 0) {
      setIssues(found);
      setError(undefined);
      return;
    }
    setBusy(true);
    setIssues([]);
    setError(undefined);
    try {
      const result = await logSourcesApi.create(tenant.id, {
        spec: built.spec,
        ...(key.input === undefined ? {} : { credential: key.input }),
      });
      onDone(
        result,
        key.input === undefined
          ? 'Fonte cadastrada. O servidor do cliente a aplica na próxima sincronização (a cada 5 minutos).'
          : 'Fonte cadastrada, com a chave cifrada para o cofre do servidor do cliente. Ele as aplica na próxima sincronização (a cada 5 minutos).',
      );
    } catch (caught) {
      const split = splitError(caught);
      setIssues(split.issues);
      setError(split.message);
    } finally {
      // Dê certo ou não, a chave sai dos campos: para mandar de novo, cola-se de novo.
      setCredential(EMPTY_CREDENTIAL);
      setBusy(false);
    }
  }

  return (
    <FormShell
      title="Cadastrar fonte de log"
      description="O servidor do cliente aplica a fonte na próxima sincronização. AWS e Cloudflare em todo ambiente; projetos da GCP só na VM do cliente."
      onSubmit={(event) => void submit(event)}
    >
      <ErrorSummary issues={issues} title="Confira os campos apontados." />
      <FormError message={error} />
      <DraftForm value={draft} onChange={setDraft} issues={issues} readOnly={busy}>
        <Grid>
          <SelectField
            path={['spec', 'provider']}
            label="Provedor"
            options={providerOptions(overview)}
            placeholder="Escolha o provedor"
            hint={overview.hosting === 'customer' ? undefined : 'Projetos da GCP só na VM do cliente.'}
          />
          {provider !== undefined && (
            <TextField
              path={['spec', 'accountId']}
              label={ACCOUNT_LABELS[provider]}
              mono
              hint={
                provider === 'aws'
                  ? '12 dígitos.'
                  : provider === 'cloudflare'
                    ? '32 caracteres hexadecimais (na URL do painel do Cloudflare).'
                    : 'Como aparece no console da GCP (minúsculas, números e hífen).'
              }
            />
          )}
        </Grid>
        {provider !== undefined && <SpecFields provider={provider} />}
      </DraftForm>
      {provider !== undefined && (
        <CredentialSection
          provider={provider}
          overview={overview}
          draft={credential}
          onChange={setCredential}
          issues={issues}
          busy={busy}
          optional
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Cadastrando…' : 'Cadastrar a fonte'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
      </div>
    </FormShell>
  );
}

/** "Alterar…": só os campos do provedor (o provedor e a conta não mudam: outra conta é outra fonte). */
export function EditSourceForm({
  tenant,
  source,
  onDone,
  onCancel,
}: {
  tenant: TenantDetail;
  source: LogSourceView;
  onDone: WriteDone;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<unknown>(() => ({ spec: draftOf(source.spec) }));
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const spec: SpecDraft = (draft as { spec?: SpecDraft }).spec ?? {};

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const built = buildUpdate(source.spec, spec);
    if (built.issues.length > 0) {
      setIssues(built.issues);
      setError(undefined);
      return;
    }
    if (Object.keys(built.update).length === 0) {
      setIssues([]);
      setError('Nada mudou: altere um campo antes de gravar.');
      return;
    }
    setBusy(true);
    setIssues([]);
    setError(undefined);
    try {
      const result = await logSourcesApi.update(tenant.id, source.id, built.update);
      onDone(
        result,
        `Fonte alterada (revisão ${result.source.revision}). O servidor do cliente aplica na próxima sincronização.`,
      );
    } catch (caught) {
      const split = splitError(caught, 'spec.');
      setIssues(split.issues);
      setError(split.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormShell
      title={`Alterar ${PROVIDER_LABELS[source.spec.provider]} ${source.spec.accountId}`}
      description="O provedor e a conta não mudam: para outra conta, cadastre outra fonte. A alteração vira uma revisão nova, que o servidor do cliente aplica na próxima sincronização."
      onSubmit={(event) => void submit(event)}
    >
      <ErrorSummary issues={issues} title="Confira os campos apontados." />
      <FormError message={error} />
      <DraftForm value={draft} onChange={setDraft} issues={issues} readOnly={busy}>
        <SpecFields provider={source.spec.provider} />
      </DraftForm>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Gravando…' : 'Gravar a alteração'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
      </div>
    </FormShell>
  );
}

/** "Enviar chave…": a chave cifrada para o cofre do servidor do cliente, numa revisão nova da credencial. */
export function CredentialForm({
  tenant,
  overview,
  source,
  onDone,
  onCancel,
}: {
  tenant: TenantDetail;
  overview: NodeSyncOverview;
  source: LogSourceView;
  onDone: WriteDone;
  onCancel: () => void;
}) {
  const [credential, setCredential] = useState<CredentialDraft>(EMPTY_CREDENTIAL);
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const provider = source.spec.provider;
  const kind = PROVIDER_CREDENTIAL_KINDS[provider];
  const sendable = overview.credentialKinds.includes(kind) && sealBlockReason(overview) === undefined;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !sendable) return;
    const key = buildCredential(kind, credential, true);
    if (key.input === undefined) {
      setIssues(key.issues);
      setError(undefined);
      return;
    }
    setBusy(true);
    setIssues([]);
    setError(undefined);
    try {
      const result = await logSourcesApi.credential(tenant.id, source.id, key.input);
      const revision = result.source.credential?.revision;
      onDone(
        result,
        `Chave enviada${revision === undefined ? '' : ` (revisão ${revision})`}, cifrada para o cofre do servidor do cliente. Ela não aparece de novo; o servidor a confere na próxima sincronização.`,
      );
    } catch (caught) {
      const split = splitError(caught, 'credential.');
      setIssues(split.issues);
      setError(split.message);
    } finally {
      setCredential(EMPTY_CREDENTIAL);
      setBusy(false);
    }
  }

  return (
    <FormShell
      title={`Enviar chave: ${PROVIDER_LABELS[provider]} ${source.spec.accountId}`}
      description="A chave vai só neste envio: o console a cifra para o cofre do servidor do cliente e não a guarda."
      onSubmit={(event) => void submit(event)}
    >
      <ErrorSummary issues={issues} title="Confira os campos apontados." />
      <FormError message={error} />
      <CredentialSection
        provider={provider}
        overview={overview}
        draft={credential}
        onChange={setCredential}
        issues={issues}
        busy={busy}
        optional={false}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !sendable}>
          {busy ? 'Enviando…' : 'Enviar a chave'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
      </div>
    </FormShell>
  );
}
