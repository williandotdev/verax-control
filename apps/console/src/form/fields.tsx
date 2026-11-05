import { Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  centsText,
  decimalText,
  formatCents,
  parseDecimal,
  parseInteger,
  parseMoney,
  parsePercent,
  rateText,
} from '@/lib/numbers';
import type { Path } from '@/lib/paths';
import { type FieldBinding, fieldId, useField, useList } from './form-context';

const INPUT =
  'h-9 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm tabular-nums placeholder:text-subtle-foreground disabled:cursor-not-allowed disabled:opacity-70 aria-invalid:border-critical';

/** Rótulo, controle, dica e erros ligados por `aria-describedby`; o erro sai em `--critical-text` com o texto. */
function FieldShell({
  binding,
  label,
  hint,
  extra,
  localError,
  className,
  children,
}: {
  binding: FieldBinding;
  label: string;
  hint?: string;
  extra?: ReactNode;
  localError?: string;
  className?: string;
  children: (describedBy: string | undefined, invalid: boolean) => ReactNode;
}) {
  const errors = [...(localError === undefined ? [] : [localError]), ...binding.issues];
  const hintId = `${binding.id}-dica`;
  const errorId = `${binding.id}-erro`;
  const describedBy =
    [hint === undefined ? undefined : hintId, errors.length === 0 ? undefined : errorId]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={binding.id} className="text-sm font-medium">
        {label}
      </label>
      {children(describedBy, errors.length > 0)}
      {extra}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {errors.length > 0 && (
        <p id={errorId} className="text-xs text-critical-text">
          {errors.join(' · ')}
        </p>
      )}
    </div>
  );
}

export type NumberKind = 'integer' | 'decimal' | 'money' | 'percent';

const PARSERS: Readonly<Record<NumberKind, (text: string) => number | undefined>> = {
  integer: parseInteger,
  decimal: parseDecimal,
  money: parseMoney,
  percent: parsePercent,
};

function toText(value: unknown, kind: NumberKind): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  if (kind === 'money') return centsText(value);
  if (kind === 'percent') return rateText(value);
  if (kind === 'integer') return String(value);
  return decimalText(value);
}

const INPUT_MODES: Readonly<Record<NumberKind, 'numeric' | 'decimal'>> = {
  integer: 'numeric',
  decimal: 'decimal',
  money: 'decimal',
  percent: 'decimal',
};

const KIND_ERRORS: Readonly<Record<NumberKind, string>> = {
  integer: 'Digite um número inteiro.',
  decimal: 'Digite um número (vírgula para os decimais).',
  money: 'Digite um valor em reais, como 1.000,00.',
  percent: 'Digite um percentual, como 4,5.',
};

/**
 * Campo numérico em pt-BR. Dinheiro aparece em reais e vai à API em centavos; percentual aparece em % e vai como
 * taxa entre 0 e 1. O texto digitado fica como está enquanto o responsável escreve; o número entra no rascunho a
 * cada tecla (vazio sai do documento; inválido vai como texto, e a API o recusa no lugar certo).
 */
export function NumberField({
  path,
  label,
  kind,
  hint,
  className,
}: {
  path: Path;
  label: string;
  kind: NumberKind;
  hint?: string;
  className?: string;
}) {
  const binding = useField(path);
  const [text, setText] = useState(() => toText(binding.value, kind));
  const [seen, setSeen] = useState(binding.value);
  // O valor mudou por fora (descartar, importar, clonar): o texto acompanha, sem efeito colateral.
  if (!Object.is(seen, binding.value)) {
    setSeen(binding.value);
    if (!Object.is(PARSERS[kind](text), binding.value)) setText(toText(binding.value, kind));
  }
  const parsed = PARSERS[kind](text);
  const localError = parsed !== undefined && Number.isNaN(parsed) ? KIND_ERRORS[kind] : undefined;
  const preview =
    kind === 'money' && typeof binding.value === 'number' ? (
      <span className="text-xs text-subtle-foreground tabular-nums">= {formatCents(binding.value)}</span>
    ) : undefined;
  return (
    <FieldShell
      binding={binding}
      label={label}
      hint={hint}
      extra={preview}
      localError={localError}
      className={className}
    >
      {(describedBy, invalid) => (
        <input
          id={binding.id}
          className={INPUT}
          type="text"
          inputMode={INPUT_MODES[kind]}
          autoComplete="off"
          value={text}
          disabled={binding.readOnly}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            const raw = event.target.value;
            setText(raw);
            const next = PARSERS[kind](raw);
            binding.set(next !== undefined && Number.isNaN(next) ? raw : next);
          }}
        />
      )}
    </FieldShell>
  );
}

