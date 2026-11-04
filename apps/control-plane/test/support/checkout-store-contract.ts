import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditService } from '../../src/audit/audit.service.js';
import {
  CHECKOUT_DAILY_LIMIT,
  checkoutDailyBucket,
  type CheckoutStore,
  DailyLimitReachedError,
  ReservationLostError,
  SLUG_RESERVATION_MS,
  SlugUnavailableError,
} from '../../src/checkout/checkout-store.js';
import { ULID_PATTERN } from '../../src/common/ulid.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import type { TenantStore } from '../../src/tenants/tenant-store.js';
import type { SlugOrder } from '../../src/tenants/tenant.schema.js';
import { type FakeClock, MINUTE_MS } from './fake-clock.js';
import { demoTenant } from './tenant-store-contract.js';

export interface CheckoutStoreHarness {
  store: CheckoutStore;
  tenants: TenantStore;
  audit: AuditService;
  clock: FakeClock;
  documents: DocumentStore;
}

/** Pedido fictício (CLAUDE.md, regra 10): CNPJ alfanumérico do exemplo da Receita, e-mail em domínio `.example`. */
export function demoOrder(slug = 'cliente-demo-a'): SlugOrder {
  return {
    plan: 'essencial',
    company: { legalName: `Cliente Demo ${slug.slice(-1).toUpperCase()} Ltda`, cnpj: '12ABC34501DE35' },
    adminEmail: `admin@${slug}.example`,
    consent: { termsVersion: '2026-11-04', privacyVersion: '2026-11-04', dpaVersion: '2026-11-04' },
  };
}

const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Contrato do `CheckoutStore` (reserva de subdomínio e teto diário), rodado contra o dublê em memória e contra o
 * emulador oficial do Firestore.
 */
