import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { tenantUrls } from '../access/tenant-urls.js';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { ENROLLMENT_CODE_STATES, ENROLLMENT_SECRET_PATTERN } from '../enrollment/enrollment.js';
import { equalValues } from '../firestore/document-store.js';
import type { RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { isUlid, ULID_PATTERN } from '../common/ulid.js';
import { NODE_RELEASE_PATTERN } from '../common/config/env.schema.js';
import { CONTRACT_CANCELABLE } from '../lifecycle/lifecycle-rules.js';
import { addMonths, contractMonthsFor } from '../pricing/contract-term.js';
import { nodeLimitsEnv } from '../pricing/node-limits.js';
import { LegacyVersionError, type OwnerContext, PricingTableStore } from '../pricing/pricing-store.js';
import {
  type Configuration,
  type ConfigurationInput,
  type ContractPricing,
  type ContractValues,
  isLegacyConfiguration,
  type PriceTable,
} from '../pricing/pricing.schema.js';
import { QuoteDailyLimitReachedError, QuoteStore } from '../pricing/quote-store.js';
import { type ContactReason, contractReference, quote } from '../pricing/quote.js';
import { isTenantEmail, isTenantName } from '../provisioning/executor-env.js';
import { type NodeFitProblem, nodeFitProblems } from '../provisioning/node-fit.js';
import { PROVISIONING_STEPS, stepsFor } from '../provisioning/provisioning-engine.js';
import { ProvisioningStore, type StepDocument } from '../provisioning/provisioning-store.js';
import { FIRST_PROVISIONING_STEP, isStepName } from '../queue/step-queue.js';
import {
  SlugTakenError,
  TenantAlreadyExistsError,
  TenantNotFoundError,
  TenantStore,
} from '../tenants/tenant-store.js';
import {
  billingModeOf,
  type ContractAmendment,
  type Hosting,
  hostingOf,
  isReservableSlug,
  isSlugFree,
  LIFECYCLE_RUN_KINDS,
  MODE_OF_HOSTING,
  type Tenant,
  type TenantRecord,
  tenantStateSchema,
} from '../tenants/tenant.schema.js';
import {
  amendmentRequestSchema,
  type ContractAmendmentResult,
  type ContractAmendmentView,
  type DirectConfiguration,
  type DirectTenantCreated,
  type DirectTenantPreview,
  type DirectTenantRequest,
  directTenantPreviewSchema,
  directTenantRequestSchema,
  type EnrollmentCodeIssued,
  enrollmentCodeRequestSchema,
  type ProvisioningRequestOutcome,
  type TenantAction,
  type TenantActionResult,
  type TenantActions,
  tenantActionSchemas,
  type TenantDetail,
  type TenantInstallation,
  type TenantLifecycleView,
  type TenantList,
  type TenantListItem,
  type TimelineStep,
} from './admin-tenants.schema.js';
import { type FieldIssue, invalidFields, invalidRequest } from './validation.js';
import type { OwnerCallResult, WorkerOwnerClient } from './worker-owner-client.js';

/** Quantos clientes a lista mostra (os mais novos primeiro). */
export const TENANT_LIST_LIMIT = 200;

/** O guia que o cliente segue para instalar o ambiente na infraestrutura dele (no repositório público). */
export const INSTALL_GUIDE_PATH = 'docs/runbooks/instalacao-no-cliente.md';

/**
 * Cadastros novos por responsável: o cadastro na infraestrutura da Verax cria um nó pago. Um responsável negocia poucos
 * contratos por dia; uma sessão do console sequestrada não cria dezenas de nós (nem dezenas de cadastros no cliente). Em
 * memória (o cp-admin tem no máximo uma instância).
 */
export const DIRECT_TENANT_CREATIONS: RateLimitRule = { capacity: 5, windowMs: 60 * 60_000 };
/** As operações do responsável (iniciar, retomar, cancelar, suspender, reativar, apagar, exportar) por responsável. */
export const TENANT_OPERATIONS: RateLimitRule = { capacity: 20, windowMs: 60 * 60_000 };

export const ADMIN_TENANT_LIMITS = Symbol('ADMIN_TENANT_LIMITS');
export interface AdminTenantLimits {
  creations: TokenBucketLimiter;
  operations: TokenBucketLimiter;
}

/** O cliente das operações do responsável no cp-worker; `null` sem `WORKER_URL` (as operações respondem 503). */
export const CONSOLE_WORKER_CLIENT = Symbol('CONSOLE_WORKER_CLIENT');

const PROBLEM_ISSUES: Readonly<Record<NodeFitProblem, (configuration: Configuration) => FieldIssue>> = {
  mode: () => ({
    path: 'configuration.mode',
    message: 'Só o modo gerenciado (na infraestrutura da Verax) é provisionado hoje.',
  }),
  size: (configuration) => ({
    path: 'configuration.gbDay',
    message: `Este volume pede o porte ${configuration.size}; o provisionamento cria só o porte P hoje.`,
  }),
  agents: (configuration) => ({
    path: 'configuration',
    message:
      configuration.mode === MODE_OF_HOSTING.customer
        ? 'Agentes nas instâncias ainda não têm instalação no ambiente do cliente (o guia não cobre).'
        : 'Agentes nas instâncias do cliente ainda não são provisionados.',
  }),
  limits: () => ({
    path: 'configuration.gbDay',
    message: 'Os limites deste volume ficam fora das faixas que o nó aceita.',
  }),
};

const CONTACT_ISSUES: Readonly<Record<ContactReason, FieldIssue>> = {
  above_online_max: {
    path: 'configuration.gbDay',
    message: 'Acima do máximo do SIEM Cloud na tabela: para mais volume, use o SIEM Dedicado.',
  },
  above_max: { path: 'configuration.gbDay', message: 'Acima do máximo cotável do plano na tabela.' },
  above_largest_size: {
    path: 'configuration.gbDay',
    message: 'Nenhum porte da tabela comporta este volume.',
  },
  mode_unavailable: {
    path: 'configuration.plan',
    message:
      'O SIEM Cloud roda só na célula da Verax: no ambiente do cliente, escolha o SIEM Dedicado ou o SIEM + vCISO.',
  },
};

/**
 * Os códigos do cp-worker (e os do caminho até ele) no erro que o console trata: o status, a mensagem e, quando o
 * problema é de um campo, o caminho dele. Nos 5xx a resposta leva só o código (a mensagem é a genérica), e o console
 * explica (`apps/console/src/features/tenants/labels.ts`).
 */
const WORKER_ERRORS: Readonly<Record<string, { status: HttpStatus; message: string; issue?: FieldIssue }>> = {
  not_found: { status: HttpStatus.NOT_FOUND, message: 'Cliente não encontrado.' },
  confirmation_mismatch: {
    status: HttpStatus.BAD_REQUEST,
    message: 'O subdomínio não confere com o do cliente: nada mudou.',
    issue: { path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' },
  },
  invalid_date: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A data do cancelamento tem de ser agora ou futura (até 2 anos).',
    issue: { path: 'at', message: 'A data do cancelamento tem de ser agora ou futura (até 2 anos).' },
  },
  invalid_object: {
    status: HttpStatus.BAD_REQUEST,
    message: 'O backup deve ser postgres/verax-<AAAAMMDD>T<HHMMSS>Z.dump.',
    issue: { path: 'object', message: 'O backup deve ser postgres/verax-<AAAAMMDD>T<HHMMSS>Z.dump.' },
  },
  not_resumable: { status: HttpStatus.CONFLICT, message: 'O cliente não está parado no provisionamento.' },
  not_allowed: { status: HttpStatus.CONFLICT, message: 'O cliente não está num estado que permita isso.' },
  stripe_managed: {
    status: HttpStatus.CONFLICT,
    message:
      'Cliente da Stripe: o provisionamento começa com o pagamento, e o cancelamento e a suspensão seguem a assinatura (Portal ou Dashboard da Stripe).',
  },
  customer_hosted: {
    status: HttpStatus.CONFLICT,
    message:
      'O ambiente deste cliente roda na infraestrutura dele: a Verax não provisiona, não para, não liga nem apaga nada lá.',
  },
  not_customer_hosted: {
    status: HttpStatus.CONFLICT,
    message: 'O ambiente deste cliente roda na infraestrutura da Verax: não há instalação para enviar.',
  },
  release_unconfigured: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'O cp-worker está sem a versão do nó (RELEASE_BUCKET e NODE_RELEASE).',
  },
  release_manifest_missing: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'O manifesto da versão do nó não está no bucket de releases.',
  },
  release_manifest_invalid: {
    status: HttpStatus.BAD_GATEWAY,
    message: 'O manifesto da versão do nó foi recusado (assinatura ou formato).',
  },
  release_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'O bucket de releases não respondeu.',
  },
  not_canceled: {
    status: HttpStatus.CONFLICT,
    message: 'Só um cliente cancelado pode ser excluído ou ter os dados exportados.',
  },
  export_window_closed: { status: HttpStatus.CONFLICT, message: 'A janela de 30 dias da exportação acabou.' },
  no_backups: { status: HttpStatus.NOT_FOUND, message: 'O cliente não tem bucket de backups.' },
  object_not_found: { status: HttpStatus.NOT_FOUND, message: 'Backup não encontrado.' },
  export_unavailable: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Exportação não configurada.' },
  export_check_failed: { status: HttpStatus.BAD_GATEWAY, message: 'O backup não pôde ser conferido.' },
  worker_refused: { status: HttpStatus.BAD_GATEWAY, message: 'O cp-worker recusou o console.' },
  worker_unconfigured: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Console sem o cp-worker.' },
  worker_unavailable: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'O cp-worker não respondeu.' },
};

