import { randomBytes } from 'node:crypto';
import {
  assertCollectionPath,
  assertDocumentId,
  DocumentAlreadyExistsError,
  type DocumentData,
  type DocumentQuery,
  type DocumentStore,
  type DocumentTransaction,
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

function matches(data: DocumentData, clause: WhereClause): boolean {
  const result = compare(fieldValue(data, clause.field), clause.value);
  if (result === undefined) return false;
  switch (clause.op) {
    case '==':
      return result === 0;
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

interface PendingWrite {
  kind: 'create' | 'set' | 'delete';
  collection: string;
  id: string;
  data?: DocumentData;
}

/**
 * Dublê em memória do `DocumentStore` para testes unitários. As transações rodam uma por vez (fila): uma segunda
 * transação só lê depois que a primeira gravou, o que reproduz o efeito observável da disputa no Firestore
 * (a perdedora relê o estado novo e a regra de negócio a rejeita). Os mesmos testes de contrato rodam contra o
 * emulador oficial (`test/firestore-emulator.test.ts`).
 */
export class MemoryDocumentStore implements DocumentStore {
  private readonly collections = new Map<string, Map<string, DocumentData>>();
  private queue: Promise<void> = Promise.resolve();

  get(collection: string, id: string): Promise<DocumentData | undefined> {
    assertCollectionPath(collection);
    assertDocumentId(id);
    const data = this.collections.get(collection)?.get(id);
    return Promise.resolve(data === undefined ? undefined : cloneDocument(data));
  }

  query(collection: string, query: DocumentQuery = {}): Promise<StoredDocument[]> {
    assertCollectionPath(collection);
    const where = query.where ?? [];
    const orderBy = query.orderBy;
    let docs = [...(this.collections.get(collection)?.entries() ?? [])]
      .map(([id, data]) => ({ id, data }))
      .filter(({ data }) => where.every((clause) => matches(data, clause)))
      // Como no Firestore: sem o campo da ordenação, o documento fica fora.
      .filter(({ data }) => orderBy === undefined || fieldValue(data, orderBy.field) !== undefined);
    if (orderBy !== undefined) {
      const direction = orderBy.direction === 'desc' ? -1 : 1;
      docs = docs
        .map((doc, index) => ({ doc, index }))
        .sort((a, b) => {
          const result = compare(
            fieldValue(a.doc.data, orderBy.field),
            fieldValue(b.doc.data, orderBy.field),
          );
          return (result ?? 0) * direction || a.index - b.index;
        })
        .map(({ doc }) => doc);
    } else {
      docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    if (query.limit !== undefined) docs = docs.slice(0, query.limit);
    return Promise.resolve(docs.map(({ id, data }) => ({ id, data: cloneDocument(data) })));
  }

  runTransaction<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.execute(fn));
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
