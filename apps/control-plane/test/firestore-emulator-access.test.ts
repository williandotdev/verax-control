import type { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe } from 'vitest';
import { AccessStore } from '../src/access/access-store.js';
import { AuditService } from '../src/audit/audit.service.js';
import { createFirestore, FirestoreDocumentStore } from '../src/firestore/firestore-document-store.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { describeAccessStoreContract } from './support/access-store-contract.js';
import { FakeClock } from './support/fake-clock.js';

/**
 * O contrato do `AccessStore` (`statusTokens` e `tenants.access`, CP-05) contra o emulador oficial do Firestore, num
 * projeto `demo-` só dele: os arquivos de teste rodam em paralelo, e a limpeza do banco de um não apaga o do outro
 * (`firestore-emulator.test.ts` usa outro projeto). Sem `FIRESTORE_EMULATOR_HOST` os testes são pulados na máquina de
 * desenvolvimento, nunca no CI.
 */
const host = process.env['FIRESTORE_EMULATOR_HOST'];
if (host === undefined && process.env['CI']) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST não definida no CI: suba o emulador com apps/control-plane/scripts/firestore-emulator.sh',
  );
}

const PROJECT_ID = 'demo-verax-cp-access';

async function clearDatabase(): Promise<void> {
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error(`o emulador não limpou o banco: HTTP ${response.status}`);
}

describe.skipIf(host === undefined)('Firestore (emulador oficial): acesso do cliente', () => {
  let db: Firestore;

  beforeAll(() => {
    db = createFirestore({ FIRESTORE_DATABASE: '(default)', FIRESTORE_PROJECT_ID: PROJECT_ID });
  });

  afterAll(async () => {
    await db.terminate();
  });

  describeAccessStoreContract('emulador', async () => {
    await clearDatabase();
    const documents = new FirestoreDocumentStore(db);
    const clock = new FakeClock();
    const audit = new AuditService(documents, clock);
    return {
      documents,
      clock,
      audit,
      tenants: new TenantStore(documents, clock, audit),
      access: new AccessStore(documents, clock, audit),
    };
  });
});
