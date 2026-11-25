import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';

/** A seleção de linhas, como a tabela a usa (`useListSelection`). */
export interface RowSelect<T extends { id: string }> {
  isSelected: (id: string) => boolean;
  /** Por que a linha não pode ser marcada; null se pode. */
  blocked: (row: T) => string | null;
  /** Marca ou desmarca uma linha; com `range`, tudo desde a última (Shift). */
  toggle: (rows: readonly T[], row: T, checked: boolean, range: boolean) => void;
  /** A caixa do cabeçalho: só as linhas desta página. */
  pageState: (rows: readonly T[]) => 'all' | 'some' | 'none';
  togglePage: (rows: readonly T[], checked: boolean) => void;
  /** No celular, as caixas só aparecem no modo de seleção. */
  selecting: boolean;
  /** As linhas na tela são de outra busca (a nova ainda não veio): nada pode ser marcado. */
  stale: boolean;
}

/** No celular, sem o modo de seleção, a coluna não existe na tela. */
const column = (selecting: boolean) => (selecting ? 'table-cell' : 'hidden md:table-cell');

/** A área de toque de 44 px em volta da caixa. */
const TARGET = 'flex size-11 cursor-pointer items-center justify-center has-disabled:cursor-not-allowed';
export const CHECKBOX =
  'size-4.5 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40';

export function SelectHeader<T extends { id: string }>({
  select,
  rows,
  noun,
}: {
  select: RowSelect<T>;
  rows: readonly T[];
  /** "casos", "alertas": para o nome da caixa. */
  noun: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selectable = rows.filter((row) => select.blocked(row) === null);
  const state = select.pageState(selectable);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <th scope="col" className={cn('w-11 p-0 align-middle', column(select.selecting))}>
      <label className={TARGET}>
        <input
          ref={input}
          type="checkbox"
          className={CHECKBOX}
          aria-label={`Selecionar os ${noun} desta página`}
          checked={state === 'all'}
          disabled={select.stale || selectable.length === 0}
          onChange={(event) => select.togglePage(selectable, event.target.checked)}
        />
      </label>
    </th>
  );
}

export function SelectCell<T extends { id: string }>({
  select,
  rows,
  row,
  label,
}: {
  select: RowSelect<T>;
  rows: readonly T[];
  row: T;
  /** O nome da linha, para o leitor de tela. */
  label: string;
}) {
  return (
    <td className={cn('w-11 p-0 align-top', column(select.selecting))}>
      <SelectBox select={select} rows={rows} row={row} label={label} />
    </td>
  );
}

/** A caixa de uma linha, com a área de toque. Espaço alterna; Shift+clique marca o trecho. */
export function SelectBox<T extends { id: string }>({
  select,
  rows,
  row,
  label,
}: {
  select: RowSelect<T>;
  rows: readonly T[];
  row: T;
  label: string;
}) {
  const blocked = select.blocked(row);
  const selected = select.isSelected(row.id);
  // O clique chega antes do `change`, e só ele diz se o Shift estava apertado.
  const shift = useRef(false);
  return (
    <label className={TARGET} title={blocked ?? undefined}>
      <input
        type="checkbox"
        className={cn(CHECKBOX, 'scroll-mb-32')}
        aria-label={blocked ? `Selecionar: ${label} (${blocked})` : `Selecionar: ${label}`}
        checked={selected}
        disabled={select.stale || (blocked !== null && !selected)}
        onClick={(event) => {
          shift.current = event.shiftKey;
        }}
        onChange={(event) => {
          const selectable = rows.filter((candidate) => select.blocked(candidate) === null);
          select.toggle(selectable, row, event.target.checked, shift.current);
          shift.current = false;
        }}
      />
    </label>
  );
}
