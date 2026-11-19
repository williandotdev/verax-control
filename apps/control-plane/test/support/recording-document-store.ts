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
 * apagados depois), para o teste provar que nenhum segredo chegou ao banco em momento nenhum, e cada consulta feita fora de
 * transação (`<coleção>?<consulta em JSON>`), para o teste contar páginas.
 */
export class RecordingDocumentStore implements DocumentStore {
  readonly writes: string[] = [];
  readonly queries: string[] = [];
  /**
   * Uma vez: roda depois da próxima consulta fora de transação que o filtro aceitar, antes de ela voltar a quem
   * perguntou. É como o teste encaixa uma escrita concorrente entre a leitura de um serviço e a transação dele.
   */
  afterQuery:
    { matches: (collection: string, query?: DocumentQuery) => boolean; run: () => Promise<void> } | undefined;

  constructor(readonly inner: MemoryDocumentStore = new MemoryDocumentStore()) {}

  get(collection: string, id: string): Promise<DocumentData | undefined> {
    return this.inner.get(collection, id);
  }

  async query(collection: string, query?: DocumentQuery): Promise<StoredDocument[]> {
    this.queries.push(`${collection}?${JSON.stringify(query ?? {})}`);
    const result = await this.inner.query(collection, query);
    const hook = this.afterQuery;
    if (hook !== undefined && hook.matches(collection, query)) {
      this.afterQuery = undefined;
      await hook.run();
    }
    return result;
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
