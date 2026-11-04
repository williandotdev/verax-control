import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { type CompositeIndex, COMPOSITE_INDEXES } from './collections.js';
import {
  assertCollectionPath,
  assertDocumentId,
  DocumentAlreadyExistsError,
  type DocumentData,
  type DocumentQuery,
  type DocumentStore,
  type DocumentTransaction,
  equalValues,
  NestedTransactionError,
  ReadAfterWriteError,
  type StoredDocument,
  type WhereClause,
} from './document-store.js';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Cópia profunda no formato que o Firestore aceita: objetos simples, arrays, primitivos e `Date`; `undefined`
 * some (como com `ignoreUndefinedProperties`); qualquer outro objeto é recusado, como o SDK faria.
 */
function clone(value: unknown, path = ''): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError(`valor não serializável em ${path || '(raiz)'}`);
    }
    return value;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((item, index) => clone(item, `${path}[${index}]`));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`valor não serializável em ${path || '(raiz)'}`);
  }
  const result: DocumentData = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    result[key] = clone(item, path ? `${path}.${key}` : key);
  }
  return result;
}

function cloneDocument(data: DocumentData): DocumentData {
  return clone(data) as DocumentData;
}

/** Valor de um campo por caminho com pontos; `undefined` quando o caminho não existe. */
function fieldValue(data: DocumentData, field: string): unknown {
  let current: unknown = data;
  for (const segment of field.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as DocumentData)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

type Comparable = number | string | boolean | Date | null;

function isComparable(value: unknown): value is Comparable {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

/** Compara dois valores do mesmo tipo, como o Firestore; tipos diferentes não se comparam (`undefined`). */
function compare(a: unknown, b: unknown): number | undefined {
  if (!isComparable(a) || !isComparable(b)) return undefined;
  if (a === null || b === null) return a === b ? 0 : undefined;
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date && b instanceof Date)) return undefined;
    return a.getTime() - b.getTime();
  }
  if (typeof a !== typeof b) return undefined;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return undefined;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `==` é igualdade profunda (arrays e objetos entram, como no Firestore); os demais comparam primitivos. */
function matches(data: DocumentData, clause: WhereClause): boolean {
  const actual = fieldValue(data, clause.field);
  if (actual === undefined) return false;
  if (clause.op === '==') return equalValues(actual, clause.value);
  const result = compare(actual, clause.value);
  if (result === undefined) return false;
  switch (clause.op) {
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
    case '>':
      return result > 0;
    case '>=':
      return result >= 0;
    default:
      return false;
  }
}

/** Consulta que o dublê não sabe executar como o Firestore executaria; falha alto em vez de divergir em silêncio. */
export class UnsupportedQueryError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedQueryError';
  }
}

/**
 * Consulta que em produção exige um índice composto que não está declarado em `COMPOSITE_INDEXES` (e, portanto,
 * nem no `firestore.tf`). O emulador não confere índices, então só o dublê pega isso antes do deploy.
 */
export class MissingCompositeIndexError extends Error {
  constructor(
    readonly collection: string,
    readonly fields: readonly string[],
  ) {
    super(
      `consulta em ${collection} precisa de um índice composto (${fields.join(', ')}) declarado em ` +
        'collections.ts (COMPOSITE_INDEXES) e no firestore.tf do infra/gcp/envs/control-plane',
    );
    this.name = 'MissingCompositeIndexError';
  }
}

const RANGE_OPERATORS = new Set(['<', '<=', '>', '>=']);

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Campos do índice composto que a consulta exige, ou `undefined` quando os índices de campo único bastam. Regras do
 * Firestore: só igualdades (quantas forem) se resolvem por junção de índices simples; um único campo com desigualdade
 * ou ordenação também; igualdade mais outro campo com desigualdade ou ordenação, ou dois campos desses, pedem um
 * índice com as igualdades na frente e os demais na ordem. A direção (ASC/DESC) não é conferida.
 */
