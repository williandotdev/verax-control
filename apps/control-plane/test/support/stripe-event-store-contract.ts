import { beforeEach, describe, expect, it } from 'vitest';
import type { CheckoutStore } from '../../src/checkout/checkout-store.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import type { TenantStore } from '../../src/tenants/tenant-store.js';
import {
  PROCESSING_LEASE_MS,
  STRIPE_EVENT_RETENTION_MS,
  type StripeEventStore,
} from '../../src/webhook/stripe-event-store.js';
import type { ReceivedEvent } from '../../src/webhook/stripe-events.js';
import { demoOrder } from './checkout-store-contract.js';
import { type FakeClock, MINUTE_MS } from './fake-clock.js';
import { demoTenant } from './tenant-store-contract.js';

export interface StripeEventStoreHarness {
  store: StripeEventStore;
  tenants: TenantStore;
  checkouts: CheckoutStore;
  clock: FakeClock;
  documents: DocumentStore;
}

let sequence = 0;

function received(overrides: Partial<ReceivedEvent> = {}): ReceivedEvent {
  sequence += 1;
  return {
    id: `evt_test_contrato_${sequence}`,
    type: 'invoice.paid',
    objectId: `in_fake_${sequence}`,
    livemode: false,
    created: new Date('2026-11-04T11:59:00.000Z'),
    ...overrides,
  };
}

/**
 * Contrato do `StripeEventStore` (idempotência do webhook, plano §4b, passo 2), rodado contra o dublê em memória e
 * contra o emulador oficial do Firestore.
 */
