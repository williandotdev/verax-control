import { z } from 'zod';

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

/** Subdomínio do cliente: 3 a 16 caracteres, para `vx-<slug>` caber nos nomes da GCP (plano §4a). */
export const slugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,14}[a-z0-9]$/, { error: 'subdomínio inválido' });

/** CNPJ no formato alfanumérico da Receita (12 posições `[A-Z0-9]` e 2 dígitos). O DV é conferido no checkout. */
export const cnpjSchema = z.string().regex(/^[A-Z0-9]{12}[0-9]{2}$/, { error: 'CNPJ inválido' });

const shortText = z.string().min(1).max(200);
const stripeId = z.string().regex(/^[A-Za-z0-9_]{3,255}$/);

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
    })
    .optional(),
  billing: z
    .strictObject({
      paidUntil: z.date().optional(),
      pastDueSince: z.date().optional(),
      graceUntil: z.date().optional(),
      unpaidSince: z.date().optional(),
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
