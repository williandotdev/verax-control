import { z } from 'zod';
import { adminEmailSchema, cnpjInputSchema, slugInputSchema } from '../checkout/checkout.schema.js';
import { ULID_PATTERN } from '../common/ulid.js';
import { AMENDABLE_PLANS } from '../pricing/contract-term.js';
import {
  type Configuration,
  type ContractedConfiguration,
  type ContractPricing,
  type ContractValues,
  contractValuesSchema,
  MAX_AMOUNT_CENTS,
  type NodeLimits,
  type OrderPricing,
  type PlanId,
  quoteInputSchema,
  type SizeId,
} from '../pricing/pricing.schema.js';
import type { ContactReason, Quote } from '../pricing/quote.js';
import type { RunKind } from '../provisioning/executor-env.js';
import type { NodeFitProblem } from '../provisioning/node-fit.js';
import type { ProvisioningStepName } from '../provisioning/provisioning-engine.js';
import {
  AMENDMENT_NOTE_MAX_LENGTH,
  type BillingMode,
  companyNameSchema,
  type ContractTerm,
  type Hosting,
  HOSTINGS,
  type LifecycleRunKind,
  type SuspensionReason,
  type TenantState,
} from '../tenants/tenant.schema.js';

/**
 * As formas da API dos clientes no console do responsável (`/v1/admin/tenants...`, só no cp-admin): a lista, o
 * detalhe com a linha do tempo do provisionamento, a cotação de referência, o cadastro de um cliente de contrato direto
 * e as operações do responsável, que o console pede ao cp-worker (`worker-owner-client.ts`). As telas leem os mesmos
 * tipos (`apps/console/src/lib/api-types.ts`, conferidos pelo teste de contrato).
 */

/**
 * Onde o ambiente do contrato direto roda, escolha obrigatória do responsável (sem padrão no formulário): na
 * infraestrutura da Verax (o provisionamento de sempre) ou na do cliente (nada é criado na Verax).
 */
export const hostingSchema = z.enum(HOSTINGS, {
  error: 'Escolha onde o ambiente roda: na infraestrutura da Verax ou na do cliente.',
});

/**
 * O plano e o volume em GB/dia, como no site: no contrato direto, o lugar é `hosting`, e o modo da tabela de preços sai
 * dele (`MODE_OF_HOSTING`: `managed` na Verax, `self_hosted` no cliente). Uma fonte só para as duas coisas. Os três
 * planos valem aqui (o site vende só a Plataforma); no cliente, só o Dedicado e o vCISO (a Plataforma é a célula da
 * Verax).
 */
export const directConfigurationSchema = quoteInputSchema;
export type DirectConfiguration = z.infer<typeof directConfigurationSchema>;

/**
 * `POST /v1/admin/tenants`: o cadastro de um cliente de contrato direto. Os campos do cliente com as mesmas regras e
 * limites do checkout do site; onde o ambiente roda (`hosting`); a configuração com o plano e o volume em GB/dia (o
 * preço de referência é o da tabela vigente, calculado como na infraestrutura da Verax nos dois lugares); e, opcional,
 * o contratado negociado (`contracted`). `idempotencyKey` é
 * um ULID gerado pelo console ao abrir o formulário: é o id do cliente, então enviar duas vezes cria um cliente só.
 * `confirmSlug` repete o subdomínio (a confirmação digitada).
 */
export const directTenantRequestSchema = z.strictObject({
  idempotencyKey: z.string().max(26).regex(ULID_PATTERN),
  companyName: companyNameSchema,
  cnpj: cnpjInputSchema,
  adminEmail: adminEmailSchema,
  slug: slugInputSchema,
  hosting: hostingSchema,
  configuration: directConfigurationSchema,
  /**
   * O contratado (o mensal e o GB/dia adicional, em centavos), que o console preenche com a referência da tabela e o
   * responsável pode mudar numa negociação por fora. Ausente, vale a referência da tabela.
   */
  contracted: contractValuesSchema.optional(),
  confirmSlug: z.string().max(64),
});
export type DirectTenantRequest = z.infer<typeof directTenantRequestSchema>;

