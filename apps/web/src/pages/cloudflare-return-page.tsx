import {
  type CloudflareOauthAccount,
  type CloudflareOauthAttempt,
  cloudflareAccountIdSchema,
  CLOUDFLARE_OAUTH_PANEL_PATH,
} from '@verax/shared';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { AuthShell } from '@/features/auth/auth-shell';
import {
  completeCloudflareOauth,
  useChooseCloudflareAccounts,
  useCloudflareOauthAttempt,
} from '@/features/cloudflare/cloudflare-oauth-api';
import { ConnectCloudflareButton } from '@/features/cloudflare/connect-button';
import { ATTEMPT_ERROR_TEXTS, oauthErrorText } from '@/features/cloudflare/labels';
import { ATTEMPT_PARAM, attemptIdOf, takeCloudflareReturn } from '@/features/cloudflare/oauth-return';
import { useMe } from '@/features/session/session';

const ACCOUNTS_PATH = '/cadastros/contas';

/**
 * O retorno do "Conectar com Cloudflare" (`/conexao-cloudflare`, o endereço que o nó anuncia ao plano de controle). O
 * Cloudflare devolve o navegador ao repasse da Verax, que o traz para cá com `code`, `state` e `iss` no fragmento. A
 * página:
 *
 * 1. lê o fragmento uma vez e o apaga da barra de endereço antes de qualquer chamada;
 * 2. sem sessão, o cliente HTTP leva ao login, e o retorno é descartado (nada é guardado para depois);
 * 3. com sessão, manda o retorno à API do nó, que só o aceita na mesma sessão que começou; a recusa é sempre a mesma;
 * 4. troca o endereço por `?tentativa=<id>` (não é segredo: a API só mostra a tentativa à mesma sessão) e acompanha a
 *    tentativa: esperando o Cloudflare, escolhendo as contas, pronta, com erro ou vencida.
 *
 * Fora do `RequireSession` de propósito: o redirecionamento dele ao login guardaria o caminho, e aqui não há o que
 * retomar. Os nomes das contas vêm do Cloudflare e aparecem só como texto.
 */
export function CloudflareReturnPage() {
  // A tentativa já tratada (a página recarregada) vem antes: ler o fragmento limpa a query também.
  const [initialAttempt] = useState(() => attemptIdOf(window.location.search));
  const [taken] = useState(takeCloudflareReturn);
  const [attemptId, setAttemptId] = useState<string | null>(initialAttempt);
  const [completeError, setCompleteError] = useState<unknown>(null);
  const sent = useRef(false);
  const me = useMe();

  useEffect(() => {
    if (taken.kind !== 'return' || me.data === undefined || sent.current) return;
    sent.current = true;
    completeCloudflareOauth(taken.input).then(
      (completed) => {
        window.history.replaceState(
          window.history.state,
          '',
          `${CLOUDFLARE_OAUTH_PANEL_PATH}?${ATTEMPT_PARAM}=${encodeURIComponent(completed.attemptId)}`,
        );
        setAttemptId(completed.attemptId);
      },
      (error: unknown) => setCompleteError(error),
    );
  }, [taken, me.data]);

  let body: ReactNode;
  if (attemptId !== null) {
    body = <AttemptView id={attemptId} />;
  } else if (taken.kind === 'invalid') {
    body = (
      <Message tone="alert" restart>
        O retorno do Cloudflare chegou incompleto ou alterado e foi descartado. Comece de novo.
      </Message>
    );
  } else if (taken.kind === 'none') {
    body = (
      <Message>
        Esta página só recebe o retorno da autorização no Cloudflare. Para conectar uma conta, use o botão
        Conectar com Cloudflare na tela de contas.
      </Message>
    );
  } else if (completeError !== null) {
    body = (
      <Message tone="alert" restart>
        {oauthErrorText(completeError)}
      </Message>
    );
  } else {
    body = <LoadingState rows={1} label="Concluindo a conexão com o Cloudflare" />;
  }

  return (
    <AuthShell title="Conectar com Cloudflare">
      {body}
      <p className="text-sm">
        <Link to={ACCOUNTS_PATH} className="underline">
          Voltar às contas cloud
        </Link>
      </p>
    </AuthShell>
  );
}

