import { beforeEach, describe, expect, it } from 'vitest';
import {
  DocumentAlreadyExistsError,
  type DocumentStore,
  ReadAfterWriteError,
} from '../../src/firestore/document-store.js';

/**
 * Contrato do `DocumentStore`, rodado contra o dublê em memória e contra o emulador oficial do Firestore: o que
 * passa num tem de passar no outro, senão o dublê não serve para os testes unitários.
 */
export function describeDocumentStoreContract(name: string, factory: () => Promise<DocumentStore>): void {
  describe(`DocumentStore (${name})`, () => {
    let store: DocumentStore;

    beforeEach(async () => {
      store = await factory();
    });

    it('grava e lê o documento inteiro: Date volta como Date e undefined some', async () => {
      const at = new Date('2026-11-04T12:00:00.000Z');
      await store.runTransaction((tx) => {
        tx.set('tenants', 'a', {
          slug: 'cliente-demo-a',
          at,
          nested: { n: 1, missing: undefined },
          list: [1, 'x'],
        });
        return Promise.resolve();
      });

      const data = await store.get('tenants', 'a');
      expect(data).toEqual({ slug: 'cliente-demo-a', at, nested: { n: 1 }, list: [1, 'x'] });
      expect(data?.['at']).toBeInstanceOf(Date);
      expect(await store.get('tenants', 'b')).toBeUndefined();
    });

    it('create falha no commit quando o documento já existe, e nada da transação é gravado', async () => {
      await store.runTransaction((tx) => {
        tx.create('tenants', 'a', { v: 1 });
        return Promise.resolve();
      });

      await expect(
        store.runTransaction((tx) => {
          tx.create('tenants', 'a', { v: 2 });
          tx.set('tenants', 'b', { v: 1 });
          return Promise.resolve();
        }),
      ).rejects.toBeInstanceOf(DocumentAlreadyExistsError);

      expect(await store.get('tenants', 'a')).toEqual({ v: 1 });
      expect(await store.get('tenants', 'b')).toBeUndefined();
    });

    it('recusa leitura depois de escrita na mesma transação', async () => {
      await expect(
        store.runTransaction(async (tx) => {
          tx.set('tenants', 'a', { v: 1 });
          await tx.get('tenants', 'a');
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ReadAfterWriteError || /reads.*before.*writes/i.test((error as Error).message),
      );
    });

    it('uma transação que lança erro não grava nada', async () => {
      await expect(
        store.runTransaction((tx) => {
          tx.set('tenants', 'a', { v: 1 });
          return Promise.reject(new Error('desisti'));
        }),
      ).rejects.toThrow('desisti');
      expect(await store.get('tenants', 'a')).toBeUndefined();
    });

    it('consulta por igualdade, desigualdade, ordenação e limite; sem o campo, o documento fica fora', async () => {
      // `state` mais `billing.graceUntil`: a consulta do `tick` e um dos índices compostos declarados.
      const day = (n: number): Date => new Date(Date.UTC(2026, 10, n));
      const grace = (n: number): { graceUntil: Date } => ({ graceUntil: day(n) });
      await store.runTransaction((tx) => {
        tx.set('tenants', 'a', { state: 'active', billing: grace(1) });
        tx.set('tenants', 'b', { state: 'active', billing: grace(3) });
        tx.set('tenants', 'c', { state: 'active', billing: grace(2) });
        tx.set('tenants', 'd', { state: 'canceled', billing: grace(1) });
        tx.set('tenants', 'e', { state: 'active' });
        return Promise.resolve();
      });

      const active = await store.query('tenants', {
        where: [
          { field: 'state', op: '==', value: 'active' },
          { field: 'billing.graceUntil', op: '<=', value: day(2) },
        ],
        orderBy: { field: 'billing.graceUntil' },
      });
      expect(active.map((doc) => doc.id)).toEqual(['a', 'c']);

      const newest = await store.query('tenants', {
        orderBy: { field: 'billing.graceUntil', direction: 'desc' },
        limit: 1,
      });
      expect(newest.map((doc) => doc.id)).toEqual(['b']);

      const all = await store.query('tenants', { where: [{ field: 'state', op: '==', value: 'active' }] });
      expect(all.map((doc) => doc.id).sort()).toEqual(['a', 'b', 'c', 'e']);
    });

    it('== compara datas, arrays e objetos por valor; tipo diferente e campo ausente não casam', async () => {
      const at = new Date('2026-11-04T12:00:00.000Z');
      await store.runTransaction((tx) => {
        tx.set('counters', 'a', { at, list: [1, 'x'], map: { n: 1 }, n: 1 });
        tx.set('counters', 'b', { at: new Date(at.getTime() + 1), list: [1, 'x', 2], map: { n: 2 }, n: '1' });
        return Promise.resolve();
      });
      const ids = async (field: string, value: unknown): Promise<string[]> =>
        (await store.query('counters', { where: [{ field, op: '==', value }] })).map((doc) => doc.id);

      expect(await ids('at', new Date(at.getTime()))).toEqual(['a']);
      expect(await ids('list', [1, 'x'])).toEqual(['a']);
      expect(await ids('map', { n: 1 })).toEqual(['a']);
      expect(await ids('n', 1)).toEqual(['a']);
      expect(await ids('n', '1')).toEqual(['b']);
      expect(await ids('nada', null)).toEqual([]);
      expect(await ids('map.n', 2)).toEqual(['b']);
    });

    it('valor undefined numa condição é recusado (o SDK não aceita)', async () => {
      await expect(
        store.query('counters', { where: [{ field: 'n', op: '==', value: undefined }] }),
      ).rejects.toThrow();
    });

    it('empate na ordenação sai pelo id, na direção da ordenação', async () => {
      const at = new Date('2026-11-04T12:00:00.000Z');
      await store.runTransaction((tx) => {
        tx.set('tenants/t/transitions', 'b', { at });
        tx.set('tenants/t/transitions', 'a', { at });
        tx.set('tenants/t/transitions', 'c', { at: new Date(at.getTime() + 1) });
        return Promise.resolve();
      });
      const asc = await store.query('tenants/t/transitions', { orderBy: { field: 'at' } });
      expect(asc.map((doc) => doc.id)).toEqual(['a', 'b', 'c']);
      const desc = await store.query('tenants/t/transitions', {
        orderBy: { field: 'at', direction: 'desc' },
      });
      expect(desc.map((doc) => doc.id)).toEqual(['c', 'b', 'a']);
    });

    it('lê e consulta dentro da transação e separa subcoleções por caminho', async () => {
      await store.runTransaction((tx) => {
        tx.set('tenants/a/transitions', 't1', { to: 'pending' });
        tx.set('tenants/b/transitions', 't2', { to: 'active' });
        return Promise.resolve();
      });

      const seen = await store.runTransaction(async (tx) => ({
        doc: await tx.get('tenants/a/transitions', 't1'),
        a: await tx.query('tenants/a/transitions'),
        b: await tx.query('tenants/b/transitions'),
      }));
      expect(seen.doc).toEqual({ to: 'pending' });
      expect(seen.a.map((doc) => doc.id)).toEqual(['t1']);
      expect(seen.b.map((doc) => doc.id)).toEqual(['t2']);
    });

    it('duas transações concorrentes sobre o mesmo documento não perdem escrita', async () => {
      await store.runTransaction((tx) => {
        tx.set('counters', 'subnets', { next: 0 });
        return Promise.resolve();
      });
      const increment = (): Promise<number> =>
        store.runTransaction(async (tx) => {
          const current = (await tx.get('counters', 'subnets')) ?? { next: 0 };
          const next = (current['next'] as number) + 1;
          tx.set('counters', 'subnets', { next });
          return next;
        });

      const results = await Promise.all([increment(), increment(), increment()]);

      expect([...results].sort()).toEqual([1, 2, 3]);
      expect(await store.get('counters', 'subnets')).toEqual({ next: 3 });
    });

    it('ids novos são únicos e seguros para documento', () => {
      const ids = new Set(Array.from({ length: 50 }, () => store.newId()));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
    });
  });
}
