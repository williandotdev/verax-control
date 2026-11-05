import type {
  DocumentData,
  DocumentQuery,
  DocumentStore,
  DocumentTransaction,
  StoredDocument,
} from '../../src/firestore/document-store.js';
import { MemoryDocumentStore } from '../../src/firestore/memory-document-store.js';

/**
 * O dublê em memória do Firestore que também guarda o texto de cada documento gravado (inclusive os sobrescritos e os
 * apagados depois), para o teste provar que nenhum segredo chegou ao banco em momento nenhum.
 */
export class RecordingDocumentStore implements DocumentStore {
  readonly writes: string[] = [];

  constructor(readonly inner: MemoryDocumentStore = new MemoryDocumentStore()) {}

  get(collection: string, id: string): Promise<DocumentData | undefined> {
    return this.inner.get(collection, id);
  }

  query(collection: string, query?: DocumentQuery): Promise<StoredDocument[]> {
    return this.inner.query(collection, query);
  }

  newId(): string {
    return this.inner.newId();
  }

  runTransaction<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    return this.inner.runTransaction((tx) =>
      fn({
        get: (collection, id) => tx.get(collection, id),
        query: (collection, query) => tx.query(collection, query),
        create: (collection, id, data) => {
          this.writes.push(`${collection}/${id} ${JSON.stringify(data)}`);
          tx.create(collection, id, data);
        },
        set: (collection, id, data) => {
          this.writes.push(`${collection}/${id} ${JSON.stringify(data)}`);
          tx.set(collection, id, data);
        },
        delete: (collection, id) => tx.delete(collection, id),
      }),
    );
  }

  /** Tudo o que já foi gravado, num texto só. */
  get text(): string {
    return this.writes.join('\n');
  }
}
