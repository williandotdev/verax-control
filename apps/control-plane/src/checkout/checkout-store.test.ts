import { AuditService } from '../audit/audit.service.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { describeCheckoutStoreContract } from '../../test/support/checkout-store-contract.js';
import { FakeClock } from '../../test/support/fake-clock.js';
import { CheckoutStore } from './checkout-store.js';

// O mesmo contrato roda contra o emulador oficial em test/firestore-emulator.test.ts.
describeCheckoutStoreContract('memória', () => {
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock();
  const audit = new AuditService(documents, clock);
  return Promise.resolve({
    documents,
    clock,
    audit,
    store: new CheckoutStore(documents, clock, audit),
    tenants: new TenantStore(documents, clock, audit),
  });
});
