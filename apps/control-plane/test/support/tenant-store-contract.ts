import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditService } from '../../src/audit/audit.service.js';
import { REDACTED } from '../../src/common/logger/sanitize.js';
import { ULID_PATTERN } from '../../src/common/ulid.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import { type DocumentStore, DocumentValidationError } from '../../src/firestore/document-store.js';
import {
  IMMUTABLE_IN_TRANSITION,
  InvalidTransitionError,
  LockHeldError,
  LockNotHeldError,
  type NewTenant,
  SlugTakenError,
  TenantAlreadyExistsError,
  TenantNotFoundError,
  type TenantStore,
} from '../../src/tenants/tenant-store.js';
import type { Tenant } from '../../src/tenants/tenant.schema.js';
import type { FakeClock } from './fake-clock.js';
import { MINUTE_MS } from './fake-clock.js';
import { demoConfiguration, demoLimits, demoOrderPricing } from './pricing-fixtures.js';

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
    configuration: demoConfiguration(),
    limits: demoLimits(),
    pricing: demoOrderPricing(),
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
        details: {
          slug: 'cliente-demo-a',
          size: 'P',
          priceTableVersion: 'teste-v1',
          billingMode: 'stripe',
          to: 'pending',
        },
        at: h.clock.now(),
      });
      expect(audit[0]?.expiresAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
    });

    it('toma o subdomínio em slugs/{slug}: o segundo cliente com o mesmo slug é recusado e nada é gravado', async () => {
      const a = await h.store.create(demoTenant('cliente-demo-a'), { reason: 'teste', audit: AUDIT });
      expect(await h.store.getSlug('cliente-demo-a')).toEqual({
        state: 'taken',
        tenantId: a.id,
        checkoutSessionId: 'cs_test_demo_a',
        updatedAt: h.clock.now(),
      });

      h.clock.advance(MINUTE_MS);
      await expect(
        h.store.create(demoTenant('cliente-demo-a', '22333444000181'), { reason: 'teste', audit: AUDIT }),
      ).rejects.toBeInstanceOf(SlugTakenError);

      expect((await h.store.getSlug('cliente-demo-a'))?.tenantId).toBe(a.id);
      const tenants = await h.documents.query(COLLECTIONS.tenants, {
        where: [{ field: 'slug', op: '==', value: 'cliente-demo-a' }],
      });
      expect(tenants.map((doc) => doc.id)).toEqual([a.id]);
      expect(await h.documents.query(COLLECTIONS.auditLog)).toHaveLength(1);
    });

    it('a reserva do mesmo checkout vira taken; a de outro checkout bloqueia até vencer', async () => {
      const reserve = (slug: string, checkoutSessionId: string, expiresAt: Date): Promise<void> =>
        h.documents.runTransaction((tx) => {
          tx.set(COLLECTIONS.slugs, slug, {
            state: 'reserved',
            checkoutSessionId,
            updatedAt: h.clock.now(),
            expiresAt,
          });
          return Promise.resolve();
        });
      const in150min = new Date(h.clock.now().getTime() + 150 * MINUTE_MS);

      await reserve('cliente-demo-a', 'cs_test_outro', in150min);
      await expect(h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT })).rejects.toBeInstanceOf(
        SlugTakenError,
      );
      expect(await h.store.findBySlug('cliente-demo-a')).toBeUndefined();

      await reserve('cliente-demo-a', 'cs_test_demo_a', in150min);
      const created = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      expect(await h.store.getSlug('cliente-demo-a')).toEqual({
        state: 'taken',
        tenantId: created.id,
        checkoutSessionId: 'cs_test_demo_a',
        updatedAt: h.clock.now(),
      });

      // Reserva de outro checkout já vencida (o TTL ainda não a apagou): o slug está livre.
      await reserve('cliente-demo-b', 'cs_test_outro', new Date(h.clock.now().getTime() - MINUTE_MS));
      const b = await h.store.create(demoTenant('cliente-demo-b', '22333444000181'), {
        reason: 'teste',
        audit: AUDIT,
      });
      expect((await h.store.getSlug('cliente-demo-b'))?.tenantId).toBe(b.id);
    });

    it('duas criações simultâneas com o mesmo slug: só uma nasce, e a outra recebe SlugTakenError', async () => {
      const results = await Promise.allSettled([
        h.store.create(demoTenant('cliente-demo-a'), { reason: 'teste', audit: AUDIT }),
        h.store.create(demoTenant('cliente-demo-a', '22333444000181'), { reason: 'teste', audit: AUDIT }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const winner = results.find((result) => result.status === 'fulfilled');
      const loser = results.find((result) => result.status === 'rejected');
      expect(loser?.reason).toBeInstanceOf(SlugTakenError);
      expect((await h.store.findBySlug('cliente-demo-a'))?.id).toBe(winner?.value.id);
      expect((await h.store.getSlug('cliente-demo-a'))?.tenantId).toBe(winner?.value.id);
      expect(await h.documents.query(COLLECTIONS.tenants)).toHaveLength(1);
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

    it('a mutação não pode mexer em slug, company, consent, createdAt nem lock; cópia igual passa', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      await h.store.acquireLock(id, 'run-1', LOCK_TTL_MS);
      const changes: Record<(typeof IMMUTABLE_IN_TRANSITION)[number], (tenant: Tenant) => Tenant> = {
        slug: (tenant) => ({ ...tenant, slug: 'outro-slug' }),
        company: (tenant) => ({ ...tenant, company: { ...tenant.company, legalName: 'Outra Ltda' } }),
        consent: (tenant) => ({ ...tenant, consent: undefined }),
        createdAt: (tenant) => ({ ...tenant, createdAt: new Date(0) }),
        lock: (tenant) => ({ ...tenant, lock: undefined }),
      };
      for (const key of IMMUTABLE_IN_TRANSITION) {
        await expect(
          h.store.transition(id, { to: 'provisioning', reason: 'x', audit: AUDIT, mutate: changes[key] }),
        ).rejects.toThrow(new TypeError(`a mutação de uma transição não pode mexer em ${key}`));
      }
      expect((await h.store.get(id))?.state).toBe('pending');
      expect(await h.store.listTransitions(id)).toHaveLength(1);

      // Uma cópia estrutural (objetos novos com o mesmo conteúdo) não é mudança.
      const copied = await h.store.transition(id, {
        to: 'provisioning',
        reason: 'x',
        audit: AUDIT,
        mutate: (tenant) => ({
          ...tenant,
          company: { ...tenant.company },
          consent: tenant.consent === undefined ? undefined : { ...tenant.consent },
          lock: tenant.lock === undefined ? undefined : { ...tenant.lock },
          createdAt: new Date(tenant.createdAt.getTime()),
          provisioning: { attempts: 0 },
        }),
      });
      expect(copied).toMatchObject({ state: 'provisioning', provisioning: { attempts: 0 } });
      expect(copied.lock?.owner).toBe('run-1');
    });

    it('a mutação no lugar também é recusada: slug no argumento, lock e company por trás de cópia rasa', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      const lock = await h.store.acquireLock(id, 'run-1', LOCK_TTL_MS);
      const inPlace: Record<'slug' | 'company' | 'lock', (tenant: Tenant) => Tenant> = {
        // Edita o argumento e o devolve: sem a cópia independente, a comparação olharia o valor já mudado.
        slug: (tenant) => {
          tenant.slug = 'outro-slug';
          return tenant;
        },
        // Cópia rasa com mudança aninhada: o objeto `company` seria o mesmo do documento relido.
        company: (tenant) => {
          tenant.company.legalName = 'Outra Ltda';
          return { ...tenant };
        },
        lock: (tenant) => {
          if (tenant.lock !== undefined) tenant.lock.owner = 'run-2';
          return { ...tenant };
        },
      };
      for (const [key, mutate] of Object.entries(inPlace)) {
        await expect(
          h.store.transition(id, { to: 'provisioning', reason: 'x', audit: AUDIT, mutate }),
        ).rejects.toThrow(new TypeError(`a mutação de uma transição não pode mexer em ${key}`));
      }
      expect(await h.store.get(id)).toMatchObject({
        state: 'pending',
        slug: 'cliente-demo-a',
        company: { legalName: 'cliente-demo-a Ltda' },
        lock,
      });
      expect(await h.store.listTransitions(id)).toHaveLength(1);
      expect(await h.audit.listForTenant(id)).toHaveLength(1);
    });

    it('mexer em state dentro da mutação não corrompe o from da transição nem da auditoria', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });

      const updated = await h.store.transition(id, {
        to: 'provisioning',
        reason: 'invoice.paid',
        audit: AUDIT,
        mutate: (tenant) => {
          tenant.state = 'active';
          return tenant;
        },
      });

      expect(updated.state).toBe('provisioning');
      expect((await h.store.listTransitions(id)).at(-1)).toMatchObject({
        from: 'pending',
        to: 'provisioning',
      });
      expect((await h.audit.listForTenant(id)).at(-1)?.details).toMatchObject({
        from: 'pending',
        to: 'provisioning',
      });
    });

    it('registros do mesmo instante saem na ordem em que foram gravados (ids ULID como desempate)', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      // O relógio não anda: `at` é igual nos três registros.
      await h.store.transition(id, { to: 'provisioning', reason: 'invoice.paid', audit: AUDIT });
      await h.store.transition(id, {
        to: 'waiting_customer_connection',
        reason: 'access.ready',
        audit: AUDIT,
      });

      const transitions = await h.store.listTransitions(id);
      expect(transitions.map((t) => t.to)).toEqual([
        'pending',
        'provisioning',
        'waiting_customer_connection',
      ]);
      expect(new Set(transitions.map((t) => t.at.getTime())).size).toBe(1);
      const ids = (await h.documents.query(COLLECTIONS.transitions(id))).map((doc) => doc.id);
      for (const docId of ids) expect(docId).toMatch(ULID_PATTERN);

      const audit = await h.audit.listForTenant(id);
      expect(audit.map((entry) => entry.details?.['to'])).toEqual([
        'pending',
        'provisioning',
        'waiting_customer_connection',
      ]);
      for (const entry of audit) expect(entry.id).toMatch(ULID_PATTERN);
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

    // --- CP-04: a reserva vira o cliente, mudanças decididas na transação e o subdomínio devolvido ---

    async function reserveFor(slug: string, tenantId: string, checkoutSessionId: string): Promise<void> {
      await h.documents.runTransaction((tx) => {
        tx.set(COLLECTIONS.slugs, slug, {
          state: 'reserved',
          tenantId,
          checkoutSessionId,
          updatedAt: h.clock.now(),
          expiresAt: new Date(h.clock.now().getTime() + 150 * MINUTE_MS),
        });
        return Promise.resolve();
      });
    }

    const RESERVED_ID = '01JC0000000000000000000RES';
    const OTHER_ID = '01JC0000000000000000000XYZ';

    it('cria com o id reservado: a reserva do mesmo checkout e do mesmo id vira o cliente; repetir é recusado', async () => {
      await reserveFor('cliente-demo-a', RESERVED_ID, 'cs_test_demo_a');

      const created = await h.store.create(demoTenant(), {
        reason: 'teste',
        audit: AUDIT,
        tenantId: RESERVED_ID,
      });

      expect(created.id).toBe(RESERVED_ID);
      expect(await h.store.getSlug('cliente-demo-a')).toMatchObject({
        state: 'taken',
        tenantId: RESERVED_ID,
      });
      await expect(
        h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT, tenantId: RESERVED_ID }),
      ).rejects.toBeInstanceOf(TenantAlreadyExistsError);
      await expect(
        h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT, tenantId: 'nao-e-ulid' }),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('cria com o id reservado: a reserva da mesma sessão com outro id não serve', async () => {
      await reserveFor('cliente-demo-a', OTHER_ID, 'cs_test_demo_a');
      await expect(
        h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT, tenantId: RESERVED_ID }),
      ).rejects.toBeInstanceOf(SlugTakenError);
      expect(await h.store.get(RESERVED_ID)).toBeUndefined();
    });

    it('change decide sobre o documento relido; sem mudança não grava; atualização audita só os nomes dos campos', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      expect((await h.store.change(id, () => undefined)).changed).toBe(false);
      const synced = (tenant: Tenant): Tenant => ({
        ...tenant,
        stripe: { livemode: false, customerId: 'cus_demo_a', status: 'active' },
      });

      h.clock.advance(MINUTE_MS);
      const updated = await h.store.change(id, () => ({
        reason: 'stripe_synced',
        eventId: 'evt_demo_2',
        audit: AUDIT,
        mutate: synced,
      }));
      expect(updated).toMatchObject({ changed: true, transitioned: false, tenant: { state: 'pending' } });
      expect(updated.tenant.updatedAt).toEqual(h.clock.now());
      expect(await h.store.listTransitions(id)).toHaveLength(1);
      const [, entry] = await h.audit.listForTenant(id);
      expect(entry).toMatchObject({
        action: 'tenant.update',
        details: { state: 'pending', fields: ['stripe'], reason: 'stripe_synced', eventId: 'evt_demo_2' },
      });

      // A mesma mudança de novo não grava nada.
      const again = await h.store.change(id, () => ({
        reason: 'stripe_synced',
        audit: AUDIT,
        mutate: synced,
      }));
      expect(again.changed).toBe(false);
      expect(await h.audit.listForTenant(id)).toHaveLength(2);
    });

    it('change: só a razão social muda com allowLegalNameChange, e só sem transição; o CNPJ nunca', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      const rename =
        (cnpj?: string) =>
        (tenant: Tenant): Tenant => ({
          ...tenant,
          company: { legalName: 'Cliente Demo A Comercio Ltda', cnpj: cnpj ?? tenant.company.cnpj },
        });
      await expect(
        h.store.change(id, () => ({ reason: 'x', audit: AUDIT, mutate: rename() })),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        h.store.change(id, () => ({
          reason: 'x',
          audit: AUDIT,
          allowLegalNameChange: true,
          mutate: rename('22333444000181'),
        })),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        h.store.change(id, () => ({
          to: 'provisioning',
          reason: 'x',
          audit: AUDIT,
          allowLegalNameChange: true,
          mutate: rename(),
        })),
      ).rejects.toBeInstanceOf(TypeError);

      const renamed = await h.store.change(id, () => ({
        reason: 'customer_synced',
        audit: AUDIT,
        allowLegalNameChange: true,
        mutate: rename(),
      }));
      expect(renamed.tenant.company).toEqual({
        legalName: 'Cliente Demo A Comercio Ltda',
        cnpj: '11222333000181',
      });
    });

    it('change concorrente: cada decisão vê o estado deixado pela outra, e só uma transiciona', async () => {
      const { id } = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      const toProvisioning = (eventId: string) => (current: Tenant) =>
        current.state === 'pending'
          ? { to: 'provisioning' as const, reason: 'pago', eventId, audit: AUDIT }
          : undefined;

      const results = await Promise.all([
        h.store.change(id, toProvisioning('evt_a')),
        h.store.change(id, toProvisioning('evt_b')),
      ]);

      expect(results.map((result) => result.transitioned).sort()).toEqual([false, true]);
      expect((await h.store.listTransitions(id)).map((t) => t.to)).toEqual(['pending', 'provisioning']);
    });

    it('acha pelo Customer e pela assinatura da Stripe', async () => {
      const a = await h.store.create(
        {
          ...demoTenant(),
          stripe: { customerId: 'cus_demo_a', subscriptionId: 'sub_demo_a', livemode: false },
        },
        { reason: 'teste', audit: AUDIT },
      );
      expect((await h.store.findByStripeCustomer('cus_demo_a'))?.id).toBe(a.id);
      expect((await h.store.findByStripeSubscription('sub_demo_a'))?.id).toBe(a.id);
      expect(await h.store.findByStripeCustomer('cus_demo_x')).toBeUndefined();
    });

    it('páginas pelo subdomínio: ordem estável, o último slug é o cursor, e mudar um documento não muda a ordem', async () => {
      // Criados fora da ordem alfabética, para a ordem vir do slug e não da criação.
      for (const slug of [
        'cliente-demo-c',
        'cliente-demo-a',
        'cliente-demo-e',
        'cliente-demo-b',
        'cliente-demo-d',
      ]) {
        await h.store.create(demoTenant(slug), { reason: 'teste', audit: AUDIT });
      }
      const slugsOf = (page: { slug: string }[]): string[] => page.map((tenant) => tenant.slug);
      const first = await h.store.listPageBySlug(undefined, 2);
      expect(slugsOf(first)).toEqual(['cliente-demo-a', 'cliente-demo-b']);
      // Uma gravação no meio da varredura (a recópia marca o cliente) não tira ninguém do lugar.
      const marked = first[0];
      if (marked === undefined) throw new Error('página vazia');
      await h.store.change(marked.id, () => ({
        reason: 'node_smtp_password_synced',
        audit: AUDIT,
        mutate: (tenant) => ({ ...tenant, resources: { nodeMailPasswordAt: h.clock.now() } }),
      }));
      const second = await h.store.listPageBySlug('cliente-demo-b', 2);
      expect(slugsOf(second)).toEqual(['cliente-demo-c', 'cliente-demo-d']);
      expect(slugsOf(await h.store.listPageBySlug('cliente-demo-d', 2))).toEqual(['cliente-demo-e']);
      expect(await h.store.listPageBySlug('cliente-demo-e', 2)).toEqual([]);
      expect((await h.store.listPageBySlug(undefined, 10))[0]?.resources?.nodeMailPasswordAt).toEqual(
        h.clock.now(),
      );
    });

    it('devolve o subdomínio tomado pelo cliente (released), uma vez só; o de outro cliente não', async () => {
      const a = await h.store.create(demoTenant(), { reason: 'teste', audit: AUDIT });
      expect(await h.store.releaseSlug(OTHER_ID, 'cliente-demo-a', 'x', AUDIT)).toBe(false);
      expect(await h.store.releaseSlug(a.id, 'cliente-demo-a', 'canceled_before_provisioning', AUDIT)).toBe(
        true,
      );
      expect(await h.store.getSlug('cliente-demo-a')).toEqual({
        state: 'released',
        tenantId: a.id,
        updatedAt: h.clock.now(),
      });
      expect(await h.store.releaseSlug(a.id, 'cliente-demo-a', 'x', AUDIT)).toBe(false);
      const actions = (await h.audit.listForTenant(a.id)).map((entry) => entry.action);
      expect(actions).toEqual(['tenant.create', 'tenant.slug_released']);
    });
  });
}
