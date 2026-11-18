import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/api';
import type { LoginRequest } from '@/lib/api-types';
import { errorMessage } from '@/lib/errors';
import { isServerReturnPath, safeReturnPath } from '@/lib/return-path';
import { AuthFrame } from './auth-frame';
import { useAdminClientConfig } from './client-config';
import { normalizeCode, SENHA_MESSAGES } from './credentials';
import { CodeField, FormAlert, TextField } from './fields';
import { CONSOLE_LOGIN_ACTION, useTurnstile } from './turnstile';
import { TurnstileWidget } from './turnstile-widget';

type Problems = Partial<Record<'email' | 'password' | 'code' | 'recoveryCode', string>>;

/**
 * A entrada no console: e-mail, senha e o código do aplicativo autenticador num formulário só (nenhum estado "só com
 * a senha"), ou um código de recuperação no lugar do código, para quem perdeu o celular. O erro da API é um só, para
 * qualquer campo errado (e para a conta bloqueada): a tela mostra a mensagem dela e nunca diz qual campo foi.
 *
 * Com o Turnstile ligado no cp-admin (a chave do site em `GET /v1/admin/client-config`), o widget da Cloudflare entra
 * antes do botão, o botão só liga com o token, e cada tentativa recusada pede um token novo (cada um vale uma vez).
 */
export function LoginPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const back = safeReturnPath(params.get('voltar'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [problems, setProblems] = useState<Problems>({});
  // Turnstile só com a chave do site vinda do cp-admin; sem ela, o formulário é o de sempre.
  const clientConfig = useAdminClientConfig();
  const siteKey = clientConfig.data?.turnstileSiteKey ?? null;
  const turnstile = useTurnstile(siteKey, CONSOLE_LOGIN_ACTION);
  const waitingTurnstile = clientConfig.isPending || (siteKey !== null && turnstile.token === undefined);

  const login = useMutation({
    mutationFn: ({ body, token }: { body: LoginRequest; token: string | undefined }) =>
      authApi.login(body, token),
    onSuccess: () => {
      // A sessão nova não herda nada de uma anterior.
      client.clear();
      // A entrada única no SIEM (`/sso/authorize`) é do servidor, não uma tela: o navegador vai até ela de verdade.
      if (isServerReturnPath(back)) window.location.assign(back);
      else void navigate(back, { replace: true });
    },
    onError: () => {
      setPassword('');
      setCode('');
      setRecoveryCode('');
      // Cada token vale uma vez: a próxima tentativa precisa de outro.
      turnstile.reset();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Problems = {};
    const address = email.trim();
    if (address === '') found.email = 'Digite o e-mail.';
    if (password.length === 0) found.password = SENHA_MESSAGES.typeIt;
    const normalizedCode = normalizeCode(code);
    const normalizedRecovery = recoveryCode.trim();
    if (useRecovery && normalizedRecovery === '') found.recoveryCode = 'Digite um código de recuperação.';
    if (!useRecovery && normalizedCode === undefined) found.code = 'Digite os 6 números do aplicativo.';
    setProblems(found);
    if (Object.keys(found).length > 0 || waitingTurnstile) return;
    login.mutate({
      body: useRecovery
        ? { email: address, password, recoveryCode: normalizedRecovery }
        : { email: address, password, code: normalizedCode ?? '' },
      token: siteKey === null ? undefined : turnstile.token,
    });
  }

  function toggleRecovery() {
    setUseRecovery((current) => !current);
    setCode('');
    setRecoveryCode('');
    setProblems((current) => ({ ...current, code: undefined, recoveryCode: undefined }));
  }

  return (
    <AuthFrame
      title="Entrar no console"
      description="Use o e-mail, a senha e o código do aplicativo autenticador da sua conta."
    >
      <form className="space-y-4" onSubmit={submit} noValidate aria-label="Entrar no console">
        <FormAlert message={login.isError ? errorMessage(login.error) : undefined} />
        <TextField
          label="E-mail"
          name="email"
          type="email"
          autoComplete="username"
          spellCheck={false}
          maxLength={254}
          value={email}
          error={problems.email}
          disabled={login.isPending}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label="Senha"
          name="password"
          type="password"
          autoComplete="current-password"
          maxLength={128}
          value={password}
          error={problems.password}
          disabled={login.isPending}
          onChange={(event) => setPassword(event.target.value)}
        />
        {useRecovery ? (
          <TextField
            label="Código de recuperação"
            hint="Um dos códigos guardados no cadastro, como ABCDE-FGH23. Cada um entra uma vez."
            name="recoveryCode"
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            maxLength={32}
            value={recoveryCode}
            error={problems.recoveryCode}
            disabled={login.isPending}
            inputClassName="font-mono"
            onChange={(event) => setRecoveryCode(event.target.value)}
          />
        ) : (
          <CodeField value={code} onChange={setCode} error={problems.code} disabled={login.isPending} />
        )}
        <button
          type="button"
          className="text-sm text-primary underline-offset-2 hover:underline"
          onClick={toggleRecovery}
        >
          {useRecovery ? 'Usar o código do aplicativo' : 'Usar um código de recuperação'}
        </button>
        {siteKey !== null && (
          <TurnstileWidget containerRef={turnstile.containerRef} status={turnstile.status} />
        )}
        <div>
          <Button type="submit" disabled={login.isPending || waitingTurnstile}>
            {login.isPending ? 'Entrando…' : 'Entrar'}
          </Button>
        </div>
      </form>
      <p className="text-xs text-muted-foreground">
        Não há cadastro por aqui: a conta é criada por quem administra o projeto, pela linha de comando.
      </p>
    </AuthFrame>
  );
}
