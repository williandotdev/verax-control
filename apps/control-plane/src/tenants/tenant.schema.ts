import { z } from 'zod';
import { ULID_PATTERN } from '../common/ulid.js';

/** Estados do cliente (plano §4b). */
export const TENANT_STATES = [
  'pending',
  'provisioning',
  'provisioning_failed',
  'waiting_customer_connection',
  'active',
  'past_due',
  'suspended',
  'canceled',
  'deleted',
] as const;
export const tenantStateSchema = z.enum(TENANT_STATES);
export type TenantState = z.infer<typeof tenantStateSchema>;

/** Planos vendidos pelo marketplace (os demais planos do nó não passam pelo checkout). */
export const PLAN_IDS = ['essencial', 'profissional'] as const;
export const planIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof planIdSchema>;

/**
 * Subdomínio do cliente: 3 a 16 caracteres, para `vx-<slug>` caber nos nomes da GCP (plano §4a). Traços nas posições
 * 3 e 4 juntos ficam de fora: são reservados do DNS (RFC 5891), como o `xn--` dos domínios internacionalizados, e o
 * painel recusa abrir um endereço assim (`isTenantSlug`, em `apps/web/src/lib/tenant-address.ts`). As duas regras
 * andam juntas, para nunca vender um subdomínio que o painel não abre.
 */
export const slugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,14}[a-z0-9]$/, { error: 'subdomínio inválido' })
  .refine((value) => value.slice(2, 4) !== '--', { error: 'subdomínio inválido' });

/** Nomes que nenhum cliente recebe: endereços da própria Verax (plano §4a). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
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
]);

/** Um subdomínio que um cliente pode pedir: no formato e fora da lista reservada. */
export function isReservableSlug(value: string): boolean {
  return slugSchema.safeParse(value).success && !RESERVED_SLUGS.has(value);
}

/** CNPJ no formato alfanumérico da Receita (12 posições `[A-Z0-9]` e 2 dígitos). O DV é conferido no checkout. */
export const cnpjSchema = z.string().regex(/^[A-Z0-9]{12}[0-9]{2}$/, { error: 'CNPJ inválido' });

const shortText = z.string().min(1).max(200);
/** Id de objeto da Stripe (`cus_...`, `sub_...`, `in_...`, `evt_...`): letras, números e sublinhado. */
export const stripeIdSchema = z.string().regex(/^[A-Za-z0-9_]{3,255}$/);
const stripeId = stripeIdSchema;

/**
 * Um item da assinatura como a Stripe o devolve na releitura: o preço, a quantidade e o `lookup_key` do preço. A
 * assinatura pode ter vários (o preço por componente e quantidade está em estudo); o plano de controle guarda a
 * lista como veio e não deduz plano nenhum dela.
 */
export const subscriptionItemSchema = z.strictObject({
  priceId: stripeId,
  quantity: z.number().int().min(0).max(1_000_000).optional(),
  lookupKey: z.string().min(1).max(200).optional(),
});
export type SubscriptionItem = z.infer<typeof subscriptionItemSchema>;

/**
 * Por que o cliente está suspenso (plano §4b e §4d): `unpaid` (a assinatura ficou não paga), `grace_expired` (a
 * carência de 7 dias venceu, pelo `tick` do CP-11) e `fraud_review` (contestação ou alerta de fraude: decisão
 * humana; um pagamento não reativa sozinho).
 */
