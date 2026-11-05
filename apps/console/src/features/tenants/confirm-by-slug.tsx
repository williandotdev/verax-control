import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * A confirmação de uma operação que cria custo ou mexe no ambiente de um cliente: o responsável digita o subdomínio dele.
 * O botão só habilita com o texto igual, e a API confere de novo (`confirmSlug`). Fica na própria página, sem janela
 * modal, como a publicação das tabelas.
 */
export function ConfirmBySlug({
  slug,
  actionLabel,
  busyLabel,
  busy,
  children,
  onConfirm,
  onCancel,
}: {
  slug: string;
  actionLabel: string;
  busyLabel: string;
  busy: boolean;
  /** O que vai acontecer, em texto, antes do campo. */
  children: ReactNode;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const [typed, setTyped] = useState('');
  const matches = typed === slug;
  return (
    <div className="space-y-3 rounded-lg border border-border-strong p-3">
      <div className="space-y-2 text-sm">{children}</div>
      <div className="flex max-w-sm flex-col gap-1">
        <label htmlFor={`${ids}-confirmar`} className="text-sm font-medium">
          Digite o subdomínio <span className="font-mono">{slug}</span> para confirmar
        </label>
        <input
          id={`${ids}-confirmar`}
          className="h-9 w-full rounded-md border border-border-strong bg-surface-raised px-3 font-mono text-sm"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value.trim())}
          aria-describedby={`${ids}-dica`}
        />
        <p id={`${ids}-dica`} className="text-xs text-muted-foreground">
          {matches ? 'Confere.' : 'O botão libera quando o texto for igual ao subdomínio.'}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onConfirm(typed)} disabled={!matches || busy}>
          {busy ? busyLabel : actionLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
      </div>
    </div>
  );
}
