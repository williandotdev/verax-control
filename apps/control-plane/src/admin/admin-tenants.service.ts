import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { tenantUrls } from '../access/tenant-urls.js';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import type { RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { isUlid, ULID_PATTERN } from '../common/ulid.js';
import { type OwnerContext, PricingTableStore } from '../pricing/pricing-store.js';
import type { Configuration, PriceTable } from '../pricing/pricing.schema.js';
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
  isReservableSlug,
  isSlugFree,
  LIFECYCLE_RUN_KINDS,
  type TenantRecord,
  type TenantState,
  tenantStateSchema,
} from '../tenants/tenant.schema.js';
import {
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
  type TenantLifecycleView,
  type TenantList,
  type TenantListItem,
  type TimelineStep,
} from './admin-tenants.schema.js';
import { type FieldIssue, invalidFields, invalidRequest } from './validation.js';
import type { OwnerCallResult, WorkerOwnerClient } from './worker-owner-client.js';

/** Quantos clientes a lista mostra (os mais novos primeiro). */
export const TENANT_LIST_LIMIT = 200;

/**
 * Cadastros novos por responsável: o cadastro cria um nó pago na GCP. Um responsável negocia poucos contratos por dia;
 * uma sessão do IAP sequestrada não cria dezenas de nós. Em memória (o cp-admin tem no máximo uma instância).
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
    path: 'configuration',
    message: `Esta configuração pede o porte ${configuration.size}; o provisionamento cria só o porte P hoje.`,
  }),
  agents: () => ({
    path: 'configuration.agents',
    message: 'Agentes nas instâncias do cliente ainda não são provisionados: deixe 0.',
  }),
  limits: () => ({
    path: 'configuration',
    message: 'Os limites desta configuração ficam fora das faixas que o nó aceita.',
  }),
};

const CONTACT_ISSUES: Readonly<Record<ContactReason, FieldIssue>> = {
  cloud_accounts_above_max: {
    path: 'configuration.cloudAccounts',
    message: 'Acima do máximo de contas que a tabela vende.',
  },
  volume_above_max: {
    path: 'configuration.monthlyGib',
    message: 'Acima da maior faixa de volume da tabela.',
  },
  agents_above_max: {
    path: 'configuration.agents',
    message: 'Acima do máximo de pacotes de agentes da tabela.',
  },
  history_above_max: {
    path: 'configuration.historyDays',
    message: 'Acima da maior opção de histórico da tabela.',
  },
  above_largest_size: { path: 'configuration', message: 'Nenhum porte da tabela comporta esta combinação.' },
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
const MEANINGFUL_5XX: ReadonlySet<string> = new Set(['export_unavailable', 'export_check_failed']);

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

const CANCELABLE: readonly TenantState[] = [
  'pending',
  'provisioning',
  'provisioning_failed',
  'waiting_customer_connection',
  'active',
  'past_due',
  'suspended',
];

/** As operações que fazem sentido para o cliente agora (as regras são as do cp-worker, que confere de novo). */
export function availableActions(tenant: TenantRecord, now: Date): TenantActions {
  const contract = billingModeOf(tenant) === 'contract';
  const lifecycle = tenant.lifecycle;
  return {
    start: contract && tenant.state === 'pending',
    resume: tenant.state === 'provisioning_failed' || tenant.state === 'provisioning',
    cancel: contract && CANCELABLE.includes(tenant.state),
    suspend:
      contract &&
      (tenant.state === 'active' ||
        tenant.state === 'waiting_customer_connection' ||
        tenant.state === 'past_due'),
    reactivate: contract && tenant.state === 'suspended' && tenant.billing?.suspendedReason === 'owner',
    deleteNow:
      tenant.state === 'canceled' ||
      (tenant.state === 'deleted' &&
        lifecycle?.purgedAt === undefined &&
        lifecycle?.run?.lastError !== undefined),
    export:
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
 * e-mail que o IAP confirmou em `actor`; o JWT do IAP nunca sai daqui).
 *
 * O cadastro confere tudo de novo, com as regras do checkout e do provisionamento: os campos (os mesmos schemas), o
 * subdomínio (formato, lista reservada, livre), o nome e o e-mail como o nó os aceita, a tabela de preços vigente, a
 * cotação ("fale conosco" é recusado) e se o `envs/tenant` sabe criar o que foi pedido (`node-fit.ts`). Só então cria o
 * cliente em `pending` com `billing.mode = contract`, com o id da chave de idempotência, e pede ao worker o início do
 * provisionamento, que segue exatamente os passos de um cliente pago (CP-07). Toda escrita e toda recusa vão à
 * auditoria com `owner:<e-mail>`; os logs levam só ids, o subdomínio, o porte, as versões e os códigos.
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
    const runId = tenant.provisioning?.runId;
    const [run, steps, transitions] = await Promise.all([
      runId === undefined ? undefined : this.runs.getRun(runId),
      runId === undefined ? new Map<string, StepDocument>() : this.runs.listSteps(runId),
      this.tenants.listTransitions(tenantId),
    ]);
    const timeline: TimelineStep[] = PROVISIONING_STEPS.map((name) => {
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
      company: { legalName: tenant.company.legalName, cnpj: tenant.company.cnpj },
      ...(tenant.adminEmail === undefined ? {} : { adminEmail: tenant.adminEmail }),
      configuration: tenant.configuration,
      limits: tenant.limits,
      pricing: tenant.pricing,
      urls: tenantUrls(tenant.slug, this.config),
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

  /** A cotação de referência pela tabela vigente e o que o provisionamento ainda não sabe criar. Nada é gravado. */
  async preview(body: unknown): Promise<DirectTenantPreview> {
    const parsed = directTenantPreviewSchema.safeParse(body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    const table = await this.currentTable();
    const outcome = quote(parsed.data.configuration, table.content);
    if (outcome.kind === 'contact_us') {
      return { priceTableVersion: table.version, contactUs: true, reason: outcome.reason };
    }
    return {
      priceTableVersion: table.version,
      contactUs: false,
      quote: outcome.quote,
      problems: nodeFitProblems(outcome.quote.configuration, outcome.quote.limits),
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
    const outcome = quote(request.configuration, table.content);
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
    const problems = nodeFitProblems(quoted.configuration, quoted.limits);
    if (problems.length > 0) {
      await this.refuseCreate(owner, 'configuration_unsupported', request.slug);
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'O provisionamento ainda não sabe criar esta configuração.',
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
        },
        {
          tenantId: request.idempotencyKey,
          reason: 'contract_created',
          audit: { actor: `owner:${owner.email}`, requestId: owner.requestId },
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
        size: tenant.configuration.size,
        priceTableVersion: table.version,
      },
      'cliente de contrato direto criado',
    );
    return {
      id: tenant.id,
      slug: tenant.slug,
      replayed: false,
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

  /** O mesmo envio de novo (a mesma chave): o mesmo cliente, ou 409 se a chave já criou outro. */
  private async replay(
    existing: TenantRecord,
    request: DirectTenantRequest,
    owner: OwnerContext,
  ): Promise<DirectTenantCreated> {
    const same =
      billingModeOf(existing) === 'contract' &&
      existing.slug === request.slug &&
      existing.company.cnpj === request.cnpj &&
      existing.adminEmail === request.adminEmail;
    if (!same) {
      await this.refuseCreate(owner, 'idempotency_conflict', request.slug);
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Este cadastro já foi usado para outro cliente. Recarregue a página para começar um cadastro novo.',
        'idempotency_conflict',
      );
    }
    let provisioning: ProvisioningRequestOutcome;
    if (existing.state === 'pending') {
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
    return { id: existing.id, slug: existing.slug, replayed: true, provisioning };
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

  /** O pedido ao cp-worker com quem agiu (o e-mail do IAP); qualquer falha do caminho vira um código. */
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
