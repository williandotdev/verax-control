import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CheckoutStore } from '../checkout/checkout-store.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { isUlid, newUlid } from '../common/ulid.js';
import { FIRST_PROVISIONING_STEP, STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import {
  type CheckoutSessionSnapshot,
  type InvoiceSnapshot,
  isStripeInvalidRequest,
  isStripeNotFound,
  type PaymentRiskSnapshot,
  STRIPE_CLIENT,
  type StripeClient,
  type StripeItem,
  type SubscriptionSnapshot,
} from '../stripe/stripe-client.js';
import {
  type AuditContext,
  InvalidTransitionError,
  type NewTenant,
  SlugTakenError,
  TenantAlreadyExistsError,
  type TenantChange,
  type TenantChangeResult,
  TenantStore,
} from '../tenants/tenant-store.js';
import { slugSchema, type SlugOrder, type TenantRecord, type TenantState } from '../tenants/tenant.schema.js';
import {
  cancelTenant,
  customerChange,
  type DecisionContext,
  enterProvisioning,
  fraudReviewChange,
  invoicePaidChange,
  isRefundWithinGuarantee,
  itemsChanged,
  neverProvisioned,
  paymentFailedChange,
  subscriptionChange,
} from './billing-rules.js';
import { InvoiceStore } from './invoice-store.js';
import { type HandledEventType, PAYMENT_EVENT_TYPES } from './stripe-events.js';

export interface ProcessContext {
  eventId: string;
  type: HandledEventType;
  objectId: string;
  /** Quando o evento aconteceu (o `created` assinado). */
  occurredAt: Date;
  requestId?: string;
}

export type ProcessResult =
  | {
      outcome: 'applied' | 'ignored';
      reason: string;
      tenantId?: string;
      /** O cliente da sessão do Checkout existe agora: os eventos adiados dele podem ser reprocessados. */
      checkoutTenantId?: string;
    }
  | { outcome: 'deferred'; reason: string; tenantId: string; slug: string };

/**
 * Motivos que pedem o olho do responsável (linha `event=stripe_webhook_attention`, alerta em monitoring.tf). Nenhum
 * leva e-mail, CNPJ ou nome: só o motivo, o evento e o `tenantId`.
 */
export type AttentionReason =
  | 'orphan_payment'
  | 'fraud_review'
  | 'paid_while_fraud_review'
  | 'subscription_items_changed'
  | 'refund_outside_guarantee'
  | 'payment_failed_unexpected_state'
  | 'boleto_failed_unexpected_state'
  | 'reservation_missing'
  | 'tax_id_rejected'
  | 'consent_missing'
  | 'customer_mismatch'
  | 'other_subscription'
  | 'object_not_found'
  | 'transition_refused';

/** A sessão paga não tem de onde virar cliente (reserva sumida, slug de outro, sessão diferente). Decisão humana. */
export class ReservationMissingError extends Error {
  constructor(
    readonly tenantId: string,
    readonly slug: string,
    readonly reason: 'reservation_missing' | 'slug_conflict' | 'checkout_mismatch',
  ) {
    super(`a sessão paga do cliente ${tenantId} (${slug}) não tem reserva utilizável: ${reason}`);
    this.name = 'ReservationMissingError';
  }
}

export class StripeUnavailableError extends Error {
  constructor() {
    super('cliente da Stripe não configurado (STRIPE_SECRET_KEY)');
    this.name = 'StripeUnavailableError';
  }
}

/** Pagamentos que a sessão do Checkout já considera feitos: o cartão (`paid`) ou nada a pagar. */
const PAID_SESSION = new Set(['paid', 'no_payment_required']);
/** Fatura relida ainda sem pagamento (uma falha de cobrança deixa assim). */
const UNPAID_INVOICE = new Set(['open', 'uncollectible']);

/** CNPJ com a máscara da Receita (`12.ABC.345/01DE-35`), o formato do `br_cnpj` na Stripe. */
export function formatCnpj(cnpj: string): string {
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

/** O `tenantId` e o slug que o checkout (CP-03) pôs na sessão; `undefined` se a sessão não for de um checkout nosso. */
function checkoutReference(session: CheckoutSessionSnapshot): { tenantId: string; slug: string } | undefined {
  const tenantId = session.clientReferenceId;
  const slug = session.metadata['slug'];
  if (tenantId === null || !isUlid(tenantId) || session.metadata['tenantId'] !== tenantId) return undefined;
  if (slug === undefined || !slugSchema.safeParse(slug).success) return undefined;
  return { tenantId, slug };
}

function paymentMethodOf(
  session: CheckoutSessionSnapshot,
  subscription: SubscriptionSnapshot | undefined,
): 'card' | 'boleto' | undefined {
  const type = subscription?.defaultPaymentMethodType;
  if (type === 'card' || type === 'boleto') return type;
  // Só cartão e boleto são oferecidos (CP-03): o cartão paga na hora, o boleto fica `unpaid` até compensar.
  if (session.paymentStatus === 'unpaid') return 'boleto';
  if (session.paymentStatus === 'paid') return 'card';
  return undefined;
}

function copyItems(items: readonly StripeItem[]): StripeItem[] {
  return items.map((item) => ({ ...item }));
}

/**
 * O pedido da reserva vira o cliente (plano §4b, linha `pending`): o plano e os dados da empresa vêm do pedido como
 * foram gravados no checkout (o plano é copiado, sem regra nenhuma em cima dele), os ids e os itens vêm da releitura
 * da sessão e da assinatura. `priceId` só existe quando há um item só; a lista inteira fica em `stripe.items`.
 */
export function tenantFromOrder(
  slug: string,
  order: SlugOrder,
  session: CheckoutSessionSnapshot,
  subscription: SubscriptionSnapshot | undefined,
  acceptedAt: Date,
): NewTenant {
  const items = copyItems(subscription?.items ?? session.lineItems);
  const paymentMethodType = paymentMethodOf(session, subscription);
  return {
    slug,
    plan: order.plan,
    ...(items.length === 1 && items[0] !== undefined ? { priceId: items[0].priceId } : {}),
    company: { ...order.company },
    adminEmail: order.adminEmail,
    consent: { ...order.consent, acceptedAt, checkoutSessionId: session.id },
    stripe: {
      livemode: session.livemode,
      ...defined({
        customerId: session.customerId ?? subscription?.customerId,
        subscriptionId: session.subscriptionId,
        status: subscription?.status,
        paymentMethodType,
        currentPeriodEnd: subscription?.currentPeriodEnd,
        latestInvoiceId: subscription?.latestInvoiceId,
        cancelAt: subscription?.cancelAt,
      }),
      items,
    },
  };
}

/** Tira as chaves `null`/`undefined` (o schema do cliente aceita ausência, não `null`). */
function defined<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], null | undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], null | undefined> };
}

