import { type FormEvent, useState } from 'react';
import QRCode from 'react-qr-code';
import { Button } from '@/components/ui/button';
import type { TotpEnrollment } from '@/lib/api-types';
import { groupSecret, normalizeCode } from './credentials';
import { CodeField, FormAlert } from './fields';

/**
 * O cadastro do aplicativo autenticador: o QR gerado aqui mesmo, no navegador (nunca por um serviço de fora), o
 * segredo para digitar à mão e o primeiro código, que confirma o cadastro.
 */
export function TotpEnrollmentForm({
  enrollment,
  busy,
  error,
  submitLabel,
  onConfirm,
}: {
  enrollment: TotpEnrollment;
  busy: boolean;
  error: string | undefined;
  submitLabel: string;
  onConfirm: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | undefined>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeCode(code);
    if (normalized === undefined) {
      setCodeError('Digite os 6 números do aplicativo.');
      return;
    }
    setCodeError(undefined);
    onConfirm(normalized);
  }

  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <FormAlert message={error} />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">1. Leia o QR no aplicativo autenticador</h2>
        <div className="w-fit rounded-md bg-white p-3">
          <QRCode
            value={enrollment.otpauthUri}
            size={168}
            role="img"
            aria-label="QR para cadastrar o console no aplicativo autenticador"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Sem câmera? Digite esta chave no aplicativo:{' '}
          <code data-testid="segredo-totp" className="font-mono break-all text-foreground">
            {groupSecret(enrollment.secret)}
          </code>
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">2. Confirme com o código que o aplicativo mostra</h2>
        <CodeField value={code} onChange={setCode} error={codeError} disabled={busy} />
      </section>
      <Button type="submit" disabled={busy}>
        {busy ? 'Conferindo…' : submitLabel}
      </Button>
    </form>
  );
}

/**
 * Os códigos de recuperação, mostrados uma única vez: copiar e confirmar que foram guardados antes de seguir. Nunca
 * vão para a URL, o `localStorage` ou o log.
 */
export function RecoveryCodesPanel({
  codes,
  continueLabel,
  onContinue,
}: {
  codes: readonly string[];
  continueLabel: string;
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | undefined>();
  // O `navigator.clipboard` só existe em contexto seguro (https); sem ele, o botão nem aparece.
  const clipboard =
    typeof navigator === 'undefined' ? undefined : (navigator.clipboard as Clipboard | undefined);

  async function copy() {
    try {
      await clipboard?.writeText(codes.join('\n'));
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        Guarde estes códigos num lugar seguro, fora do celular. Cada um entra uma única vez, no lugar do
        código do aplicativo, se você perder o celular. <strong>Eles não aparecem de novo.</strong>
      </p>
      <ul
        aria-label="Códigos de recuperação"
        className="grid grid-cols-2 gap-1 rounded-md border bg-surface-raised p-3 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      {clipboard !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            Copiar
          </Button>
          <span role="status" className="text-xs text-muted-foreground">
            {copied === 'ok' && 'Códigos copiados.'}
            {copied === 'failed' && 'Não deu para copiar: selecione e copie à mão.'}
          </span>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        Guardei os códigos em lugar seguro
      </label>
      <Button onClick={onContinue} disabled={!saved}>
        {continueLabel}
      </Button>
    </div>
  );
}
