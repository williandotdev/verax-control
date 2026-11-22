import { describe, expect, it } from 'vitest';
import { COLLECTIONS, NODE_SYNC_COLLECTIONS } from '../firestore/collections.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import { purgeNodeSync } from './node-sync-purge.js';

const TENANT = '01JD0000000000000000000001';
const OTHER = '01JD0000000000000000000002';

async function seed(store: MemoryDocumentStore, tenantId: string, perCollection: number): Promise<void> {
  for (const name of NODE_SYNC_COLLECTIONS) {
    for (let start = 0; start < perCollection; start += 300) {
      await store.runTransaction((tx) => {
        for (let index = start; index < Math.min(perCollection, start + 300); index += 1) {
          tx.set(COLLECTIONS[name](tenantId), `doc-${index}`, { index });
        }
        return Promise.resolve();
      });
    }
  }
}

/** A limpeza da exclusão (`deletion.node_sync`): tudo da sincronização do cliente sai, em lotes, e só dele. */
describe('purgeNodeSync', () => {
  it('apaga as sete subcoleções do cliente, em mais de um lote, e não toca no outro cliente', async () => {
    const store = new MemoryDocumentStore();
    await seed(store, TENANT, 450);
    await seed(store, OTHER, 2);
    const deleted = await purgeNodeSync(store, TENANT);
    expect(deleted).toEqual(Object.fromEntries(NODE_SYNC_COLLECTIONS.map((name) => [name, 450])));
    for (const name of NODE_SYNC_COLLECTIONS) {
      expect(await store.query(COLLECTIONS[name](TENANT))).toEqual([]);
      expect(await store.query(COLLECTIONS[name](OTHER))).toHaveLength(2);
    }
    // Repetir não dá erro e não conta nada.
    expect(await purgeNodeSync(store, TENANT)).toEqual({});
  });
});
