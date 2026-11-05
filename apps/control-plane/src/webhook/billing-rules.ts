import { z } from 'zod';
import { FIRST_PROVISIONING_STEP } from '../queue/step-queue.js';
import type {
  CustomerSnapshot,
  InvoiceSnapshot,
  StripeItem,
  SubscriptionSnapshot,
} from '../stripe/stripe-client.js';
import type { AuditContext, TenantChange } from '../tenants/tenant-store.js';
import type { ResumeState, Tenant, TenantRecord, TenantState } from '../tenants/tenant.schema.js';

/**
 * As regras da máquina de estados do webhook (plano §4b e §4d), puras: recebem o cliente relido dentro da transação
 * (`TenantStore.change`) e o objeto relido na Stripe, e devolvem a mudança, ou `undefined` para não mexer. Rodam de
 * novo se o Firestore repetir a transação; por isso não leem relógio nem geram id (o `runId` e o instante vêm de
 * fora). O estado atual decide: um evento que chega fora de ordem, ou repetido, encontra o cliente onde outro evento
 * o deixou e não volta atrás.
 */

const DAY_MS = 24 * 60 * 60_000;
/** Carência depois de uma renovação não paga (plano §4b): 7 dias, contados do evento. */
export const GRACE_PERIOD_MS = 7 * DAY_MS;
/** Exportação sob pedido e exclusão 1 (plano §4d): 30 dias depois do cancelamento. */
export const EXPORT_WINDOW_MS = 30 * DAY_MS;
/** Exclusão 2, a cripto-destruição (plano §4d): 97 dias depois do cancelamento. */
export const CRYPTO_DESTROY_AFTER_MS = 97 * DAY_MS;
/** Garantia (plano §4b): reembolso integral até 7 dias depois da contratação cancela a assinatura. */
export const REFUND_GUARANTEE_MS = 7 * DAY_MS;

/** Status da assinatura na Stripe que encerram o contrato. */
const ENDED_SUBSCRIPTION = new Set(['canceled', 'incomplete_expired']);

export interface DecisionContext {
  eventId: string;
  /** Quando o evento aconteceu (`created` assinado pela Stripe): os prazos de cobrança contam daqui. */
  at: Date;
  audit: AuditContext;
}

