import { describe, expect, it } from 'vitest';
import type { CustomerSnapshot, InvoiceSnapshot, SubscriptionSnapshot } from '../stripe/stripe-client.js';
import type { TenantChange } from '../tenants/tenant-store.js';
import { type TenantRecord, type TenantState, tenantSchema } from '../tenants/tenant.schema.js';
import { demoConfiguration, demoLimits, demoOrderPricing } from '../../test/support/pricing-fixtures.js';
import {
  cancelTenant,
  customerChange,
  type DecisionContext,
  enterProvisioning,
  fraudReviewChange,
  GRACE_PERIOD_MS,
  invoicePaidChange,
  isRefundWithinGuarantee,
  itemsChanged,
  paymentFailedChange,
  subscriptionChange,
} from './billing-rules.js';

const AT = new Date('2026-12-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;
const RUN_ID = '01JBZ0000000000000000000RN';
const CTX: DecisionContext = {
  eventId: 'evt_test_regras',
  at: AT,
  audit: { actor: 'stripe:evt_test_regras' },
};

/** Cliente fictício (CLAUDE.md, regra 10), no estado pedido. */
function tenant(state: TenantState, overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: '01JBZ00000000000000000000T',
    slug: 'cliente-demo-a',
    state,
    stateUpdatedAt: new Date('2026-11-04T12:00:00.000Z'),
    configuration: demoConfiguration(),
    limits: demoLimits(),
    pricing: demoOrderPricing(),
    company: { legalName: 'Cliente Demo A Ltda', cnpj: '12ABC34501DE35' },
    adminEmail: 'admin@cliente-demo-a.example',
    stripe: { customerId: 'cus_fake_1', subscriptionId: 'sub_fake_1', livemode: false },
    createdAt: new Date('2026-11-04T12:00:00.000Z'),
    updatedAt: new Date('2026-11-04T12:00:00.000Z'),
    ...overrides,
  };
}

/** Aplica a mudança como o `TenantStore.change` faria (sem o store): o documento seguinte, validado. */
function apply(current: TenantRecord, change: TenantChange | undefined): TenantRecord | undefined {
  if (change === undefined) return undefined;
  const { id, ...doc } = current;
  const mutated = change.mutate === undefined ? doc : change.mutate(structuredClone(doc));
  return { id, ...tenantSchema.parse({ ...mutated, state: change.to ?? current.state }) };
}

function invoice(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: 'in_fake_1',
    livemode: false,
    status: 'paid',
    billingReason: 'subscription_cycle',
    customerId: 'cus_fake_1',
    subscriptionId: 'sub_fake_1',
    subscriptionMetadata: {},
    amountPaid: 100_000,
    currency: 'brl',
    paidAt: AT,
    periodStart: AT,
    periodEnd: new Date(AT.getTime() + 30 * DAY_MS),
    hostedInvoiceUrl: null,
    ...overrides,
  };
}

function subscription(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    id: 'sub_fake_1',
    livemode: false,
    status: 'active',
    customerId: 'cus_fake_1',
    metadata: {},
    cancelAt: null,
    currentPeriodEnd: new Date(AT.getTime() + 30 * DAY_MS),
    latestInvoiceId: 'in_fake_1',
    items: [{ priceId: 'price_fake_1', quantity: 1 }],
    defaultPaymentMethodType: 'card',
    ...overrides,
  };
}