/**
 * Uma mensagem que recebe o foco ao aparecer (cada troca de situação é anunciada e o teclado continua daqui). Com
 * `restart`, o botão de começar de novo.
 */
function Message({
  children,
  tone = 'status',
  restart = false,
}: {
  children: ReactNode;
  tone?: 'status' | 'alert';
  restart?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="space-y-3">
      <div
        ref={ref}
        tabIndex={-1}
        role={tone}
        className={
          tone === 'alert'
            ? 'rounded-md border border-critical/40 bg-critical/5 px-3 py-2 text-sm focus:outline-none'
            : 'rounded-md border px-3 py-2 text-sm focus:outline-none'
        }
      >
        {children}
      </div>
      {restart && <RestartButton />}
    </div>
  );
}

/** Começar de novo leva direto à autorização (sem conta: a conta já cadastrada é ligada sozinha). */
function RestartButton() {
  const me = useMe();
  if (me.data?.permissions.includes('cloud_credentials:write') !== true) return null;
  return <ConnectCloudflareButton variant="secondary">Começar de novo</ConnectCloudflareButton>;
}

function AttemptView({ id }: { id: string }) {
  const attempt = useCloudflareOauthAttempt(id);
  if (attempt.isPending) return <LoadingState rows={1} label="Carregando a conexão" />;
  if (attempt.data === undefined) {
    return (
      <Message tone="alert" restart>
        {oauthErrorText(attempt.error)}
      </Message>
    );
  }
  return <AttemptState key={attempt.data.status} attempt={attempt.data} />;
}

function AttemptState({ attempt }: { attempt: CloudflareOauthAttempt }) {
  switch (attempt.status) {
    case 'started':
    case 'code_received':
      return (
        <Message>
          Conferindo a autorização no Cloudflare e as contas liberadas. Isso leva alguns segundos; esta tela
          se atualiza sozinha.
        </Message>
      );
    case 'choosing':
      return <ChooseAccounts attempt={attempt} />;
    case 'done':
      return <Done ids={attempt.cloudAccountIds} />;
    case 'expired':
      return (
        <Message tone="alert" restart>
          O prazo para concluir a conexão terminou. Nada foi alterado nas contas. Comece de novo.
        </Message>
      );
    case 'failed':
      return (
        <Message tone="alert" restart>
          {attempt.errorCode ? ATTEMPT_ERROR_TEXTS[attempt.errorCode] : ATTEMPT_ERROR_TEXTS.internal_error}
        </Message>
      );
  }
}