/** Os 5xx do worker que têm significado próprio; qualquer outro é "o worker não respondeu". */
const MEANINGFUL_5XX: ReadonlySet<string> = new Set([
  'export_unavailable',
  'export_check_failed',
  'release_unconfigured',
  'release_manifest_missing',
  'release_manifest_invalid',
  'release_unavailable',
]);

/** O código estável de uma chamada ao worker que não deu certo. */
export function workerFailureOf(result: { status: number; code: string }): string {
  if (result.code === 'worker_unconfigured') return 'worker_unconfigured';
  if (result.status === 0 || result.code === 'worker_unreachable') return 'worker_unavailable';
  if (result.status === 401 || result.status === 403) return 'worker_refused';
  // Sem JSON: a entrada do Cloud Run (só de dentro do projeto) ou o balanceador, não o app do worker.
  if (result.code === 'worker_error') return 'worker_unavailable';
  if (result.status >= 500 && !MEANINGFUL_5XX.has(result.code)) return 'worker_unavailable';
  return Object.hasOwn(WORKER_ERRORS, result.code) ? result.code : 'worker_unavailable';
}

function workerError(failure: string): ApiError {
  const known = WORKER_ERRORS[failure] ?? WORKER_ERRORS['worker_unavailable'];
  const entry = known ?? { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'O cp-worker não respondeu.' };
  const code = failure === 'not_found' ? 'tenant_not_found' : failure;
  return new ApiError(
    entry.status,
    entry.message,
    code,
    entry.issue === undefined ? undefined : { issues: [entry.issue] },
  );
}

const isoDate = z.iso.datetime({ offset: true });
const runSchema = z.object({
  runId: z.string().regex(ULID_PATTERN),
  step: z.string().max(64).refine(isStepName),
});
/** O que o worker devolve em cada operação, conferido antes de chegar ao console. */
const RESULT_SCHEMAS = {
  start: runSchema,
  resume: runSchema,
  cancel: z.union([
    z.object({
      result: z.literal('canceled'),
      deleteAfter: isoDate.optional(),
      cryptoDestroyAfter: isoDate.optional(),
    }),
    z.object({ result: z.literal('scheduled'), cancelAt: isoDate }),
  ]),
  suspend: z.object({ state: tenantStateSchema }),
  reactivate: z.object({ state: tenantStateSchema }),
  'delete-now': z.object({
    deletion: z.enum(['started', 'restarted', 'in_progress', 'deleted', 'purged']),
    phase: z.enum(LIFECYCLE_RUN_KINDS).optional(),
  }),
  export: z.object({
    url: z.url({ protocol: /^https$/ }).max(4096),
    expiresAt: isoDate,
    object: z.string().min(1).max(200),
  }),
} as const satisfies Record<TenantAction, z.ZodType>;

/** Um endereço do release no GitHub (o worker os monta do manifesto assinado; aqui, conferidos de novo). */
const githubUrl = z
  .url({ protocol: /^https$/ })
  .max(500)
  .refine((url) => {
    const parsed = new URL(url);
    return parsed.hostname === 'github.com' && parsed.search === '' && parsed.hash === '';
  });
/** Uma imagem pelo digest: nunca uma tag sozinha. */
const imageRef = z
  .string()
  .max(300)
  .regex(/^[a-z0-9][A-Za-z0-9._/:-]{0,250}@sha256:[0-9a-f]{64}$/);
