/**
 * Leitura e escrita por caminho num documento JSON (o rascunho em edição). O caminho em texto é o mesmo que a API
 * devolve em `details.issues` (`volume.bands.0.amount`), e é por ele que cada campo acha a mensagem dele.
 */
export type Path = readonly (string | number)[];

export function pathKey(path: Path): string {
  return path.map(String).join('.');
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

export function getAt(root: unknown, path: Path): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isContainer(current)) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function isEmptyRecord(value: unknown): boolean {
  return isContainer(value) && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * Uma cópia do documento com `value` no caminho (os objetos e listas do caminho são copiados, o resto é
 * compartilhado). `undefined` tira a chave de um objeto: o campo vazio vai à API como ausente. Um objeto que fica
 * vazio por isso também sai (o preço do porte G apagado inteiro some, em vez de virar `{}` sem valor nem chave).
 */
export function setAt(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...(root as unknown[])] : [];
    list[head] = setAt(list[head], rest, value);
    return list;
  }
  const record: Record<string, unknown> = isContainer(root) && !Array.isArray(root) ? { ...root } : {};
  const next = setAt(record[head as string], rest, value);
  if (next === undefined || (rest.length > 0 && isEmptyRecord(next))) delete record[head as string];
  else record[head as string] = next;
  return record;
}

/** Tira o item `index` de uma lista no caminho. */
export function removeAt(root: unknown, path: Path, index: number): unknown {
  const list = getAt(root, path);
  if (!Array.isArray(list)) return root;
  return setAt(
    root,
    path,
    list.filter((_, position) => position !== index),
  );
}

/** Acrescenta `item` ao fim da lista no caminho (cria a lista se não existir). */
export function appendAt(root: unknown, path: Path, item: unknown): unknown {
  const list = getAt(root, path);
  const items: unknown[] = Array.isArray(list) ? list : [];
  return setAt(root, path, [...items, item]);
}