/** `POST /v1/admin/tenants/preview`: a cotação de referência de uma configuração, antes do cadastro. */
export const directTenantPreviewSchema = z.strictObject({
  hosting: hostingSchema,
  configuration: directConfigurationSchema,
});

/**
 * As operações do responsável sobre um cliente, no console (`POST /v1/admin/tenants/:id/<operação>`), cada uma com o
 * subdomínio digitado como confirmação (`confirmSlug`), conferido no cp-admin e de novo no cp-worker:
 * - `start`: o início do provisionamento de um contrato direto em `pending` (o worker não respondeu no cadastro);
 * - `resume`: o provisionamento parado (CP-07);
 * - `cancel` (com `at`, a data do fim do contrato, opcional), `suspend` e `reactivate`: só contrato direto (CP-11);
 * - `delete-now`: a Exclusão 1 agora, de um cliente cancelado (CP-11);
 * - `export` (com `object`, o backup): o link de 24 h de um cliente cancelado, na janela de 30 dias (CP-11).
 */
export const TENANT_ACTIONS = [
  'start',
  'resume',
  'cancel',
  'suspend',
  'reactivate',
  'delete-now',
  'export',
] as const;
export type TenantAction = (typeof TENANT_ACTIONS)[number];

const confirmSlug = z.string().max(64);
export const tenantActionSchemas = {
  start: z.strictObject({ confirmSlug }),
  resume: z.strictObject({ confirmSlug }),
  cancel: z.strictObject({ confirmSlug, at: z.iso.datetime({ offset: true }).optional() }),
  suspend: z.strictObject({ confirmSlug }),
  reactivate: z.strictObject({ confirmSlug }),
  'delete-now': z.strictObject({ confirmSlug }),
  /** O nome do objeto que o worker aceita (`postgres/verax-<AAAAMMDD>T<HHMMSS>Z.dump`), conferido lá. */
  export: z.strictObject({ confirmSlug, object: z.string().min(1).max(200) }),
} as const satisfies Record<TenantAction, z.ZodType>;

/** Sem caractere de controle (quebra de linha, tabulação, NUL): a observação vai à auditoria e ao console. */
function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * `POST /v1/admin/tenants/:id/amend`: o aditivo de um contrato direto (decisão do responsável de 19/11/2026). O plano
 * (os três do cadastro; o SIEM Cloud só na infraestrutura da Verax), o volume em GB/dia e onde o ambiente roda, cotados de novo pela tabela
 * vigente com as mesmas regras do cadastro; o contratado negociado (`contracted`, ausente: a referência da tabela) e,
 * no vCISO, a implantação contratada (`contractedSetup`, em centavos; ausente: a da tabela); uma observação opcional
 * (`note`); e o subdomínio digitado como confirmação. Mudar `hosting` só vale antes de qualquer instalação
 * (`hostingChangeAllowed`).
 */
export const amendmentRequestSchema = z.strictObject({
  hosting: hostingSchema,
  configuration: z.strictObject({
    plan: z.enum(AMENDABLE_PLANS, {
      error: 'Escolha o plano: SIEM Cloud, SIEM Dedicado ou SIEM + vCISO.',
    }),
    gbDay: directConfigurationSchema.shape.gbDay,
  }),
  contracted: contractValuesSchema.optional(),
  contractedSetup: z.number().int().min(0).max(MAX_AMOUNT_CENTS).optional(),
  note: z
    .string()
    .trim()
    .min(1, { error: 'Observação vazia: deixe o campo em branco ou escreva o motivo.' })
    .max(AMENDMENT_NOTE_MAX_LENGTH, {
      error: `Observação longa demais: no máximo ${AMENDMENT_NOTE_MAX_LENGTH} caracteres.`,
    })
    .refine(hasNoControlCharacters, { error: 'Observação com caracteres inválidos.' })
    .optional(),
  confirmSlug,
});
export type AmendmentRequest = z.infer<typeof amendmentRequestSchema>;

