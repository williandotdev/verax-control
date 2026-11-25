import { useState } from 'react';
import type { RowSelect } from './select-cells';
import { freshest, pageCheck, rangeOf, type Selected, setSelected } from './selection';

interface SelectionState<T> {
  key: string;
  selected: Selected<T>;
  /** A última linha marcada à mão: de onde o Shift conta. */
  anchor: string | null;
  /** Linhas que não couberam no teto, para avisar. */
  refused: number;
  /** A seleção é o filtro inteiro da lista, e não linhas. */
  filter: boolean;
  /** No celular, o modo de seleção. */
  selecting: boolean;
}

export interface ListSelection<T extends { id: string }> {
  select: RowSelect<T>;
  selected: Selected<T>;
  refused: number;
  filter: boolean;
  selecting: boolean;
  /** As linhas marcadas, com os números de agora para as que estão na tela. */
  items: (rows: readonly T[]) => T[];
  selectFilter: () => void;
  setSelecting: (selecting: boolean) => void;
  clear: () => void;
}

/**
 * A seleção de uma lista, com teto. Ela atravessa as páginas e some quando a lista passa a ser outra (`resetKey`: a visão e
 * os filtros), para ninguém tratar o que não está mais vendo.
 */
export function useListSelection<T extends { id: string }>({
  limit,
  resetKey,
  blocked,
}: {
  limit: number;
  resetKey: string;
  blocked: (row: T) => string | null;
}): ListSelection<T> {
  const empty = (selecting: boolean): SelectionState<T> => ({
    key: resetKey,
    selected: new Map(),
    anchor: null,
    refused: 0,
    filter: false,
    selecting,
  });
  const [state, setState] = useState<SelectionState<T>>(() => empty(false));
  // Outra lista: a seleção recomeça, durante o render, sem efeito (recomendação do React).
  const current = state.key === resetKey ? state : empty(state.selecting);
  if (current !== state) setState(current);

  const apply = (rows: readonly T[], checked: boolean, anchor: string | null) =>
    setState((before) => {
      // Mexer numa linha com o filtro inteiro escolhido volta a escolher linhas.
      const base = before.filter ? new Map<string, T>() : before.selected;
      const { selected, refused } = setSelected(base, rows, checked, limit);
      return { ...before, selected, refused, anchor, filter: false };
    });

  return {
    selected: current.selected,
    refused: current.refused,
    filter: current.filter,
    selecting: current.selecting,
    items: (rows) => freshest(current.selected, rows),
    selectFilter: () =>
      setState((before) => ({ ...before, filter: true, selected: new Map(), refused: 0, anchor: null })),
    setSelecting: (selecting) => setState((before) => (selecting ? { ...before, selecting } : empty(false))),
    clear: () => setState((before) => empty(before.selecting)),
    select: {
      selecting: current.selecting,
      isSelected: (id) => current.filter || current.selected.has(id),
      blocked,
      toggle: (rows, row, checked, range) => {
        // Com o filtro inteiro escolhido, desmarcar uma linha deixa as outras da página marcadas.
        if (current.filter)
          apply(
            rows.filter((candidate) => candidate.id !== row.id),
            true,
            row.id,
          );
        else apply(range ? rangeOf(rows, current.anchor, row.id) : [row], checked, row.id);
      },
      pageState: (rows) => (current.filter ? 'all' : pageCheck(current.selected, rows)),
      togglePage: (rows, checked) => apply(rows, checked, null),
    },
  };
}
