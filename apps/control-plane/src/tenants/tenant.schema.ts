import { z } from 'zod';
import { ULID_PATTERN } from '../common/ulid.js';
import {
  configurationSchema,
  contractedConfigurationSchema,
  type DeploymentMode,
  nodeLimitsSchema,
  orderPricingSchema,
} from '../pricing/pricing.schema.js';

/**
 * Estados do cliente (plano §4b). `waiting_customer_install` é só do contrato direto com o ambiente na infraestrutura
 * do cliente (`hosting = customer`): o cliente nasce nele, com a versão e o guia para instalar, e nada roda na
 * infraestrutura da Verax.
 */
export const TENANT_STATES = [
  'pending',
  'provisioning',
  'provisioning_failed',
  'waiting_customer_install',
  'waiting_customer_connection',
  'active',
  'past_due',
  'suspended',
  'canceled',
  'deleted',
] as const;
export const tenantStateSchema = z.enum(TENANT_STATES);
export type TenantState = z.infer<typeof tenantStateSchema>;

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

/**
 * O nome do cliente (a razão social): até 120 caracteres em todo lugar (decisão do responsável, 05/11/2026), o limite
 * do nó (`Tenant.name` é `VarChar(120)`, e os schemas de cliente de `packages/shared` param em 120). O checkout, o
 * `customer.updated` da Stripe, o executor Terraform e o `envs/tenant` aceitam o mesmo, e o nó recebe o nome inteiro.
 */
export const COMPANY_NAME_MAX_LENGTH = 120;

/** Sem caracteres de controle (quebra de linha, tabulação, NUL): o nome vai a e-mail, painel e nota fiscal. */
function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * A razão social como o checkout e o `customer.updated` a aceitam: sem espaço nas pontas, de 2 a 120 caracteres e sem
 * caractere de controle. Contada como o zod e o nó a contam (o `length` do JS, em unidades UTF-16): nunca passa de 120
 * pontos de código, a conta do executor (`isTenantName`, `entrypoint.sh`), nem de 120 caracteres do Terraform.
 */
export const companyNameSchema = z
  .string()
  .trim()
  .min(2, { error: 'nome da empresa curto demais: no mínimo 2 caracteres' })
  .max(COMPANY_NAME_MAX_LENGTH, {
    error: `nome da empresa longo demais: no máximo ${COMPANY_NAME_MAX_LENGTH} caracteres`,
  })
  .refine(hasNoControlCharacters, { error: 'caracteres inválidos' });

const shortText = z.string().min(1).max(200);
/** Id de objeto da Stripe (`cus_...`, `sub_...`, `in_...`, `evt_...`): letras, números e sublinhado. */
export const stripeIdSchema = z.string().regex(/^[A-Za-z0-9_]{3,255}$/);
const stripeId = stripeIdSchema;

/**
 * Um item da assinatura como a Stripe o devolve na releitura: o preço, a quantidade e o `lookup_key` do preço. A
 * assinatura tem um item por componente cobrado (preço configurável); o plano de controle guarda a lista como veio e
 * não deduz a configuração dela (a configuração vem da cotação, no pedido da reserva).
 */
export const subscriptionItemSchema = z.strictObject({
  priceId: stripeId,
  quantity: z.number().int().min(0).max(1_000_000).optional(),
  lookupKey: z.string().min(1).max(200).optional(),
});
export type SubscriptionItem = z.infer<typeof subscriptionItemSchema>;

/**
 * Por que o cliente está suspenso (plano §4b e §4d): `unpaid` (a assinatura ficou não paga), `grace_expired` (a
 * carência de 7 dias venceu, pelo `tick` do CP-11), `fraud_review` (contestação ou alerta de fraude: decisão
 * humana; um pagamento não reativa sozinho) e `owner` (o responsável suspendeu um cliente de contrato direto, CP-11:
 * só ele reativa).
 */