/** O contrato como um aditivo o encontrou ou deixou. */
export interface ContractTermsView {
  hosting: Hosting;
  configuration: Configuration;
  limits: NodeLimits;
  pricing: OrderPricing;
  contractPricing?: ContractPricing;
  contractTerm?: ContractTerm;
}

/** Um aditivo no detalhe do cliente: quem, quando, a observação, o antes e o depois. */
export interface ContractAmendmentView {
  id: string;
  at: Date;
  by: string;
  note?: string;
  before: ContractTermsView;
  after: ContractTermsView;
  stateBefore: TenantState;
  stateAfter: TenantState;
  /** Os limites do nó mudaram com o ambiente já instalado: o nó em execução ainda não os tem. */
  nodeLimitsPending: boolean;
}

/** `POST /v1/admin/tenants/:id/amend`: o aditivo gravado. */
export interface ContractAmendmentResult {
  amendmentId: string;
  state: TenantState;
  hosting: Hosting;
  /** Onde o ambiente roda mudou: na Verax, o próximo passo é "Iniciar provisionamento"; no cliente, o código. */
  hostingChanged: boolean;
  nodeLimitsPending: boolean;
  contractTerm: ContractTerm;
}

/** Uma linha da lista de clientes. */
export interface TenantListItem {
  id: string;
  slug: string;
  companyName: string;
  state: TenantState;
  stateUpdatedAt: Date;
  billingMode: BillingMode;
  hosting: Hosting;
  /** O plano; ausente num cliente do modelo de preço anterior. */
  plan?: PlanId;
  size: SizeId;
  /** O passo do provisionamento, só em `provisioning` e `provisioning_failed`. */
  step?: string;
  /** O código da falha, só em `provisioning_failed`. */
  lastErrorCode?: string;
  createdAt: Date;
}

export interface TenantList {
  tenants: TenantListItem[];
  /** Documentos que não puderam ser lidos (fora do formato): ficam de fora, contados. */
  unreadable: number;
  /** O teto da lista (os mais novos primeiro). */
  limit: number;
}

export type TimelineStepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed';

/** Um passo do provisionamento na linha do tempo do console, na ordem do plano. */
export interface TimelineStep {
  name: ProvisioningStepName;
  status: TimelineStepStatus;
  attempts: number;
  startedAt?: Date;
  waitingSince?: Date;
  finishedAt?: Date;
  /** O código da falha (definitiva ou a última repetível); nunca uma mensagem de terceiro. */
  errorCode?: string;
}

export interface TenantTransitionView {
  from: TenantState | null;
  to: TenantState;
  reason: string;
  at: Date;
}

/** O ciclo de vida depois da venda (CP-11): os prazos e o que já aconteceu. */
export interface TenantLifecycleView {
  suspendedReason?: SuspensionReason;
  canceledAt?: Date;
  cancelScheduledFor?: Date;
  exportUntil?: Date;
  deleteAfter?: Date;
  deletedAt?: Date;
  cryptoDestroyAfter?: Date;
  cryptoDestroyedAt?: Date;
  purgedAt?: Date;
  nodeStoppedAt?: Date;
  /** A exclusão em andamento: a fase, o passo e, se parou, o código. */
  run?: { kind: LifecycleRunKind; step: string; startedAt: Date; lastError?: { code: string; at: Date } };
}

/**
 * O que o console oferece agora (a API confere de novo em cada operação, e o cp-worker de novo). `enrollmentCode`: gerar
 * o código de instalação da VM do cliente (`POST /v1/admin/tenants/:id/enrollment-code`). `amend`: o aditivo do
 * contrato (`POST /v1/admin/tenants/:id/amend`); `amendHosting`: o aditivo ainda pode mudar onde o ambiente roda (nada
 * instalado nem provisionado).
 */
