import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/support/fake-clock.js';
import { describeLegalStoreContract } from '../../test/support/legal-store-contract.js';
import { AuditService } from '../audit/audit.service.js';
import { COLLECTIONS } from '../firestore/collections.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import { LegalTextStore } from './legal-store.js';
import { legalContentSchema, type LegalKind } from './legal.schema.js';

// O mesmo contrato roda contra o emulador oficial em test/firestore-emulator.test.ts.
describeLegalStoreContract('memória', () => {
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock();
  const audit = new AuditService(documents, clock);
  return Promise.resolve({ documents, clock, audit, store: new LegalTextStore(documents, clock, audit) });
});

describe('textos legais: forma', () => {
  it('uma subcoleção por texto; um tipo desconhecido não monta caminho', () => {
    expect(COLLECTIONS.legalVersions('terms')).toBe('legalTexts/terms/versions');
    expect(COLLECTIONS.legalVersions('dpa')).toBe('legalTexts/dpa/versions');
    expect(() => COLLECTIONS.legalVersions('../tenants' as LegalKind)).toThrow(TypeError);
  });

  it('o texto aceita Markdown com acento, tabulação e emoji; recusa caractere de controle', () => {
    expect(legalContentSchema.parse('# Título\r\n\n- item\tcom ç e ✓')).toBe('# Título\n\n- item\tcom ç e ✓');
    expect(legalContentSchema.safeParse('a\u0007b').success).toBe(false);
    expect(legalContentSchema.safeParse('a\u007fb').success).toBe(false);
  });
});
