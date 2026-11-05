import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccessStore,
  AlreadyRevealedError,
  REVEAL_EMAIL_AFTER_MS,
  REVEAL_EMAIL_UNTIL_MS,
  RevealNotAvailableError,
  StatusAccessNotFoundError,
} from '../../src/access/access-store.js';
import { STATUS_TOKEN_TTL_MS, statusTokenId } from '../../src/access/status-token.js';
import type { AuditService } from '../../src/audit/audit.service.js';
import { COLLECTIONS } from '../../src/firestore/collections.js';
import type { DocumentStore } from '../../src/firestore/document-store.js';
import type { NewTenant, TenantStore } from '../../src/tenants/tenant-store.js';
import type { TenantRecord } from '../../src/tenants/tenant.schema.js';
import { type FakeClock, MINUTE_MS } from './fake-clock.js';
import { demoTenant } from './tenant-store-contract.js';

export interface AccessStoreHarness {
  access: AccessStore;
  tenants: TenantStore;
  audit: AuditService;
  clock: FakeClock;
  documents: DocumentStore;
}

const HOUR_MS = 60 * MINUTE_MS;
const AUDIT = { actor: 'system', requestId: 'req-demo-00001' };

export type DemoState =
  'pending' | 'provisioning' | 'waiting_customer_connection' | 'active' | 'canceled' | 'deleted';

type Step = Exclude<DemoState, 'pending'>;

/** O caminho de `pending` até cada estado pela tabela de transições. */
const PATHS: Readonly<Record<DemoState, readonly Step[]>> = {
  pending: [],
  provisioning: ['provisioning'],
  waiting_customer_connection: ['provisioning', 'waiting_customer_connection'],
  active: ['provisioning', 'waiting_customer_connection', 'active'],
  canceled: ['canceled'],
  deleted: ['canceled', 'deleted'],
};

export interface DemoTenantOptions {
  /** A sessão do Checkout que criou o cliente (`consent.checkoutSessionId`). */
  sessionId?: string;
  /** O id reservado no checkout; sem ele, um ULID novo. */
  tenantId?: string;
  /** Campos da Stripe por cima dos do cliente fictício (o meio de pagamento, a fatura). */
  stripe?: Partial<NonNullable<NewTenant['stripe']>>;
}

/** Um cliente fictício já no estado pedido, pelo caminho da tabela de transições. */
export async function tenantIn(
  tenants: TenantStore,
  slug: string,
  state: DemoState,
  options: DemoTenantOptions = {},
): Promise<TenantRecord> {
  const base = demoTenant(slug);
  const sessionId = options.sessionId ?? `cs_test_${slug.replaceAll('-', '')}`;
  let tenant = await tenants.create(
    {
      ...base,
      consent: base.consent === undefined ? undefined : { ...base.consent, checkoutSessionId: sessionId },
      ...(options.stripe === undefined
        ? {}
        : { stripe: { ...(base.stripe ?? { livemode: false }), ...options.stripe } }),
    },
    {
      reason: 'teste',
      audit: AUDIT,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    },
  );
  for (const to of PATHS[state]) {
    tenant = await tenants.transition(tenant.id, { to, reason: 'teste', audit: AUDIT });
  }
  return tenant;
}

/**
 * Contrato do `AccessStore` (`statusTokens` e `tenants.access`), rodado contra o dublê em memória e contra o emulador
 * oficial do Firestore: só o hash vai ao banco, prazo e tipo conferidos na leitura, a revelação marcada numa
 * transação (a segunda, mesmo ao mesmo tempo, perde), o desfazer e o plano B.
 */