function requiredIndexFields(query: DocumentQuery): string[] | undefined {
  const where = query.where ?? [];
  const equalities = unique(where.filter((clause) => clause.op === '==').map((clause) => clause.field));
  const tail = unique(where.filter((clause) => RANGE_OPERATORS.has(clause.op)).map((clause) => clause.field));
  if (query.orderBy !== undefined && !tail.includes(query.orderBy.field)) tail.push(query.orderBy.field);
  const others = tail.filter((field) => !equalities.includes(field));
  if (others.length === 0) return undefined;
  if (equalities.length === 0 && others.length === 1) return undefined;
  return [...equalities, ...others];
}

function hasIndex(
  indexes: readonly CompositeIndex[],
  group: string,
  required: readonly string[],
  equalities: number,
): boolean {
  const wantedEqualities = new Set(required.slice(0, equalities));
  const wantedTail = required.slice(equalities);
  return indexes.some((index) => {
    if (index.collectionGroup !== group || index.fields.length !== required.length) return false;
    const paths = index.fields.map((field) => field.fieldPath);
    const head = paths.slice(0, equalities);
    return (
      head.every((path) => wantedEqualities.has(path)) &&
      new Set(head).size === wantedEqualities.size &&
      paths.slice(equalities).every((path, position) => path === wantedTail[position])
    );
  });
}

/** O que o SDK recusa na montagem da consulta, mais o que o dublê não implementa. */
function assertSupportedQuery(
  collection: string,
  query: DocumentQuery,
  indexes: readonly CompositeIndex[],
): void {
  for (const clause of query.where ?? []) {
    if (clause.value === undefined) {
      throw new UnsupportedQueryError(`valor undefined na condição sobre ${clause.field} (o SDK recusa)`);
    }
    if (RANGE_OPERATORS.has(clause.op) && !isComparable(clause.value)) {
      throw new UnsupportedQueryError(
        `o dublê não compara arrays nem objetos com ${clause.op} (condição sobre ${clause.field})`,
      );
    }
  }
  const required = requiredIndexFields(query);
  if (required === undefined) return;
  const group = collection.split('/').at(-1) ?? collection;
  const equalities = unique((query.where ?? []).filter((c) => c.op === '==').map((c) => c.field)).length;
  if (!hasIndex(indexes, group, required, equalities))
    throw new MissingCompositeIndexError(collection, required);
}

interface PendingWrite {
  kind: 'create' | 'set' | 'delete';
  collection: string;
  id: string;
  data?: DocumentData;
}

export interface MemoryDocumentStoreOptions {
  /** Índices compostos "existentes"; o padrão é a lista do código, a mesma do `firestore.tf`. */
  indexes?: readonly CompositeIndex[];
}

/**
 * Dublê em memória do `DocumentStore` para testes unitários. As transações rodam uma por vez (fila): uma segunda
 * transação só lê depois que a primeira gravou, o que reproduz o efeito observável da disputa no Firestore
 * (a perdedora relê o estado novo e a regra de negócio a rejeita). Os mesmos testes de contrato rodam contra o
 * emulador oficial (`test/firestore-emulator.test.ts`).
 *
 * O dublê é mais estrito que o emulador onde o emulador é mais frouxo que a produção: recusa consulta que exigiria
 * índice composto não declarado (`MissingCompositeIndexError`) e as formas que não sabe reproduzir
 * (`UnsupportedQueryError`), em vez de devolver um resultado que o Firestore real não devolveria.
 */
export class MemoryDocumentStore implements DocumentStore {
  private readonly collections = new Map<string, Map<string, DocumentData>>();
  private readonly indexes: readonly CompositeIndex[];
  private readonly insideTransaction = new AsyncLocalStorage<true>();
  private queue: Promise<void> = Promise.resolve();

  constructor(options: MemoryDocumentStoreOptions = {}) {
    this.indexes = options.indexes ?? COMPOSITE_INDEXES;
  }

  get(collection: string, id: string): Promise<DocumentData | undefined> {
    assertCollectionPath(collection);
    assertDocumentId(id);
    const data = this.collections.get(collection)?.get(id);
    return Promise.resolve(data === undefined ? undefined : cloneDocument(data));
  }

