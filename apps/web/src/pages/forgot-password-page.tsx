import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authErrorMessage, isTurnstileRefusal, requestPasswordReset } from '@/features/auth/auth-api';
import { AuthShell, FormError, FormNotice } from '@/features/auth/auth-shell';
import { useAuthClientConfig } from '@/features/auth/client-config';
import { useTurnstile } from '@/features/auth/turnstile';
import { TurnstileWidget } from '@/features/auth/turnstile-widget';
import { ApiRequestError } from '@/lib/api-client';

/** A resposta é sempre a mesma, exista ou não o e-mail (não revela quem tem acesso ao painel). */
export const RESET_REQUESTED_MESSAGE =
  'Se o e-mail estiver cadastrado, você vai receber um link para redefinir a senha. O link vale por 60 minutos.';

/** Caminho para quem não recebe o e-mail: o administrador gera uma senha temporária na tela de Usuários. */
export const ASK_ADMIN_MESSAGE =
  'Se o e-mail não chegar (confira também o spam), peça ao administrador do painel uma senha temporária. No próximo login, você troca a senha.';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  // Turnstile só com a chave do site vinda da API; sem ela, o formulário é o de sempre.
  const clientConfig = useAuthClientConfig();
  const siteKey = clientConfig.data?.turnstileSiteKey ?? null;
  // Depois do envio, o formulário sai da tela: sem a chave, o hook remove o widget e para de acompanhar o tema.
  const turnstile = useTurnstile(sent ? null : siteKey, 'password-reset');
  const waitingTurnstile = clientConfig.isPending || (siteKey !== null && turnstile.token === undefined);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      await requestPasswordReset(email.trim(), turnstile.token);
      setSent(true);
    } catch (caught) {
      // Só limite de tentativas, falha do servidor, de rede ou do Turnstile aparecem como erro; qualquer outra recusa
      // mostra a mesma mensagem de sucesso, para não revelar nada sobre o e-mail.
      const refused = caught instanceof ApiRequestError && caught.status < 500 && caught.status !== 429;
      if (refused && !isTurnstileRefusal(caught)) {
        setSent(true);
        return;
      }
      setError(authErrorMessage(caught, 'sign-in'));
      // Cada token vale uma vez: a próxima tentativa precisa de outro.
      turnstile.reset();
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
          {siteKey !== null && (
            <TurnstileWidget containerRef={turnstile.containerRef} status={turnstile.status} />
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !email.includes('@') || waitingTurnstile}
          >
            Enviar link
          </Button>
          <Link to="/login" className="block text-center text-sm underline">
            Voltar ao login
          </Link>
        </form>
      )}
      <p className="text-xs text-muted-foreground">{ASK_ADMIN_MESSAGE}</p>
    </AuthShell>
  );
}