export const SUSPENSION_REASONS = ['unpaid', 'grace_expired', 'fraud_review', 'owner'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/**
 * Como o cliente é cobrado: `stripe` (o checkout do site, o padrão quando o campo falta) ou `contract` (contrato
 * direto, criado pelo responsável no console, sem assinatura na Stripe; as faturas correm por fora). O relógio do
 * `tick` nunca suspende, cancela nem exclui um cliente `contract` por falta de evento da Stripe: para ele, suspensão,
 * cancelamento (com data) e reativação são só operações do responsável (CP-11).
 */
export const BILLING_MODES = ['stripe', 'contract'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/**
 * Onde o ambiente (o back end do cliente) roda, sem nome de provedor (decisão do responsável, 06/11/2026: hoje a
 * infraestrutura da Verax é a GCP, e pode mudar):
 * - `verax` (o padrão, quando o campo falta): na infraestrutura da Verax, criado pelo provisionamento (CP-07). É o
 *   único caminho do site (o checkout da Stripe) e o padrão do contrato direto;
 * - `customer`: na infraestrutura do próprio cliente, só por contrato direto (`billing.mode = contract`), escolhido
 *   pelo responsável no console. O plano de controle nunca provisiona, para, liga nem apaga nada dele: o cliente
 *   instala a versão publicada com o guia (`docs/runbooks/instalacao-no-cliente.md`) e apaga o próprio ambiente.
 */
export const HOSTINGS = ['verax', 'customer'] as const;
export type Hosting = (typeof HOSTINGS)[number];

/** O modo da tabela de preços de cada lugar: o ambiente gerenciado na Verax, a licença na infraestrutura do cliente. */
export const MODE_OF_HOSTING: Readonly<Record<Hosting, DeploymentMode>> = {
  verax: 'managed',
  customer: 'self_hosted',
};

/** Para onde o cliente volta quando a inadimplência acaba: o estado em que estava antes dela. */
export const RESUME_STATES = ['active', 'waiting_customer_connection'] as const;
export type ResumeState = (typeof RESUME_STATES)[number];

/**
 * As duas execuções da exclusão (plano §4d; docs/ARQUITETURA.md, "Exclusão em dois tempos"): `delete` é a Exclusão 1
 * (D+30, ou o `delete-now` do responsável) e `crypto_destroy`, a Exclusão 2 (D+97). Os mesmos nomes do `RUN_KIND` do
 * executor Terraform, o único lugar em que a conta de serviço do nó pode ser apagada.
 */
export const LIFECYCLE_RUN_KINDS = ['delete', 'crypto_destroy'] as const;
export type LifecycleRunKind = (typeof LIFECYCLE_RUN_KINDS)[number];

/** Quem pediu a Exclusão 1: o relógio (`tick`, `deleteAfter` vencido) ou o responsável (`delete-now`). */
export const DELETION_REQUESTERS = ['schedule', 'owner'] as const;
export type DeletionRequester = (typeof DELETION_REQUESTERS)[number];

/** A execução da exclusão em andamento: o passo atual e, se parou, o código (o `delete-now` recomeça). */
export const lifecycleRunSchema = z.strictObject({
  kind: z.enum(LIFECYCLE_RUN_KINDS),
  runId: z.string().regex(ULID_PATTERN),
  step: z.string().max(64),
  startedAt: z.date(),
  lastError: z.strictObject({ code: z.string().max(64), at: z.date() }).optional(),
});
export type LifecycleRun = z.infer<typeof lifecycleRunSchema>;

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
const tenantObjectSchema = z.strictObject({
  slug: slugSchema,
  state: tenantStateSchema,
  stateUpdatedAt: z.date(),
  /**
   * O que foi contratado: a configuração (o plano, o lugar, a franquia em GB/dia, que a medição do excedente e o
   * contador do painel usam, o porte e o histórico), os limites do nó (`node-limits.ts`, para o provisionamento e o
   * PR-18) e de qual tabela e cotação saiu o preço. Copiados do pedido da reserva, sem regra em cima: uma tabela nova
   * nunca muda um cliente existente. Um cliente contratado no modelo de preço anterior (portes, contas e volume mensal)
   * continua legível com a configuração de antes (`legacyConfigurationSchema`).
   */
  configuration: contractedConfigurationSchema,
  limits: nodeLimitsSchema,
  pricing: orderPricingSchema,
  priceId: stripeId.optional(),
  /**
   * A razão social entra pelo checkout e pelo `customer.updated`, ambos com `companyNameSchema` (até 120). A leitura
   * ainda aceita até 200, o limite antigo, para um cliente gravado antes continuar legível; o provisionamento o recusa
   * com `tenant_name_invalid` (`isTenantName`), em vez de cortar o nome.
   */
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
  /**
   * Onde o ambiente roda (`HOSTINGS`). Ausente é `verax` (`hostingOf`): todo cliente do checkout e todo contrato direto
   * de antes da escolha. `customer` só existe com `billing.mode = contract` e o modo `self_hosted` da tabela (conferido
   * abaixo, na leitura e na gravação).
   */
  hosting: z.enum(HOSTINGS).optional(),
  billing: z
    .strictObject({
      /** Ausente é `stripe` (`billingModeOf`). Quem cria o cliente de contrato direto (o console) grava `contract`. */
      mode: z.enum(BILLING_MODES).optional(),
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
      /**
       * Quando a versão do nó (`nodeVersion`) ficou presa: o `terraform.apply` grava antes de disparar o primeiro Job
       * (CP-07). Daí em diante pode existir uma VM com essa versão instalada, mesmo que o `apply` tenha falhado depois,
       * e uma versão nova nos metadados não seria instalada (PR-N7): o `resume` mantém a presa, mesmo com outro
       * `NODE_RELEASE`.
       */
      nodeVersionPinnedAt: z.date().optional(),
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
      /**
       * O ID único da conta de serviço do nó (saída do Terraform, CP-07): é por ele que o papel de leitura na AWS do
       * cliente aceita o nó. Guardado para a frota (CP-12) notar uma conta recriada, o que o executor recusa.
       */
      serviceAccountUniqueId: z.string().max(32).optional(),
      /** O bucket de backups do nó (exportação sob pedido e Exclusão 2, CP-11). */
      backupsBucket: z.string().max(80).optional(),
      /**
       * Quando a senha da caixa de envio dos nós foi copiada para o cofre deste nó pela última vez (o passo
       * `secrets.smtp_password` e a recópia da troca de senha). Sem o campo, o nó não tem e-mail (`MAIL_TRANSPORT=none`)
       * e fica fora da recópia.
       */
      nodeMailPasswordAt: z.date().optional(),
    })
    .optional(),
  /** Apagado em `deleted`. */
  access: z
    .strictObject({
      passwordRevealedAt: z.date().optional(),
      revealEmailSentAt: z.date().optional(),
    })
    .optional(),
  /**
   * O ciclo de vida depois do cancelamento (plano §4d, CP-11). Os prazos (`exportUntil`, `deleteAfter`,
   * `cryptoDestroyAfter`) são gravados no cancelamento e contam dele; os carimbos dizem o que já aconteceu. Fica no
   * registro mínimo depois da Exclusão 2.
   */
  lifecycle: z
    .strictObject({
      canceledAt: z.date().optional(),
      exportUntil: z.date().optional(),
      deleteAfter: z.date().optional(),
      /** A Exclusão 1 terminou: recursos do nó, túnel, DNS e site apagados; e-mail e acesso apagados do cliente. */
      deletedAt: z.date().optional(),
      cryptoDestroyAfter: z.date().optional(),
      /** As versões de `vx-<slug>-credentials-key` foram destruídas (Exclusão 2). */
      cryptoDestroyedAt: z.date().optional(),
      deletionRequestedAt: z.date().optional(),
      deletionRequestedBy: z.enum(DELETION_REQUESTERS).optional(),
      /** O e-mail do registro de exclusão saiu (fica ausente se o SMTP não estava configurado). */
      deletionRecordSentAt: z.date().optional(),
      /** O bucket de backups foi apagado (Exclusão 2, quando a retenção dele já o esvaziou). */
      backupsBucketDeletedAt: z.date().optional(),
      /** A Exclusão 2 terminou: o cliente é o registro mínimo (plano §3). */
      purgedAt: z.date().optional(),
      /**
       * A VM foi parada pelo plano de controle (suspensão ou cancelamento) e ainda não foi religada: o `tick` religa só
       * a VM que ele mesmo parou, e nunca uma parada à mão pelo responsável.
       */
      nodeStoppedAt: z.date().optional(),
      /**
       * O plano de controle pediu à Google para parar a VM (antes da chamada, CP-11) e ela ainda não foi confirmada
       * parada e religada. Com ele, um cliente reativado no meio da parada é religado (pelo passo ou pelo `tick`), mesmo
       * que o pedido de ligar se perca.
       */
      nodeStopRequestedAt: z.date().optional(),
      /** Contrato direto: o cancelamento marcado pelo responsável para uma data futura (o `tick` cancela nela). */
      cancelScheduledFor: z.date().optional(),
      run: lifecycleRunSchema.optional(),
    })
    .optional(),
  lock: lockSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * O documento com as amarras entre os campos: o ambiente na infraestrutura do cliente é só de contrato direto, com a
 * licença da tabela (`self_hosted`), e o estado de espera da instalação é só dele. Um documento fora disso não é lido
 * nem gravado.
 */
export const tenantSchema = tenantObjectSchema.superRefine((tenant, ctx) => {
  const customer = tenant.hosting === 'customer';
  if (customer && tenant.billing?.mode !== 'contract') {
    ctx.addIssue({ code: 'custom', path: ['hosting'], message: 'só contrato direto roda no cliente' });
  }
  if (customer && tenant.configuration.mode !== MODE_OF_HOSTING.customer) {
    ctx.addIssue({
      code: 'custom',
      path: ['configuration', 'mode'],
      message: 'o modo do cliente é self_hosted',
    });
  }
  if (!customer && tenant.state === 'waiting_customer_install') {
    ctx.addIssue({ code: 'custom', path: ['state'], message: 'estado só do ambiente no cliente' });
  }
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
 * tenant. A configuração, os limites e o preço saem da cotação gravada (nunca do que o site mandou) e são copiados como
 * vieram, sem regra em cima (a tabela de preços pode mudar). Some com a reserva: o TTL apaga a reserva vencida, e a
 * liberação e a tomada (`taken`) regravam o documento sem ele.
 */
export const slugOrderSchema = z.strictObject({
  configuration: configurationSchema,
  limits: nodeLimitsSchema,
  pricing: orderPricingSchema,
  company: z.strictObject({ legalName: shortText, cnpj: cnpjSchema }),
  adminEmail: z.email(),
  consent: z.strictObject({ termsVersion: shortText, privacyVersion: shortText, dpaVersion: shortText }),
});

export type SlugOrder = z.infer<typeof slugOrderSchema>;

/**
 * O pedido como a reserva o guarda, na LEITURA: o de hoje ou um gravado antes da troca do modelo de preço (10/11/2026),
 * com a configuração do modelo anterior. Uma reserva aberta antes do deploy e paga depois (o boleto leva dias) precisa
 * continuar legível, senão o `checkout.session.completed` falharia ao ler o subdomínio e o cliente pago nunca seria
 * criado (e a repetição do evento falharia igual). Pedido novo é sempre gravado com `slugOrderSchema` (só o modelo de
 * hoje: `CheckoutStore.reserve`); o cliente aceita as duas configurações (`contractedConfigurationSchema`).
 */
export const storedSlugOrderSchema = slugOrderSchema.extend({ configuration: contractedConfigurationSchema });

export type StoredSlugOrder = z.infer<typeof storedSlugOrderSchema>;

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
  order: storedSlugOrderSchema.optional(),
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

/** Como o cliente é cobrado; sem o campo, `stripe` (todo cliente do checkout). */
export function billingModeOf(tenant: Pick<Tenant, 'billing'>): BillingMode {
  return tenant.billing?.mode ?? 'stripe';
}

/** Onde o ambiente roda; sem o campo, `verax` (todo cliente do checkout e os contratos diretos de antes da escolha). */
export function hostingOf(tenant: Pick<Tenant, 'hosting'>): Hosting {
  return tenant.hosting ?? 'verax';
}