export function describeAccessStoreContract(name: string, factory: () => Promise<AccessStoreHarness>): void {
  describe(`AccessStore (${name})`, () => {
    let h: AccessStoreHarness;

    beforeEach(async () => {
      h = await factory();
    });

    it('cria a credencial com só o hash no banco, o prazo do tipo e a auditoria sem o valor', async () => {
      const tenant = await tenantIn(h.tenants, 'cliente-demo-a', 'pending');
      const minted = await h.access.mint(tenant.id, 'cookie', `customer:${tenant.id}`, {
        requestId: 'req-demo-00002',
      });

      expect(minted.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(minted.expiresAt).toEqual(new Date(h.clock.now().getTime() + STATUS_TOKEN_TTL_MS.cookie));
      const stored = await h.documents.get(COLLECTIONS.statusTokens, statusTokenId(minted.value));
      expect(stored).toEqual({
        tenantId: tenant.id,
        kind: 'cookie',
        createdAt: h.clock.now(),
        expiresAt: minted.expiresAt,
      });
      expect(JSON.stringify(await h.documents.query(COLLECTIONS.statusTokens))).not.toContain(minted.value);
      const records = await h.audit.listForTenant(tenant.id);
      expect(records.at(-1)).toMatchObject({
        actor: `customer:${tenant.id}`,
        action: 'access.status_claimed',
        details: { kind: 'cookie' },
        requestId: 'req-demo-00002',
      });
      expect(JSON.stringify(records)).not.toContain(minted.value);

      const link = await h.access.mint(tenant.id, 'email_reveal', 'system');
      expect(link.expiresAt).toEqual(new Date(h.clock.now().getTime() + STATUS_TOKEN_TTL_MS.email_reveal));
    });

    it('resolve só a credencial existente, do tipo pedido e no prazo (mesmo antes de o TTL apagar)', async () => {
      const tenant = await tenantIn(h.tenants, 'cliente-demo-a', 'pending');
      const cookie = await h.access.mint(tenant.id, 'cookie', 'system');

      expect(await h.access.resolve(cookie.value, 'cookie')).toMatchObject({
        tenantId: tenant.id,
        kind: 'cookie',
      });
      expect(await h.access.resolve(cookie.value, 'email_reveal')).toBeUndefined();
      expect(await h.access.resolve('x'.repeat(43), 'cookie')).toBeUndefined();
      expect(await h.access.resolve('não é um valor', 'cookie')).toBeUndefined();

      h.clock.advance(STATUS_TOKEN_TTL_MS.cookie);
      expect(await h.access.resolve(cookie.value, 'cookie')).toBeUndefined();
      expect(await h.documents.get(COLLECTIONS.statusTokens, statusTokenId(cookie.value))).toBeDefined();
    });

    it('marca a revelação uma vez: a segunda é recusada, e só a espera da conexão revela', async () => {
      const waiting = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
      const cookie = await h.access.mint(waiting.id, 'cookie', 'system');

      const claim = await h.access.claimReveal(cookie.value, 'cookie', { requestId: 'req-demo-00003' });
      expect(claim.tenant.access?.passwordRevealedAt).toEqual(h.clock.now());
      expect((await h.tenants.require(waiting.id)).access?.passwordRevealedAt).toEqual(h.clock.now());
      expect((await h.audit.listForTenant(waiting.id)).at(-1)).toMatchObject({
        actor: `customer:${waiting.id}`,
        action: 'access.revealed',
        details: { via: 'cookie' },
      });
      await expect(h.access.claimReveal(cookie.value, 'cookie')).rejects.toBeInstanceOf(AlreadyRevealedError);

      const provisioning = await tenantIn(h.tenants, 'cliente-demo-b', 'provisioning');
      const other = await h.access.mint(provisioning.id, 'cookie', 'system');
      await expect(h.access.claimReveal(other.value, 'cookie')).rejects.toBeInstanceOf(
        RevealNotAvailableError,
      );
      expect((await h.tenants.require(provisioning.id)).access).toBeUndefined();

      const deleted = await tenantIn(h.tenants, 'cliente-demo-c', 'deleted');
      const gone = await h.access.mint(deleted.id, 'cookie', 'system');
      await expect(h.access.claimReveal(gone.value, 'cookie')).rejects.toBeInstanceOf(
        StatusAccessNotFoundError,
      );
    });

    it('duas revelações ao mesmo tempo: uma marca, a outra perde', async () => {
      const waiting = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
      const first = await h.access.mint(waiting.id, 'cookie', 'system');
      const second = await h.access.mint(waiting.id, 'email_reveal', 'system');

      const results = await Promise.allSettled([
        h.access.claimReveal(first.value, 'cookie'),
        h.access.claimReveal(second.value, 'email_reveal'),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyRevealedError);
      const revealed = (await h.audit.listForTenant(waiting.id)).filter(
        (r) => r.action === 'access.revealed',
      );
      expect(revealed).toHaveLength(1);
    });

    it('o link do e-mail vale uma vez, e desfazer a revelação o devolve (com o mesmo carimbo só)', async () => {
      const waiting = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
      const link = await h.access.mint(waiting.id, 'email_reveal', 'system');

      const claim = await h.access.claimReveal(link.value, 'email_reveal');
      const used = await h.documents.get(COLLECTIONS.statusTokens, statusTokenId(link.value));
      expect(used?.['usedAt']).toEqual(claim.revealedAt);
      expect(await h.access.resolve(link.value, 'email_reveal')).toBeUndefined();

      h.clock.advance(MINUTE_MS);
      expect(await h.access.revertReveal(claim, 'bootstrap_not_found')).toBe(true);
      expect((await h.tenants.require(waiting.id)).access?.passwordRevealedAt).toBeUndefined();
      expect(await h.access.resolve(link.value, 'email_reveal')).toBeDefined();
      expect((await h.audit.listForTenant(waiting.id)).at(-1)).toMatchObject({
        actor: 'system',
        action: 'access.reveal_reverted',
        details: { reason: 'bootstrap_not_found', via: 'email_reveal' },
      });
      // Desfazer de novo (ou uma revelação mais nova) não mexe em nada.
      expect(await h.access.revertReveal(claim, 'bootstrap_not_found')).toBe(false);
      const again = await h.access.claimReveal(link.value, 'email_reveal');
      expect(await h.access.revertReveal(claim, 'velha')).toBe(false);
      expect((await h.tenants.require(waiting.id)).access?.passwordRevealedAt).toEqual(again.revealedAt);
      await expect(h.access.claimReveal(link.value, 'email_reveal')).rejects.toBeInstanceOf(
        StatusAccessNotFoundError,
      );
    });

    it('plano B: o cliente entra no prazo às 48 h de espera, sai com o e-mail, a revelação ou as 72 h', async () => {
      const waiting = await tenantIn(h.tenants, 'cliente-demo-a', 'waiting_customer_connection');
      const revealed = await tenantIn(h.tenants, 'cliente-demo-b', 'waiting_customer_connection');
      await tenantIn(h.tenants, 'cliente-demo-c', 'provisioning');
      const cookie = await h.access.mint(revealed.id, 'cookie', 'system');
      await h.access.claimReveal(cookie.value, 'cookie');

      h.clock.advance(REVEAL_EMAIL_AFTER_MS - MINUTE_MS);
      expect(await h.access.findDueForRevealEmail(h.clock.now())).toEqual([]);

      h.clock.advance(MINUTE_MS);
      expect((await h.access.findDueForRevealEmail(h.clock.now())).map((tenant) => tenant.id)).toEqual([
        waiting.id,
      ]);

      h.clock.advance(REVEAL_EMAIL_UNTIL_MS - REVEAL_EMAIL_AFTER_MS);
      expect(await h.access.findDueForRevealEmail(h.clock.now())).toEqual([]);

      h.clock.advance(-HOUR_MS);
      await h.access.markRevealEmailSent(waiting.id, { requestId: 'req-demo-00004' });
      expect((await h.tenants.require(waiting.id)).access?.revealEmailSentAt).toEqual(h.clock.now());
      expect(await h.access.findDueForRevealEmail(h.clock.now())).toEqual([]);
      expect((await h.audit.listForTenant(waiting.id)).at(-1)).toMatchObject({
        actor: 'system',
        action: 'access.reveal_email_sent',
      });
    });
  });
}
