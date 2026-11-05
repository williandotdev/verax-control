import { describeAccessStoreContract } from '../../test/support/access-store-contract.js';
import { FakeClock } from '../../test/support/fake-clock.js';
import { AuditService } from '../audit/audit.service.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { AccessStore } from './access-store.js';

// O mesmo contrato roda contra o emulador oficial em test/firestore-emulator-access.test.ts.
describeAccessStoreContract('memória', () => {
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock();
  const audit = new AuditService(documents, clock);
  return Promise.resolve({
    documents,
    clock,
    audit,
    tenants: new TenantStore(documents, clock, audit),
    access: new AccessStore(documents, clock, audit),
  });
});
