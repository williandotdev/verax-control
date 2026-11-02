import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authErrorMessage, safeRedirect, verifyRecoveryCode, verifyTotp } from '@/features/auth/auth-api';
import { AuthShell, FormError } from '@/features/auth/auth-shell';

/** Segundo passo do login: código do aplicativo autenticador ou um código de recuperação. */
export function MfaVerifyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const from = (location.state as { from?: unknown } | null)?.from;
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      if (useRecovery) await verifyRecoveryCode(code.trim());
      else await verifyTotp(code.replace(/\s/g, ''));
      queryClient.clear();
      await navigate(safeRedirect(from), { replace: true });
    } catch (caught) {
      setError(authErrorMessage(caught, 'code'));
      setCode('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Verificação em duas etapas"
      description={
        useRecovery
          ? 'Digite um dos códigos de recuperação que você guardou. Cada um vale uma vez.'
          : 'Digite o código de 6 dígitos do seu aplicativo autenticador.'
      }
    >
      <form className="space-y-4" onSubmit={(event) => void onSubmit(event)} noValidate>
        <FormError message={error} />
        {useRecovery ? (
          <Field
            label="Código de recuperação"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        ) : (
          <Field
            label="Código do aplicativo"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
        )}
        <Button
          type="submit"
          className="w-full"
          disabled={submitting || (useRecovery ? code.trim().length === 0 : code.length !== 6)}
        >
          {submitting ? 'Verificando…' : 'Verificar'}
        </Button>
        <button
          type="button"
          className="block w-full text-center text-sm underline"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setCode('');
            setError(undefined);
          }}
        >
          {useRecovery
            ? 'Usar o código do aplicativo'
            : 'Perdi o acesso ao aplicativo: usar código de recuperação'}
        </button>
        <Link to="/login" className="block text-center text-sm text-muted-foreground underline">
          Voltar ao login
        </Link>
      </form>
    </AuthShell>
  );
}
