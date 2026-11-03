import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import {
  authErrorMessage,
  changePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@/features/auth/auth-api';
import { AuthShell, FormError } from '@/features/auth/auth-shell';
import { ME_QUERY_KEY, useMe, useSignOut } from '@/features/session/session';
import { ApiRequestError } from '@/lib/api-client';

/** Aviso que o cadastro do MFA mostra depois da troca (a senha nova é pedida de novo lá). */
export const CREDENTIAL_CHANGED_NOTICE = 'Senha trocada. Use a senha nova para confirmar abaixo.';

/**
 * Troca obrigatória da senha temporária, no primeiro acesso ou depois que o administrador gerou outra. A sessão aberta
 * com ela só alcança esta troca (a API recusa o resto); em seguida vem o cadastro do MFA, se ainda não houver.
 */
export function ChangePasswordPage() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  const [temporary, setTemporary] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  if (me.isPending) return <LoadingState className="m-8" />;
  if (me.error instanceof ApiRequestError && me.error.status === 401) return <Navigate to="/login" replace />;
  if (me.error) return <ErrorState className="m-8" error={me.error} onRetry={() => void me.refetch()} />;
  // Sem senha temporária (ou logo depois de trocá-la): segue para o MFA, ou para o painel se já houver MFA.
  if (!me.data.mustChangePassword) {
    return me.data.mfaEnabled ? (
      <Navigate to="/" replace />
    ) : (
      <Navigate
        to="/mfa/cadastro"
        replace
        state={changed ? { notice: CREDENTIAL_CHANGED_NOTICE } : undefined}
      />
    );
  }

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const sameAsTemporary = password.length > 0 && password === temporary;
  const mismatch = confirmation.length > 0 && confirmation !== password;
  const invalid = !temporary || !password || !confirmation || tooShort || sameAsTemporary || mismatch;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    setError(undefined);
    setSubmitting(true);
    try {
      await changePassword(temporary, password);
      setChanged(true);
      // Relê a sessão: sem a senha temporária, a própria página leva adiante.
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    } catch (caught) {
      setError(authErrorMessage(caught, 'change-password'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Troque a senha temporária"
      description={`Você entrou com a senha temporária criada pelo administrador. Como outra pessoa já a viu, ela só serve para este passo: crie agora uma senha que só você conheça.${
        me.data.mfaEnabled ? '' : ' Em seguida, você vai ativar a verificação em duas etapas.'
      }`}
    >
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)} noValidate>
        <FormError message={error} />
        <Field
          label="Senha temporária"
          type="password"
          autoComplete="current-password"
          value={temporary}
          onChange={(event) => setTemporary(event.target.value)}
        />
        <Field
          label="Nova senha"
          type="password"
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          hint={`Pelo menos ${PASSWORD_MIN_LENGTH} caracteres. Uma frase longa é mais fácil de lembrar e mais forte.`}
          error={
            tooShort
              ? `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`
              : sameAsTemporary
                ? 'A senha nova precisa ser diferente da temporária.'
                : undefined
          }
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Field
          label="Confirme a nova senha"
          type="password"
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          error={mismatch ? 'As senhas não são iguais.' : undefined}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <Button type="submit" className="w-full" disabled={submitting || invalid}>
          {submitting ? 'Salvando…' : 'Salvar e continuar'}
        </Button>
        <button
          type="button"
          className="block w-full text-center text-sm text-muted-foreground underline"
          disabled={signOut.isPending}
          onClick={() =>
            signOut.mutate(undefined, { onSettled: () => void navigate('/login', { replace: true }) })
          }
        >
          Sair
        </button>
      </form>
    </AuthShell>
  );
}