  query(collection: string, query: DocumentQuery = {}): Promise<StoredDocument[]> {
    assertCollectionPath(collection);
    try {
      // Como no SDK, que recusa a consulta dentro do método assíncrono: a recusa chega como rejeição.
      assertSupportedQuery(collection, query, this.indexes);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const where = query.where ?? [];
    const orderBy = query.orderBy;
    // Sem orderBy, o Firestore ordena pelo campo da desigualdade (se houver) e pelo id; com orderBy, por ele e
    // pelo id, na mesma direção. Os empates saem iguais nos dois backends.
    const direction = orderBy?.direction === 'desc' ? -1 : 1;
    const sortField = orderBy?.field ?? where.find((clause) => RANGE_OPERATORS.has(clause.op))?.field;
    let docs = [...(this.collections.get(collection)?.entries() ?? [])]
      .map(([id, data]) => ({ id, data }))
      .filter(({ data }) => where.every((clause) => matches(data, clause)))
      // Como no Firestore: sem o campo da ordenação, o documento fica fora.
      .filter(({ data }) => orderBy === undefined || fieldValue(data, orderBy.field) !== undefined)
      .sort((a, b) => {
        const byField =
          sortField === undefined
            ? 0
            : (compare(fieldValue(a.data, sortField), fieldValue(b.data, sortField)) ?? 0);
        return (byField || compareIds(a.id, b.id)) * direction;
      });
    if (query.limit !== undefined) docs = docs.slice(0, query.limit);
    return Promise.resolve(docs.map(({ id, data }) => ({ id, data: cloneDocument(data) })));
  }

  runTransaction<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    // Chamada de dentro de uma transação deste store: no dublê esperaria a fila para sempre.
    if (this.insideTransaction.getStore() === true) return Promise.reject(new NestedTransactionError());
    const run = this.queue.then(() => this.insideTransaction.run(true, () => this.execute(fn)));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  newId(): string {
    let id = '';
    for (const byte of randomBytes(20)) {
      id += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
    return id;
  }

  /** Só para testes: apaga tudo. */
  clear(): void {
    this.collections.clear();
  }

  private async execute<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    const tx = new MemoryTransaction(this);
    const result = await fn(tx);
    this.commit(tx.writes);
    return result;
  }

  private commit(writes: readonly PendingWrite[]): void {
    const conflicts = writes
      .filter((write) => write.kind === 'create' && this.collections.get(write.collection)?.has(write.id))
      .map((write) => `${write.collection}/${write.id}`);
    if (conflicts.length > 0) throw new DocumentAlreadyExistsError(conflicts);
    for (const write of writes) {
      let collection = this.collections.get(write.collection);
      if (collection === undefined) {
        collection = new Map();
        this.collections.set(write.collection, collection);
      }
      if (write.kind === 'delete') collection.delete(write.id);
      else collection.set(write.id, write.data ?? {});
    }
  }
}

class MemoryTransaction implements DocumentTransaction {
  readonly writes: PendingWrite[] = [];

  constructor(private readonly store: MemoryDocumentStore) {}

  get(collection: string, id: string): Promise<DocumentData | undefined> {
    if (this.writes.length > 0) return Promise.reject(new ReadAfterWriteError());
    return this.store.get(collection, id);
  }

  query(collection: string, query?: DocumentQuery): Promise<StoredDocument[]> {
    if (this.writes.length > 0) return Promise.reject(new ReadAfterWriteError());
    return this.store.query(collection, query);
  }

  create(collection: string, id: string, data: DocumentData): void {
    this.push({ kind: 'create', collection, id, data: cloneDocument(data) });
  }

  set(collection: string, id: string, data: DocumentData): void {
    this.push({ kind: 'set', collection, id, data: cloneDocument(data) });
  }

  delete(collection: string, id: string): void {
    this.push({ kind: 'delete', collection, id });
  }

  private push(write: PendingWrite): void {
    assertCollectionPath(write.collection);
    assertDocumentId(write.id);
    this.writes.push(write);
  }
}