export const SUSPENSION_REASONS = ['unpaid', 'grace_expired', 'fraud_review'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/** Para onde o cliente volta quando a inadimplência acaba: o estado em que estava antes dela. */
export const RESUME_STATES = ['active', 'waiting_customer_connection'] as const;
export type ResumeState = (typeof RESUME_STATES)[number];

/** Trava por cliente dos passos do provisionamento: dono (`runId`) e vencimento (plano §4c). */
export const lockSchema = z.strictObject({
  owner: z.string().min(1).max(128),
  expiresAt: z.date(),
});
export type TenantLock = z.infer<typeof lockSchema>;

/**
 * Documento `tenants/{tenantId}` (plano §3). Estrito: um campo desconhecido faz a leitura falhar em vez de ser
 * apagado em silêncio pela gravação do documento inteiro. Nunca guarda segredo, senha, cartão nem token.
 */
export const tenantSchema = z.strictObject({
  slug: slugSchema,
  state: tenantStateSchema,
  stateUpdatedAt: z.date(),
  plan: planIdSchema,
  priceId: stripeId.optional(),
  company: z.strictObject({ legalName: shortText, cnpj: cnpjSchema }),
  /** Apagado em `deleted`. */
  adminEmail: z.email().optional(),
  consent: z
    .strictObject({
      termsVersion: shortText,
      privacyVersion: shortText,
      dpaVersion: shortText,
      acceptedAt: z.date(),
      checkoutSessionId: stripeId,
    })
    .optional(),
  stripe: z
    .strictObject({
      customerId: stripeId.optional(),
      subscriptionId: stripeId.optional(),
      status: z.string().max(64).optional(),
      paymentMethodType: z.enum(['card', 'boleto']).optional(),
      currentPeriodEnd: z.date().optional(),
      latestInvoiceId: stripeId.optional(),
      cancelAt: z.date().optional(),
      livemode: z.boolean(),
      /** Os itens da assinatura na última releitura (preço e quantidade), na ordem da Stripe. */
      items: z.array(subscriptionItemSchema).max(50).optional(),
    })
    .optional(),
  billing: z
    .strictObject({
      paidUntil: z.date().optional(),
      pastDueSince: z.date().optional(),
      graceUntil: z.date().optional(),
      unpaidSince: z.date().optional(),
      /** Só em `suspended`: o motivo decide se um pagamento reativa (`fraud_review` não reativa). */
      suspendedReason: z.enum(SUSPENSION_REASONS).optional(),
      /** Só em `past_due` e `suspended`: o estado ao qual o cliente volta quando a fatura em aberto for paga. */
      resumeState: z.enum(RESUME_STATES).optional(),
    })
    .optional(),
  provisioning: z
    .strictObject({
      runId: z.string().max(128).optional(),
      step: z.string().max(64).optional(),
      attempts: z.number().int().min(0),
      lastError: z.strictObject({ code: z.string().max(64), at: z.date() }).optional(),
      nodeVersion: z.string().max(64).optional(),
    })
    .optional(),
  /** Apagado em `deleted`. */
  resources: z
    .strictObject({
      nodesProject: z.string().max(64).optional(),
      zone: z.string().max(64).optional(),
      instanceName: z.string().max(64).optional(),
      namePrefix: z.string().max(64).optional(),
      subnetCidr: z.string().max(32).optional(),
      natIp: z.string().max(64).optional(),
      tunnelId: z.string().max(64).optional(),
      dnsRecordIds: z.array(z.string().max(64)).optional(),
      firebaseProject: z.string().max(64).optional(),
      siteId: z.string().max(64).optional(),
      panelDomainActive: z.boolean().optional(),
      tfstatePrefix: z.string().max(128).optional(),
    })
    .optional(),
  /** Apagado em `deleted`. */
  access: z
    .strictObject({
      passwordRevealedAt: z.date().optional(),
      revealEmailSentAt: z.date().optional(),
    })
    .optional(),
  lifecycle: z
    .strictObject({
      canceledAt: z.date().optional(),
      exportUntil: z.date().optional(),
      deleteAfter: z.date().optional(),
      deletedAt: z.date().optional(),
      cryptoDestroyAfter: z.date().optional(),
      cryptoDestroyedAt: z.date().optional(),
    })
    .optional(),
  lock: lockSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Tenant = z.infer<typeof tenantSchema>;

export interface TenantRecord extends Tenant {
  id: string;
}

/** Documento `tenants/{id}/transitions/{auto}`: o histórico de estados, com o evento da Stripe que o causou. */
export const transitionSchema = z.strictObject({
  from: tenantStateSchema.nullable(),
  to: tenantStateSchema,
  reason: z.string().min(1).max(200),
  eventId: stripeId.optional(),
  at: z.date(),
});

export type TenantTransition = z.infer<typeof transitionSchema>;

/** Estado da nota fiscal de serviço de uma fatura (plano §4f): `manual` na v1, sem emissor automático. */
export const NFSE_STATUSES = ['manual', 'pending', 'issued'] as const;

/**
 * Documento `tenants/{id}/invoices/{invoiceId}` (plano §3 e §4f): a fatura paga, como a releitura na Stripe a
 * mostrou. Guardado por 5 anos (obrigação fiscal). O período é o do serviço cobrado (o das linhas da fatura). A NFS-e
 * nasce `manual` e só o responsável a muda: a releitura de uma fatura já gravada nunca mexe em `nfse`.
 */
export const invoiceSchema = z.strictObject({
  amount: z.number().int().min(0),
  currency: z.string().regex(/^[a-z]{3}$/),
  status: z.string().min(1).max(32),
  billingReason: z.string().min(1).max(64).optional(),
  subscriptionId: stripeId.optional(),
  periodStart: z.date().optional(),
  periodEnd: z.date().optional(),
  paidAt: z.date().optional(),
  hostedInvoiceUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  paymentMethodType: z.enum(['card', 'boleto']).optional(),
  nfse: z.strictObject({ status: z.enum(NFSE_STATUSES), number: z.string().min(1).max(64).optional() }),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type InvoiceDocument = z.infer<typeof invoiceSchema>;

/**
 * O pedido feito no checkout (CP-03), guardado na reserva até virar cliente: é o que a Stripe não guarda (o CNPJ não
 * vai à sessão, e a Stripe não coleta CNPJ do Brasil) e o que o `checkout.session.completed` (CP-04) copia para o
 * tenant. O `plan` é copiado como veio, sem regra em cima dele (a tabela de preços pode mudar). Some com a reserva: o
 * TTL apaga a reserva vencida, e a liberação e a tomada (`taken`) regravam o documento sem ele.
 */
export const slugOrderSchema = z.strictObject({
  plan: planIdSchema,
  company: z.strictObject({ legalName: shortText, cnpj: cnpjSchema }),
  adminEmail: z.email(),
  consent: z.strictObject({ termsVersion: shortText, privacyVersion: shortText, dpaVersion: shortText }),
});

export type SlugOrder = z.infer<typeof slugOrderSchema>;

/**
 * Documento `slugs/{slug}` (plano §3): o checkout reserva o subdomínio (`reserved`, com o `tenantId` novo, o pedido,
 * `expiresAt` de 2 h 30 para o TTL e, depois de criada, o `checkoutSessionId` da sessão) e o
 * `checkout.session.completed` o toma para o cliente (`taken`, com o mesmo `tenantId`, sem `expiresAt` nem o pedido).
 * Fica `released` (volta a aceitar reserva) uma reserva desfeita (a Stripe falhou depois dela, ou a sessão venceu:
 * `checkout.session.expired`) e o subdomínio de um cliente cancelado que nunca provisionou nada (boleto do 1.º ciclo
 * vencido, CP-04). O id do documento é o próprio slug: dois clientes nunca nascem com o mesmo subdomínio, porque o
 * segundo `TenantStore.create` encontra o documento `taken` (ou falha no commit do `create`).
 */
export const slugDocumentSchema = z.strictObject({
  state: z.enum(['reserved', 'taken', 'released']),
  tenantId: z.string().regex(ULID_PATTERN).optional(),
  checkoutSessionId: stripeId.optional(),
  order: slugOrderSchema.optional(),
  updatedAt: z.date(),
  expiresAt: z.date().optional(),
});

export type SlugDocument = z.infer<typeof slugDocumentSchema>;

/**
 * O subdomínio está livre: sem documento, liberado, ou reservado com o prazo vencido (o TTL ainda não o apagou). Uma
 * reserva sem `expiresAt` nunca vence (não deveria existir; na dúvida, ocupado). `taken` nunca fica livre.
 */
export function isSlugFree(current: SlugDocument | undefined, now: Date): boolean {
  if (current === undefined || current.state === 'released') return true;
  if (current.state === 'taken') return false;
  return current.expiresAt !== undefined && current.expiresAt.getTime() <= now.getTime();
}
