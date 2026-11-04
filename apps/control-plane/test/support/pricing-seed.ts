import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import { priceTableDocumentSchema } from '../../src/pricing/pricing-store.js';
import { lookupKeysOf, type PriceTableInput, priceTableSchema } from '../../src/pricing/pricing.schema.js';
import type { FakeStripe } from './fake-stripe.js';

/**
 * Grava uma tabela de preços já publicada direto no banco (sem auditoria, para não misturar com a do teste), vigente
 * desde `effectiveFrom`. Os testes do console publicam pela API; os do site e do checkout só precisam de uma vigente.
 */
export async function seedPublishedTable(
  documents: DocumentStore,
  content: PriceTableInput,
  options: { version?: string; effectiveFrom: Date },
): Promise<void> {
  const at = options.effectiveFrom;
  const document = priceTableDocumentSchema.parse({
    status: 'published',
    content,
    effectiveFrom: at,
    publishedAt: at,
    publishedBy: 'responsavel@verax.example',
    createdAt: at,
    createdBy: 'responsavel@verax.example',
    updatedAt: at,
    updatedBy: 'responsavel@verax.example',
  });
  await documents.runTransaction((tx) => {
    tx.set(COLLECTIONS.pricingTables, options.version ?? 'teste-v1', { ...document });
    return Promise.resolve();
  });
}

/**
 * Cria na Stripe falsa um preço para cada `lookup_key` da tabela, como o `stripe-setup` os criaria: mensal em BRL, ou
 * avulso na implantação. Devolve o id do preço de cada `lookup_key`.
 */
export function seedStripePrices(fake: FakeStripe, content: PriceTableInput): Map<string, string> {
  const ids = new Map<string, string>();
  for (const entry of lookupKeysOf(priceTableSchema.parse(content))) {
    const price = fake.addPrice(
      entry.lookupKey,
      entry.amount,
      entry.recurring ? {} : { type: 'one_time', recurring: null },
    );
    ids.set(entry.lookupKey, String(price['id']));
  }
  return ids;
}
