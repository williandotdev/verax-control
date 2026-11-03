import type { ComponentProps, ReactNode } from 'react';
import { useId, useState } from 'react';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { useMe } from '@/features/session/session';
import { errorMessage } from '@/lib/errors';

/** Moldura das telas de cadastro: título, explicação curta e o botão principal. */
export function AdminShell({
  title,
  description,
  action,
  needsTenant = true,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  /** Os cadastros do cliente pedem o cliente da sessão; o de clientes, não. */
  needsTenant?: boolean;
  children: ReactNode;
}) {
  const { data: me } = useMe();
  const missingTenant = needsTenant && me !== undefined && me.scopeTenantId === null;
  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
        {!missingTenant && action}
      </header>
      {missingTenant ? (
        <EmptyState
          title="Escolha um cliente"
          description="Este cadastro é de um cliente por vez. Escolha um no seletor do topo."
        />
      ) : (
        children
      )}
    </section>
  );
}

/** Seletor nativo com rótulo e erro ligados ao campo. */
export function SelectInput({
  label,
  error,
  options,
  className,
  ...props
}: Omit<ComponentProps<'select'>, 'id'> & {
  label: string;
  error?: string;
  options: readonly { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <div className={className ? `space-y-1 ${className}` : 'space-y-1'}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-erro` : undefined}
        className="h-10 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm aria-invalid:border-critical"
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={`${id}-erro`} className="text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

/** Área de texto com rótulo e erro ligados ao campo. */
export function TextAreaField({
  label,
  error,
  hint,
  ...props
}: Omit<ComponentProps<'textarea'>, 'id'> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const described = [hint ? `${id}-dica` : undefined, error ? `${id}-erro` : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={described || undefined}
        {...props}
      />
      {hint && (
        <p id={`${id}-dica`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-erro`} className="text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

/** Ação destrutiva em dois passos: o primeiro clique pede a confirmação, sem janela do navegador. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  busy = false,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant="secondary" onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirmação">
      <Button type="button" variant="danger" disabled={busy} onClick={onConfirm}>
        {confirmLabel}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
        Cancelar
      </Button>
    </span>
  );
}

/** Erro da API num formulário, anunciado para leitor de tela. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-critical">
      {errorMessage(error)}
    </p>
  );
}
