import { useQueryClient } from '@tanstack/react-query';
import { Copy, Download } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import QRCode from 'react-qr-code';
import { Navigate, useNavigate } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { authErrorMessage, enableMfa, totpSecretFromUri, verifyTotp } from '@/features/auth/auth-api';
import { AuthShell, FormError } from '@/features/auth/auth-shell';
import { useMe } from '@/features/session/session';
import { ApiRequestError } from '@/lib/api-client';

interface Enrollment {
  totpURI: string;
  backupCodes: string[];
}

/**
 * Cadastro obrigatório do MFA no primeiro acesso: senha, QR para o aplicativo autenticador (gerado aqui no
 * navegador; o segredo nunca passa por serviço externo), códigos de recuperação e o primeiro código.
 */
export function MfaEnrollPage() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  if (me.isPending) return <LoadingState className="m-8" />;
  if (me.error instanceof ApiRequestError && me.error.status === 401) return <Navigate to="/login" replace />;
  if (me.error) return <ErrorState className="m-8" error={me.error} onRetry={() => void me.refetch()} />;
  if (me.data.mfaEnabled) return <Navigate to="/" replace />;

  async function start(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      setEnrollment(await enableMfa(password));
      setPassword('');
    } catch (caught) {
      setError(authErrorMessage(caught, 'enroll'));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      await verifyTotp(code);
      queryClient.clear();
      await navigate('/', { replace: true });
    } catch (caught) {
      setError(authErrorMessage(caught, 'code'));
      setCode('');
    } finally {
      setSubmitting(false);
    }
  }

  if (!enrollment) {
    return (
      <AuthShell
        title="Ative a verificação em duas etapas"
        description="O acesso ao painel exige um código do aplicativo autenticador além da senha. Confirme sua senha para começar."
      >
        <form className="space-y-4" onSubmit={(event) => void start(event)} noValidate>
          <FormError message={error} />
          <Field
            label="Senha"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" className="w-full" disabled={submitting || !password}>
            Continuar
          </Button>
        </form>
      </AuthShell>
    );
  }

  const codesText = enrollment.backupCodes.join('\n');
  const downloadCodes = () => {
    const url = URL.createObjectURL(
      new Blob([`Códigos de recuperação do Verax Control\n\n${codesText}\n`], { type: 'text/plain' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'verax-control-codigos-de-recuperacao.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AuthShell
      title="Configure o aplicativo autenticador"
      description="Use um aplicativo como Google Authenticator, Microsoft Authenticator ou 1Password."
    >
      <form className="space-y-5" onSubmit={(event) => void confirm(event)} noValidate>
        <FormError message={error} />
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">1. Leia o QR no aplicativo</h2>
          <div className="w-fit rounded-md bg-white p-3">
            <QRCode
              value={enrollment.totpURI}
              size={168}
              role="img"
              aria-label="QR code para o aplicativo autenticador"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Sem câmera? Digite esta chave no aplicativo:{' '}
            <code className="break-all font-mono text-foreground">
              {totpSecretFromUri(enrollment.totpURI)}
            </code>
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">2. Guarde os códigos de recuperação</h2>
          <p className="text-xs text-muted-foreground">
            Cada código entra uma vez, se você perder o celular. Eles não aparecem de novo.
          </p>
          <ul
            aria-label="Códigos de recuperação"
            className="grid grid-cols-2 gap-1 rounded-md border bg-surface-raised p-3 font-mono text-sm"
          >
            {enrollment.backupCodes.map((backupCode) => (
              <li key={backupCode}>{backupCode}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(codesText)}
            >
              <Copy aria-hidden /> Copiar
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={downloadCodes}>
              <Download aria-hidden /> Baixar
            </Button>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            Guardei os códigos em local seguro
          </label>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">3. Confirme com o primeiro código</h2>
          <Field
            label="Código do aplicativo"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
        </section>

        <Button type="submit" className="w-full" disabled={submitting || !saved || code.length !== 6}>
          Ativar e entrar
        </Button>
      </form>
    </AuthShell>
  );
}
