import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import {
  authErrorMessage,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  resetPassword,
} from '@/features/auth/auth-api';
import { AuthShell, FormError } from '@/features/auth/auth-shell';

/**
 * Lê o token do fragmento da URL (`#token=…`) uma única vez e o apaga da barra de endereço, para ele não
 * ficar no histórico nem aparecer em captura de tela. O fragmento nunca é enviado a servidor nenhum.
 */
function takeTokenFromFragment(): string | undefined {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? undefined;
  if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname);
  return token;
}

/** Contas novas nascem com senha temporária; o link por e-mail serve só para redefinir a senha. */
const COPY = {
  title: 'Defina uma nova senha',
  description: 'Depois de salvar, as sessões abertas são encerradas e você entra de novo com a senha nova.',
  done: 'Senha redefinida. Entre com a senha nova.',
} as const;

export function SetPasswordPage() {
  const navigate = useNavigate();
  const [token] = useState(takeTokenFromFragment);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const copy = COPY;

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirmation.length > 0 && confirmation !== password;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token || tooShort || mismatch) return;
    setError(undefined);
    setSubmitting(true);
    try {
      await resetPassword(token, password);
      await navigate('/login', { replace: true, state: { notice: copy.done } });
    } catch (caught) {
      setError(authErrorMessage(caught, 'set-password'));
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title={copy.title}>
        <FormError message="Este link está incompleto. Abra de novo o link do e-mail ou peça um novo." />
        <Link to="/esqueci-senha" className="block text-center text-sm underline">
          Pedir um novo link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={copy.title} description={copy.description}>
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)} noValidate>
        <FormError message={error} />
        <Field
          label="Nova senha"
          type="password"
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          hint={`Pelo menos ${PASSWORD_MIN_LENGTH} caracteres. Uma frase longa é mais fácil de lembrar e mais forte.`}
          error={tooShort ? `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.` : undefined}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Field
          label="Confirme a senha"
          type="password"
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          error={mismatch ? 'As senhas não são iguais.' : undefined}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <Button
          type="submit"
          className="w-full"
          disabled={submitting || !password || tooShort || mismatch || !confirmation}
        >
          Salvar senha
        </Button>
      </form>
    </AuthShell>
  );
}