export function describeCheckoutStoreContract(
  name: string,
  factory: () => Promise<CheckoutStoreHarness>,
): void {
  describe(`CheckoutStore (${name})`, () => {
    let h: CheckoutStoreHarness;

    beforeEach(async () => {
      h = await factory();
    });

    async function counter(): Promise<unknown> {
      return (await h.documents.get(COLLECTIONS.rateLimits, checkoutDailyBucket(h.clock.now()).id))?.[
        'count'
      ];
    }

    it('reserva por 2 h 30 com um tenantId novo e o pedido, conta no teto do dia e audita sem dado pessoal', async () => {
      const reservation = await h.store.reserve({
        slug: 'cliente-demo-a',
        order: demoOrder(),
        requestId: 'req-demo-0001',
      });

      expect(reservation.tenantId).toMatch(ULID_PATTERN);
      expect(reservation.expiresAt).toEqual(new Date(h.clock.now().getTime() + SLUG_RESERVATION_MS));
      expect(await h.documents.get(COLLECTIONS.slugs, 'cliente-demo-a')).toEqual({
        state: 'reserved',
        tenantId: reservation.tenantId,
        order: demoOrder(),
        updatedAt: h.clock.now(),
        expiresAt: reservation.expiresAt,
      });
      const bucket = checkoutDailyBucket(h.clock.now());
      expect(await h.documents.get(COLLECTIONS.rateLimits, bucket.id)).toEqual({
        count: 1,
        expiresAt: bucket.endsAt,
      });
      expect(bucket).toEqual({
        id: 'checkout-sessions-2026-11-04',
        day: '2026-11-04',
        endsAt: new Date('2026-11-05T00:00:00.000Z'),
      });

      const audit = await h.audit.listForTenant(reservation.tenantId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor: 'system',
        action: 'checkout.slug_reserved',
        requestId: 'req-demo-0001',
        details: { slug: 'cliente-demo-a', plan: 'essencial', expiresAt: reservation.expiresAt },
      });
      const raw = JSON.stringify(await h.documents.query(COLLECTIONS.auditLog));
      for (const personal of ['admin@cliente-demo-a.example', '12ABC34501DE35', 'Cliente Demo']) {
        expect(raw).not.toContain(personal);
      }
    });

    it('o mesmo subdomínio duas vezes: a segunda é recusada e não consome o teto', async () => {
      const first = await h.store.reserve({ slug: 'cliente-demo-a', order: demoOrder() });
      h.clock.advance(MINUTE_MS);

      await expect(h.store.reserve({ slug: 'cliente-demo-a', order: demoOrder() })).rejects.toBeInstanceOf(
        SlugUnavailableError,
      );

      expect((await h.documents.get(COLLECTIONS.slugs, 'cliente-demo-a'))?.['tenantId']).toBe(first.tenantId);
      expect(await counter()).toBe(1);
      expect(await h.documents.query(COLLECTIONS.auditLog)).toHaveLength(1);
    });

    it('duas reservas simultâneas do mesmo subdomínio: só uma fica, a outra recebe SlugUnavailableError', async () => {
      const results = await Promise.allSettled([
        h.store.reserve({ slug: 'cliente-demo-a', order: demoOrder() }),
        h.store.reserve({ slug: 'cliente-demo-a', order: demoOrder() }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const winner = results.find((result) => result.status === 'fulfilled');
      const loser = results.find((result) => result.status === 'rejected');
      expect(loser?.reason).toBeInstanceOf(SlugUnavailableError);
      expect((await h.documents.get(COLLECTIONS.slugs, 'cliente-demo-a'))?.['tenantId']).toBe(
        winner?.value.tenantId,
      );
      expect(await counter()).toBe(1);
    });

    it('reserva vencida e reserva liberada voltam a aceitar; slug tomado por cliente, nunca', async () => {
      const old = await h.store.reserve({ slug: 'cliente-demo-a', order: demoOrder() });
      h.clock.advance(SLUG_RESERVATION_MS - 1);
      expect(await h.store.isSlugAvailable('cliente-demo-a')).toBe(false);
      h.clock.advance(1);
      expect(await h.store.isSlugAvailable('cliente-demo-a')).toBe(true);
      const renewed = await h.store.reserve({ slug: 'cliente-demo-a', order: demoOrder() });
      expect(renewed.tenantId).not.toBe(old.tenantId);

      const released = await h.store.reserve({ slug: 'cliente-demo-b', order: demoOrder('cliente-demo-b') });
      expect(await h.store.release(released, 'stripe_error')).toBe(true);
      expect(await h.store.isSlugAvailable('cliente-demo-b')).toBe(true);
      await h.store.reserve({ slug: 'cliente-demo-b', order: demoOrder('cliente-demo-b') });

      await h.tenants.create(demoTenant('cliente-demo-c'), { reason: 'teste', audit: { actor: 'system' } });
      expect(await h.store.isSlugAvailable('cliente-demo-c')).toBe(false);
      h.clock.advance(365 * DAY_MS);
      expect(await h.store.isSlugAvailable('cliente-demo-c')).toBe(false);
      await expect(
        h.store.reserve({ slug: 'cliente-demo-c', order: demoOrder('cliente-demo-c') }),
      ).rejects.toBeInstanceOf(SlugUnavailableError);
    });

    it('consulta: fora do formato e da lista reservada é indisponível, sem tocar o banco', async () => {
      for (const slug of [
        'verax',
        'api',
        'www',
        'conta',
        'control',
        'demo',
        'status',
        'admin',
        'mail',
        'suporte',
      ]) {
        expect(await h.store.isSlugAvailable(slug), slug).toBe(false);
        await expect(h.store.reserve({ slug, order: demoOrder() })).rejects.toBeInstanceOf(
          SlugUnavailableError,
        );
      }
      for (const slug of [
        'a',
        'ab',
        'Cliente',
        '1cliente',
        'cliente-',
        'cliente_demo',
        'a'.repeat(17),
        'x/y',
      ]) {
        expect(await h.store.isSlugAvailable(slug), slug).toBe(false);
      }
      expect(await h.store.isSlugAvailable('abc')).toBe(true);
      expect(await h.store.isSlugAvailable('a'.repeat(16))).toBe(true);
      expect(await counter()).toBeUndefined();
    });

    it(`teto diário: com ${CHECKOUT_DAILY_LIMIT - 1} no dia, três ao mesmo tempo dão uma reserva e duas recusas`, async () => {
      const bucket = checkoutDailyBucket(h.clock.now());
      await h.documents.runTransaction((tx) => {
        tx.set(COLLECTIONS.rateLimits, bucket.id, {
          count: CHECKOUT_DAILY_LIMIT - 1,
          expiresAt: bucket.endsAt,
        });
        return Promise.resolve();
      });

      const results = await Promise.allSettled(
        ['teto-a', 'teto-b', 'teto-c'].map((slug) => h.store.reserve({ slug, order: demoOrder(slug) })),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const refusals = results.filter((result) => result.status === 'rejected');
      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) {
        expect(refusal.reason).toBeInstanceOf(DailyLimitReachedError);
        expect(refusal.reason).toMatchObject({
          limit: CHECKOUT_DAILY_LIMIT,
          day: '2026-11-04',
          resetsAt: bucket.endsAt,
        });
      }
      expect(await counter()).toBe(CHECKOUT_DAILY_LIMIT);
      const reserved = await h.documents.query(COLLECTIONS.slugs);
      expect(reserved).toHaveLength(1);

      // No dia seguinte (UTC), o balde é outro.
      h.clock.set(new Date('2026-11-05T00:00:00.000Z'));
      const next = await h.store.reserve({ slug: 'teto-d', order: demoOrder('teto-d') });
      expect(next.slug).toBe('teto-d');
      expect(await counter()).toBe(1);
    });

    it('grava a sessão na reserva e audita a criação; reserva que não é mais deste checkout é recusada', async () => {
      const reservation = await h.store.reserve({ slug: 'cliente-demo-a', order: demoOrder() });
      const sessionExpiresAt = new Date(h.clock.now().getTime() + 120 * MINUTE_MS);

      await h.store.attachSession(
        reservation,
        { id: 'cs_test_demo_a', livemode: false, expiresAt: sessionExpiresAt },
        'req-demo-0002',
      );

      expect(await h.documents.get(COLLECTIONS.slugs, 'cliente-demo-a')).toMatchObject({
        state: 'reserved',
        tenantId: reservation.tenantId,
        checkoutSessionId: 'cs_test_demo_a',
        expiresAt: reservation.expiresAt,
      });
      const audit = await h.audit.listForTenant(reservation.tenantId);
      expect(audit.map((entry) => entry.action)).toEqual([
        'checkout.slug_reserved',
        'checkout.session_created',
      ]);
      expect(audit[1]?.details).toEqual({
        slug: 'cliente-demo-a',
        plan: 'essencial',
        livemode: false,
        sessionExpiresAt,
      });

      const other = { ...reservation, tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };
      await expect(
        h.store.attachSession(other, { id: 'cs_test_outro', livemode: false, expiresAt: sessionExpiresAt }),
      ).rejects.toBeInstanceOf(ReservationLostError);
      expect(await h.store.release(other, 'stripe_error')).toBe(false);
      expect((await h.documents.get(COLLECTIONS.slugs, 'cliente-demo-a'))?.['checkoutSessionId']).toBe(
        'cs_test_demo_a',
      );
    });

    it('liberar tira o pedido e o prazo, audita, e o cliente pode ser criado sobre o slug liberado', async () => {
      const reservation = await h.store.reserve({ slug: 'cliente-demo-a', order: demoOrder() });
      h.clock.advance(MINUTE_MS);

      expect(await h.store.release(reservation, 'stripe_error', 'req-demo-0003')).toBe(true);

      expect(await h.documents.get(COLLECTIONS.slugs, 'cliente-demo-a')).toEqual({
        state: 'released',
        tenantId: reservation.tenantId,
        updatedAt: h.clock.now(),
      });
      const audit = await h.audit.listForTenant(reservation.tenantId);
      expect(audit.at(-1)).toMatchObject({
        action: 'checkout.slug_released',
        details: { slug: 'cliente-demo-a', reason: 'stripe_error' },
        requestId: 'req-demo-0003',
      });
      // Segunda liberação: a reserva já não está lá.
      expect(await h.store.release(reservation, 'stripe_error')).toBe(false);

      const created = await h.tenants.create(demoTenant(), { reason: 'teste', audit: { actor: 'system' } });
      expect((await h.tenants.getSlug('cliente-demo-a'))?.tenantId).toBe(created.id);
    });
  });
}