function Done({ ids }: { ids: string[] }) {
  return (
    <div className="space-y-3">
      <Message>
        {ids.length === 1 ? 'Conta conectada.' : `${ids.length} contas conectadas.`} O Verax começa a ler a
        auditoria e os eventos de segurança de todas as zonas na próxima coleta. Se a conta usava um token
        colado, ele já saiu do cofre do Verax: apague-o também no Cloudflare.
      </Message>
      <ul className="space-y-1 text-sm">
        {ids.map((id, index) => (
          <li key={id}>
            <Link to={`${ACCOUNTS_PATH}?conta=${encodeURIComponent(id)}`} className="underline">
              {ids.length === 1 ? 'Ver a conta conectada' : `Ver a conta conectada ${index + 1}`}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ACCOUNT_STATE_TEXTS: Readonly<Record<CloudflareOauthAccount['state'], string>> = {
  available: 'pode ser monitorada',
  registered: 'já cadastrada: passa a ser lida por esta autorização',
  forbidden: 'sem permissão de leitura da auditoria',
  unavailable: 'o Cloudflare não respondeu sobre esta conta',
};

function isUsable(account: CloudflareOauthAccount): boolean {
  return account.state === 'available' || account.state === 'registered';
}

/**
 * Mais de uma conta autorizada (ou nenhuma que o Cloudflare liste): o cliente escolhe quais monitorar, vendo o nome e o
 * ID de cada uma e o ambiente do Verax que vai lê-las. As não escolhidas nunca são lidas.
 */
function ChooseAccounts({ attempt }: { attempt: CloudflareOauthAttempt }) {
  const choose = useChooseCloudflareAccounts(attempt.id);
  const usable = attempt.accounts.filter(isUsable);
  const [chosen, setChosen] = useState<string[]>(() =>
    usable.length === 1 && usable[0] ? [usable[0].accountId] : [],
  );
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const ids = attempt.accountIdRequired ? [typed.trim().toLowerCase()] : chosen;
    if (attempt.accountIdRequired && !cloudflareAccountIdSchema.safeParse(ids[0]).success) {
      setError('Informe o ID da conta: 32 caracteres, de 0 a 9 e de a a f.');
      return;
    }
    if (ids.length === 0) {
      setError('Escolha ao menos uma conta.');
      return;
    }
    setError(undefined);
    choose.mutate({ accountIds: ids });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3 text-sm">
      <h2 ref={heading} tabIndex={-1} className="text-base font-semibold focus:outline-none">
        Escolha as contas a monitorar
      </h2>
      <p>
        Ambiente do Verax que vai ler: <span className="font-mono">{window.location.host}</span>. Confira se é
        o seu antes de continuar.
      </p>
      {attempt.accountIdRequired ? (
        <Field
          label="ID da conta do Cloudflare"
          hint="O Cloudflare não listou as contas autorizadas. Informe o ID (32 caracteres, na página inicial da conta no Cloudflare)."
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          error={error}
          spellCheck={false}
          autoComplete="off"
        />
      ) : (
        <fieldset className="space-y-2">
          <legend className="font-medium">Contas autorizadas no Cloudflare</legend>
          {attempt.accounts.length === 0 && (
            <p className="text-muted-foreground">
              Nenhuma conta foi autorizada. Comece de novo e escolha uma conta.
            </p>
          )}
          {attempt.accounts.map((account) => (
            <AccountOption
              key={account.accountId}
              account={account}
              checked={chosen.includes(account.accountId)}
              onChange={(checked) =>
                setChosen((previous) =>
                  checked
                    ? [...previous, account.accountId]
                    : previous.filter((value) => value !== account.accountId),
                )
              }
            />
          ))}
          {error && (
            <p role="alert" className="text-xs text-critical-text">
              {error}
            </p>
          )}
        </fieldset>
      )}
      <p className="text-xs text-muted-foreground">
        As contas não escolhidas nunca são lidas. Para o Verax nem poder vê-las, autorize no Cloudflare só as
        que quer monitorar.
      </p>
      {choose.error && (
        <p role="alert" className="text-sm text-critical-text">
          {oauthErrorText(choose.error)}
        </p>
      )}
      <Button
        type="submit"
        disabled={choose.isPending || (!attempt.accountIdRequired && usable.length === 0)}
      >
        Monitorar as contas escolhidas
      </Button>
    </form>
  );
}

function AccountOption({
  account,
  checked,
  onChange,
}: {
  account: CloudflareOauthAccount;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const usable = isUsable(account);
  const descriptionId = `conta-${account.accountId}-situacao`;
  return (
    <label className="flex items-start gap-2 rounded-md border p-2">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={!usable}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 space-y-0.5">
        <span className="block break-words font-medium">{account.name ?? 'Conta sem nome'}</span>
        <span className="block break-all font-mono text-xs">{account.accountId}</span>
        <span id={descriptionId} className="block text-xs text-muted-foreground">
          {ACCOUNT_STATE_TEXTS[account.state]}
        </span>
      </span>
    </label>
  );
}