export function describeStripeEventStoreContract(
  name: string,
  factory: () => Promise<StripeEventStoreHarness>,
): void {
  describe(`StripeEventStore (${name})`, () => {
    let h: StripeEventStoreHarness;

    beforeEach(async () => {
      h = await factory();
    });

    it('a 1.ª entrega cria o registro em processing, com prazo de processamento e TTL de 90 dias', async () => {
      const event = received();
      const claim = await h.store.claim(event);

      expect(claim.status).toBe('claimed');
      expect(await h.documents.get(COLLECTIONS.stripeEvents, event.id)).toEqual({
        type: 'invoice.paid',
        objectId: event.objectId,
        livemode: false,
        eventCreatedAt: event.created,
        receivedAt: h.clock.now(),
        attempts: 1,
        outcome: 'processing',
        leaseUntil: new Date(h.clock.now().getTime() + PROCESSING_LEASE_MS),
        expiresAt: new Date(h.clock.now().getTime() + STRIPE_EVENT_RETENTION_MS),
      });
      expect(STRIPE_EVENT_RETENTION_MS).toBe(90 * 24 * 60 * MINUTE_MS);
    });

    it('desfecho final: a repetição é duplicata; em processamento, a outra entrega espera', async () => {
      const event = received();
      await h.store.claim(event);
      expect(await h.store.claim(event)).toEqual({ status: 'in_progress' });

      expect(await h.store.finish(event.id, 1, { outcome: 'applied', reason: 'invoice_paid' })).toBe(true);
      expect(await h.store.claim(event)).toEqual({ status: 'duplicate', outcome: 'applied' });
      expect(await h.store.get(event.id)).toMatchObject({
        outcome: 'applied',
        reason: 'invoice_paid',
        processedAt: h.clock.now(),
      });
      expect((await h.store.get(event.id))?.leaseUntil).toBeUndefined();
    });

    it('falha ou prazo vencido: a próxima entrega retoma com attempts + 1, e a vez antiga não grava mais', async () => {
      const event = received();
      await h.store.claim(event);
      await h.store.finish(event.id, 1, { outcome: 'failed', reason: 'stripe_error' });
      const retry = await h.store.claim(event);
      expect(retry.status === 'claimed' && retry.record.attempts).toBe(2);

      // A instância da vez 2 caiu: passado o prazo, a vez 3 retoma; a 2 não sobrescreve a 3.
      h.clock.advance(PROCESSING_LEASE_MS + 1);
      const third = await h.store.claim(event);
      expect(third.status === 'claimed' && third.record.attempts).toBe(3);
      expect(await h.store.finish(event.id, 2, { outcome: 'applied', reason: 'atrasada' })).toBe(false);
      expect(await h.store.finish(event.id, 3, { outcome: 'ignored', reason: 'nada' })).toBe(true);
      expect(await h.store.get(event.id)).toMatchObject({ outcome: 'ignored', attempts: 3 });
    });

    it('duas entregas simultâneas do mesmo evento: uma processa, a outra espera', async () => {
      const event = received();
      const results = await Promise.all([h.store.claim(event), h.store.claim(event)]);
      expect(results.map((result) => result.status).sort()).toEqual(['claimed', 'in_progress']);
    });

    it('adiar: reserva viva → deferred e listado; reserva sumida → ignored; cliente criado → tenant_exists', async () => {
      const reservation = await h.checkouts.reserve({ slug: 'cliente-demo-a', order: demoOrder() });
      const target = { tenantId: reservation.tenantId, slug: 'cliente-demo-a', reason: 'tenant_not_created' };

      const deferred = received({ created: new Date('2026-11-04T11:00:00.000Z') });
      await h.store.claim(deferred);
      expect(await h.store.defer(deferred.id, 1, target)).toBe('deferred');
      const older = received({ created: new Date('2026-11-04T10:00:00.000Z') });
      await h.store.claim(older);
      expect(await h.store.defer(older.id, 1, target)).toBe('deferred');
      expect((await h.store.listPending(reservation.tenantId)).map((record) => record.id)).toEqual([
        older.id,
        deferred.id,
      ]);
      expect(await h.store.get(deferred.id)).toMatchObject({
        outcome: 'deferred',
        tenantId: reservation.tenantId,
        slug: 'cliente-demo-a',
      });

      // O adiado é retomado pelo reprocessamento.
      const claim = await h.store.claimStored(deferred.id);
      expect(claim?.status === 'claimed' && claim.record.attempts).toBe(2);
      expect(await h.store.claimStored('evt_test_inexistente')).toBeUndefined();

      await h.checkouts.release(reservation, 'teste');
      const gone = received();
      await h.store.claim(gone);
      expect(await h.store.defer(gone.id, 1, target)).toBe('reservation_gone');
      expect(await h.store.get(gone.id)).toMatchObject({ outcome: 'ignored', reason: 'reservation_gone' });

      const created = await h.tenants.create(demoTenant('cliente-demo-b'), {
        reason: 'teste',
        audit: { actor: 'system' },
      });
      const late = received();
      await h.store.claim(late);
      expect(
        await h.store.defer(late.id, 1, { tenantId: created.id, slug: 'cliente-demo-b', reason: 'x' }),
      ).toBe('tenant_exists');
      expect((await h.store.get(late.id))?.outcome).toBe('processing');
    });

    it('adiar e criar o cliente ao mesmo tempo: ou o adiado fica listado, ou o adiamento vê o cliente', async () => {
      const reservation = await h.checkouts.reserve({ slug: 'cliente-demo-a', order: demoOrder() });
      const tenant = demoTenant('cliente-demo-a');
      const sessionId = tenant.consent?.checkoutSessionId ?? '';
      await h.checkouts.attachSession(reservation, {
        id: sessionId,
        livemode: false,
        expiresAt: new Date(h.clock.now().getTime() + 60 * MINUTE_MS),
      });
      const event = received();
      await h.store.claim(event);

      const [deferral] = await Promise.all([
        h.store.defer(event.id, 1, {
          tenantId: reservation.tenantId,
          slug: 'cliente-demo-a',
          reason: 'tenant_not_created',
        }),
        h.tenants.create(tenant, {
          reason: 'teste',
          audit: { actor: 'system' },
          tenantId: reservation.tenantId,
        }),
      ]);

      const pending = (await h.store.listPending(reservation.tenantId)).map((record) => record.id);
      expect(deferral === 'tenant_exists' ? pending : [deferral, pending]).toEqual(
        deferral === 'tenant_exists' ? [] : ['deferred', [event.id]],
      );
    });
  });
}