/** O que o worker devolve da instalação no cliente (`installation.ts`), conferido antes de chegar ao console. */
const INSTALLATION_SCHEMA = z.object({
  release: z.string().regex(NODE_RELEASE_PATTERN),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  releasedAt: isoDate.optional(),
  repositoryUrl: githubUrl,
  releaseUrl: githubUrl,
  manifestUrl: githubUrl,
  signatureUrl: githubUrl,
  package: z.object({ url: githubUrl, sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  installer: z.object({ url: githubUrl, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  images: z.object({ api: imageRef, migrate: imageRef }),
  thirdPartyImages: z.array(imageRef).min(1).max(20),
  releaseKey: z.object({
    name: z.string().regex(/^release-[a-z0-9-]{1,60}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

/** O que o worker devolve do código de instalação (`enrollment/`), conferido antes de chegar ao console. */
const ENROLLMENT_CODE_SCHEMA = z.strictObject({
  code: z.string().regex(ENROLLMENT_SECRET_PATTERN),
  expiresAt: isoDate,
  reinstall: z.boolean(),
  runId: z.string().regex(ULID_PATTERN).optional(),
  step: z.string().max(64).refine(isStepName).optional(),
});

/** O plano e o volume do contrato direto com o modo do lugar escolhido (a configuração que a cotação recebe). */
export function configurationFor(hosting: Hosting, configuration: DirectConfiguration): ConfigurationInput {
  return { ...configuration, mode: MODE_OF_HOSTING[hosting] };
}

function notFound(): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, 'Cliente não encontrado.', 'tenant_not_found');
}

function slugUnavailable(): ApiError {
  return new ApiError(HttpStatus.CONFLICT, 'Este subdomínio não está disponível.', 'slug_unavailable', {
    issues: [{ path: 'slug', message: 'Este subdomínio não está disponível. Escolha outro.' }],
  });
}

function rateLimited(): ApiError {
  return new ApiError(
    HttpStatus.TOO_MANY_REQUESTS,
    'Muitas operações em pouco tempo. Tente novamente mais tarde.',
    'rate_limited',
  );
}

/**
 * As operações que fazem sentido para o cliente agora (as regras são as do cp-worker, que confere de novo). Com o
 * ambiente na VM do cliente, gerar o código de instalação (que também recomeça um provisionamento parado), cancelar e
 * apagar: nada de suspender, reativar nem exportar, que agiriam numa VM que é do cliente.
 */
export function availableActions(tenant: TenantRecord, now: Date): TenantActions {
  const contract = billingModeOf(tenant) === 'contract';
  const verax = hostingOf(tenant) === 'verax';
  const lifecycle = tenant.lifecycle;
  return {
    start: verax && contract && tenant.state === 'pending',
    resume: verax && (tenant.state === 'provisioning_failed' || tenant.state === 'provisioning'),
    cancel: contract && CONTRACT_CANCELABLE.includes(tenant.state),
    suspend:
      verax &&
      contract &&
      (tenant.state === 'active' ||
        tenant.state === 'waiting_customer_connection' ||
        tenant.state === 'past_due'),
    reactivate:
      verax && contract && tenant.state === 'suspended' && tenant.billing?.suspendedReason === 'owner',
    enrollmentCode: !verax && ENROLLMENT_CODE_STATES.includes(tenant.state),
    amend: amendRefusalOf(tenant) === undefined,
    amendHosting: amendRefusalOf(tenant) === undefined && hostingChangeAllowed(tenant),
    deleteNow:
      tenant.state === 'canceled' ||
      (tenant.state === 'deleted' &&
        lifecycle?.purgedAt === undefined &&
        lifecycle?.run?.lastError !== undefined),
    export:
      verax &&
      tenant.state === 'canceled' &&
      lifecycle?.exportUntil !== undefined &&
      lifecycle.exportUntil.getTime() > now.getTime(),
  };
}

/** Por que um aditivo é recusado, num motivo que vale para o cliente inteiro (`undefined`: o aditivo cabe). */
export type AmendRefusal =
  'stripe_managed' | 'not_allowed' | 'legacy_configuration' | 'hosting_locked' | 'no_change';

/**
 * O contrato aceita um aditivo: contrato direto (o da Stripe segue a assinatura), fora do fim do contrato (cancelado ou
 * excluído) e no modelo por GB/dia (um contrato do modelo anterior não é cotado de novo).
 */
export function amendRefusalOf(tenant: Tenant): AmendRefusal | undefined {
  if (billingModeOf(tenant) !== 'contract') return 'stripe_managed';
  if (tenant.state === 'canceled' || tenant.state === 'deleted') return 'not_allowed';
  if (isLegacyConfiguration(tenant.configuration)) return 'legacy_configuration';
  return undefined;
}

/**
 * O aditivo ainda pode mudar onde o ambiente roda: nada instalado nem provisionado. Na Verax, o cliente em `pending`
 * sem execução do provisionamento (o "Iniciar provisionamento" ainda não foi usado, ou não chegou ao cp-worker); no
 * cliente, em `waiting_customer_install`, antes do primeiro código de instalação (que começa o provisionamento reduzido:
 * o túnel e o site na Verax). Nos dois, sem recurso nenhum criado. Depois disso, só o plano, o volume e os valores.
 */
export function hostingChangeAllowed(tenant: Tenant): boolean {
  if (tenant.provisioning?.runId !== undefined || tenant.resources !== undefined) return false;
  return hostingOf(tenant) === 'customer'
    ? tenant.state === 'waiting_customer_install' && tenant.enrollment?.claimedAt === undefined
    : tenant.state === 'pending';
}

/**
 * O nó do cliente já recebeu os limites do contrato: na Verax, o `terraform.apply` já prendeu a versão (daí em diante
 * pode existir uma VM com os limites gravados no `node.conf` dela); no cliente, a VM já fez o `claim` (que entrega as
 * linhas do `node.conf`). Os limites só chegam ao nó na instalação: não há hoje como empurrá-los a um nó em execução.
 */
export function nodeInstalled(tenant: Tenant): boolean {
  return hostingOf(tenant) === 'customer'
    ? tenant.enrollment?.claimedAt !== undefined
    : tenant.provisioning?.nodeVersionPinnedAt !== undefined || tenant.resources?.instanceName !== undefined;
}

/** A recusa de um aditivo dentro da transação (o cliente mudou entre a leitura e a gravação). */
class AmendmentRefusedError extends Error {
  constructor(readonly code: AmendRefusal) {
    super(`aditivo recusado: ${code}`);
    this.name = 'AmendmentRefusedError';
  }
}

const AMEND_ERRORS: Readonly<
  Record<AmendRefusal, { status: HttpStatus; message: string; issue?: FieldIssue }>
> = {
  stripe_managed: {
    status: HttpStatus.CONFLICT,
    message: 'Cliente da Stripe: o contrato segue a assinatura, e o aditivo é só do contrato direto.',
  },
  not_allowed: {
    status: HttpStatus.CONFLICT,
    message: 'O contrato já terminou (cancelado ou excluído): não há o que alterar.',
  },
  legacy_configuration: {
    status: HttpStatus.CONFLICT,
    message:
      'Contrato do modelo de preço anterior (antes do preço por GB/dia): o aditivo não o cota de novo. Fale com o desenvolvimento.',
  },
  hosting_locked: {
    status: HttpStatus.CONFLICT,
    message:
      'Onde o ambiente roda só muda antes de qualquer instalação: este ambiente já foi provisionado ou já teve o código de instalação gerado.',
    issue: {
      path: 'hosting',
      message:
        'O ambiente já começou a ser criado (provisionamento ou código de instalação): onde ele roda não muda mais num aditivo.',
    },
  },
  no_change: {
    status: HttpStatus.CONFLICT,
    message: 'Nada muda neste aditivo: o plano, o volume, onde roda e os valores são os mesmos de hoje.',
  },
};

function amendError(code: AmendRefusal): ApiError {
  const entry = AMEND_ERRORS[code];
  return new ApiError(
    entry.status,
    entry.message,
    code,
    entry.issue === undefined ? undefined : { issues: [entry.issue] },
  );
}

function amendmentViewOf(amendment: ContractAmendment & { id: string }): ContractAmendmentView {
  return {
    id: amendment.id,
    at: amendment.at,
    by: amendment.by,
    ...(amendment.note === undefined ? {} : { note: amendment.note }),
    before: amendment.before,
    after: amendment.after,
    stateBefore: amendment.stateBefore,
    stateAfter: amendment.stateAfter,
    nodeLimitsPending: amendment.nodeLimitsPending,
  };
}

function lifecycleOf(tenant: TenantRecord): TenantLifecycleView {
  const lifecycle = tenant.lifecycle ?? {};
  const dates = [
    'canceledAt',
    'cancelScheduledFor',
    'exportUntil',
    'deleteAfter',
    'deletedAt',
    'cryptoDestroyAfter',
    'cryptoDestroyedAt',
    'purgedAt',
    'nodeStoppedAt',
  ] as const;
  const view: TenantLifecycleView = {};
  for (const key of dates) {
    const value = lifecycle[key];
    if (value !== undefined) view[key] = value;
  }
  if (tenant.billing?.suspendedReason !== undefined) view.suspendedReason = tenant.billing.suspendedReason;
  if (lifecycle.run !== undefined) {
    const { kind, step, startedAt, lastError } = lifecycle.run;
    view.run = { kind, step, startedAt, ...(lastError === undefined ? {} : { lastError }) };
  }
  return view;
}

/**
 * Os clientes no console do responsável (só no cp-admin): a lista, o detalhe com a linha do tempo do provisionamento, a
 * cotação de referência, o cadastro de um cliente de contrato direto (sem checkout nem Stripe) e as operações do
 * responsável, que o console pede ao cp-worker em nome dele (`worker-owner-client.ts`: o token da conta do cp-admin e o
 * e-mail da sessão em `actor`; o cookie da sessão nunca sai daqui).
 *
 * O cadastro confere tudo de novo, com as regras do checkout e do provisionamento: os campos (os mesmos schemas), o
 * subdomínio (formato, lista reservada, livre), o nome e o e-mail como o nó os aceita, a tabela de preços vigente, a
 * cotação ("fale conosco" é recusado) e se o `envs/tenant` sabe criar o que foi pedido (`node-fit.ts`). Só então cria o
 * cliente com `billing.mode = contract` e o id da chave de idempotência. Onde o ambiente roda é escolha do responsável
 * (`hosting`, decisão de 06/11/2026):
 * - na infraestrutura da Verax: o cliente nasce em `pending` e o worker é chamado para o início do provisionamento, que
 *   segue exatamente os passos de um cliente pago (CP-07);
 * - na infraestrutura do cliente (só o Dedicado e o vCISO): a cotação de referência é calculada como na Verax (o
 *   mesmo preço por GB/dia), no modo `self_hosted` (a DRE sem a nuvem da Verax), o cliente nasce em `waiting_customer_install` e nada é pedido ao worker; o console mostra a versão e o guia para o cliente instalar
 *   (`installation`), e o ciclo de vida só registra o fim do contrato.
 * Os valores do contrato (`contractPricing`): a referência da tabela (o mensal da cotação e o preço de um GB/dia a mais,
 * `contractReference`) e o contratado, que o responsável pode ter negociado por fora (`contracted` no pedido; ausente,
 * a referência). Os dois ficam no cliente e na auditoria do cadastro.
 * Toda escrita e toda recusa vão à auditoria com `owner:<e-mail>`; os logs levam só ids, o subdomínio, o porte, as
 * versões e os códigos.
 */
@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly runs: ProvisioningStore,
    private readonly tables: PricingTableStore,
    private readonly quotes: QuoteStore,
    private readonly audit: AuditService,
    @Inject(CONSOLE_WORKER_CLIENT) private readonly worker: WorkerOwnerClient | null,
    @Inject(ADMIN_TENANT_LIMITS) private readonly limits: AdminTenantLimits,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(AdminTenantsService.name) private readonly logger: PinoLogger,
  ) {}

  async list(): Promise<TenantList> {
    const { tenants, unreadable } = await this.tenants.listRecent(TENANT_LIST_LIMIT);
    if (unreadable.length > 0) {
      this.logger.warn(
        { event: 'admin_tenant_unreadable', tenantIds: unreadable.slice(0, 20) },
        'cliente fora do formato na lista do console',
      );
    }
    return { tenants: tenants.map(listItemOf), unreadable: unreadable.length, limit: TENANT_LIST_LIMIT };
  }

  async detail(tenantId: string): Promise<TenantDetail> {
    if (!isUlid(tenantId)) throw notFound();
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) throw notFound();
    const hosting = hostingOf(tenant);
    const runId = tenant.provisioning?.runId;
    const [run, steps, transitions, amendments] = await Promise.all([
      runId === undefined ? undefined : this.runs.getRun(runId),
      runId === undefined ? new Map<string, StepDocument>() : this.runs.listSteps(runId),
      this.tenants.listTransitions(tenantId),
      this.tenants.listAmendments(tenantId),
    ]);
    // Na VM do cliente, a sequência reduzida, e só depois do primeiro código (antes, nenhum passo vai rodar).
    const names = hosting === 'customer' ? (runId === undefined ? [] : stepsFor(tenant)) : PROVISIONING_STEPS;
    const timeline: TimelineStep[] = names.map((name) => {
      const step = steps.get(name);
      if (step === undefined) return { name, status: 'pending', attempts: 0 };
      return {
        name,
        status: step.status,
        attempts: step.attempts,
        startedAt: step.startedAt,
        ...(step.waitingSince === undefined ? {} : { waitingSince: step.waitingSince }),
        ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }),
        ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
      };
    });
    const provisioning = tenant.provisioning;
    return {
      id: tenant.id,
      slug: tenant.slug,
      state: tenant.state,
      stateUpdatedAt: tenant.stateUpdatedAt,
      createdAt: tenant.createdAt,
      billingMode: billingModeOf(tenant),
      hosting,
      company: { legalName: tenant.company.legalName, cnpj: tenant.company.cnpj },
      ...(tenant.adminEmail === undefined ? {} : { adminEmail: tenant.adminEmail }),
      configuration: tenant.configuration,
      limits: tenant.limits,
      pricing: tenant.pricing,
      ...(tenant.contractPricing === undefined ? {} : { contractPricing: tenant.contractPricing }),
      ...(tenant.contractTerm === undefined ? {} : { contractTerm: tenant.contractTerm }),
      amendments: amendments.map(amendmentViewOf),
      // O painel e a API ficam na Verax também para a VM do cliente (o site e o túnel do provisionamento reduzido).
      ...(hosting === 'verax' || runId !== undefined ? { urls: tenantUrls(tenant.slug, this.config) } : {}),
      ...(provisioning === undefined
        ? {}
        : {
            provisioning: {
              attempts: provisioning.attempts,
              ...(provisioning.runId === undefined ? {} : { runId: provisioning.runId }),
              ...(provisioning.step === undefined ? {} : { step: provisioning.step }),
              ...(provisioning.lastError === undefined ? {} : { lastError: provisioning.lastError }),
              ...(provisioning.nodeVersion === undefined ? {} : { nodeVersion: provisioning.nodeVersion }),
            },
          }),
      ...(run === undefined || runId === undefined
        ? {}
        : {
            run: {
              runId,
              kind: run.kind,
              startedAt: run.startedAt,
              ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
              ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
              ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
              ...(run.release === undefined ? {} : { release: run.release.release }),
            },
          }),
      timeline,
      access: {
        ...(tenant.access?.passwordRevealedAt === undefined
          ? {}
          : { passwordRevealedAt: tenant.access.passwordRevealedAt }),
        ...(tenant.access?.revealEmailSentAt === undefined
          ? {}
          : { revealEmailSentAt: tenant.access.revealEmailSentAt }),
      },
      lifecycle: lifecycleOf(tenant),
      transitions: transitions.map(({ from, to, reason, at }) => ({ from, to, reason, at })),
      actions: availableActions(tenant, this.clock.now()),
    };
  }

  /**
   * A cotação de referência pela tabela vigente, no plano e no lugar escolhidos (o preço é calculado como na
   * infraestrutura da Verax nos dois lugares: o motor não muda o preço pelo lugar), os valores da tabela que o console
   * preenche no contratado (`reference`) e o que o provisionamento ainda não sabe criar. Nada é gravado.
   */
  async preview(body: unknown): Promise<DirectTenantPreview> {
    const parsed = directTenantPreviewSchema.safeParse(body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    const { hosting, configuration } = parsed.data;
    const table = await this.currentTable();
    const outcome = quote(configurationFor(hosting, configuration), table.content);
    if (outcome.kind === 'contact_us') {
      return { priceTableVersion: table.version, contactUs: true, reason: outcome.reason };
    }
    return {
      priceTableVersion: table.version,
      contactUs: false,
      quote: outcome.quote,
      reference: contractReference(outcome.quote, table.content),
      problems: nodeFitProblems(outcome.quote.configuration, outcome.quote.limits, hosting),
    };
  }

  /**
   * O que o responsável manda ao cliente de contrato direto que instala o ambiente na infraestrutura dele: a versão do
   * nó lida e conferida pelo cp-worker (o manifesto assinado do bucket de releases), o guia de instalação do
   * repositório e as linhas do `node.conf` que o contrato define. Só leitura, sem nada gravado; o worker confere de novo
   * que o ambiente é do cliente.
   */
  async installation(tenantId: string, owner: OwnerContext): Promise<TenantInstallation> {
    if (!isUlid(tenantId)) throw notFound();
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) throw notFound();
    if (hostingOf(tenant) !== 'customer') throw workerError('not_customer_hosted');
    const worker = this.worker;
    let result: OwnerCallResult;
    if (worker === null) {
      result = { ok: false, status: 503, code: 'worker_unconfigured' };
    } else {
      try {
        result = await worker.installation(tenant.id, owner.email);
      } catch {
        result = { ok: false, status: 0, code: 'worker_unreachable' };
      }
    }
    const checked = result.ok ? INSTALLATION_SCHEMA.safeParse(result.body) : undefined;
    if (!result.ok || checked === undefined || !checked.success) {
      const failure = workerFailureOf(result.ok ? { status: 502, code: 'worker_error' } : result);
      this.logger.warn(
        { event: 'admin_installation_failed', tenantId: tenant.id, failure, status: result.status },
        'a versão para o cliente instalar não veio do cp-worker',
      );
      throw workerError(failure);
    }
    const { repositoryUrl, ...release } = checked.data;
    return {
      ...release,
      thirdPartyImages: [...release.thirdPartyImages],
      guideUrl: `${repositoryUrl}/blob/main/${INSTALL_GUIDE_PATH}`,
      size: tenant.configuration.size,
      nodeConf: Object.entries(nodeLimitsEnv(tenant.limits)).map(([name, value]) => ({ name, value })),
    };
  }

  /**
   * O código de instalação de uso único da VM do cliente, pedido ao cp-worker como as outras operações do responsável
   * (o subdomínio digitado, o limite por responsável, a auditoria do pedido). O worker gera, guarda só o hash, revoga o
   * anterior e, no primeiro, começa o provisionamento reduzido. O código passa por aqui uma vez, na máscara do logger,
   * e nunca vai à auditoria nem ao log; o controlador o esquece quando a resposta termina.
   */
  async enrollmentCode(tenantId: string, body: unknown, owner: OwnerContext): Promise<EnrollmentCodeIssued> {
    const parsed = enrollmentCodeRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    if (!isUlid(tenantId)) throw notFound();
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) throw notFound();
    if (parsed.data.confirmSlug !== tenant.slug) {
      await this.refuseOperation(owner, tenant, 'enrollment-code', 'confirmation_mismatch');
      throw workerError('confirmation_mismatch');
    }
    if (hostingOf(tenant) !== 'customer') throw workerError('not_customer_hosted');
    if (!this.limits.operations.take(owner.email).allowed) {
      await this.refuseOperation(owner, tenant, 'enrollment-code', 'rate_limited');
      throw rateLimited();
    }
    const worker = this.worker;
    let result: OwnerCallResult;
    if (worker === null) {
      result = { ok: false, status: 503, code: 'worker_unconfigured' };
    } else {
      try {
        result = await worker.enrollmentCode(tenant.id, parsed.data.confirmSlug, owner.email);
      } catch {
        result = { ok: false, status: 0, code: 'worker_unreachable' };
      }
    }
    const candidate = result.ok ? result.body['code'] : undefined;
    if (typeof candidate === 'string') registerLiveSecret(candidate);
    const checked = result.ok ? ENROLLMENT_CODE_SCHEMA.safeParse(result.body) : undefined;
    if (!result.ok || checked === undefined || !checked.success) {
      if (typeof candidate === 'string') forgetLiveSecret(candidate);
      const failed: Extract<OwnerCallResult, { ok: false }> = result.ok
        ? { ok: false, status: 502, code: 'worker_error' }
        : result;
      throw workerError(await this.recordFailure('enrollment-code', tenant, owner, failed));
    }
    const issued = checked.data;
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.console_request',
      tenantId: tenant.id,
      // Nunca o código: só se é uma reinstalação e a execução.
      details: {
        operation: 'enrollment-code',
        outcome: 'ok',
        reinstall: issued.reinstall,
        ...(issued.runId === undefined ? {} : { runId: issued.runId }),
      },
      requestId: owner.requestId,
    });
    this.logger.info(
      { event: 'admin_tenant_operation', tenantId: tenant.id, operation: 'enrollment-code' },
      'código de instalação pedido ao cp-worker',
    );
    return {
      code: issued.code,
      expiresAt: issued.expiresAt,
      reinstall: issued.reinstall,
      ...(issued.runId === undefined ? {} : { runId: issued.runId }),
      ...(issued.step === undefined ? {} : { step: issued.step }),
    };
  }

  /** O cadastro de um cliente de contrato direto (veja a classe). */
  async create(body: unknown, owner: OwnerContext): Promise<DirectTenantCreated> {
    const parsed = directTenantRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      await this.refuseCreate(owner, 'invalid_request');
      throw invalidRequest(parsed.error);
    }
    const request = parsed.data;
    const customer = request.hosting === 'customer';
    if (request.confirmSlug !== request.slug) {
      await this.refuseCreate(owner, 'confirmation_mismatch', request.slug);
      throw workerError('confirmation_mismatch');
    }
    const existing = await this.tenants.get(request.idempotencyKey);
    if (existing !== undefined) return this.replay(existing, request, owner);

    const nodeIssues: FieldIssue[] = [];
    if (!isTenantEmail(request.adminEmail)) {
      nodeIssues.push({ path: 'adminEmail', message: 'E-mail fora do formato que o nó do cliente aceita.' });
    }
    if (!isTenantName(request.companyName)) {
      nodeIssues.push({
        path: 'companyName',
        message: 'Razão social fora do formato que o nó do cliente aceita.',
      });
    }
    if (nodeIssues.length > 0) {
      await this.refuseCreate(owner, 'invalid_request', request.slug);
      throw invalidFields(nodeIssues);
    }
    if (
      !isReservableSlug(request.slug) ||
      !isSlugFree(await this.tenants.getSlug(request.slug), this.clock.now())
    ) {
      await this.refuseCreate(owner, 'slug_unavailable', request.slug);
      throw slugUnavailable();
    }
    const table = await this.currentTable();
    const outcome = quote(configurationFor(request.hosting, request.configuration), table.content);
    if (outcome.kind === 'contact_us') {
      await this.refuseCreate(owner, 'configuration_contact_us', request.slug);
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Esta configuração está acima do que a tabela de preços vende.',
        'configuration_contact_us',
        { reason: outcome.reason, issues: [CONTACT_ISSUES[outcome.reason]] },
      );
    }
    const quoted = outcome.quote;
    const problems = nodeFitProblems(quoted.configuration, quoted.limits, request.hosting);
    if (problems.length > 0) {
      await this.refuseCreate(owner, 'configuration_unsupported', request.slug);
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        customer
          ? 'Esta configuração ainda não pode ser instalada na infraestrutura do cliente.'
          : 'O provisionamento ainda não sabe criar esta configuração.',
        'configuration_unsupported',
        { problems, issues: problems.map((problem) => PROBLEM_ISSUES[problem](quoted.configuration)) },
      );
    }
    if (!this.limits.creations.take(owner.email).allowed) {
      await this.refuseCreate(owner, 'rate_limited', request.slug);
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'Muitos cadastros em pouco tempo. Tente novamente mais tarde.',
        'rate_limited',
      );
    }
    const reference = contractReference(quoted, table.content);
    const contracted = request.contracted ?? reference;
    let stored;
    try {
      stored = await this.quotes.create(table.version, quoted);
    } catch (error) {
      if (error instanceof QuoteDailyLimitReachedError) {
        throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Cotação indisponível.', 'quote_unavailable');
      }
      throw error;
    }
    let tenant: TenantRecord;
    try {
      tenant = await this.tenants.create(
        {
          slug: request.slug,
          configuration: quoted.configuration,
          limits: quoted.limits,
          pricing: {
            priceTableVersion: table.version,
            quoteId: stored.quoteId,
            monthlyTotal: quoted.monthlyTotal,
            setupTotal: quoted.setupTotal,
          },
          contractPricing: { reference, contracted },
          company: { legalName: request.companyName, cnpj: request.cnpj },
          adminEmail: request.adminEmail,
          billing: { mode: 'contract' },
          ...(customer ? { hosting: 'customer' as const } : {}),
        },
        {
          tenantId: request.idempotencyKey,
          reason: customer ? 'contract_created_customer_hosted' : 'contract_created',
          audit: { actor: `owner:${owner.email}`, requestId: owner.requestId },
          // No cliente, nasce esperando a instalação dele: nunca passa por `pending` nem pelo provisionamento.
          ...(customer ? { initialState: 'waiting_customer_install' as const } : {}),
        },
      );
    } catch (error) {
      if (error instanceof TenantAlreadyExistsError) {
        // Dois envios da mesma chave ao mesmo tempo: o outro criou; este responde como a repetição.
        const raced = await this.tenants.get(request.idempotencyKey);
        if (raced !== undefined) return this.replay(raced, request, owner);
      }
      if (error instanceof SlugTakenError) {
        await this.refuseCreate(owner, 'slug_unavailable', request.slug);
        throw slugUnavailable();
      }
      throw error;
    }
    this.logger.info(
      {
        event: 'contract_tenant_created',
        tenantId: tenant.id,
        slug: tenant.slug,
        plan: request.configuration.plan,
        size: tenant.configuration.size,
        hosting: request.hosting,
        priceTableVersion: table.version,
        // Se houve negociação (só o sim ou não): os valores ficam no documento e na auditoria, nunca no log.
        negotiated: !equalValues(contracted, reference),
      },
      'cliente de contrato direto criado',
    );
    // No cliente, nada é pedido ao cp-worker: nenhum passo, nenhuma fila, nenhum recurso na infraestrutura da Verax.
    if (customer) return { id: tenant.id, slug: tenant.slug, replayed: false, hosting: 'customer' };
    return {
      id: tenant.id,
      slug: tenant.slug,
      replayed: false,
      hosting: 'verax',
      provisioning: await this.startAfterCreate(tenant, owner),
    };
  }

  /**
   * Uma operação do responsável sobre o cliente: o corpo da operação, o cliente, o subdomínio digitado igual ao dele, o
   * limite por responsável e o pedido ao cp-worker, que decide pelas regras dele (CP-07 e CP-11). O pedido vai à
   * auditoria com o desfecho; a mudança de estado, o worker audita com o mesmo `owner:<e-mail>`.
   */
  async act(
    action: TenantAction,
    tenantId: string,
    body: unknown,
    owner: OwnerContext,
  ): Promise<TenantActionResult> {
    const parsed = tenantActionSchemas[action].safeParse(body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    if (!isUlid(tenantId)) throw notFound();
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) throw notFound();
    const input = parsed.data as { confirmSlug: string; at?: string; object?: string };
    if (input.confirmSlug !== tenant.slug) {
      await this.refuseOperation(owner, tenant, action, 'confirmation_mismatch');
      throw workerError('confirmation_mismatch');
    }
    if (!this.limits.operations.take(owner.email).allowed) {
      await this.refuseOperation(owner, tenant, action, 'rate_limited');
      throw rateLimited();
    }
    const result = await this.callWorker(action, tenant, owner, input);
    if (!result.ok) throw workerError(await this.recordFailure(action, tenant, owner, result));
    const checked = RESULT_SCHEMAS[action].safeParse(result.body);
    if (!checked.success) {
      throw workerError(
        await this.recordFailure(action, tenant, owner, { ok: false, status: 502, code: 'worker_error' }),
      );
    }
    const outcome = { action, ...(checked.data as Record<string, unknown>) } as TenantActionResult;
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.console_request',
      tenantId: tenant.id,
      // Nunca o link assinado da exportação: só o objeto.
      details: {
        operation: action,
        outcome: 'ok',
        ...('runId' in outcome ? { runId: outcome.runId } : {}),
        ...(outcome.action === 'export' ? { object: outcome.object } : {}),
      },
      requestId: owner.requestId,
    });
    this.logger.info(
      { event: 'admin_tenant_operation', tenantId: tenant.id, operation: action },
      'operação do responsável pedida ao cp-worker',
    );
    return outcome;
  }

  /**
   * O aditivo de um contrato direto (decisão do responsável de 19/11/2026): o plano (os três; o SIEM Cloud só na
   * Verax), o volume, onde o ambiente roda e os valores do contrato, cotados de novo pela tabela vigente com as mesmas regras do cadastro (a
   * cotação, "fale conosco" recusado, o que o provisionamento ou a instalação no cliente sabem criar). A vigência
   * recomeça na data do aditivo com a duração do plano novo (`contract-term.ts`).
   *
   * Onde o ambiente roda muda só antes de qualquer instalação (`hostingChangeAllowed`); a troca põe o cliente no estado
   * de um cadastro novo daquele lugar: na Verax, `pending` (o "Iniciar provisionamento" começa dali), sem o registro da
   * VM do cliente (o código de instalação, se houvesse, deixa de valer); no cliente, `waiting_customer_install` (o
   * código de instalação começa dali). Com o ambiente já instalado, o aditivo muda só o contrato gravado: os limites do
   * nó novos ficam no cliente e chegam ao nó na próxima instalação (`nodeLimitsPending`).
   *
   * Tudo no cp-admin, como o cadastro: só o Firestore muda, nada na nuvem. A transação relê o cliente e confere as regras
   * de novo; o aditivo fica em `tenants/{id}/amendments` e na auditoria com o antes e o depois.
   */
  async amend(tenantId: string, body: unknown, owner: OwnerContext): Promise<ContractAmendmentResult> {
    if (!isUlid(tenantId)) throw notFound();
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) throw notFound();
    const parsed = amendmentRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      await this.refuseAmend(owner, tenant, 'invalid_request');
      throw invalidRequest(parsed.error);
    }
    const request = parsed.data;
    if (request.confirmSlug !== tenant.slug) {
      await this.refuseOperation(owner, tenant, 'amend', 'confirmation_mismatch');
      throw workerError('confirmation_mismatch');
    }
    const refusal =
      amendRefusalOf(tenant) ??
      (request.hosting !== hostingOf(tenant) && !hostingChangeAllowed(tenant) ? 'hosting_locked' : undefined);
    if (refusal !== undefined) {
      await this.refuseAmend(owner, tenant, refusal);
      throw amendError(refusal);
    }
    const table = await this.currentTable();
    const outcome = quote(configurationFor(request.hosting, request.configuration), table.content);
    if (outcome.kind === 'contact_us') {
      await this.refuseAmend(owner, tenant, 'configuration_contact_us');
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Esta configuração está acima do que a tabela de preços vende.',
        'configuration_contact_us',
        { reason: outcome.reason, issues: [CONTACT_ISSUES[outcome.reason]] },
      );
    }
    const quoted = outcome.quote;
    const problems = nodeFitProblems(quoted.configuration, quoted.limits, request.hosting);
    if (problems.length > 0) {
      await this.refuseAmend(owner, tenant, 'configuration_unsupported');
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        request.hosting === 'customer'
          ? 'Esta configuração ainda não pode ser instalada na infraestrutura do cliente.'
          : 'O provisionamento ainda não sabe criar esta configuração.',
        'configuration_unsupported',
        { problems, issues: problems.map((problem) => PROBLEM_ISSUES[problem](quoted.configuration)) },
      );
    }
    if (request.contractedSetup !== undefined && quoted.setupTotal === 0) {
      await this.refuseAmend(owner, tenant, 'invalid_request');
      throw invalidFields([{ path: 'contractedSetup', message: 'A implantação só existe no SIEM + vCISO.' }]);
    }
    const reference = contractReference(quoted, table.content);
    const contractPricing: ContractPricing = {
      reference,
      contracted: request.contracted ?? reference,
      ...(quoted.setupTotal > 0
        ? {
            setup: { reference: quoted.setupTotal, contracted: request.contractedSetup ?? quoted.setupTotal },
          }
        : {}),
    };
    // O aditivo que não muda nada: o mesmo lugar, a mesma configuração, os mesmos limites e os mesmos valores (com a
    // implantação). Conferido aqui e de novo na transação: dois envios iguais ao mesmo tempo gravam um só.
    const unchangedFor = (subject: Tenant): boolean =>
      request.hosting === hostingOf(subject) &&
      equalValues(quoted.configuration, subject.configuration) &&
      equalValues(quoted.limits, subject.limits) &&
      equalValues(contractPricing, subject.contractPricing);
    if (unchangedFor(tenant)) {
      await this.refuseAmend(owner, tenant, 'no_change');
      throw amendError('no_change');
    }
    if (!this.limits.operations.take(owner.email).allowed) {
      await this.refuseOperation(owner, tenant, 'amend', 'rate_limited');
      throw rateLimited();
    }
    let stored;
    try {
      stored = await this.quotes.create(table.version, quoted);
    } catch (error) {
      if (error instanceof QuoteDailyLimitReachedError) {
        throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Cotação indisponível.', 'quote_unavailable');
      }
      throw error;
    }
    const now = this.clock.now();
    const months = contractMonthsFor(request.configuration.plan, table.content);
    const contractTerm = { months, startsAt: now, endsAt: addMonths(now, months) };
    const target = request.hosting;
    let result;
    try {
      result = await this.tenants.amend(
        tenant.id,
        (current) => {
          // As regras de novo, sobre o cliente relido na transação.
          const again =
            amendRefusalOf(current) ??
            (target !== hostingOf(current) && !hostingChangeAllowed(current) ? 'hosting_locked' : undefined);
          if (again !== undefined) throw new AmendmentRefusedError(again);
          if (unchangedFor(current)) throw new AmendmentRefusedError('no_change');
          const { id: _id, ...base } = current;
          let next: Tenant = {
            ...base,
            configuration: quoted.configuration,
            limits: quoted.limits,
            pricing: {
              priceTableVersion: table.version,
              quoteId: stored.quoteId,
              monthlyTotal: quoted.monthlyTotal,
              setupTotal: quoted.setupTotal,
            },
            contractPricing,
            contractTerm,
          };
          const moving = target !== hostingOf(current);
          if (moving) {
            // O estado de um cadastro novo do lugar de destino: nada da execução nem do registro da VM fica para trás.
            const { provisioning: _run, enrollment: _enrollment, hosting: _hosting, ...rest } = next;
            next =
              target === 'customer'
                ? { ...rest, hosting: 'customer', state: 'waiting_customer_install' }
                : { ...rest, state: 'pending' };
          }
          return {
            next,
            reason: moving ? `contract_amended_to_${target}` : 'contract_amended',
            ...(request.note === undefined ? {} : { note: request.note }),
            nodeLimitsPending: nodeInstalled(current) && !equalValues(current.limits, quoted.limits),
          };
        },
        { actor: `owner:${owner.email}`, by: owner.email, requestId: owner.requestId },
      );
    } catch (error) {
      if (error instanceof AmendmentRefusedError) {
        await this.refuseAmend(owner, tenant, error.code);
        throw amendError(error.code);
      }
      if (error instanceof TenantNotFoundError) throw notFound();
      throw error;
    }
    const after = result.tenant;
    const hostingChanged = hostingOf(after) !== hostingOf(result.before);
    this.logger.info(
      {
        event: 'contract_amended',
        tenantId: after.id,
        amendmentId: result.amendment.id,
        plan: request.configuration.plan,
        size: after.configuration.size,
        hosting: hostingOf(after),
        hostingChanged,
        priceTableVersion: table.version,
        // Só o sim ou não: os valores ficam no cliente, no aditivo e na auditoria, nunca no log.
        negotiated: !equalValues(contractPricing.contracted, reference),
        nodeLimitsPending: result.amendment.nodeLimitsPending,
      },
      'aditivo de contrato direto gravado',
    );
    return {
      amendmentId: result.amendment.id,
      state: after.state,
      hosting: hostingOf(after),
      hostingChanged,
      nodeLimitsPending: result.amendment.nodeLimitsPending,
      contractTerm,
    };
  }

  /**
   * O pedido que a chave já criou, conferido inteiro contra o cliente gravado (que é o pedido normalizado): o modo de
   * cobrança, onde o ambiente roda, o subdomínio, a razão social, o CNPJ, o e-mail, a configuração levada à tabela da
   * cotação original (a mesma versão publicada, que não muda) e o contratado (sem ele no pedido, a referência daquela
   * tabela). Qualquer diferença é outro cadastro com a mesma chave: 409, sem mexer no cliente.
   */
  private async sameRequest(existing: TenantRecord, request: DirectTenantRequest): Promise<boolean> {
    if (
      billingModeOf(existing) !== 'contract' ||
      hostingOf(existing) !== request.hosting ||
      existing.slug !== request.slug ||
      existing.company.legalName !== request.companyName ||
      existing.company.cnpj !== request.cnpj ||
      existing.adminEmail !== request.adminEmail
    ) {
      return false;
    }
    // Um cliente do modelo de preço anterior nunca é a repetição de um cadastro de hoje.
    if (isLegacyConfiguration(existing.configuration)) return false;
    const table = await this.tables.get(existing.pricing.priceTableVersion).catch((error: unknown) => {
      if (error instanceof LegacyVersionError) return undefined;
      throw error;
    });
    if (table === undefined || table.status === 'draft') return false;
    const outcome = quote(configurationFor(request.hosting, request.configuration), table.content);
    if (outcome.kind !== 'quote') return false;
    const reference = contractReference(outcome.quote, table.content);
    // Um contrato direto de antes dos valores de contrato: o contratado era a referência.
    const storedContracted: ContractValues = existing.contractPricing?.contracted ?? reference;
    return (
      equalValues(outcome.quote.configuration, existing.configuration) &&
      equalValues(outcome.quote.limits, existing.limits) &&
      equalValues(request.contracted ?? reference, storedContracted)
    );
  }

  /** O mesmo envio de novo (a mesma chave): o mesmo cliente, ou 409 se a chave já criou outro pedido. */
  private async replay(
    existing: TenantRecord,
    request: DirectTenantRequest,
    owner: OwnerContext,
  ): Promise<DirectTenantCreated> {
    if (!(await this.sameRequest(existing, request))) {
      await this.refuseCreate(owner, 'idempotency_conflict', request.slug);
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Este cadastro já foi usado com outros dados. Recarregue a página para começar um cadastro novo.',
        'idempotency_conflict',
      );
    }
    if (hostingOf(existing) === 'customer') {
      // No cliente, a repetição só devolve o mesmo cliente: não há provisionamento para pedir de novo.
      this.logger.info(
        { event: 'contract_tenant_replayed', tenantId: existing.id },
        'cadastro repetido: o mesmo cliente',
      );
      return { id: existing.id, slug: existing.slug, replayed: true, hosting: 'customer' };
    }
    let provisioning: ProvisioningRequestOutcome;
    // Em `pending`, o pedido ao worker não chegou; parado no `preflight`, ele pode ter mudado o estado e falhado ao
    // enfileirar a task. Nos dois casos o `provision` de novo resolve: o worker garante a task pelo id determinístico.
    const stillStarting =
      existing.state === 'pending' ||
      (existing.state === 'provisioning' && existing.provisioning?.step === FIRST_PROVISIONING_STEP);
    if (stillStarting) {
      provisioning = await this.startAfterCreate(existing, owner);
    } else if (existing.provisioning?.runId === undefined) {
      provisioning = { started: false, failure: 'not_allowed' };
    } else {
      provisioning = {
        started: true,
        runId: existing.provisioning.runId,
        step: existing.provisioning.step ?? FIRST_PROVISIONING_STEP,
      };
    }
    this.logger.info(
      { event: 'contract_tenant_replayed', tenantId: existing.id },
      'cadastro repetido: o mesmo cliente',
    );
    return { id: existing.id, slug: existing.slug, replayed: true, hosting: 'verax', provisioning };
  }

  /** O pedido do início do provisionamento logo depois do cadastro: sem o worker, o cliente fica em `pending`. */
  private async startAfterCreate(
    tenant: TenantRecord,
    owner: OwnerContext,
  ): Promise<ProvisioningRequestOutcome> {
    const result = await this.callWorker('start', tenant, owner, { confirmSlug: tenant.slug });
    if (!result.ok) {
      return { started: false, failure: await this.recordFailure('start', tenant, owner, result) };
    }
    const checked = RESULT_SCHEMAS.start.safeParse(result.body);
    if (!checked.success) {
      const failure = await this.recordFailure('start', tenant, owner, {
        ok: false,
        status: 502,
        code: 'worker_error',
      });
      return { started: false, failure };
    }
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.console_request',
      tenantId: tenant.id,
      details: { operation: 'start', outcome: 'ok', runId: checked.data.runId },
      requestId: owner.requestId,
    });
    return { started: true, runId: checked.data.runId, step: checked.data.step };
  }

  /** O pedido ao cp-worker com quem agiu (o e-mail da sessão); qualquer falha do caminho vira um código. */
  private async callWorker(
    action: TenantAction,
    tenant: TenantRecord,
    owner: OwnerContext,
    input: { confirmSlug: string; at?: string; object?: string },
  ): Promise<OwnerCallResult> {
    const worker = this.worker;
    if (worker === null) return { ok: false, status: 503, code: 'worker_unconfigured' };
    const actor = owner.email;
    try {
      switch (action) {
        case 'start':
          return await worker.provision(tenant.id, input.confirmSlug, actor);
        case 'resume':
          return await worker.resume(tenant.id, actor);
        case 'cancel':
          return await worker.cancel(
            tenant.id,
            input.confirmSlug,
            actor,
            input.at === undefined ? undefined : new Date(input.at),
          );
        case 'suspend':
          return await worker.suspend(tenant.id, input.confirmSlug, actor);
        case 'reactivate':
          return await worker.reactivate(tenant.id, input.confirmSlug, actor);
        case 'delete-now':
          return await worker.deleteNow(tenant.id, input.confirmSlug, actor);
        case 'export':
          return await worker.exportLink(tenant.id, input.object ?? '', actor);
      }
    } catch {
      // O token de identidade não saiu (servidor de metadados) ou o id não serviu: nada chegou ao worker.
      return { ok: false, status: 0, code: 'worker_unreachable' };
    }
  }

  /** Audita e registra uma operação que o worker não atendeu; devolve o código estável. */
  private async recordFailure(
    action: TenantAction | 'enrollment-code',
    tenant: TenantRecord,
    owner: OwnerContext,
    result: Extract<OwnerCallResult, { ok: false }>,
  ): Promise<string> {
    const failure = workerFailureOf(result);
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.console_request',
      tenantId: tenant.id,
      details: { operation: action, outcome: failure, status: result.status },
      requestId: owner.requestId,
    });
    this.logger.warn(
      {
        event: 'admin_worker_request_failed',
        tenantId: tenant.id,
        operation: action,
        failure,
        status: result.status,
      },
      'o cp-worker não atendeu o pedido do console',
    );
    return failure;
  }

  private async refuseCreate(owner: OwnerContext, code: string, slug?: string): Promise<void> {
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.create_refused',
      details: { code, ...(slug === undefined ? {} : { slug }) },
      requestId: owner.requestId,
    });
    this.logger.info({ event: 'contract_tenant_refused', code }, 'cadastro de contrato direto recusado');
  }

  private async refuseAmend(owner: OwnerContext, tenant: TenantRecord, code: string): Promise<void> {
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.amend_refused',
      tenantId: tenant.id,
      details: { code, state: tenant.state },
      requestId: owner.requestId,
    });
    this.logger.info({ event: 'contract_amend_refused', tenantId: tenant.id, code }, 'aditivo recusado');
  }

  private async refuseOperation(
    owner: OwnerContext,
    tenant: TenantRecord,
    action: TenantAction | 'enrollment-code' | 'amend',
    code: 'confirmation_mismatch' | 'rate_limited',
  ): Promise<void> {
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.console_request_refused',
      tenantId: tenant.id,
      details: { operation: action, code, state: tenant.state },
      requestId: owner.requestId,
    });
  }

  private async currentTable(): Promise<{ version: string; content: PriceTable }> {
    const table = await this.tables.current();
    if (table === undefined) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Nenhuma tabela de preços vigente: publique uma antes de cadastrar um cliente.',
        'pricing_table_missing',
      );
    }
    return table;
  }
}

function listItemOf(tenant: TenantRecord): TenantListItem {
  const provisioningState = tenant.state === 'provisioning' || tenant.state === 'provisioning_failed';
  return {
    id: tenant.id,
    slug: tenant.slug,
    companyName: tenant.company.legalName,
    state: tenant.state,
    stateUpdatedAt: tenant.stateUpdatedAt,
    billingMode: billingModeOf(tenant),
    hosting: hostingOf(tenant),
    ...(isLegacyConfiguration(tenant.configuration) ? {} : { plan: tenant.configuration.plan }),
    size: tenant.configuration.size,
    ...(provisioningState && tenant.provisioning?.step !== undefined
      ? { step: tenant.provisioning.step }
      : {}),
    ...(tenant.state === 'provisioning_failed' && tenant.provisioning?.lastError !== undefined
      ? { lastErrorCode: tenant.provisioning.lastError.code }
      : {}),
    createdAt: tenant.createdAt,
  };
}
