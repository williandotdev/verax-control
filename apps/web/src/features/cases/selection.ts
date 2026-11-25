/**
 * A seleção de linhas de uma lista (casos ou alertas), sem React: um mapa de id para a linha, na ordem em que foram
 * marcadas, com um teto. A linha vai junto para as contas valerem também para o que está em outra página.
 */
export type Selected<T> = ReadonlyMap<string, T>;

export interface SelectionChange<T> {
  selected: Selected<T>;
  /** Quantas linhas ficaram de fora por causa do teto. */
  refused: number;
}

/** Marca (ou desmarca) linhas. O que passaria do teto fica de fora; o que já estava marcado não conta de novo. */
export function setSelected<T extends { id: string }>(
  selected: Selected<T>,
  rows: readonly T[],
  checked: boolean,
  limit: number,
): SelectionChange<T> {
  const next = new Map(selected);
  let refused = 0;
  for (const row of rows) {
    if (!checked) next.delete(row.id);
    else if (next.has(row.id)) next.set(row.id, row);
    else if (next.size < limit) next.set(row.id, row);
    else refused += 1;
  }
  return { selected: next, refused };
}

/**
 * As linhas entre a última marcada e a de agora, com as duas (Shift+clique). Sem a última na página (ou se ela não existe
 * mais), só a de agora.
 */
export function rangeOf<T extends { id: string }>(
  rows: readonly T[],
  anchorId: string | null,
  id: string,
): T[] {
  const to = rows.findIndex((row) => row.id === id);
  if (to < 0) return [];
  const from = anchorId === null ? -1 : rows.findIndex((row) => row.id === anchorId);
  if (from < 0) return rows.slice(to, to + 1);
  return rows.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** A caixa do cabeçalho: todas as linhas da página marcadas, algumas ou nenhuma. */
export function pageCheck<T extends { id: string }>(
  selected: Selected<T>,
  rows: readonly T[],
): 'all' | 'some' | 'none' {
  if (rows.length === 0) return 'none';
  const count = rows.filter((row) => selected.has(row.id)).length;
  if (count === 0) return 'none';
  return count === rows.length ? 'all' : 'some';
}

/** As linhas marcadas, com os números de agora para as que estão na página. */
export function freshest<T extends { id: string }>(selected: Selected<T>, rows: readonly T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...selected.values()].map((row) => byId.get(row.id) ?? row);
}
