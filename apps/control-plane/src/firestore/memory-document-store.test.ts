import { describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { describeDocumentStoreContract } from '../../test/support/document-store-contract.js';
import { FakeClock } from '../../test/support/fake-clock.js';
import { describeTenantStoreContract } from '../../test/support/tenant-store-contract.js';
import { NestedTransactionError } from './document-store.js';
import {
  MemoryDocumentStore,
  MissingCompositeIndexError,
  UnsupportedQueryError,
} from './memory-document-store.js';

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

  it('transação aninhada é recusada na hora, em vez de esperar a fila para sempre', async () => {
    const store = new MemoryDocumentStore();
    const audit = new AuditService(store, new FakeClock());
    await expect(
      store.runTransaction(async (tx) => {
        tx.set('tenants', 'a', { v: 1 });
        // O erro clássico: gravar a auditoria por fora da transação que está mudando o estado.
        await audit.write({ actor: 'system', action: 'teste.aninhado' });
      }),
    ).rejects.toBeInstanceOf(NestedTransactionError);
    // A externa abortou: nada foi gravado, e a fila continua servindo.
    expect(await store.get('tenants', 'a')).toBeUndefined();
    await expect(audit.write({ actor: 'system', action: 'teste.solto' })).resolves.toBeUndefined();
    // Transações em sequência (uma depois da outra) não são aninhadas.
    await store.runTransaction((tx) => {
      tx.set('tenants', 'b', { v: 2 });
      return Promise.resolve();
    });
    expect(await store.get('tenants', 'b')).toEqual({ v: 2 });
  });

  it('consulta que em produção exigiria índice composto não declarado é recusada', async () => {
    const store = new MemoryDocumentStore();
    const tenantId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const equalState = { field: 'state', op: '==' as const, value: 'active' };
    // Declarado em COMPOSITE_INDEXES (e no firestore.tf): passa.
    await expect(
      store.query('tenants', {
        where: [equalState, { field: 'billing.graceUntil', op: '<=', value: new Date() }],
        orderBy: { field: 'billing.graceUntil' },
      }),
    ).resolves.toEqual([]);
    await expect(
      store.query('tenants', { where: [equalState], orderBy: { field: 'stateUpdatedAt' } }),
    ).resolves.toEqual([]);
    // Igualdade mais ordenação (ou desigualdade) noutro campo sem índice declarado: recusada.
    await expect(
      store.query('tenants', { where: [equalState], orderBy: { field: 'updatedAt' } }),
    ).rejects.toBeInstanceOf(MissingCompositeIndexError);
    await expect(
      store.query('tenants', { where: [equalState, { field: 'updatedAt', op: '>', value: new Date() }] }),
    ).rejects.toMatchObject({ name: 'MissingCompositeIndexError', fields: ['state', 'updatedAt'] });
    // O grupo da subcoleção é o último segmento do caminho.
    await expect(
      store.query(`tenants/${tenantId}/transitions`, {
        where: [{ field: 'to', op: '==', value: 'active' }],
        orderBy: { field: 'at' },
      }),
    ).rejects.toBeInstanceOf(MissingCompositeIndexError);
    // Desigualdade num campo e ordenação noutro também pede índice.
    await expect(
      store.query('tenants', {
        where: [{ field: 'billing.graceUntil', op: '<=', value: new Date() }],
        orderBy: { field: 'state' },
      }),
    ).rejects.toBeInstanceOf(MissingCompositeIndexError);
    // Só igualdades, ou um campo só: índices de campo único bastam.
    await expect(
      store.query('tenants', { where: [equalState, { field: 'plan', op: '==', value: 'essencial' }] }),
    ).resolves.toEqual([]);
    await expect(store.query('tenants', { orderBy: { field: 'updatedAt' } })).resolves.toEqual([]);
    // A lista de índices é injetável (um dublê sem nenhum recusa até o índice do tick).
    const bare = new MemoryDocumentStore({ indexes: [] });
    await expect(
      bare.query('tenants', { where: [equalState], orderBy: { field: 'stateUpdatedAt' } }),
    ).rejects.toBeInstanceOf(MissingCompositeIndexError);
  });

  it('desigualdade sobre array ou objeto não é reproduzida pelo dublê: recusa em vez de divergir', async () => {
    const store = new MemoryDocumentStore();
    await expect(
      store.query('counters', { where: [{ field: 'list', op: '<', value: [2] }] }),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);
    await expect(
      store.query('counters', { where: [{ field: 'map', op: '>=', value: { n: 1 } }] }),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);
    await expect(
      store.query('counters', { where: [{ field: 'n', op: '==', value: undefined }] }),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);
  });

  it('campo que só existe no protótipo (constructor, __proto__, toString) conta como ausente', async () => {
    const store = new MemoryDocumentStore();
    await store.runTransaction((tx) => {
      tx.set('counters', 'a', { n: 1, map: { k: 1 } });
      return Promise.resolve();
    });
    // Sem o `Object.hasOwn`, `__proto__` resolvia para `Object.prototype` (igual a `{}` por valor) e `toString`
    // para a função herdada: a condição casava e a ordenação incluía o documento; no Firestore, nenhum dos dois.
    for (const field of ['constructor', '__proto__', 'toString', 'map.__proto__', 'map.hasOwnProperty']) {
      await expect(store.query('counters', { where: [{ field, op: '==', value: {} }] })).resolves.toEqual([]);
      await expect(store.query('counters', { orderBy: { field } })).resolves.toEqual([]);
    }
    // O campo próprio aninhado continua acessível pelo mesmo caminho.
    const own = await store.query('counters', { where: [{ field: 'map.k', op: '==', value: 1 }] });
    expect(own.map((doc) => doc.id)).toEqual(['a']);
  });

  it('ids novos sorteiam o alfabeto inteiro sem viés (randomInt, não o resto de um byte por 62)', () => {
    const store = new MemoryDocumentStore();
    const ids = 5_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < ids; i += 1) {
      for (const char of store.newId()) counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    const expected = (ids * 20) / 62;
    // Com `byte % 62`, os oito primeiros caracteres (5/256 contra 4/256) sairiam 21% acima do esperado, mais de
    // 8 desvios; 6 desvios (±239 em 100 mil sorteios) separa isso do acaso (uma falha espúria a cada ~10 milhões
    // de execuções).
    const tolerance = 6 * Math.sqrt(expected * (1 - 1 / 62));
    expect(counts.size).toBe(62);
    for (const [char, count] of counts) {
      expect(Math.abs(count - expected), `caractere ${char}`).toBeLessThanOrEqual(tolerance);
    }
  });

  it('sem orderBy, a desigualdade ordena pelo próprio campo e depois pelo id, como no Firestore', async () => {
    const store = new MemoryDocumentStore();
    await store.runTransaction((tx) => {
      tx.set('counters', 'b', { n: 2 });
      tx.set('counters', 'a', { n: 3 });
      tx.set('counters', 'c', { n: 2 });
      tx.set('counters', 'd', { n: 1 });
      return Promise.resolve();
    });
    const docs = await store.query('counters', { where: [{ field: 'n', op: '>=', value: 2 }] });
    expect(docs.map((doc) => doc.id)).toEqual(['b', 'c', 'a']);
  });
});
