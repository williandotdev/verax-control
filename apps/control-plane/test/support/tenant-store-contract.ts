import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditService } from '../../src/audit/audit.service.js';
import { REDACTED } from '../../src/common/logger/sanitize.js';
import { ULID_PATTERN } from '../../src/common/ulid.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import { type DocumentStore, DocumentValidationError } from '../../src/firestore/document-store.js';
import {
  InvalidTransitionError,
  LockHeldError,
  LockNotHeldError,
  type NewTenant,
  TenantNotFoundError,
  type TenantStore,
} from '../../src/tenants/tenant-store.js';
import type { FakeClock } from './fake-clock.js';
import { MINUTE_MS } from './fake-clock.js';

export interface TenantStoreHarness {
  store: TenantStore;
  audit: AuditService;
  clock: FakeClock;
  documents: DocumentStore;
}

/** Cliente fictício (CLAUDE.md, regra 10): CNPJ sintético com dígitos verificadores válidos. */
export function demoTenant(slug = 'cliente-demo-a', cnpj = '11222333000181'): NewTenant {
  return {
    slug,
    plan: 'essencial',
    company: { legalName: `${slug} Ltda`, cnpj },
    adminEmail: `admin@${slug}.example`,
    consent: {
      termsVersion: '2026-11-04',
      privacyVersion: '2026-11-04',
      dpaVersion: '2026-11-04',
      acceptedAt: new Date('2026-11-04T11:59:00.000Z'),
      checkoutSessionId: 'cs_test_demo_a',
    },
    stripe: { customerId: 'cus_demo_a', livemode: false },
  };
}

const AUDIT = { actor: 'stripe:evt_demo_1', requestId: 'req-demo-00001' };
const LOCK_TTL_MS = 20 * MINUTE_MS;

/** Segredos marcados: se qualquer um chegar à auditoria, a limpeza falhou. */
const LEAKS = {
  password: 'leak-password-0001',
  token: 'leak-token-0002',
  stripeKey: ['sk', 'test', 'leakstripekey0003'].join('_'),
  bearer: 'leak-bearer-0004',
  cookie: 'leak-cookie-0005',
  signature: 'leak-signature-0006',
};

/**
 * Contrato do `TenantStore` e do `AuditService` sobre um `DocumentStore`, rodado contra o dublê em memória e
 * contra o emulador oficial do Firestore.
 */
