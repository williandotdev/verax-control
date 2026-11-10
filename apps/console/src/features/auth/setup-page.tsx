import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError, authApi } from '@/lib/api';
import type { SetupCompleted, SetupStartRequest, TotpEnrollment } from '@/lib/api-types';
import { errorMessage } from '@/lib/errors';
import { AuthFrame } from './auth-frame';
import { newPasswordProblems, PASSWORD_MIN } from './credentials';
import { FormAlert, TextField } from './fields';
import { RecoveryCodesPanel, TotpEnrollmentForm } from './totp-enrollment';

type Problems = Partial<Record<'setupToken' | 'email' | 'password' | 'confirmation', string>>;

/** O que a API recusou no primeiro passo, em texto para o responsável (o 403 é genérico de propósito). */
function startMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'setup_refused')
      return 'Não foi possível começar a configuração. Confira o token de configuração e o e-mail.';
    if (error.code === 'setup_closed') return 'O console já foi configurado. Entre com a sua conta.';
    if (error.code === 'invalid_request') return 'Confira os campos marcados.';
  }
  return errorMessage(error);
}

function confirmMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_code')
      return 'O código não confere. Confira o relógio do celular e digite o código atual.';
    if (error.code === 'enrollment_expired')
      return 'O prazo para confirmar o aplicativo terminou. Comece a configuração de novo.';
    if (error.code === 'setup_closed') return 'O console já foi configurado. Entre com a sua conta.';
  }
  return errorMessage(error);
}

/** O primeiro passo: o token de configuração, o e-mail do responsável e a senha nova. */
function StartForm({ onStarted }: { onStarted: (enrollment: TotpEnrollment) => void }) {
  const [setupToken, setSetupToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problems, setProblems] = useState<Problems>({});

  const start = useMutation({
    mutationFn: (body: SetupStartRequest) => authApi.setupStart(body),
    onSuccess: (enrollment) => {
      // O token e a senha não ficam na memória da tela depois do passo.
      setSetupToken('');
      setPassword('');
      setConfirmation('');
      onStarted(enrollment);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.issues.length > 0) {
        const fromApi: Problems = {};
        for (const issue of error.issues) {
          if (issue.path === 'setupToken' || issue.path === 'email' || issue.path === 'password') {
            fromApi[issue.path] = issue.message;
          }
        }
        setProblems(fromApi);
      }
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Problems = { ...newPasswordProblems(password, confirmation) };
    if (setupToken.trim() === '') found.setupToken = 'Cole o token de configuração.';
    if (email.trim() === '') found.email = 'Digite o e-mail do responsável.';
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    start.mutate({ setupToken: setupToken.trim(), email: email.trim(), password });
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate aria-label="Configurar o acesso">
      <FormAlert message={start.isError ? startMessage(start.error) : undefined} />
      <TextField
        label="Token de configuração"
        hint="O valor gravado no segredo cp-admin-setup-token do Secret Manager."
        name="setupToken"
        type="password"
        autoComplete="off"
        spellCheck={false}
        maxLength={512}
        value={setupToken}
        error={problems.setupToken}
        disabled={start.isPending}
        onChange={(event) => setSetupToken(event.target.value)}
      />
      <TextField
        label="E-mail"
        hint="Um dos e-mails de responsável do console."
        name="email"
        type="email"
        autoComplete="username"
        spellCheck={false}
        maxLength={254}
        value={email}
        error={problems.email}
        disabled={start.isPending}
        onChange={(event) => setEmail(event.target.value)}
      />
      <TextField
        label="Senha nova"
        hint={`Pelo menos ${PASSWORD_MIN} caracteres. Use um gerenciador de senhas.`}
        name="password"
        type="password"
        autoComplete="new-password"
        maxLength={128}
        value={password}
        error={problems.password}
        disabled={start.isPending}
        onChange={(event) => setPassword(event.target.value)}
      />
      <TextField
        label="Confirme a senha nova"
        name="confirmation"
        type="password"
        autoComplete="new-password"
        maxLength={128}
        value={confirmation}
        error={problems.confirmation}
        disabled={start.isPending}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <Button type="submit" disabled={start.isPending}>
        {start.isPending ? 'Conferindo…' : 'Continuar'}
      </Button>
    </form>
  );
}

/**
 * O primeiro acesso ao console (`/configurar`): só enquanto nenhuma conta existe. O token de configuração (que o
 * responsável gravou no Secret Manager), o e-mail e a senha; depois o aplicativo autenticador, pelo QR gerado aqui; e
 * os códigos de recuperação, uma única vez. A API abre a sessão na confirmação, e esta tela se fecha para sempre.
 */
export function SetupPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: authApi.setupStatus, staleTime: 0 });
  const [enrollment, setEnrollment] = useState<TotpEnrollment | undefined>();
  const [completed, setCompleted] = useState<SetupCompleted | undefined>();

  const confirm = useMutation({
    mutationFn: (code: string) => {
      if (enrollment === undefined) throw new Error('cadastro sem início');
      return authApi.setupConfirm({ enrollmentId: enrollment.enrollmentId, code });
    },
    onSuccess: (result) => {
      setEnrollment(undefined);
      setCompleted(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'enrollment_expired') setEnrollment(undefined);
    },
  });

  if (completed !== undefined) {
    return (
      <AuthFrame
        title="Guarde os códigos de recuperação"
        description={`Conta criada para ${completed.email}.`}
      >
        <RecoveryCodesPanel
          codes={completed.recoveryCodes}
          continueLabel="Ir para o console"
          onContinue={() => {
            client.clear();
            void navigate('/', { replace: true });
          }}
        />
      </AuthFrame>
    );
  }

  if (status.isPending) {
    return (
      <AuthFrame title="Configurar o console">
        <LoadingState label="Conferindo a configuração" />
      </AuthFrame>
    );
  }
  if (status.isError) {
    return (
      <AuthFrame title="Configurar o console">
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      </AuthFrame>
    );
  }
  if (!status.data.open) {
    return (
      <AuthFrame title="O console já está configurado">
        <p className="text-sm">
          A conta do responsável já existe. Para trocar a senha ou o aplicativo autenticador, entre e abra{' '}
          <span className="font-medium">Minha conta</span>.
        </p>
        <Link to="/entrar" className="text-sm text-primary underline-offset-2 hover:underline">
          Ir para a entrada
        </Link>
      </AuthFrame>
    );
  }

  if (enrollment !== undefined) {
    return (
      <AuthFrame
        title="Cadastre o aplicativo autenticador"
        description="Use um aplicativo como Google Authenticator, Microsoft Authenticator ou 1Password."
      >
        <TotpEnrollmentForm
          enrollment={enrollment}
          busy={confirm.isPending}
          error={confirm.isError ? confirmMessage(confirm.error) : undefined}
          submitLabel="Confirmar o aplicativo"
          onConfirm={(code) => confirm.mutate(code)}
        />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title="Configurar o console"
      description="O primeiro acesso: crie a senha e cadastre o aplicativo autenticador do responsável."
    >
      {confirm.isError && <FormAlert message={confirmMessage(confirm.error)} />}
      <StartForm
        onStarted={(started) => {
          confirm.reset();
          setEnrollment(started);
        }}
      />
    </AuthFrame>
  );
}