function after(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

/** O estado ao qual o cliente volta quando a inadimplência acabar (o de antes dela). */
export function resumeStateOf(tenant: Tenant): ResumeState | undefined {
  if (tenant.state === 'active' || tenant.state === 'waiting_customer_connection') return tenant.state;
  if (tenant.state === 'past_due' || tenant.state === 'suspended') return tenant.billing?.resumeState;
  return undefined;
}

/** Sem os campos da inadimplência (de volta ao normal): só ficam o `paidUntil` e o modo de cobrança. */
export function clearDelinquency(billing: Tenant['billing'], paidUntil: Date | undefined): Tenant['billing'] {
  const next = paidUntil ?? billing?.paidUntil;
  const kept = {
    ...(billing?.mode === undefined ? {} : { mode: billing.mode }),
    ...(next === undefined ? {} : { paidUntil: next }),
  };
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** Cliente cancelado sem nunca ter provisionado nada: o subdomínio pode voltar a ser reservado. */
export function neverProvisioned(tenant: Tenant): boolean {
  return tenant.provisioning?.runId === undefined;
}

/** Entra em `provisioning` (cartão pago, boleto compensado, 1.ª fatura paga): só de `pending`. */
export function enterProvisioning(
  tenant: TenantRecord,
  ctx: DecisionContext,
  runId: string,
  reason: string,
  extra?: (tenant: Tenant) => Tenant,
): TenantChange | undefined {
  if (tenant.state !== 'pending') return undefined;
  return {
    to: 'provisioning',
    reason,
    eventId: ctx.eventId,
    audit: ctx.audit,
    mutate: (current) => ({
      ...(extra === undefined ? current : extra(current)),
      provisioning: { runId, step: FIRST_PROVISIONING_STEP, attempts: 0 },
    }),
  };
}

/**
 * Cancelado (plano §4d): `exportUntil` e `deleteAfter` em +30 dias, `cryptoDestroyAfter` em +97 dias, contados de
 * `ctx.at` (o evento da Stripe, ou o vencimento dos 30 dias sem pagar no `tick`, CP-11).
 */
export function cancelTenant(
  tenant: TenantRecord,
  ctx: Omit<DecisionContext, 'eventId'> & { eventId?: string },
  reason: string,
  extra?: (tenant: Tenant) => Tenant,
): TenantChange | undefined {
  if (tenant.state === 'canceled' || tenant.state === 'deleted') return undefined;
  return {
    to: 'canceled',
    reason,
    eventId: ctx.eventId,
    audit: ctx.audit,
    mutate: (current) => {
      const base = extra === undefined ? current : extra(current);
      return {
        ...base,
        lifecycle: {
          ...base.lifecycle,
          canceledAt: ctx.at,
          exportUntil: after(ctx.at, EXPORT_WINDOW_MS),
          deleteAfter: after(ctx.at, EXPORT_WINDOW_MS),
          cryptoDestroyAfter: after(ctx.at, CRYPTO_DESTROY_AFTER_MS),
        },
      };
    },
  };
}

/** Os campos `stripe` do cliente a partir da assinatura relida (status, período, itens). */
function withSubscription(tenant: Tenant, subscription: SubscriptionSnapshot): Tenant {
  const current = tenant.stripe ?? { livemode: subscription.livemode };
  return {
    ...tenant,
    stripe: {
      ...current,
      customerId: current.customerId ?? subscription.customerId ?? undefined,
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd ?? undefined,
      latestInvoiceId: subscription.latestInvoiceId ?? current.latestInvoiceId,
      cancelAt: subscription.cancelAt ?? undefined,
      items: subscription.items.map((item) => ({ ...item })),
    },
  };
}

/**
 * `customer.subscription.*` (plano §4b): a assinatura relida decide. Encerrada → `canceled`; `unpaid` → `suspended`
 * (de `active`, `past_due` ou `waiting_customer_connection`); qualquer outra coisa só atualiza os campos da Stripe
 * (status, período, `cancel_at`, itens). Troca de preço não muda o plano: fica registrada nos itens e vira item de
 * suporte (quem decide é o processador, depois da transação). Um cliente excluído (`deleted`) não volta a ganhar campos
 * da Stripe: depois da Exclusão 2 ele é o registro mínimo (CP-11).
 */
export function subscriptionChange(
  tenant: TenantRecord,
  subscription: SubscriptionSnapshot,
  ctx: DecisionContext,
): TenantChange | undefined {
  if (tenant.state === 'deleted') return undefined;
  const sync = (current: Tenant): Tenant => withSubscription(current, subscription);
  if (ENDED_SUBSCRIPTION.has(subscription.status)) {
    return cancelTenant(tenant, ctx, 'subscription_ended', sync) ?? syncOnly(ctx, sync);
  }
  if (subscription.status === 'unpaid') {
    if (
      tenant.state === 'active' ||
      tenant.state === 'past_due' ||
      tenant.state === 'waiting_customer_connection'
    ) {
      return {
        to: 'suspended',
        reason: 'subscription_unpaid',
        eventId: ctx.eventId,
        audit: ctx.audit,
        mutate: (current) => {
          const synced = sync(current);
          return {
            ...synced,
            billing: {
              ...synced.billing,
              unpaidSince: synced.billing?.unpaidSince ?? ctx.at,
              suspendedReason: 'unpaid',
              resumeState: resumeStateOf(current),
            },
          };
        },
      };
    }
    if (tenant.state === 'suspended' && tenant.billing?.unpaidSince === undefined) {
      // Já suspenso por outro motivo: só passa a contar o `unpaid` (os 30 dias do CP-11).
      return syncOnly(ctx, (current) => {
        const synced = sync(current);
        return { ...synced, billing: { ...synced.billing, unpaidSince: ctx.at } };
      });
    }
  }
  return syncOnly(ctx, sync);
}

function syncOnly(ctx: DecisionContext, mutate: (tenant: Tenant) => Tenant): TenantChange {
  return { reason: 'stripe_synced', eventId: ctx.eventId, audit: ctx.audit, mutate };
}

/** Inadimplente por falta de pagamento: o estado que uma fatura paga pode desfazer, se a dívida acabou. */
export function isDelinquent(tenant: Tenant): boolean {
  return (
    tenant.state === 'past_due' ||
    (tenant.state === 'suspended' &&
      tenant.billing?.suspendedReason !== 'fraud_review' &&
      tenant.billing?.suspendedReason !== 'owner')
  );
}

/**
 * `invoice.paid` com a fatura relida como paga (plano §4b e §4d): `paidUntil` avança até o fim do período cobrado.
 * Em `pending`, a 1.ª fatura (`subscription_create`) leva a `provisioning`. Em `past_due`, ou `suspended` por falta de
 * pagamento, o cliente volta ao estado de antes (`active` ou `waiting_customer_connection`) e os campos da
 * inadimplência somem, mas só com `debtCleared === true`: a fatura paga prova que ela foi paga, não que a assinatura
 * não deve outra (uma fatura antiga paga atrasada, ou o evento dela entregue tarde, com uma renovação mais nova em
 * aberto). Quem chama relê as faturas em aberto da assinatura; sem essa leitura (`undefined`), não reativa. Suspenso por
 * `fraud_review` não volta sozinho: a decisão é humana.
 */
export function invoicePaidChange(
  tenant: TenantRecord,
  invoice: InvoiceSnapshot,
  ctx: DecisionContext,
  runId: string,
  debtCleared: boolean | undefined,
): TenantChange | undefined {
  const paidUntil = latest(tenant.billing?.paidUntil, invoice.periodEnd ?? undefined);
  const withPaid = (current: Tenant): Tenant =>
    paidUntil === undefined ? current : { ...current, billing: { ...current.billing, paidUntil } };
  if (tenant.state === 'pending' && invoice.billingReason === 'subscription_create') {
    return enterProvisioning(tenant, ctx, runId, 'first_invoice_paid', withPaid);
  }
  if (isDelinquent(tenant) && debtCleared === true) {
    const to: TenantState = resumeStateOf(tenant) ?? 'active';
    return {
      to,
      reason: 'invoice_paid',
      eventId: ctx.eventId,
      audit: ctx.audit,
      mutate: (current) => ({ ...current, billing: clearDelinquency(current.billing, paidUntil) }),
    };
  }
  return syncOnly(ctx, withPaid);
}

/**
 * `invoice.payment_failed` numa renovação (plano §4b e §4d, D0): `past_due` com `pastDueSince` e `graceUntil` em +7
 * dias, só a partir de `active` ou `waiting_customer_connection`. Uma nova falha (o Smart Retries do cartão repete até
 * 8 vezes) encontra o cliente em `past_due` e não estende a carência. A 1.ª fatura (`subscription_create`) não conta:
 * o boleto do 1.º ciclo é tratado pelos eventos da sessão do Checkout.
 */
export function paymentFailedChange(
  tenant: TenantRecord,
  invoice: InvoiceSnapshot,
  ctx: DecisionContext,
): TenantChange | undefined {
  if (invoice.billingReason === 'subscription_create') return undefined;
  if (tenant.state !== 'active' && tenant.state !== 'waiting_customer_connection') return undefined;
  const resumeState = tenant.state;
  return {
    to: 'past_due',
    reason: 'renewal_payment_failed',
    eventId: ctx.eventId,
    audit: ctx.audit,
    mutate: (current) => ({
      ...current,
      billing: {
        ...current.billing,
        pastDueSince: ctx.at,
        graceUntil: after(ctx.at, GRACE_PERIOD_MS),
        resumeState,
      },
    }),
  };
}

/**
 * Contestação (`charge.dispute.created`) ou alerta de fraude (`radar.early_fraud_warning.created`), plano §4b:
 * `suspended` com motivo `fraud_review` a partir de qualquer estado em que o cliente já pagou (inclusive durante o
 * provisionamento). Já suspenso por outro motivo, o motivo passa a ser `fraud_review` (um pagamento não reativa mais).
 */
export function fraudReviewChange(tenant: TenantRecord, ctx: DecisionContext): TenantChange | undefined {
  switch (tenant.state) {
    case 'provisioning':
    case 'provisioning_failed':
    case 'waiting_customer_connection':
    case 'active':
    case 'past_due':
      return {
        to: 'suspended',
        reason: 'fraud_review',
        eventId: ctx.eventId,
        audit: ctx.audit,
        mutate: (current) => ({
          ...current,
          billing: {
            ...current.billing,
            suspendedReason: 'fraud_review',
            resumeState: resumeStateOf(current),
          },
        }),
      };
    case 'suspended':
      if (tenant.billing?.suspendedReason === 'fraud_review') return undefined;
      return syncOnly(ctx, (current) => ({
        ...current,
        billing: { ...current.billing, suspendedReason: 'fraud_review' },
      }));
    default:
      return undefined;
  }
}

/** Sem caracteres de controle: o nome vai a e-mail, painel e nota fiscal. */
function isPrintable(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const emailSchema = z.email().max(254);

/**
 * `customer.updated` (plano §4b): o e-mail e a razão social do Customer passam para o cliente (o CNPJ não muda: é o
 * que foi conferido no checkout). Valor fora do formato é ignorado; cliente `deleted` não volta a ter e-mail.
 */
export function customerChange(
  tenant: TenantRecord,
  customer: CustomerSnapshot,
  ctx: DecisionContext,
): TenantChange | undefined {
  if (tenant.state === 'deleted') return undefined;
  const email = customer.email?.trim();
  const name = customer.businessName?.trim();
  const nextEmail = email !== undefined && emailSchema.safeParse(email).success ? email : undefined;
  const nextName =
    name !== undefined && name.length >= 2 && name.length <= 200 && isPrintable(name) ? name : undefined;
  return {
    reason: 'customer_synced',
    eventId: ctx.eventId,
    audit: ctx.audit,
    allowLegalNameChange: true,
    mutate: (current) => ({
      ...current,
      ...(nextEmail === undefined ? {} : { adminEmail: nextEmail }),
      company: { ...current.company, ...(nextName === undefined ? {} : { legalName: nextName }) },
    }),
  };
}

/** Reembolso integral dentro da garantia de 7 dias da contratação (o `createdAt` do cliente). */
export function isRefundWithinGuarantee(
  tenant: Tenant,
  charge: { amount: number; amountRefunded: number; refunded: boolean },
  at: Date,
): boolean {
  const full = charge.refunded && charge.amount > 0 && charge.amountRefunded >= charge.amount;
  return full && at.getTime() - tenant.createdAt.getTime() <= REFUND_GUARANTEE_MS;
}

/** Os itens mudaram (preço ou quantidade), comparados sem depender da ordem. */
export function itemsChanged(before: readonly StripeItem[] | undefined, now: readonly StripeItem[]): boolean {
  if (before === undefined) return false;
  const key = (items: readonly StripeItem[]): string =>
    items
      .map((item) => `${item.priceId}:${item.quantity ?? ''}`)
      .sort()
      .join('|');
  return key(before) !== key(now);
}

function latest(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
