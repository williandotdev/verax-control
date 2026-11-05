import type { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe } from 'vitest';
import { createFirestore, FirestoreDocumentStore } from '../src/firestore/firestore-document-store.js';
import { describeDirectTenantContract } from './support/direct-tenant-contract.js';
import { FakeClock } from './support/fake-clock.js';

/**
 * O cadastro de um cliente de contrato direto pelo console (criação, idempotência, recusas, auditoria, lista, detalhe e
 * as operações) contra o emulador oficial do Firestore, num projeto `demo-` só dele: os arquivos de teste rodam em
 * paralelo, e a limpeza do banco de um não apaga o do outro. Sem `FIRESTORE_EMULATOR_HOST` os testes são pulados na
 * máquina de desenvolvimento, nunca no CI.
 */
const host = process.env['FIRESTORE_EMULATOR_HOST'];
if (host === undefined && process.env['CI']) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST não definida no CI: suba o emulador com apps/control-plane/scripts/firestore-emulator.sh',
  );
}

const PROJECT_ID = 'demo-verax-cp-tenants';

async function clearDatabase(): Promise<void> {
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error(`o emulador não limpou o banco: HTTP ${response.status}`);
}

describe.skipIf(host === undefined)('Firestore (emulador oficial): clientes no console', () => {
  let db: Firestore;

  beforeAll(() => {
    db = createFirestore({ FIRESTORE_DATABASE: '(default)', FIRESTORE_PROJECT_ID: PROJECT_ID });
  });

  afterAll(async () => {
    await db.terminate();
  });

  describeDirectTenantContract('emulador', async () => {
    await clearDatabase();
    return { documents: new FirestoreDocumentStore(db), clock: new FakeClock() };
  });
});
