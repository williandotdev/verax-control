import {
  type CollectionReference,
  Firestore,
  type Query as FirestoreQuery,
  Timestamp,
  type Transaction as FirestoreTransactionApi,
} from '@google-cloud/firestore';
import type { AppConfig } from '../common/config/config.module.js';
import {
  assertCollectionPath,
  assertDocumentId,
  DocumentAlreadyExistsError,
  type DocumentData,
  type DocumentQuery,
  type DocumentStore,
  type DocumentTransaction,
  type StoredDocument,
} from './document-store.js';

/** Código gRPC `ALREADY_EXISTS`, devolvido pelo commit quando um `create` encontra o documento. */
const ALREADY_EXISTS = 6;

/** O Firestore devolve `Timestamp`; o domínio trabalha com `Date`. */
function fromFirestore(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(fromFirestore);
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const result: DocumentData = {};
    for (const [key, item] of Object.entries(value)) result[key] = fromFirestore(item);
    return result;
  }
  return value;
}

function buildQuery(collection: CollectionReference, query: DocumentQuery): FirestoreQuery {
  let built: FirestoreQuery = collection;
  for (const clause of query.where ?? []) built = built.where(clause.field, clause.op, clause.value);
  if (query.orderBy !== undefined)
    built = built.orderBy(query.orderBy.field, query.orderBy.direction ?? 'asc');
  if (query.limit !== undefined) built = built.limit(query.limit);
  return built;
}

/**
 * Cliente do Firestore a partir da configuração. O projeto vem dos metadados do Cloud Run quando
 * `FIRESTORE_PROJECT_ID` não é informado; com o emulador (`FIRESTORE_EMULATOR_HOST`, lido do ambiente pelo
 * próprio SDK) ele é obrigatório. `ignoreUndefinedProperties` faz campos opcionais ausentes sumirem do
 * documento, como no dublê em memória.
 */
export function createFirestore(
  config: Pick<AppConfig, 'FIRESTORE_DATABASE' | 'FIRESTORE_PROJECT_ID'>,
): Firestore {
  return new Firestore({
    ...(config.FIRESTORE_PROJECT_ID === undefined ? {} : { projectId: config.FIRESTORE_PROJECT_ID }),
    databaseId: config.FIRESTORE_DATABASE,
    ignoreUndefinedProperties: true,
  });
}

/** `DocumentStore` sobre o SDK oficial. As transações têm a repetição automática do SDK (contenção). */
export class FirestoreDocumentStore implements DocumentStore {
  constructor(private readonly db: Firestore) {}

  async get(collection: string, id: string): Promise<DocumentData | undefined> {
    assertCollectionPath(collection);
    assertDocumentId(id);
    const snapshot = await this.db.collection(collection).doc(id).get();
    return snapshot.exists ? (fromFirestore(snapshot.data()) as DocumentData) : undefined;
  }

  async query(collection: string, query: DocumentQuery = {}): Promise<StoredDocument[]> {
    assertCollectionPath(collection);
    const snapshot = await buildQuery(this.db.collection(collection), query).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, data: fromFirestore(doc.data()) as DocumentData }));
  }

  async runTransaction<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    let creates: string[] = [];
    try {
      return await this.db.runTransaction(async (transaction) => {
        const tx = new FirestoreTransaction(this.db, transaction);
        const result = await fn(tx);
        creates = tx.creates;
        return result;
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === ALREADY_EXISTS)
        throw new DocumentAlreadyExistsError(creates);
      throw error;
    }
  }

  newId(): string {
    return this.db.collection('ids').doc().id;
  }
}

class FirestoreTransaction implements DocumentTransaction {
  /** Documentos criados nesta tentativa, para nomear o conflito se o commit falhar com ALREADY_EXISTS. */
  readonly creates: string[] = [];

  constructor(
    private readonly db: Firestore,
    private readonly transaction: FirestoreTransactionApi,
  ) {}

  async get(collection: string, id: string): Promise<DocumentData | undefined> {
    assertCollectionPath(collection);
    assertDocumentId(id);
    const snapshot = await this.transaction.get(this.db.collection(collection).doc(id));
    return snapshot.exists ? (fromFirestore(snapshot.data()) as DocumentData) : undefined;
  }

  async query(collection: string, query: DocumentQuery = {}): Promise<StoredDocument[]> {
    assertCollectionPath(collection);
    const snapshot = await this.transaction.get(buildQuery(this.db.collection(collection), query));
    return snapshot.docs.map((doc) => ({ id: doc.id, data: fromFirestore(doc.data()) as DocumentData }));
  }

  create(collection: string, id: string, data: DocumentData): void {
    assertCollectionPath(collection);
    assertDocumentId(id);
    this.creates.push(`${collection}/${id}`);
    this.transaction.create(this.db.collection(collection).doc(id), data);
  }

  set(collection: string, id: string, data: DocumentData): void {
    assertCollectionPath(collection);
    assertDocumentId(id);
    this.transaction.set(this.db.collection(collection).doc(id), data);
  }

  delete(collection: string, id: string): void {
    assertCollectionPath(collection);
    assertDocumentId(id);
    this.transaction.delete(this.db.collection(collection).doc(id));
  }
}
