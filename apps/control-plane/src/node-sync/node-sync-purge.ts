import { COLLECTIONS, NODE_SYNC_COLLECTIONS } from '../firestore/collections.js';
import type { DocumentStore } from '../firestore/document-store.js';

/** Quantos documentos cada transação da limpeza apaga (bem abaixo do limite de tamanho do commit do Firestore). */
const PURGE_BATCH = 400;

/**
 * Apaga tudo da sincronização do nó de um cliente (`NODE_SYNC_COLLECTIONS`: o estado, o desejado, as fontes, os
 * usuários pedidos, os envelopes e os relatos), em lotes, até não sobrar nada. Repetir não dá erro: o que já saiu não
 * conta. Devolve quantos documentos saíram, por subcoleção (só as que tinham algum).
 */
export async function purgeNodeSync(store: DocumentStore, tenantId: string): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const name of NODE_SYNC_COLLECTIONS) {
    const collection = COLLECTIONS[name](tenantId);
    for (;;) {
      const docs = await store.query(collection, { limit: PURGE_BATCH });
      if (docs.length === 0) break;
      await store.runTransaction((tx) => {
        for (const doc of docs) tx.delete(collection, doc.id);
        return Promise.resolve();
      });
      deleted[name] = (deleted[name] ?? 0) + docs.length;
    }
  }
  return deleted;
}
