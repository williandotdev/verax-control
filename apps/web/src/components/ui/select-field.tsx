import { useId } from 'react';
import { cn } from '@/lib/cn';

export interface SelectOption {
  value: string;
  label: string;
}

/** Seletor nativo com rótulo (filtros das listas). */
export function SelectField({
  label,
  value,
  onChange,
  options,
  className,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  className?: string;
  /** Uma linha embaixo do campo, que diz como ele filtra (lida também pelo leitor de tela). */
  hint?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        className="h-9 min-w-40 rounded-md border bg-surface-raised px-2 text-sm"
        value={value}
        aria-describedby={hint ? `${id}-dica` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && (
        <p id={`${id}-dica`} className="max-w-56 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