export type TenantActions = Record<
  | 'start'
  | 'resume'
  | 'cancel'
  | 'suspend'
  | 'reactivate'
  | 'deleteNow'
  | 'export'
  | 'enrollmentCode'
  | 'amend'
  | 'amendHosting',
  boolean
>;

/** `GET /v1/admin/tenants/:id`. Nunca segredo, senha, token nem dado de cartão. */
export interface TenantDetail {
  id: string;
  slug: string;
  state: TenantState;
  stateUpdatedAt: Date;
  createdAt: Date;
  billingMode: BillingMode;
  /** Onde o ambiente roda (`verax` para todo cliente do site). */
  hosting: Hosting;
  company: { legalName: string; cnpj: string };
  adminEmail?: string;
  /** O contratado: no modelo por GB/dia ou, num cliente de antes dele, no modelo anterior (sem `plan`). */
  configuration: ContractedConfiguration;
  limits: NodeLimits;
  /** O preço de referência (contrato direto) ou o cotado no checkout. */
  pricing: OrderPricing;
  /** Só no contrato direto cadastrado com os valores do contrato: a referência da tabela e o contratado. */
  contractPricing?: ContractPricing;
  /** A vigência do contrato direto, gravada pelo último aditivo. */
  contractTerm?: ContractTerm;
  /** Os aditivos do contrato, do mais antigo ao mais novo. */
  amendments: ContractAmendmentView[];
  /**
   * Os endereços do painel (o site do Firebase) e da API (pelo túnel da Verax): no gerenciado e na VM do cliente, que
   * usa os mesmos. Ausentes só num cliente da VM própria que ainda não começou o provisionamento reduzido.
   */
  urls?: { panelUrl: string; apiUrl: string };
  provisioning?: {
    runId?: string;
    step?: string;
    attempts: number;
    lastError?: { code: string; at: Date };
    nodeVersion?: string;
  };
  run?: {
    runId: string;
    kind: RunKind;
    startedAt: Date;
    finishedAt?: Date;
    outcome?: 'succeeded' | 'failed';
    failureCode?: string;
    release?: string;
  };
  /**
   * Os passos do provisionamento: a sequência do gerenciado ou, na VM do cliente, a reduzida (vazia enquanto o primeiro
   * código de instalação não foi gerado).
   */
  timeline: TimelineStep[];
  access: { passwordRevealedAt?: Date; revealEmailSentAt?: Date };
  lifecycle: TenantLifecycleView;
  transitions: TenantTransitionView[];
  actions: TenantActions;
}

/**
 * `POST /v1/admin/tenants/preview`. Com preço, `reference` traz os valores da tabela que o console usa para preencher o
 * contratado: o mensal da cotação e o preço de um GB/dia a mais.
 */
export type DirectTenantPreview =
  | { priceTableVersion: string; contactUs: true; reason: ContactReason }
  | {
      priceTableVersion: string;
      contactUs: false;
      quote: Quote;
      reference: ContractValues;
      problems: NodeFitProblem[];
    };

/**
 * O que aconteceu com o pedido ao cp-worker depois do cadastro. Sem sucesso, o código estável que o console explica:
 * `worker_unavailable` (sem resposta: rede, a entrada do Cloud Run, um 5xx), `worker_refused` (o worker recusou a conta
 * do console), `worker_unconfigured` (o cp-admin sem `WORKER_URL`) ou um código do worker (`not_allowed`...).
 */
export type ProvisioningRequestOutcome =
  { started: true; runId: string; step: string } | { started: false; failure: string };

/** `POST /v1/admin/tenants`: o cliente (novo, ou o mesmo de antes com a mesma chave) e o início do provisionamento. */
export interface DirectTenantCreated {
  id: string;
  slug: string;
  /** `true` quando a chave já tinha criado este cliente (o mesmo envio repetido): nada novo foi criado. */
  replayed: boolean;
  hosting: Hosting;
  /** O pedido ao cp-worker; ausente no ambiente do cliente (nada é provisionado nem pedido ao worker). */
  provisioning?: ProvisioningRequestOutcome;
}

