import { AuditService } from '../audit/audit.service.js';
import { CheckoutStore } from '../checkout/checkout-store.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { FakeClock } from '../../test/support/fake-clock.js';
import { describeStripeEventStoreContract } from '../../test/support/stripe-event-store-contract.js';
import { StripeEventStore } from './stripe-event-store.js';

// O mesmo contrato roda contra o emulador oficial em test/firestore-emulator.test.ts.
describeStripeEventStoreContract('memória', () => {
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock();
  const audit = new AuditService(documents, clock);
  return Promise.resolve({
    documents,
    clock,
    store: new StripeEventStore(documents, clock),
    tenants: new TenantStore(documents, clock, audit),
    checkouts: new CheckoutStore(documents, clock, audit),
  });
});
