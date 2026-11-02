import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authErrorMessage, requestPasswordReset } from '@/features/auth/auth-api';
import { AuthShell, FormError, FormNotice } from '@/features/auth/auth-shell';
import { ApiRequestError } from '@/lib/api-client';

/** A resposta é sempre a mesma, exista ou não o e-mail (não revela quem tem acesso ao painel). */
export const RESET_REQUESTED_MESSAGE =
  'Se o e-mail estiver cadastrado, você vai receber um link para redefinir a senha. O link vale por 60 minutos.';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (caught) {
      // Só limite de tentativas, falha do servidor ou de rede aparecem como erro; qualquer outra recusa mostra
      // a mesma mensagem de sucesso, para não revelar nada sobre o e-mail.
      if (caught instanceof ApiRequestError && caught.status < 500 && caught.status !== 429) setSent(true);
      else setError(authErrorMessage(caught, 'sign-in'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Redefinir senha" description="Informe o e-mail de acesso ao painel.">
      {sent ? (
        <div className="space-y-4">
          <FormNotice message={RESET_REQUESTED_MESSAGE} />
          <Link to="/login" className="block text-center text-sm underline">
            Voltar ao login
          </Link>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void onSubmit(event)} noValidate>
          <FormError message={error} />
          <Field
            label="E-mail"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" className="w-full" disabled={submitting || !email.includes('@')}>
            Enviar link
          </Button>
          <Link to="/login" className="block text-center text-sm underline">
            Voltar ao login
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
