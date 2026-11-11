import type { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { CheckoutStore } from '../src/checkout/checkout-store.js';
import { createFirestore, FirestoreDocumentStore } from '../src/firestore/firestore-document-store.js';
import { LegalTextStore } from '../src/legal/legal-store.js';
import { CostModelStore, PricingTableStore } from '../src/pricing/pricing-store.js';
import { QuoteStore } from '../src/pricing/quote-store.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { StripeEventStore } from '../src/webhook/stripe-event-store.js';
import { describeCheckoutStoreContract } from './support/checkout-store-contract.js';
import { describeDocumentStoreContract } from './support/document-store-contract.js';
import { FakeClock } from './support/fake-clock.js';
import { describeLegalStoreContract } from './support/legal-store-contract.js';
import { describePricingStoreContract } from './support/pricing-store-contract.js';
import { describeStripeEventStoreContract } from './support/stripe-event-store-contract.js';
import { describeTenantStoreContract } from './support/tenant-store-contract.js';

/**
 * Os contratos do `DocumentStore`, do `TenantStore`, do `CheckoutStore`, do `StripeEventStore`, dos repositórios do
 * preço configurável (tabelas, modelos de custo e cotações) e dos textos legais contra o emulador oficial do Firestore
 * (`scripts/firestore-emulator.sh start`; no CI, passo do job "Testes" em ci.yml). Sem `FIRESTORE_EMULATOR_HOST`
 * os testes são pulados na máquina de desenvolvimento, nunca no CI.
 */
const host = process.env['FIRESTORE_EMULATOR_HOST'];
if (host === undefined && process.env['CI']) {
  throw new Error(
    'FIRESTORE_EMULATOR_HOST não definida no CI: suba o emulador com apps/control-plane/scripts/firestore-emulator.sh',
  );
}

/** Projeto `demo-`: por convenção do emulador, nunca corresponde a um projeto real. */
const PROJECT_ID = 'demo-verax-cp-test';

async function clearDatabase(): Promise<void> {
  const response = await fetch(
    `http://${host}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw new Error(`o emulador não limpou o banco: HTTP ${response.status}`);
}

describe.skipIf(host === undefined)('Firestore (emulador oficial)', () => {
  let db: Firestore;

  beforeAll(() => {
    db = createFirestore({ FIRESTORE_DATABASE: '(default)', FIRESTORE_PROJECT_ID: PROJECT_ID });
  });

  afterAll(async () => {
    await db.terminate();
  });

  describeDocumentStoreContract('emulador', async () => {
    await clearDatabase();
    return new FirestoreDocumentStore(db);
  });

  describeTenantStoreContract('emulador', async () => {
    await clearDatabase();
    const documents = new FirestoreDocumentStore(db);
    const clock = new FakeClock();
    const audit = new AuditService(documents, clock);
    return { documents, clock, audit, store: new TenantStore(documents, clock, audit) };
  });

  describeStripeEventStoreContract('emulador', async () => {
    await clearDatabase();
    const documents = new FirestoreDocumentStore(db);
    const clock = new FakeClock();
    const audit = new AuditService(documents, clock);
    return {
      documents,
      clock,
      store: new StripeEventStore(documents, clock),
      tenants: new TenantStore(documents, clock, audit),
      checkouts: new CheckoutStore(documents, clock, audit),
    };
  });

  describeCheckoutStoreContract('emulador', async () => {
    await clearDatabase();
    const documents = new FirestoreDocumentStore(db);
    const clock = new FakeClock();
    const audit = new AuditService(documents, clock);
    return {
      documents,
      clock,
      audit,
      store: new CheckoutStore(documents, clock, audit),
      tenants: new TenantStore(documents, clock, audit),
    };
  });

  describePricingStoreContract('emulador', async () => {
    await clearDatabase();
    const documents = new FirestoreDocumentStore(db);
    const clock = new FakeClock();
    const audit = new AuditService(documents, clock);
    return {
      documents,
      clock,
      audit,
      tables: new PricingTableStore(documents, clock, audit),
      costs: new CostModelStore(documents, clock, audit),
      quotes: new QuoteStore(documents, clock),
    };
  });

  describeLegalStoreContract('emulador', async () => {
    await clearDatabase();
    const documents = new FirestoreDocumentStore(db);
    const clock = new FakeClock();
    const audit = new AuditService(documents, clock);
    return { documents, clock, audit, store: new LegalTextStore(documents, clock, audit) };
  });
});