/** Texto curto (rótulos, `lookup_key`, ids). Vazio sai do documento. */
export function TextField({
  path,
  label,
  hint,
  mono = false,
  type = 'text',
  className,
}: {
  path: Path;
  label: string;
  hint?: string;
  mono?: boolean;
  type?: 'text' | 'date' | 'url';
  className?: string;
}) {
  const binding = useField(path);
  return (
    <FieldShell binding={binding} label={label} hint={hint} className={className}>
      {(describedBy, invalid) => (
        <input
          id={binding.id}
          className={cn(INPUT, mono && 'font-mono')}
          type={type}
          autoComplete="off"
          spellCheck={mono ? false : undefined}
          value={typeof binding.value === 'string' ? binding.value : ''}
          disabled={binding.readOnly}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => binding.set(event.target.value === '' ? undefined : event.target.value)}
        />
      )}
    </FieldShell>
  );
}

export interface Option {
  value: string;
  label: string;
}

/** Seletor nativo; a opção vazia (quando há) tira o valor do documento. */
export function SelectField({
  path,
  label,
  options,
  hint,
  placeholder,
  className,
}: {
  path: Path;
  label: string;
  options: readonly Option[];
  hint?: string;
  placeholder?: string;
  className?: string;
}) {
  const binding = useField(path);
  const value = typeof binding.value === 'string' ? binding.value : '';
  return (
    <FieldShell binding={binding} label={label} hint={hint} className={className}>
      {(describedBy, invalid) => (
        <select
          id={binding.id}
          className={INPUT}
          value={value}
          disabled={binding.readOnly}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => binding.set(event.target.value === '' ? undefined : event.target.value)}
        >
          {(placeholder !== undefined || value === '') && (
            <option value="">{placeholder ?? 'Escolha'}</option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}

/** Um bloco do formulário com título e, quando a API aponta problema no bloco inteiro, a mensagem. */
export function Section({
  title,
  description,
  path,
  children,
  actions,
}: {
  title: string;
  description?: string;
  /** O caminho do bloco, para mostrar os problemas que a API aponta nele (ex.: faixas fora de ordem). */
  path?: Path;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <fieldset className="space-y-4 rounded-xl border bg-surface p-4">
      <legend className="px-1 text-base font-semibold">{title}</legend>
      {description !== undefined && <p className="-mt-2 text-sm text-muted-foreground">{description}</p>}
      {path !== undefined && <SectionIssues path={path} />}
      {children}
      {actions}
    </fieldset>
  );
}

function SectionIssues({ path }: { path: Path }) {
  const binding = useField(path);
  if (binding.issues.length === 0) return null;
  return (
    <p id={fieldId(path)} tabIndex={-1} className="text-sm text-critical-text">
      {binding.issues.join(' · ')}
    </p>
  );
}

export function Grid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}>{children}</div>;
}

/**
 * Uma lista editável: cada item num quadro numerado, com o botão de tirar, e o de acrescentar no fim (com o item
 * vazio do formato da lista). Os problemas da lista inteira aparecem em cima.
 */
export function ListEditor({
  path,
  itemLabel,
  addLabel,
  newItem,
  children,
}: {
  path: Path;
  itemLabel: string;
  addLabel: string;
  newItem: () => unknown;
  children: (index: number) => ReactNode;
}) {
  const list = useList(path);
  return (
    <div className="space-y-3">
      {list.issues.length > 0 && (
        <p id={fieldId(path)} tabIndex={-1} className="text-sm text-critical-text">
          {list.issues.join(' · ')}
        </p>
      )}
      {list.items.length === 0 && <p className="text-sm text-muted-foreground">Nenhum item.</p>}
      {list.items.map((_, index) => (
        <div key={index} className="rounded-lg border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {itemLabel} {index + 1}
            </p>
            {!list.readOnly && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => list.remove(index)}
                aria-label={`Tirar ${itemLabel.toLowerCase()} ${index + 1}`}
              >
                <Trash2 aria-hidden />
                Tirar
              </Button>
            )}
          </div>
          {children(index)}
        </div>
      ))}
      {!list.readOnly && (
        <Button variant="secondary" size="sm" onClick={() => list.append(newItem())}>
          <Plus aria-hidden />
          {addLabel}
        </Button>
      )}
    </div>
  );
}