/** Uma linha do `node.conf` do cliente que o contrato define (o plano e os limites, `node-limits.ts`). */
export interface NodeConfLine {
  name: string;
  value: string;
}

/**
 * `GET /v1/admin/tenants/:id/installation`: o que o responsável manda ao cliente de contrato direto que instala o
 * ambiente na infraestrutura dele: a versão do nó (a que o provisionamento usaria agora, lida e conferida pelo
 * cp-worker), os endereços do release no GitHub, o pacote com o SHA-256, as imagens pelo digest, o guia de instalação
 * do repositório e as linhas do `node.conf` do contrato. Tudo público ou do próprio contrato: nada de segredo.
 */
export interface TenantInstallation {
  release: string;
  commit: string;
  releasedAt?: string;
  releaseUrl: string;
  manifestUrl: string;
  signatureUrl: string;
  guideUrl: string;
  package: { url: string; sha256: string };
  /**
   * O instalador da VM do cliente (`verax-install.sh`) e o SHA-256 dele, do manifesto assinado; ausente numa versão de
   * antes do instalador. É o que o comando do console baixa e confere antes de rodar com o código de uso único.
   */
  installer?: { url: string; sha256: string };
  images: { api: string; migrate: string };
  thirdPartyImages: string[];
  /** A chave de release que assinou o manifesto e a impressão digital dela (SHA-256 da pública em DER). */
  releaseKey: { name: string; sha256: string };
  /** O porte do contrato, para o console sugerir o perfil da VM (CPU, memória e disco). */
  size: SizeId;
  nodeConf: NodeConfLine[];
}

/**
 * `POST /v1/admin/tenants/:id/enrollment-code` `{confirmSlug}`: o código de instalação de uso único da VM do cliente,
 * mostrado uma vez (a resposta sai com `Cache-Control: private, no-store`). `reinstall`: a VM anterior já tinha se
 * registrado, e a chave dela deixou de valer. `runId` e `step`: a execução do provisionamento reduzido em andamento (a
 * que o primeiro código começou).
 */
export const enrollmentCodeRequestSchema = z.strictObject({ confirmSlug });

export interface EnrollmentCodeIssued {
  code: string;
  expiresAt: string;
  reinstall: boolean;
  runId?: string;
  step?: string;
}

/**
 * `POST /v1/admin/tenants/:id/reveal-access` `{confirmSlug}`: a revelação única da senha inicial pelo responsável, que
 * a copia e manda ao cliente. É **a** revelação (a mesma da página de status e do link do e-mail): marca
 * `access.passwordRevealedAt`, a versão do `admin-bootstrap` é destruída em seguida, e o link do cliente deixa de valer.
 * A resposta sai uma vez, com `Cache-Control: private, no-store`; a senha nunca vai à auditoria nem ao log.
 */
export const revealAccessRequestSchema = z.strictObject({ confirmSlug });

export interface AccessRevealed {
  panelUrl: string;
  adminEmail: string;
  password: string;
  /** Até quando a senha temporária vale (ISO); depois, só a renovação do runbook de onboarding (§7). */
  passwordExpiresAt: string;
}

/** `POST /v1/admin/tenants/:id/<operação>`: o que o cp-worker fez. */
export type TenantActionResult =
  | { action: 'start' | 'resume'; runId: string; step: string }
  | { action: 'cancel'; result: 'canceled'; deleteAfter?: string; cryptoDestroyAfter?: string }
  | { action: 'cancel'; result: 'scheduled'; cancelAt: string }
  | { action: 'suspend' | 'reactivate'; state: TenantState }
  | {
      action: 'delete-now';
      deletion: 'started' | 'restarted' | 'in_progress' | 'deleted' | 'purged';
      phase?: LifecycleRunKind;
    }
  /** O link assinado (24 h) de um backup: mostrado uma vez, nunca guardado nem registrado. */
  | { action: 'export'; url: string; expiresAt: string; object: string };
