import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ApiError, authApi } from '@/lib/api';
import type {
  PasswordChangeRequest,
  RecoveryCodes,
  TotpEnrollment,
  TotpResetStartRequest,
} from '@/lib/api-types';
import { errorMessage } from '@/lib/errors';
import { newPasswordProblems, normalizeCode, PASSWORD_MIN } from './credentials';
import { CodeField, FormAlert, TextField } from './fields';
import { RecoveryCodesPanel, TotpEnrollmentForm } from './totp-enrollment';

/** O erro de uma troca: senha atual ou código errado é uma mensagem só, como na entrada. */
function accountMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials')
      return 'A senha atual ou o código não confere. Depois de várias tentativas, o acesso fica bloqueado por 15 minutos.';
    if (error.code === 'invalid_code')
      return 'O código não confere. Confira o relógio do celular e digite o código atual.';
    if (error.code === 'enrollment_expired')
      return 'O prazo para confirmar o aplicativo novo terminou. Comece de novo.';
    if (error.code === 'invalid_request') return 'Confira os campos marcados.';
  }
  return errorMessage(error);
}

type PasswordProblems = Partial<Record<'currentPassword' | 'code' | 'newPassword' | 'confirmation', string>>;

/** A troca da senha: a senha atual, o código do aplicativo e a senha nova (as outras sessões são encerradas). */
function PasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [problems, setProblems] = useState<PasswordProblems>({});
  const change = useMutation({
    mutationFn: (body: PasswordChangeRequest) => authApi.changePassword(body),
    onSettled: () => {
      setCurrentPassword('');
      setCode('');
      setNewPassword('');
      setConfirmation('');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.issues.some((issue) => issue.path === 'newPassword')) {
        setProblems({ newPassword: error.issues.find((issue) => issue.path === 'newPassword')?.message });
      }
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fresh = newPasswordProblems(newPassword, confirmation);
    const found: PasswordProblems = { newPassword: fresh.password, confirmation: fresh.confirmation };
    if (currentPassword === '') found.currentPassword = 'Digite a senha atual.';
    const normalized = normalizeCode(code);
    if (normalized === undefined) found.code = 'Digite os 6 números do aplicativo.';
    if (found.newPassword === undefined && newPassword === currentPassword && newPassword !== '')
      found.newPassword = 'A senha nova precisa ser diferente da atual.';
    const cleaned = Object.fromEntries(
      Object.entries(found).filter(([, value]) => value !== undefined),
    ) as PasswordProblems;
    setProblems(cleaned);
    if (Object.keys(cleaned).length > 0 || normalized === undefined) return;
    change.mutate({ currentPassword, code: normalized, newPassword });
  }

  return (
    <Card aria-labelledby="conta-senha">
      <CardHeader>
        <div>
          <CardTitle id="conta-senha">Trocar a senha</CardTitle>
          <CardDescription>As outras sessões abertas do console são encerradas.</CardDescription>
        </div>
      </CardHeader>
      <form className="max-w-sm space-y-4" onSubmit={submit} noValidate aria-label="Trocar a senha">
        <FormAlert message={change.isError ? accountMessage(change.error) : undefined} />
        {change.isSuccess && (
          <p role="status" className="text-sm">
            Senha trocada.
          </p>
        )}
        <TextField
          label="Senha atual"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          maxLength={128}
          value={currentPassword}
          error={problems.currentPassword}
          disabled={change.isPending}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <CodeField value={code} onChange={setCode} error={problems.code} disabled={change.isPending} />
        <TextField
          label="Senha nova"
          hint={`Pelo menos ${PASSWORD_MIN} caracteres.`}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={newPassword}
          error={problems.newPassword}
          disabled={change.isPending}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <TextField
          label="Confirme a senha nova"
          name="confirmation"
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={confirmation}
          error={problems.confirmation}
          disabled={change.isPending}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <Button type="submit" disabled={change.isPending}>
          {change.isPending ? 'Trocando…' : 'Trocar a senha'}
        </Button>
      </form>
    </Card>
  );
}

/**
 * A troca do aplicativo autenticador (celular novo): a senha atual e o código do aplicativo atual (ou um código de
 * recuperação, se o celular se perdeu); depois o QR do aplicativo novo, o primeiro código dele e os códigos de
 * recuperação novos, uma única vez (os antigos deixam de valer).
 */
function TotpCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [problems, setProblems] = useState<
    Partial<Record<'currentPassword' | 'code' | 'recoveryCode', string>>
  >({});
  const [enrollment, setEnrollment] = useState<TotpEnrollment | undefined>();
  const [codes, setCodes] = useState<RecoveryCodes | undefined>();

  const start = useMutation({
    mutationFn: (body: TotpResetStartRequest) => authApi.totpStart(body),
    onSuccess: (started) => setEnrollment(started),
    onSettled: () => {
      setCurrentPassword('');
      setCode('');
      setRecoveryCode('');
    },
  });
  const confirm = useMutation({
    mutationFn: (newCode: string) => {
      if (enrollment === undefined) throw new Error('troca sem início');
      return authApi.totpConfirm({ enrollmentId: enrollment.enrollmentId, code: newCode });
    },
    onSuccess: (result) => {
      setEnrollment(undefined);
      setCodes(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'enrollment_expired') setEnrollment(undefined);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: typeof problems = {};
    if (currentPassword === '') found.currentPassword = 'Digite a senha atual.';
    const normalized = normalizeCode(code);
    const recovery = recoveryCode.trim();
    if (useRecovery && recovery === '') found.recoveryCode = 'Digite um código de recuperação.';
    if (!useRecovery && normalized === undefined) found.code = 'Digite os 6 números do aplicativo.';
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    confirm.reset();
    start.mutate(
      useRecovery ? { currentPassword, recoveryCode: recovery } : { currentPassword, code: normalized ?? '' },
    );
  }

  let body;
  if (codes !== undefined) {
    body = (
      <RecoveryCodesPanel
        codes={codes.recoveryCodes}
        continueLabel="Concluir"
        onContinue={() => setCodes(undefined)}
      />
    );
  } else if (enrollment !== undefined) {
    body = (
      <TotpEnrollmentForm
        enrollment={enrollment}
        busy={confirm.isPending}
        error={confirm.isError ? accountMessage(confirm.error) : undefined}
        submitLabel="Confirmar o aplicativo novo"
        onConfirm={(newCode) => confirm.mutate(newCode)}
      />
    );
  } else {
    body = (
      <form
        className="max-w-sm space-y-4"
        onSubmit={submit}
        noValidate
        aria-label="Trocar o aplicativo autenticador"
      >
        <FormAlert
          message={
            start.isError
              ? accountMessage(start.error)
              : confirm.isError
                ? accountMessage(confirm.error)
                : undefined
          }
        />
        <TextField
          label="Senha atual"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          maxLength={128}
          value={currentPassword}
          error={problems.currentPassword}
          disabled={start.isPending}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        {useRecovery ? (
          <TextField
            label="Código de recuperação"
            name="recoveryCode"
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            value={recoveryCode}
            error={problems.recoveryCode}
            disabled={start.isPending}
            inputClassName="font-mono"
            onChange={(event) => setRecoveryCode(event.target.value)}
          />
        ) : (
          <CodeField
            label="Código do aplicativo atual"
            value={code}
            onChange={setCode}
            error={problems.code}
            disabled={start.isPending}
          />
        )}
        <button
          type="button"
          className="block text-sm text-primary underline-offset-2 hover:underline"
          onClick={() => {
            setUseRecovery((current) => !current);
            setCode('');
            setRecoveryCode('');
            setProblems({});
          }}
        >
          {useRecovery ? 'Usar o código do aplicativo' : 'Perdi o celular: usar um código de recuperação'}
        </button>
        <Button type="submit" disabled={start.isPending}>
          {start.isPending ? 'Conferindo…' : 'Trocar o aplicativo'}
        </Button>
      </form>
    );
  }

  return (
    <Card aria-labelledby="conta-totp">
      <CardHeader>
        <div>
          <CardTitle id="conta-totp">Trocar o aplicativo autenticador</CardTitle>
          <CardDescription>
            Para um celular novo. Os códigos de recuperação antigos deixam de valer e saem códigos novos.
          </CardDescription>
        </div>
      </CardHeader>
      {body}
    </Card>
  );
}

/** Minha conta (`/conta`): a troca da senha e do aplicativo autenticador, sempre com o código atual. */
export function AccountPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Minha conta</h1>
      <PasswordCard />
      <TotpCard />
    </div>
  );
}
