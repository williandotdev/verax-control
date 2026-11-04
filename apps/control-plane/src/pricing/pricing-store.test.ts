import { describe, expect, it } from 'vitest';
import { describePricingStoreContract } from '../../test/support/pricing-store-contract.js';
import { FakeClock } from '../../test/support/fake-clock.js';
import { AuditService } from '../audit/audit.service.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import { contentChanges, CostModelStore, PricingTableStore } from './pricing-store.js';
import { QuoteStore } from './quote-store.js';

// O mesmo contrato roda contra o emulador oficial em test/firestore-emulator.test.ts.
describePricingStoreContract('memória', () => {
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock();
  const audit = new AuditService(documents, clock);
  return Promise.resolve({
    documents,
    clock,
    audit,
    tables: new PricingTableStore(documents, clock, audit),
    costs: new CostModelStore(documents, clock, audit),
    quotes: new QuoteStore(documents, clock),
  });
});

describe('diferença entre duas versões (auditoria da edição)', () => {
  it('folha a folha, com o caminho; arrays por posição; campos novos e removidos', () => {
    expect(
      contentChanges(
        { a: 1, b: { c: 'x', d: [1, 2] }, e: true },
        { a: 1, b: { c: 'y', d: [1, 3, 4] }, f: null },
      ),
    ).toEqual([
      { path: 'b.c', before: 'x', after: 'y' },
      { path: 'b.d.1', before: 2, after: 3 },
      { path: 'b.d.2', before: undefined, after: 4 },
      { path: 'e', before: true, after: undefined },
      { path: 'f', before: undefined, after: null },
    ]);
    expect(contentChanges({ a: [1] }, { a: [1] })).toEqual([]);
  });
});
