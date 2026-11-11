import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { tenantUrls } from '../access/tenant-urls.js';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { equalValues } from '../firestore/document-store.js';
import type { RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { isUlid, ULID_PATTERN } from '../common/ulid.js';
import { NODE_RELEASE_PATTERN } from '../common/config/env.schema.js';
import { CONTRACT_CANCELABLE } from '../lifecycle/lifecycle-rules.js';
import { nodeLimitsEnv } from '../pricing/node-limits.js';
import { LegacyVersionError, type OwnerContext, PricingTableStore } from '../pricing/pricing-store.js';
import {
  type Configuration,
  type ConfigurationInput,
  isLegacyConfiguration,
  type PriceTable,
} from '../pricing/pricing.schema.js';
import { QuoteDailyLimitReachedError, QuoteStore } from '../pricing/quote-store.js';
import { type ContactReason, quote } from '../pricing/quote.js';
import { isTenantEmail, isTenantName } from '../provisioning/executor-env.js';
import { type NodeFitProblem, nodeFitProblems } from '../provisioning/node-fit.js';
import { PROVISIONING_STEPS } from '../provisioning/provisioning-engine.js';
import { ProvisioningStore, type StepDocument } from '../provisioning/provisioning-store.js';
import { FIRST_PROVISIONING_STEP, isStepName } from '../queue/step-queue.js';
import { SlugTakenError, TenantAlreadyExistsError, TenantStore } from '../tenants/tenant-store.js';
import {
  billingModeOf,
  type Hosting,
  hostingOf,
  isReservableSlug,
  isSlugFree,
  LIFECYCLE_RUN_KINDS,
  MODE_OF_HOSTING,
  type TenantRecord,
  tenantStateSchema,
} from '../tenants/tenant.schema.js';
import {
  type DirectConfiguration,
  type DirectTenantCreated,
  type DirectTenantPreview,
  type DirectTenantRequest,
  directTenantPreviewSchema,
  directTenantRequestSchema,
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
    message: 'Acima do máximo da Plataforma na tabela: para mais volume, use o Dedicado.',
  },
  above_max: { path: 'configuration.gbDay', message: 'Acima do máximo cotável do plano na tabela.' },
  above_largest_size: {
    path: 'configuration.gbDay',
    message: 'Nenhum porte da tabela comporta este volume.',
  },
  mode_unavailable: {
    path: 'configuration.plan',
    message:
      'A Plataforma roda só na célula da Verax: no ambiente do cliente, escolha o Dedicado ou o vCISO.',
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
  images: z.object({ api: imageRef, migrate: imageRef }),
  thirdPartyImages: z.array(imageRef).min(1).max(20),
  releaseKey: z.object({
    name: z.string().regex(/^release-[a-z0-9-]{1,60}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
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
 * ambiente na infraestrutura do cliente, só cancelar e apagar (o registro do fim do contrato): nada de provisionar,
 * suspender, reativar nem exportar, que agiriam na infraestrutura da Verax.
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
 * - na infraestrutura do cliente (só o Dedicado e o vCISO): a cotação de referência é o mesmo preço por GB/dia, no modo
 *   `self_hosted` (a DRE sem a nuvem da Verax), o cliente nasce em `waiting_customer_install` e nada é pedido ao worker; o console mostra a versão e o guia para o cliente instalar
 *   (`installation`), e o ciclo de vida só registra o fim do contrato.
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
    const [run, steps, transitions] = await Promise.all([
      runId === undefined ? undefined : this.runs.getRun(runId),
      runId === undefined ? new Map<string, StepDocument>() : this.runs.listSteps(runId),
      this.tenants.listTransitions(tenantId),
    ]);
    // O ambiente no cliente não tem provisionamento: nenhuma linha do tempo de passos que nunca vão rodar.
    const names = hosting === 'customer' ? [] : PROVISIONING_STEPS;
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
      // Os endereços da Verax só valem para o ambiente na Verax: os do cliente, ele escolhe na instalação.
      ...(hosting === 'verax' ? { urls: tenantUrls(tenant.slug, this.config) } : {}),
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
   * A cotação de referência pela tabela vigente, no plano e no lugar escolhidos (o mesmo preço por GB/dia nos dois
   * lugares), e o que o provisionamento ainda não sabe criar. Nada é gravado.
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
      nodeConf: Object.entries(nodeLimitsEnv(tenant.limits)).map(([name, value]) => ({ name, value })),
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
   * O pedido que a chave já criou, conferido inteiro contra o cliente gravado (que é o pedido normalizado): o modo de
   * cobrança, onde o ambiente roda, o subdomínio, a razão social, o CNPJ, o e-mail e a configuração levada à tabela da
   * cotação original (a mesma versão publicada, que não muda). Qualquer diferença é outro cadastro com a mesma chave:
   * 409, sem mexer no cliente.
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
    return (
      outcome.kind === 'quote' &&
      equalValues(outcome.quote.configuration, existing.configuration) &&
      equalValues(outcome.quote.limits, existing.limits)
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
    action: TenantAction,
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

  private async refuseOperation(
    owner: OwnerContext,
    tenant: TenantRecord,
    action: TenantAction,
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
