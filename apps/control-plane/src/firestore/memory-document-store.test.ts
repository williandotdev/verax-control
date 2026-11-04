import { describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { describeDocumentStoreContract } from '../../test/support/document-store-contract.js';
import { FakeClock } from '../../test/support/fake-clock.js';
import { describeTenantStoreContract } from '../../test/support/tenant-store-contract.js';
import { MemoryDocumentStore } from './memory-document-store.js';

// Os mesmos contratos rodam contra o emulador oficial em test/firestore-emulator.test.ts.
describeDocumentStoreContract('memória', () => Promise.resolve(new MemoryDocumentStore()));

describeTenantStoreContract('memória', () => {
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock();
  const audit = new AuditService(documents, clock);
  return Promise.resolve({ documents, clock, audit, store: new TenantStore(documents, clock, audit) });
});

describe('MemoryDocumentStore (só o dublê)', () => {
  it('recusa valores que o Firestore não aceita (instâncias de classe, funções)', async () => {
    const store = new MemoryDocumentStore();
    class Custom {}
    await expect(
      store.runTransaction((tx) => {
        tx.set('tenants', 'a', { custom: new Custom() });
        return Promise.resolve();
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.runTransaction((tx) => {
        tx.set('tenants', 'a', { fn: () => 1 });
        return Promise.resolve();
      }),
    ).rejects.toThrow(TypeError);
  });

  it('recusa caminho de coleção par e id com barra', async () => {
    const store = new MemoryDocumentStore();
    // A validação do caminho é síncrona, antes de qualquer leitura.
    expect(() => store.get('tenants/a', 'x')).toThrow(TypeError);
    expect(() => store.get('tenants', 'a/b')).toThrow(TypeError);
    await expect(store.get('tenants', 'a')).resolves.toBeUndefined();
  });

  it('clear apaga tudo', async () => {
    const store = new MemoryDocumentStore();
    await store.runTransaction((tx) => {
      tx.set('tenants', 'a', { v: 1 });
      return Promise.resolve();
    });
    store.clear();
    expect(await store.get('tenants', 'a')).toBeUndefined();
  });
});
