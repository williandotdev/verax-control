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

/** Chaves que mexeriam no protótipo dos objetos: nenhum campo do console tem esses nomes, e o caminho as recusa. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isUnsafe(segment: string | number): boolean {
  return typeof segment === 'string' && UNSAFE_KEYS.has(segment);
}

function assertSafe(segment: string | number): void {
  if (isUnsafe(segment)) throw new TypeError(`caminho inválido: ${segment}`);
}

/**
 * O valor no caminho, ou `undefined` se algum trecho faltar, não for objeto ou lista, ou for uma chave do protótipo.
 * Só propriedades próprias: um documento importado com `__proto__` ou um caminho para `constructor` nunca chega ao
 * protótipo.
 */
export function getAt(root: unknown, path: Path): unknown {
  if (path.length === 0) return root;
  const [head, ...rest] = path;
  if (head === undefined || isUnsafe(head) || !isContainer(root) || !Object.hasOwn(root, head))
    return undefined;
  return getAt((root as Record<string | number, unknown>)[head], rest);
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
  if (head === undefined) return value;
  assertSafe(head);
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...(root as unknown[])] : [];
    list[head] = setAt(getAt(list, [head]), rest, value);
    return list;
  }
  const record: Record<string, unknown> = isContainer(root) && !Array.isArray(root) ? { ...root } : {};
  const next = setAt(getAt(record, [head]), rest, value);
  if (next === undefined || (rest.length > 0 && isEmptyRecord(next))) delete record[head];
  else record[head] = next;
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