export function describeTenantStoreContract(name: string, factory: () => Promise<TenantStoreHarness>): void {
  describe(`TenantStore (${name})`, () => {
    let h: TenantStoreHarness;

    beforeEach(async () => {
      h = await factory();
    });

    it('cria o cliente em pending com a primeira transição e a auditoria na mesma transação', async () => {
      const created = await h.store.create(demoTenant(), {
        reason: 'checkout.session.completed',
        eventId: 'evt_demo_1',
        audit: AUDIT,
      });

      expect(created.id).toMatch(ULID_PATTERN);
      expect(created).toMatchObject({
        state: 'pending',
        slug: 'cliente-demo-a',
        stateUpdatedAt: h.clock.now(),
      });
      expect(await h.store.get(created.id)).toEqual(created);
      expect(await h.store.listTransitions(created.id)).toEqual([
        {
          from: null,
          to: 'pending',
          reason: 'checkout.session.completed',
          eventId: 'evt_demo_1',
          at: h.clock.now(),
        },
      ]);
      const audit = await h.audit.listForTenant(created.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor: 'stripe:evt_demo_1',
        action: 'tenant.create',
        tenantId: created.id,
        requestId: 'req-demo-00001',
        details: { slug: 'cliente-demo-a', plan: 'essencial', to: 'pending' },
        at: h.clock.now(),
      });
      expect(audit[0]?.expiresAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
    });

    it('encontra pelo subdomínio e devolve undefined para quem não existe', async () => {
      const a = await h.store.create(demoTenant('cliente-demo-a'), { reason: 'teste', audit: AUDIT });
      const b = await h.store.create(demoTenant('cliente-demo-b', '22333444000181'), {
        reason: 'teste',
        audit: AUDIT,
      });

      expect((await h.store.findBySlug('cliente-demo-b'))?.id).toBe(b.id);
      expect((await h.store.findBySlug('cliente-demo-a'))?.id).toBe(a.id);
      expect(await h.store.findBySlug('cliente-demo-c')).toBeUndefined();
      expect(await h.store.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeUndefined();
      await expect(h.store.require('01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toBeInstanceOf(TenantNotFoundError);
    });

    it('muda o estado pela tabela, com transição, auditoria e carimbo de tempo do relógio', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      h.clock.advance(5 * MINUTE_MS);

      const updated = await h.store.transition(id, {
        to: 'provisioning',
        reason: 'invoice.paid',
        eventId: 'evt_demo_2',
        audit: { actor: 'stripe:evt_demo_2' },
      });

      expect(updated).toMatchObject({
        state: 'provisioning',
        stateUpdatedAt: h.clock.now(),
        updatedAt: h.clock.now(),
      });
      expect((await h.store.listTransitions(id)).map((t) => [t.from, t.to, t.eventId])).toEqual([
        [null, 'pending', undefined],
        ['pending', 'provisioning', 'evt_demo_2'],
      ]);
      const audit = await h.audit.listForTenant(id);
      expect(audit.map((entry) => entry.action)).toEqual(['tenant.create', 'tenant.transition']);
      expect(audit[1]?.details).toEqual({
        from: 'pending',
        to: 'provisioning',
        reason: 'invoice.paid',
        eventId: 'evt_demo_2',
      });
    });

    it('recusa transição fora da tabela (inclusive repetir o estado) e não grava nada', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });

      await expect(
        h.store.transition(id, { to: 'active', reason: 'x', audit: AUDIT }),
      ).rejects.toBeInstanceOf(InvalidTransitionError);
      await expect(
        h.store.transition(id, { to: 'pending', reason: 'x', audit: AUDIT }),
      ).rejects.toMatchObject({
        name: 'InvalidTransitionError',
        from: 'pending',
        to: 'pending',
      });

      expect((await h.store.get(id))?.state).toBe('pending');
      expect(await h.store.listTransitions(id)).toHaveLength(1);
      expect(await h.audit.listForTenant(id)).toHaveLength(1);
    });

    it('duas transições concorrentes: uma commita, a outra relê o estado novo e perde', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });

      const results = await Promise.allSettled([
        h.store.transition(id, {
          to: 'provisioning',
          reason: 'invoice.paid',
          eventId: 'evt_a',
          audit: AUDIT,
        }),
        h.store.transition(id, {
          to: 'provisioning',
          reason: 'invoice.paid',
          eventId: 'evt_b',
          audit: AUDIT,
        }),
      ]);

      const outcomes = results.map((result) => result.status).sort();
      expect(outcomes).toEqual(['fulfilled', 'rejected']);
      const loser = results.find((result) => result.status === 'rejected');
      expect(loser?.reason).toBeInstanceOf(InvalidTransitionError);
      expect((await h.store.get(id))?.state).toBe('provisioning');
      expect(await h.store.listTransitions(id)).toHaveLength(2);
      expect(await h.audit.listForTenant(id)).toHaveLength(2);
    });

    it('a mutação acompanha a transição, mas não pode mexer na lock', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      await h.store.transition(id, { to: 'provisioning', reason: 'x', audit: AUDIT });
      await h.store.transition(id, { to: 'waiting_customer_connection', reason: 'x', audit: AUDIT });
      await h.store.acquireLock(id, 'run-1', LOCK_TTL_MS);
      const graceUntil = new Date(h.clock.now().getTime() + 7 * 24 * 60 * MINUTE_MS);

      const pastDue = await h.store.transition(id, {
        to: 'past_due',
        reason: 'invoice.payment_failed',
        audit: AUDIT,
        mutate: (tenant) => ({ ...tenant, billing: { pastDueSince: h.clock.now(), graceUntil } }),
      });
      expect(pastDue.billing).toEqual({ pastDueSince: h.clock.now(), graceUntil });
      expect(pastDue.lock?.owner).toBe('run-1');

      await expect(
        h.store.transition(id, {
          to: 'suspended',
          reason: 'x',
          audit: AUDIT,
          mutate: (tenant) => ({ ...tenant, lock: { owner: 'run-2', expiresAt: h.clock.now() } }),
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect((await h.store.get(id))?.state).toBe('past_due');
    });

    it('trava: adquire, renova e solta; outro dono é recusado enquanto ela vale', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });

      const lock = await h.store.acquireLock(id, 'run-1', LOCK_TTL_MS);
      expect(lock).toEqual({ owner: 'run-1', expiresAt: new Date(h.clock.now().getTime() + LOCK_TTL_MS) });
      await expect(h.store.acquireLock(id, 'run-2', LOCK_TTL_MS)).rejects.toMatchObject({
        name: 'LockHeldError',
        owner: 'run-1',
      });
      await expect(h.store.acquireLock(id, 'run-2', LOCK_TTL_MS)).rejects.toBeInstanceOf(LockHeldError);

      h.clock.advance(10 * MINUTE_MS);
      const renewed = await h.store.renewLock(id, 'run-1', LOCK_TTL_MS);
      expect(renewed.expiresAt).toEqual(new Date(h.clock.now().getTime() + LOCK_TTL_MS));
      // O mesmo dono adquirir de novo é uma renovação.
      expect((await h.store.acquireLock(id, 'run-1', LOCK_TTL_MS)).owner).toBe('run-1');

      await expect(h.store.releaseLock(id, 'run-2')).rejects.toBeInstanceOf(LockNotHeldError);
      expect((await h.store.get(id))?.lock?.owner).toBe('run-1');
      await h.store.releaseLock(id, 'run-1');
      expect((await h.store.get(id))?.lock).toBeUndefined();
      await expect(h.store.releaseLock(id, 'run-1')).resolves.toBeUndefined();
      await expect(h.store.renewLock(id, 'run-1', LOCK_TTL_MS)).rejects.toBeInstanceOf(LockNotHeldError);
    });

    it('trava vencida é tomada por outro dono, e o antigo não renova nem solta mais', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      await h.store.acquireLock(id, 'run-1', LOCK_TTL_MS);

      h.clock.advance(LOCK_TTL_MS + MINUTE_MS);
      const taken = await h.store.acquireLock(id, 'run-2', LOCK_TTL_MS);

      expect(taken.owner).toBe('run-2');
      await expect(h.store.renewLock(id, 'run-1', LOCK_TTL_MS)).rejects.toBeInstanceOf(LockNotHeldError);
      await expect(h.store.releaseLock(id, 'run-1')).rejects.toBeInstanceOf(LockNotHeldError);
      expect((await h.store.get(id))?.lock).toEqual(taken);
    });

    it('trava e transição de cobrança não disputam: a transição preserva a trava', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      const lock = await h.store.acquireLock(id, 'run-1', LOCK_TTL_MS);

      await h.store.transition(id, { to: 'provisioning', reason: 'invoice.paid', audit: AUDIT });

      expect((await h.store.get(id))?.lock).toEqual(lock);
    });

    it('cliente inexistente: transição e trava falham com TenantNotFoundError', async () => {
      await expect(
        h.store.transition('01ARZ3NDEKTSV4RRFFQ69G5FAV', { to: 'provisioning', reason: 'x', audit: AUDIT }),
      ).rejects.toBeInstanceOf(TenantNotFoundError);
      await expect(
        h.store.acquireLock('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'run-1', LOCK_TTL_MS),
      ).rejects.toBeInstanceOf(TenantNotFoundError);
    });

    it('documento fora do formato falha na leitura citando o campo, nunca o valor', async () => {
      const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      await h.documents.runTransaction((tx) => {
        tx.set(COLLECTIONS.tenants, id, { ...demoTenant(), state: 'voando-baixo', createdAt: new Date() });
        return Promise.resolve();
      });

      let error: unknown;
      try {
        await h.store.get(id);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DocumentValidationError);
      const message = (error as Error).message;
      expect(message).toContain(`tenants/${id}`);
      expect(message).toContain('state');
      expect(message).not.toContain('voando-baixo');
    });

    it('nada sensível chega ao details da auditoria', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      h.clock.advance(MINUTE_MS);

      await h.audit.write({
        actor: 'owner:cp-deployer@projeto-demo.iam.gserviceaccount.com',
        action: 'tenant.resume',
        tenantId: id,
        details: {
          password: LEAKS.password,
          session: { token: LEAKS.token },
          stripeSecretKey: LEAKS.stripeKey,
          note: `chamada com Bearer ${LEAKS.bearer} e chave ${LEAKS.stripeKey}`,
          headers: { cookie: LEAKS.cookie, 'stripe-signature': LEAKS.signature },
          passwordRevealed: true,
          step: 'terraform.apply',
        },
      });

      const [, entry] = await h.audit.listForTenant(id);
      expect(entry?.details).toEqual({
        password: REDACTED,
        session: { token: REDACTED },
        stripeSecretKey: REDACTED,
        note: `chamada com Bearer ${REDACTED} e chave ${REDACTED}`,
        headers: { cookie: REDACTED, 'stripe-signature': REDACTED },
        passwordRevealed: true,
        step: 'terraform.apply',
      });
      const raw = JSON.stringify(await h.documents.query(COLLECTIONS.auditLog));
      for (const leak of Object.values(LEAKS)) expect(raw).not.toContain(leak);
    });
  });
}
