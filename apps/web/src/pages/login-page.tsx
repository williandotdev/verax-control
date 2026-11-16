import { useQueryClient } from '@tanstack/react-query';
import { meSchema } from '@verax/shared';
import { type FormEvent, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Field } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { authErrorMessage, safeRedirect, signIn } from '@/features/auth/auth-api';
import { AuthShell, FormError, FormNotice } from '@/features/auth/auth-shell';
import { useAuthClientConfig } from '@/features/auth/client-config';
import { useTurnstile } from '@/features/auth/turnstile';
import { TurnstileWidget } from '@/features/auth/turnstile-widget';
import { type DemoSignIn, DemoLoginHint } from '@/features/demo-login/entry';
import { ME_QUERY_KEY } from '@/features/session/session';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';

/** O retorno recusado da entrada única (`?sso=recusado`): a API nunca diz o motivo. */
export const SSO_REFUSED_MESSAGE =
  'Não foi possível entrar pelo Admin master. Tente de novo ou entre com e-mail e senha.';

interface LoginState {
  from?: unknown;
  notice?: unknown;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const state = (location.state ?? {}) as LoginState;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  // Turnstile só com a chave do site vinda da API; sem ela, o formulário é o de sempre.
  const clientConfig = useAuthClientConfig();
  const siteKey = clientConfig.data?.turnstileSiteKey ?? null;
  const turnstile = useTurnstile(siteKey, 'login');
  const waitingTurnstile = clientConfig.isPending || (siteKey !== null && turnstile.token === undefined);
  // Entrada única pelo console do responsável: só onde a equipe da Verax entra (o endereço dela na célula ou o nó
  // dedicado da Verax), quando a API diz onde fica o console.
  const adminMasterUrl = clientConfig.data?.adminMasterUrl ?? null;
  const ssoRefused = params.get('sso') === 'recusado';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      const { needsCode } = await signIn(email.trim(), password, turnstile.token);
      setPassword('');
      if (needsCode) {
        await navigate('/login/codigo', { replace: true, state: { from: state.from } });
        return;
      }
      // Sem MFA cadastrado ainda: a sessão só serve para trocar a senha temporária (primeiro acesso) e, depois,
      // cadastrar o MFA.
      const me = await queryClient.fetchQuery({
        queryKey: ME_QUERY_KEY,
        queryFn: () => api.get('/v1/me', meSchema),
      });
      const next = me.mustChangePassword
        ? '/trocar-senha'
        : me.mfaEnabled
          ? safeRedirect(state.from)
          : '/mfa/cadastro';
      await navigate(next, { replace: true });
    } catch (caught) {
      setError(authErrorMessage(caught, 'sign-in'));
      // Cada token vale uma vez: a próxima tentativa precisa de outro.
      turnstile.reset();
    } finally {
      setSubmitting(false);
    }
  }

  // Só na demonstração (modo `mock`): preenche o acesso de exemplo e leva o foco ao "Entrar", sem enviar.
  function fillDemoAccess(access: DemoSignIn) {
    flushSync(() => {
      setEmail(access.email);
      setPassword(access.password);
      setError(undefined);
    });
    submitRef.current?.focus();
  }

  return (
    <AuthShell
      title="Entrar"
      description="No primeiro acesso, use a senha temporária que o administrador enviou para você."
    >
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)} noValidate>
        <FormNotice message={typeof state.notice === 'string' ? state.notice : undefined} />
        <FormError message={error ?? (ssoRefused ? SSO_REFUSED_MESSAGE : undefined)} />
        <Field
          label="E-mail"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label="Senha"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {siteKey !== null && (
          <TurnstileWidget containerRef={turnstile.containerRef} status={turnstile.status} />
        )}
        <Button
          ref={submitRef}
          type="submit"
          className="w-full"
          disabled={submitting || !email || !password || waitingTurnstile}
        >
          {submitting ? 'Entrando…' : 'Entrar'}
        </Button>
        <Link to="/esqueci-senha" className="block text-center text-sm underline">
          Esqueci a senha
        </Link>
        {adminMasterUrl !== null && (
          <div className="space-y-2 border-t pt-4">
            {/* Navegação de verdade: a API leva ao login do console e volta com a sessão do painel. */}
            <a
              href={`${API_URL}/v1/auth/sso/start`}
              className={buttonVariants({ variant: 'secondary', className: 'w-full' })}
            >
              Entrar com o Admin master
            </a>
            <p className="text-center text-xs text-muted-foreground">
              Equipe da Verax: o login do console do responsável (e-mail, senha e código do aplicativo).
            </p>
          </div>
        )}
        <DemoLoginHint onFill={fillDemoAccess} />
      </form>
    </AuthShell>
  );
}
