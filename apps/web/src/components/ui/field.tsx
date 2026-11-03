import { type ComponentProps, useId } from 'react';
import { cn } from '@/lib/cn';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm placeholder:text-subtle-foreground disabled:opacity-50 aria-invalid:border-critical',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-20 w-full rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm placeholder:text-subtle-foreground disabled:opacity-50 aria-invalid:border-critical',
        className,
      )}
      {...props}
    />
  );
}

interface FieldProps extends Omit<ComponentProps<'input'>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
}

/** Campo com rótulo, dica e erro ligados por `aria-describedby`. */
export function Field({ label, hint, error, className, ...props }: FieldProps) {
  const id = useId();
  const hintId = `${id}-dica`;
  const errorId = `${id}-erro`;
  const describedBy = [hint ? hintId : undefined, error ? errorId : undefined].filter(Boolean).join(' ');
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...props}
      />
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-critical-text">
          {error}
        </p>
      )}
    </div>
  );
}