describe('regras da máquina de estados do webhook (plano §4b e §4d)', () => {
  it('provisioning só a partir de pending, com a execução e o primeiro passo', () => {
    const change = enterProvisioning(tenant('pending'), CTX, RUN_ID, 'checkout_paid');
    expect(change?.to).toBe('provisioning');
    expect(apply(tenant('pending'), change)?.provisioning).toEqual({
      runId: RUN_ID,
      step: 'preflight',
      attempts: 0,
    });
    for (const state of ['provisioning', 'active', 'canceled'] as const) {
      expect(enterProvisioning(tenant(state), CTX, RUN_ID, 'checkout_paid')).toBeUndefined();
    }
  });

  it('a 1.ª fatura paga provisiona quem está em pending; a renovação não', () => {
    const first = invoicePaidChange(
      tenant('pending'),
      invoice({ billingReason: 'subscription_create' }),
      CTX,
      RUN_ID,
      undefined,
    );
    expect(first?.to).toBe('provisioning');
    expect(apply(tenant('pending'), first)?.billing?.paidUntil).toEqual(new Date(AT.getTime() + 30 * DAY_MS));
    expect(invoicePaidChange(tenant('pending'), invoice(), CTX, RUN_ID, undefined)?.to).toBeUndefined();
  });

  it('fatura paga só reativa o inadimplente com a dívida quitada (nenhuma outra em aberto confirmada)', () => {
    const billing = { pastDueSince: AT, graceUntil: AT, resumeState: 'active' as const };
    for (const delinquent of [
      tenant('past_due', { billing }),
      tenant('suspended', { billing: { ...billing, suspendedReason: 'unpaid' } }),
    ]) {
      expect(invoicePaidChange(delinquent, invoice(), CTX, RUN_ID, true)?.to, delinquent.state).toBe(
        'active',
      );
      // Outra fatura em aberto (ou sem a releitura): só grava o `paidUntil`; a inadimplência fica.
      for (const debtCleared of [false, undefined]) {
        const change = invoicePaidChange(delinquent, invoice(), CTX, RUN_ID, debtCleared);
        expect(change?.to).toBeUndefined();
        expect(apply(delinquent, change)).toMatchObject({
          state: delinquent.state,
          billing: { ...delinquent.billing, paidUntil: new Date(AT.getTime() + 30 * DAY_MS) },
        });
      }
    }
  });

  it('falha na renovação: past_due com 7 dias de carência; de novo em past_due não estende', () => {
    const change = paymentFailedChange(tenant('active'), invoice({ status: 'open' }), CTX);
    expect(change?.to).toBe('past_due');
    expect(apply(tenant('active'), change)?.billing).toEqual({
      pastDueSince: AT,
      graceUntil: new Date(AT.getTime() + GRACE_PERIOD_MS),
      resumeState: 'active',
    });
    expect(GRACE_PERIOD_MS).toBe(7 * DAY_MS);
    for (const state of ['past_due', 'suspended', 'pending', 'provisioning', 'canceled'] as const) {
      expect(paymentFailedChange(tenant(state), invoice({ status: 'open' }), CTX)).toBeUndefined();
    }
    // A 1.ª fatura não conta (o boleto do 1.º ciclo é tratado pela sessão do Checkout).
    expect(
      paymentFailedChange(
        tenant('active'),
        invoice({ status: 'open', billingReason: 'subscription_create' }),
        CTX,
      ),
    ).toBeUndefined();
  });

  it('assinatura unpaid suspende guardando para onde voltar; o pagamento reativa e limpa a inadimplência', () => {
    const pastDue = tenant('past_due', {
      billing: { pastDueSince: AT, graceUntil: AT, resumeState: 'waiting_customer_connection' },
    });
    const suspend = subscriptionChange(pastDue, subscription({ status: 'unpaid' }), CTX);
    expect(suspend?.to).toBe('suspended');
    const suspended = apply(pastDue, suspend);
    expect(suspended?.billing).toMatchObject({
      suspendedReason: 'unpaid',
      unpaidSince: AT,
      resumeState: 'waiting_customer_connection',
    });

    const paid = invoicePaidChange(suspended as TenantRecord, invoice(), CTX, RUN_ID, true);
    expect(paid?.to).toBe('waiting_customer_connection');
    expect(apply(suspended as TenantRecord, paid)?.billing).toEqual({
      paidUntil: new Date(AT.getTime() + 30 * DAY_MS),
    });
    // O modo de cobrança gravado (`billing.mode`) sobrevive à limpeza da inadimplência.
    const withMode = {
      ...(suspended as TenantRecord),
      billing: { ...suspended?.billing, mode: 'stripe' as const },
    };
    expect(apply(withMode, invoicePaidChange(withMode, invoice(), CTX, RUN_ID, true))?.billing).toEqual({
      mode: 'stripe',
      paidUntil: new Date(AT.getTime() + 30 * DAY_MS),
    });
  });

  it('fraud_review suspende até durante o provisionamento, e o pagamento não reativa', () => {
    for (const state of [
      'provisioning',
      'provisioning_failed',
      'waiting_customer_connection',
      'active',
      'past_due',
    ] as const) {
      expect(fraudReviewChange(tenant(state), CTX)?.to, state).toBe('suspended');
    }
    expect(fraudReviewChange(tenant('pending'), CTX)).toBeUndefined();
    expect(fraudReviewChange(tenant('canceled'), CTX)).toBeUndefined();
    const unpaid = tenant('suspended', { billing: { suspendedReason: 'unpaid', resumeState: 'active' } });
    const relabel = fraudReviewChange(unpaid, CTX);
    expect(relabel?.to).toBeUndefined();
    const fraud = apply(unpaid, relabel) as TenantRecord;
    expect(fraud.billing?.suspendedReason).toBe('fraud_review');
    expect(fraudReviewChange(fraud, CTX)).toBeUndefined();
    expect(invoicePaidChange(fraud, invoice(), CTX, RUN_ID, true)?.to).toBeUndefined();
  });

  it('assinatura encerrada cancela com os prazos de 30 e 97 dias; cancelado não cancela de novo', () => {
    const change = subscriptionChange(tenant('active'), subscription({ status: 'canceled' }), CTX);
    expect(change?.to).toBe('canceled');
    expect(apply(tenant('active'), change)?.lifecycle).toEqual({
      canceledAt: AT,
      exportUntil: new Date(AT.getTime() + 30 * DAY_MS),
      deleteAfter: new Date(AT.getTime() + 30 * DAY_MS),
      cryptoDestroyAfter: new Date(AT.getTime() + 97 * DAY_MS),
    });
    expect(cancelTenant(tenant('canceled'), CTX, 'x')).toBeUndefined();
    expect(
      subscriptionChange(tenant('canceled'), subscription({ status: 'canceled' }), CTX)?.to,
    ).toBeUndefined();
  });

  it('a assinatura relida atualiza status, período e todos os itens, sem mexer na configuração contratada', () => {
    const items = [
      { priceId: 'price_fake_1', quantity: 1, lookupKey: 'vc_env_p_v1' },
      { priceId: 'price_fake_2', quantity: 4 },
    ];
    const next = apply(tenant('active'), subscriptionChange(tenant('active'), subscription({ items }), CTX));
    expect(next?.configuration).toEqual(demoConfiguration());
    expect(next?.limits).toEqual(demoLimits());
    expect(next?.stripe).toMatchObject({ status: 'active', items });
    expect(itemsChanged([{ priceId: 'price_fake_1', quantity: 1 }], items)).toBe(true);
    expect(itemsChanged(items, [...items].reverse())).toBe(false);
    expect(itemsChanged(undefined, items)).toBe(false);
  });

  it('customer.updated: e-mail e razão social válidos entram, o resto é ignorado; o CNPJ não muda', () => {
    const customer = (overrides: Partial<CustomerSnapshot>): CustomerSnapshot => ({
      id: 'cus_fake_1',
      livemode: false,
      deleted: false,
      email: 'financeiro@cliente-demo-a.example',
      businessName: 'Cliente Demo A Comercio Ltda',
      ...overrides,
    });
    const synced = apply(tenant('active'), customerChange(tenant('active'), customer({}), CTX));
    expect(synced).toMatchObject({
      adminEmail: 'financeiro@cliente-demo-a.example',
      company: { legalName: 'Cliente Demo A Comercio Ltda', cnpj: '12ABC34501DE35' },
    });
    const kept = apply(
      tenant('active'),
      customerChange(
        tenant('active'),
        customer({ email: 'nao-e-email', businessName: 'Linha\nquebrada' }),
        CTX,
      ),
    );
    expect(kept).toMatchObject({
      adminEmail: 'admin@cliente-demo-a.example',
      company: { legalName: 'Cliente Demo A Ltda' },
    });
    expect(customerChange(tenant('deleted'), customer({}), CTX)).toBeUndefined();
  });

  it('customer.updated: a razão social segue o limite do checkout (120); acima, a anterior fica', () => {
    const longest = `Cliente Demo A ${'ã'.repeat(105)}`;
    const named = (businessName: string): CustomerSnapshot => ({
      id: 'cus_fake_1',
      livemode: false,
      deleted: false,
      email: 'admin@cliente-demo-a.example',
      businessName,
    });
    expect(
      apply(tenant('active'), customerChange(tenant('active'), named(` ${longest} `), CTX)),
    ).toMatchObject({
      company: { legalName: longest },
    });
    expect(
      apply(tenant('active'), customerChange(tenant('active'), named(`${longest}x`), CTX)),
    ).toMatchObject({
      company: { legalName: 'Cliente Demo A Ltda' },
    });
  });

  it('garantia: reembolso integral até 7 dias da contratação', () => {
    const t = tenant('active');
    const full = { amount: 100_000, amountRefunded: 100_000, refunded: true };
    expect(isRefundWithinGuarantee(t, full, new Date(t.createdAt.getTime() + 7 * DAY_MS))).toBe(true);
    expect(isRefundWithinGuarantee(t, full, new Date(t.createdAt.getTime() + 7 * DAY_MS + 1))).toBe(false);
    expect(
      isRefundWithinGuarantee(t, { ...full, amountRefunded: 100_000, refunded: false }, t.createdAt),
    ).toBe(false);
  });
});