/**
 * O que cada um dos 13 eventos faz (plano §4b), sempre a partir da releitura na API da Stripe: o evento só diz o
 * que olhar. A decisão sai do objeto relido e do estado atual do cliente, dentro da transação (`TenantStore.change`),
 * então a mesma entrega repetida, eventos fora de ordem e entregas simultâneas chegam ao mesmo lugar. Os efeitos fora
 * do Firestore (cancelar a assinatura, gravar o `br_cnpj`, enfileirar o `preflight`) são idempotentes e decididos
 * pelo estado resultante, para que a repetição de uma entrega que falhou no meio complete o que faltou.
 */
@Injectable()
export class StripeEventProcessor {
  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripeClient: StripeClient | null,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tenants: TenantStore,
    private readonly invoices: InvoiceStore,
    private readonly checkouts: CheckoutStore,
    @InjectPinoLogger(StripeEventProcessor.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Um objeto que a releitura não acha (404: apagado, ou de outra conta) não vai aparecer numa repetição: o evento fica
   * `ignored`, com aviso. Qualquer outro erro sobe, e a entrega falha (a Stripe repete).
   */
  async process(ctx: ProcessContext): Promise<ProcessResult> {
    try {
      return await this.dispatch(ctx);
    } catch (error) {
      if (!isStripeNotFound(error)) throw error;
      this.attention(ctx, 'object_not_found');
      return ignored('object_not_found');
    }
  }

  private async dispatch(ctx: ProcessContext): Promise<ProcessResult> {
    switch (ctx.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed':
        return this.onCheckoutSession(ctx);
      case 'checkout.session.expired':
        return this.onCheckoutExpired(ctx);
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.onSubscription(ctx);
      case 'invoice.paid':
      case 'invoice.payment_failed':
        return this.onInvoice(ctx);
      case 'charge.refunded':
        return this.onRefund(ctx);
      case 'charge.dispute.created':
        return this.onPaymentRisk(ctx, await this.stripe().retrieveDispute(ctx.objectId));
      case 'radar.early_fraud_warning.created':
        return this.onPaymentRisk(ctx, await this.stripe().retrieveEarlyFraudWarning(ctx.objectId));
      case 'customer.updated':
        return this.onCustomer(ctx);
    }
  }

  // --- Sessão do Checkout -------------------------------------------------------------------------------------

  /**
   * `completed`, `async_payment_succeeded` e `async_payment_failed`: qualquer um deles, chegando primeiro, transforma a
   * reserva no cliente (a sessão relida como `complete` é a prova), grava o `br_cnpj` no Customer e então aplica o
   * pagamento: sessão paga → `provisioning`; boleto ainda não pago → espera em `pending`; boleto vencido →
   * cancela a assinatura, `canceled` e libera o slug.
   */
  private async onCheckoutSession(ctx: ProcessContext): Promise<ProcessResult> {
    const session = await this.stripe().retrieveCheckoutSession(ctx.objectId);
    const reference = checkoutReference(session);
    if (reference === undefined || session.mode !== 'subscription') return ignored('foreign_session');
    if (session.status !== 'complete') return ignored('session_not_complete', reference.tenantId);
    if (!session.termsAccepted) this.attention(ctx, 'consent_missing', reference.tenantId);

    const { tenant, created } = await this.ensureTenant(session, reference, ctx);
    const taxIdCreated = await this.ensureTaxId(tenant, ctx);
    const base = { tenantId: tenant.id, checkoutTenantId: tenant.id };
    let changed = created || taxIdCreated;

    if (ctx.type === 'checkout.session.async_payment_failed') {
      const failed = await this.onBoletoFailed(tenant, session, ctx);
      changed ||= failed;
      return { outcome: changed ? 'applied' : 'ignored', reason: 'boleto_failed', ...base };
    }
    if (PAID_SESSION.has(session.paymentStatus)) {
      const reason = ctx.type === 'checkout.session.completed' ? 'checkout_paid' : 'boleto_paid';
      changed = (await this.provision(tenant.id, ctx, reason)) || changed;
      return { outcome: changed ? 'applied' : 'ignored', reason, ...base };
    }
    return { outcome: changed ? 'applied' : 'ignored', reason: 'awaiting_payment', ...base };
  }

  /** A reserva vira o cliente com o mesmo id; se outra entrega já o criou, devolve o existente. */
  private async ensureTenant(
    session: CheckoutSessionSnapshot,
    reference: { tenantId: string; slug: string },
    ctx: ProcessContext,
  ): Promise<{ tenant: TenantRecord; created: boolean }> {
    const existing = await this.tenants.get(reference.tenantId);
    if (existing !== undefined) {
      if (existing.consent?.checkoutSessionId !== session.id) {
        this.attention(ctx, 'reservation_missing', reference.tenantId);
        throw new ReservationMissingError(reference.tenantId, reference.slug, 'checkout_mismatch');
      }
      return { tenant: existing, created: false };
    }
    const reservation = await this.tenants.getSlug(reference.slug);
    if (
      reservation?.state !== 'reserved' ||
      reservation.tenantId !== reference.tenantId ||
      reservation.checkoutSessionId !== session.id ||
      reservation.order === undefined
    ) {
      // Pago, mas sem o pedido (reserva vencida e apagada, ou tomada por outro checkout depois de 2 h 30): não há de
      // onde tirar o CNPJ. Falha (a Stripe repete por 3 dias) e alerta: o responsável resolve à mão.
      this.attention(ctx, 'reservation_missing', reference.tenantId);
      throw new ReservationMissingError(reference.tenantId, reference.slug, 'reservation_missing');
    }
    const subscription =
      session.subscriptionId === null
        ? undefined
        : await this.stripe().retrieveSubscription(session.subscriptionId);
    const input = tenantFromOrder(reference.slug, reservation.order, session, subscription, ctx.occurredAt);
    try {
      const tenant = await this.tenants.create(input, {
        tenantId: reference.tenantId,
        reason: ctx.type,
        eventId: ctx.eventId,
        audit: this.audit(ctx),
      });
      return { tenant, created: true };
    } catch (error) {
      if (!(error instanceof TenantAlreadyExistsError) && !(error instanceof SlugTakenError)) throw error;
      // Outra entrega (outro evento da mesma sessão) criou o cliente entre a leitura e a criação.
      const raced = await this.tenants.get(reference.tenantId);
      if (raced !== undefined) return { tenant: raced, created: false };
      this.attention(ctx, 'reservation_missing', reference.tenantId);
      throw new ReservationMissingError(reference.tenantId, reference.slug, 'slug_conflict');
    }
  }

  /**
   * O CNPJ vai ao Customer como `br_cnpj` (plano §4a: a Stripe não coleta CNPJ do Brasil no Checkout). Idempotente:
   * um ID fiscal igual já gravado não é repetido. Se a Stripe recusar o valor (400), o cliente segue e o responsável
   * é avisado; outro erro faz a entrega falhar, e a repetição tenta de novo.
   */
  private async ensureTaxId(tenant: TenantRecord, ctx: ProcessContext): Promise<boolean> {
    const customerId = tenant.stripe?.customerId;
    if (customerId === undefined) return false;
    try {
      const result = await this.stripe().ensureTaxId(
        customerId,
        { type: 'br_cnpj', value: formatCnpj(tenant.company.cnpj) },
        `tax-id-br-cnpj-${tenant.id}`,
      );
      return result === 'created';
    } catch (error) {
      if (!isStripeInvalidRequest(error)) throw error;
      this.attention(ctx, 'tax_id_rejected', tenant.id);
      return false;
    }
  }

  /**
   * Boleto do 1.º ciclo vencido (plano §4b, linha `canceled`): a Stripe não cancela a assinatura sozinha (ela pode
   * ficar `active` sem pagamento), então o plano de controle cancela pela API, leva o cliente de `pending` a
   * `canceled` sem provisionar e libera o subdomínio.
   */
  private async onBoletoFailed(
    tenant: TenantRecord,
    session: CheckoutSessionSnapshot,
    ctx: ProcessContext,
  ): Promise<boolean> {
    if (PAID_SESSION.has(session.paymentStatus)) return false;
    if (tenant.state !== 'pending' && tenant.state !== 'canceled') {
      this.attention(ctx, 'boleto_failed_unexpected_state', tenant.id);
      return false;
    }
    let changed = await this.cancelStripeSubscription(tenant, 'boleto');
    const result = await this.applyChange(ctx, tenant.id, (current) =>
      current.state === 'pending' ? cancelTenant(current, this.decision(ctx), 'boleto_expired') : undefined,
    );
    changed = (result?.changed ?? false) || changed;
    changed = (await this.releaseIfNeverProvisioned(result?.tenant ?? tenant, ctx)) || changed;
    return changed;
  }

  /** Sessão vencida sem pagamento: a reserva do subdomínio é desfeita (plano §4a, passo 5). */
  private async onCheckoutExpired(ctx: ProcessContext): Promise<ProcessResult> {
    const session = await this.stripe().retrieveCheckoutSession(ctx.objectId);
    const reference = checkoutReference(session);
    if (reference === undefined) return ignored('foreign_session');
    if (session.status !== 'expired') return ignored('session_not_expired', reference.tenantId);
    const released = await this.checkouts.release(
      reference,
      'checkout_expired',
      ctx.requestId,
      this.audit(ctx).actor,
    );
    return released
      ? { outcome: 'applied', reason: 'reservation_released', tenantId: reference.tenantId }
      : ignored('reservation_not_found', reference.tenantId);
  }

  // --- Assinatura ---------------------------------------------------------------------------------------------

  private async onSubscription(ctx: ProcessContext): Promise<ProcessResult> {
    const subscription = await this.stripe().retrieveSubscription(ctx.objectId);
    const tenant = await this.resolveTenant(ctx, {
      tenantId: subscription.metadata['tenantId'],
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
    });
    if (tenant === undefined) return this.deferOrIgnore(ctx, subscription.metadata);
    if (tenant.stripe?.subscriptionId !== undefined && tenant.stripe.subscriptionId !== subscription.id) {
      this.attention(ctx, 'other_subscription', tenant.id);
      return ignored('other_subscription', tenant.id);
    }
    const result = await this.applyChange(ctx, tenant.id, (current) =>
      subscriptionChange(current, subscription, this.decision(ctx)),
    );
    if (result === undefined) return ignored('transition_refused', tenant.id);
    if (itemsChanged(result.before.stripe?.items, subscription.items)) {
      // Troca de preço ou quantidade: registrada nos itens; o plano não muda sozinho (item de suporte, plano §4b).
      this.attention(ctx, 'subscription_items_changed', tenant.id);
    }
    const released = await this.releaseIfNeverProvisioned(result.tenant, ctx);
    return outcomeOf(result.changed || released, result, 'subscription_synced', tenant.id);
  }

  // --- Faturas ------------------------------------------------------------------------------------------------

  private async onInvoice(ctx: ProcessContext): Promise<ProcessResult> {
    const invoice = await this.stripe().retrieveInvoice(ctx.objectId);
    if (invoice.subscriptionId === null) return ignored('not_subscription_invoice');
    const tenant = await this.resolveTenant(ctx, {
      tenantId: invoice.subscriptionMetadata['tenantId'],
      customerId: invoice.customerId,
      subscriptionId: invoice.subscriptionId,
    });
    if (tenant === undefined) return this.deferOrIgnore(ctx, invoice.subscriptionMetadata);
    if (invoice.status === 'paid') return this.onInvoicePaid(ctx, tenant, invoice);
    if (
      ctx.type === 'invoice.payment_failed' &&
      invoice.status !== null &&
      UNPAID_INVOICE.has(invoice.status)
    ) {
      const result = await this.applyChange(ctx, tenant.id, (current) =>
        paymentFailedChange(current, invoice, this.decision(ctx)),
      );
      const unexpected: TenantState[] = ['pending', 'provisioning', 'provisioning_failed'];
      if (
        invoice.billingReason !== 'subscription_create' &&
        unexpected.includes(result?.tenant.state ?? tenant.state)
      ) {
        this.attention(ctx, 'payment_failed_unexpected_state', tenant.id);
      }
      return outcomeOf(result?.changed ?? false, result, 'payment_failed', tenant.id);
    }
    return ignored('invoice_not_paid', tenant.id);
  }

  /** Fatura paga: grava em `invoices` (NFS-e manual) e aplica a regra (1.ª fatura provisiona; renovação reativa). */
  private async onInvoicePaid(
    ctx: ProcessContext,
    tenant: TenantRecord,
    invoice: InvoiceSnapshot,
  ): Promise<ProcessResult> {
    const recorded = await this.invoices.record(tenant.id, invoice, tenant.stripe?.paymentMethodType, {
      ...this.audit(ctx),
      eventId: ctx.eventId,
    });
    const runId = newUlid(this.clock.now().getTime());
    const result = await this.applyChange(ctx, tenant.id, (current) =>
      invoicePaidChange(current, invoice, this.decision(ctx), runId),
    );
    const after = result?.tenant ?? tenant;
    const enqueued = await this.ensurePreflight(after);
    if (after.state === 'suspended' && after.billing?.suspendedReason === 'fraud_review') {
      this.attention(ctx, 'paid_while_fraud_review', tenant.id);
    }
    const changed = recorded !== 'unchanged' || (result?.changed ?? false) || enqueued;
    return outcomeOf(changed, result, 'invoice_paid', tenant.id);
  }

  // --- Reembolso, contestação e fraude ------------------------------------------------------------------------

  /**
   * Reembolso integral dentro da garantia de 7 dias da contratação (plano §4b): cancela a assinatura na API e leva o
   * cliente a `canceled`. Parcial, ou fora do prazo, não muda nada e vira aviso (decisão humana).
   */
  private async onRefund(ctx: ProcessContext): Promise<ProcessResult> {
    const charge = await this.stripe().retrieveCharge(ctx.objectId);
    const tenant = await this.resolveTenant(ctx, { customerId: charge.customerId });
    if (tenant === undefined) return this.unknownTenant(ctx);
    if (charge.amountRefunded === 0) return ignored('not_refunded', tenant.id);
    if (tenant.state === 'canceled' || tenant.state === 'deleted')
      return ignored('already_canceled', tenant.id);
    if (!isRefundWithinGuarantee(tenant, charge, ctx.occurredAt)) {
      this.attention(ctx, 'refund_outside_guarantee', tenant.id);
      return ignored('refund_outside_guarantee', tenant.id);
    }
    let changed = await this.cancelStripeSubscription(tenant, 'refund');
    const result = await this.applyChange(ctx, tenant.id, (current) =>
      cancelTenant(current, this.decision(ctx), 'refund_guarantee'),
    );
    changed = (result?.changed ?? false) || changed;
    changed = (await this.releaseIfNeverProvisioned(result?.tenant ?? tenant, ctx)) || changed;
    return outcomeOf(changed, result, 'refund_guarantee', tenant.id);
  }

  /** Contestação ou alerta de fraude: `suspended` com `fraud_review`, e o responsável decide (plano §4b). */
  private async onPaymentRisk(ctx: ProcessContext, risk: PaymentRiskSnapshot): Promise<ProcessResult> {
    let customerId = risk.customerId;
    if (customerId === null && risk.chargeId !== null) {
      customerId = (await this.stripe().retrieveCharge(risk.chargeId)).customerId;
    }
    const tenant = await this.resolveTenant(ctx, { customerId });
    if (tenant === undefined) return this.unknownTenant(ctx);
    const result = await this.applyChange(ctx, tenant.id, (current) =>
      fraudReviewChange(current, this.decision(ctx)),
    );
    const state = result?.tenant.state ?? tenant.state;
    if (state === 'suspended') this.attention(ctx, 'fraud_review', tenant.id);
    return outcomeOf(result?.changed ?? false, result, 'fraud_review', tenant.id);
  }

  // --- Customer -----------------------------------------------------------------------------------------------

  private async onCustomer(ctx: ProcessContext): Promise<ProcessResult> {
    const customer = await this.stripe().retrieveCustomer(ctx.objectId);
    if (customer.deleted) return ignored('customer_deleted');
    const tenant = await this.tenants.findByStripeCustomer(customer.id);
    if (tenant === undefined) return ignored('unknown_tenant');
    const result = await this.applyChange(ctx, tenant.id, (current) =>
      customerChange(current, customer, this.decision(ctx)),
    );
    return outcomeOf(result?.changed ?? false, result, 'customer_synced', tenant.id);
  }

  // --- Apoio --------------------------------------------------------------------------------------------------

  /** Entra em `provisioning` (de `pending`) e garante o `preflight` na fila. `true` se algo mudou. */
  private async provision(tenantId: string, ctx: ProcessContext, reason: string): Promise<boolean> {
    const runId = newUlid(this.clock.now().getTime());
    const result = await this.applyChange(ctx, tenantId, (current) =>
      enterProvisioning(current, this.decision(ctx), runId, reason),
    );
    const enqueued = result === undefined ? false : await this.ensurePreflight(result.tenant);
    return (result?.changed ?? false) || enqueued;
  }

  /**
   * O cliente está em `provisioning` esperando o 1.º passo: enfileira o `preflight` da execução gravada. Repetir não
   * cria outra task (id `preflight-<runId>`); é o que completa uma entrega que mudou o estado e falhou ao enfileirar.
   */
  private async ensurePreflight(tenant: TenantRecord): Promise<boolean> {
    const runId = tenant.provisioning?.runId;
    if (
      tenant.state !== 'provisioning' ||
      tenant.provisioning?.step !== FIRST_PROVISIONING_STEP ||
      runId === undefined
    ) {
      return false;
    }
    const { created } = await this.queue.enqueue({
      queue: 'provisioning',
      step: FIRST_PROVISIONING_STEP,
      tenantId: tenant.id,
      runId,
    });
    return created;
  }

  /**
   * Cancela a assinatura na Stripe, se ainda não estiver encerrada (idempotente: relê antes; a chave de idempotência
   * cobre a repetição da mesma chamada). `true` se cancelou agora.
   */
  private async cancelStripeSubscription(tenant: TenantRecord, why: 'boleto' | 'refund'): Promise<boolean> {
    const subscriptionId = tenant.stripe?.subscriptionId;
    if (subscriptionId === undefined) return false;
    const subscription = await this.stripe().retrieveSubscription(subscriptionId);
    if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') return false;
    await this.stripe().cancelSubscription(subscriptionId, `cancel-${why}-${tenant.id}`);
    return true;
  }

  /** Cancelado sem nunca ter provisionado: o subdomínio volta a ficar livre (nenhum recurso `vx-<slug>` existe). */
  private async releaseIfNeverProvisioned(tenant: TenantRecord, ctx: ProcessContext): Promise<boolean> {
    if (tenant.state !== 'canceled' || !neverProvisioned(tenant)) return false;
    return this.tenants.releaseSlug(tenant.id, tenant.slug, 'canceled_before_provisioning', this.audit(ctx));
  }

  /**
   * O cliente do evento: pelo `tenantId` dos metadados da assinatura (gravados pelo checkout), senão pelo Customer,
   * senão pela assinatura. Um `tenantId` cujo Customer não bate com o do evento não é usado (aviso).
   */
  private async resolveTenant(
    ctx: ProcessContext,
    hints: { tenantId?: string; customerId?: string | null; subscriptionId?: string | null },
  ): Promise<TenantRecord | undefined> {
    if (hints.tenantId !== undefined && isUlid(hints.tenantId)) {
      const tenant = await this.tenants.get(hints.tenantId);
      if (tenant !== undefined) {
        const known = tenant.stripe?.customerId;
        if (known === undefined || hints.customerId == null || known === hints.customerId) return tenant;
        this.attention(ctx, 'customer_mismatch', tenant.id);
        return undefined;
      }
    }
    if (hints.customerId != null) {
      const tenant = await this.tenants.findByStripeCustomer(hints.customerId);
      if (tenant !== undefined) return tenant;
    }
    if (hints.subscriptionId != null) return this.tenants.findByStripeSubscription(hints.subscriptionId);
    return undefined;
  }

  /**
   * Evento de uma assinatura cujo cliente ainda não existe: se a reserva do checkout está lá (o
   * `checkout.session.completed` ainda vai chegar), o evento é adiado e reprocessado quando ela virar cliente; senão,
   * é ignorado (com alerta, se for de pagamento).
   */
  private async deferOrIgnore(
    ctx: ProcessContext,
    metadata: Readonly<Record<string, string>>,
  ): Promise<ProcessResult> {
    const tenantId = metadata['tenantId'];
    const slug = metadata['slug'];
    if (
      tenantId !== undefined &&
      isUlid(tenantId) &&
      slug !== undefined &&
      slugSchema.safeParse(slug).success
    ) {
      const reservation = await this.tenants.getSlug(slug);
      if (reservation?.state === 'reserved' && reservation.tenantId === tenantId) {
        return { outcome: 'deferred', reason: 'tenant_not_created', tenantId, slug };
      }
    }
    return this.unknownTenant(ctx);
  }

  private unknownTenant(ctx: ProcessContext): ProcessResult {
    if (PAYMENT_EVENT_TYPES.has(ctx.type)) this.attention(ctx, 'orphan_payment');
    return ignored('unknown_tenant');
  }

  /**
   * `TenantStore.change` com a recusa da tabela tratada: uma regra que propôs transição fora da tabela não deveria
   * existir; vira aviso e o evento fica `ignored`, em vez de falhar e ser repetido pela Stripe por 3 dias.
   */
  private async applyChange(
    ctx: ProcessContext,
    tenantId: string,
    decide: (current: TenantRecord) => TenantChange | undefined,
  ): Promise<TenantChangeResult | undefined> {
    try {
      return await this.tenants.change(tenantId, decide);
    } catch (error) {
      if (!(error instanceof InvalidTransitionError)) throw error;
      this.attention(ctx, 'transition_refused', tenantId);
      return undefined;
    }
  }

  private decision(ctx: ProcessContext): DecisionContext {
    return { eventId: ctx.eventId, at: ctx.occurredAt, audit: this.audit(ctx) };
  }

  private audit(ctx: ProcessContext): AuditContext {
    return { actor: `stripe:${ctx.eventId}`, requestId: ctx.requestId };
  }

  private attention(ctx: ProcessContext, reason: AttentionReason, tenantId?: string): void {
    this.logger.warn(
      { event: 'stripe_webhook_attention', reason, eventId: ctx.eventId, eventType: ctx.type, tenantId },
      'evento da Stripe pede a atenção do responsável',
    );
  }

  private stripe(): StripeClient {
    if (this.stripeClient === null) throw new StripeUnavailableError();
    return this.stripeClient;
  }
}

function ignored(reason: string, tenantId?: string): ProcessResult {
  return { outcome: 'ignored', reason, ...(tenantId === undefined ? {} : { tenantId }) };
}

/** `applied` se algo mudou; o motivo é o da transição, quando houve, ou o padrão do evento. */
function outcomeOf(
  changed: boolean,
  result: TenantChangeResult | undefined,
  fallback: string,
  tenantId: string,
): ProcessResult {
  const reason =
    result?.transitioned === true ? `${result.before.state}_to_${result.tenant.state}` : fallback;
  return { outcome: changed ? 'applied' : 'ignored', reason, tenantId };
}
