import { useQueryClient } from '@tanstack/react-query';
import { meSchema } from '@verax/shared';
import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Field } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { authErrorMessage, safeRedirect, signIn } from '@/features/auth/auth-api';
import { AuthShell, FormError, FormNotice } from '@/features/auth/auth-shell';
import { ME_QUERY_KEY } from '@/features/session/session';
import { api } from '@/lib/api';
import { DemoLoginHint } from '@/components/demo-banner';

interface LoginState {
  from?: unknown;
  notice?: unknown;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const state = (location.state ?? {}) as LoginState;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      const { needsCode } = await signIn(email.trim(), password);
      setPassword('');
      if (needsCode) {
        await navigate('/login/codigo', { replace: true, state: { from: state.from } });
        return;
      }
      // Sem MFA cadastrado ainda: a sessão só serve para cadastrar o MFA.
      const me = await queryClient.fetchQuery({
        queryKey: ME_QUERY_KEY,
        queryFn: () => api.get('/v1/me', meSchema),
      });
      await navigate(me.mfaEnabled ? safeRedirect(state.from) : '/mfa/cadastro', { replace: true });
    } catch (caught) {
      setError(authErrorMessage(caught, 'sign-in'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Entrar" description="Use o e-mail e a senha do seu convite.">
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)} noValidate>
        <FormNotice message={typeof state.notice === 'string' ? state.notice : undefined} />
        <FormError message={error} />
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
        <Button type="submit" className="w-full" disabled={submitting || !email || !password}>
          {submitting ? 'Entrando…' : 'Entrar'}
        </Button>
        <Link to="/esqueci-senha" className="block text-center text-sm underline">
          Esqueci a senha
        </Link>
        <DemoLoginHint />
      </form>
    </AuthShell>
  );
}
