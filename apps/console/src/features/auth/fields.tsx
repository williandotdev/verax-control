import { TriangleAlert } from 'lucide-react';
import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/cn';

const INPUT =
  'h-9 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm placeholder:text-subtle-foreground disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-critical';

/**
 * Um campo das telas de acesso: rótulo de verdade, dica e erro ligados por `aria-describedby`. Sem o contexto dos
 * formulários de rascunho (`src/form`): aqui nada é desenhado a partir de um documento da API.
 */
export function TextField({
  label,
  hint,
  error,
  className,
  inputClassName,
  ...input
}: Omit<ComponentProps<'input'>, 'id'> & {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  inputClassName?: string;
}) {
  const id = useId();
  const hintId = `${id}-dica`;
  const errorId = `${id}-erro`;
  const describedBy =
    [hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        className={cn(INPUT, inputClassName)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
        {...input}
      />
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="text-xs text-critical-text">
          {error}
        </p>
      )}
    </div>
  );
}

/** O campo do código de 6 dígitos do aplicativo autenticador. */
export function CodeField({
  label = 'Código do aplicativo',
  value,
  onChange,
  error,
  disabled,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  disabled?: boolean;
}) {
  return (
    <TextField
      label={label}
      hint="Os 6 números que o aplicativo autenticador mostra agora."
      error={error}
      name="code"
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      spellCheck={false}
      maxLength={8}
      value={value}
      disabled={disabled}
      inputClassName="max-w-40 font-mono tracking-widest"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * O aviso de erro do formulário, no alto: recebe o foco quando aparece ou muda (o leitor de tela anuncia), sem dizer
 * qual campo estava errado quando a API não diz.
 */
export function FormAlert({ message }: { message: string | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message !== undefined) ref.current?.focus();
  }, [message]);
  if (message === undefined) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm focus:outline-none"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-critical" />
      <span>{message}</span>
    </div>
  );
}
