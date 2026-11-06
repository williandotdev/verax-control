import { describeDirectTenantContract } from '../../test/support/direct-tenant-contract.js';
import { FakeClock } from '../../test/support/fake-clock.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';

// O mesmo contrato roda contra o emulador oficial em test/firestore-emulator-tenants.test.ts.
describeDirectTenantContract('memória', () =>
  Promise.resolve({ documents: new MemoryDocumentStore(), clock: new FakeClock() }),
);
