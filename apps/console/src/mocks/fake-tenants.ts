import type {
  ConfigurationInput,
  NodeFitProblem,
  PriceTable,
  ProvisioningStepName,
  TenantActions,
  TenantDetail,
  TenantListItem,
  TenantState,
  TimelineStep,
  ValidationIssue,
} from '@/lib/api-types';
import { quote } from './fake-engine';

/**
 * Os clientes na API simulada do console (`/v1/admin/tenants...`), em memória: a lista, o detalhe com a linha do tempo,
 * a cotação de referência, o cadastro de contrato direto (com a chave de idempotência) e as operações do responsável.
 * Imita os contratos de `apps/control-plane/src/admin/admin-tenants.*` e as regras do cp-worker (CP-07 e CP-11), com
 * uma amostra da validação (a de verdade é a da API). Clientes FICTÍCIOS ("Cliente Demo A/B/C"), CNPJ de exemplo,
 * nenhum dado real.
 */
export interface FakeTenantsState {
  tenants: Map<string, TenantDetail>;
  /** O cp-worker fora do alcance do console: o cadastro fica em `pending`, e as operações respondem 503. */
  workerDown: boolean;
}

export interface FakeResponse {
  status: number;
  body: unknown;
}

const STEPS: readonly ProvisioningStepName[] = [
  'preflight',
  'cloudflare.tunnel',
  'firebase.site',
  'terraform.apply',
  'terraform.wait',
  'secrets.tunnel_token',
  'node.wait_ready',
  'node.health',
  'panel.domain_wait',
  'access.ready',
];

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/;
const BACKUP_PATTERN = /^postgres\/verax-[0-9]{8}T[0-9]{6}Z\.dump$/;
const RESERVED = new Set([
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
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CANCELABLE: readonly TenantState[] = [
  'pending',
  'provisioning',
  'provisioning_failed',
  'waiting_customer_connection',
  'active',
  'past_due',
  'suspended',
];

function error(
  status: number,
  message: string,
  code: string,
  details?: Record<string, unknown>,
): FakeResponse {
  return {
    status,
    body: { statusCode: status, message, code, ...(details === undefined ? {} : { details }) },
  };
}

function invalid(issues: ValidationIssue[]): FakeResponse {
  return error(400, 'Dados inválidos.', 'invalid_request', { issues });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** As operações disponíveis, pelas mesmas regras de `availableActions` do cp-admin. */
function actionsOf(tenant: Omit<TenantDetail, 'actions'>, now: Date): TenantActions {
  const contract = tenant.billingMode === 'contract';
  const exportUntil = tenant.lifecycle.exportUntil;
  return {
    start: contract && tenant.state === 'pending',
    resume: tenant.state === 'provisioning_failed' || tenant.state === 'provisioning',
    cancel: contract && CANCELABLE.includes(tenant.state),
    suspend:
      contract &&
      (tenant.state === 'active' ||
        tenant.state === 'waiting_customer_connection' ||
        tenant.state === 'past_due'),
    reactivate: contract && tenant.state === 'suspended' && tenant.lifecycle.suspendedReason === 'owner',
    deleteNow: tenant.state === 'canceled',
    export: tenant.state === 'canceled' && exportUntil !== undefined && new Date(exportUntil) > now,
  };
}

function withActions(tenant: Omit<TenantDetail, 'actions'>, now: Date): TenantDetail {
  return { ...tenant, actions: actionsOf(tenant, now) };
}

/** A linha do tempo com os passos até `done` feitos e o seguinte no estado dado. */
function timeline(
  at: (minutes: number) => string,
  done: number,
  current?: { status: TimelineStep['status']; errorCode?: string; attempts?: number },
): TimelineStep[] {
  return STEPS.map((name, index) => {
    if (index < done) {
      return {
        name,
        status: 'done',
        attempts: 1,
        startedAt: at(60 - index * 5),
        finishedAt: at(58 - index * 5),
      };
    }
    if (index === done && current !== undefined) {
      return {
        name,
        status: current.status,
        attempts: current.attempts ?? 1,
        startedAt: at(40),
        ...(current.errorCode === undefined ? {} : { errorCode: current.errorCode }),
        ...(current.status === 'failed' ? { finishedAt: at(30) } : {}),
      };
    }
    return { name, status: 'pending', attempts: 0 };
  });
}

function base(
  id: string,
  slug: string,
  name: string,
  at: (minutes: number) => string,
): Omit<TenantDetail, 'state' | 'billingMode' | 'timeline' | 'transitions' | 'actions'> {
  return {
    id,
    slug,
    stateUpdatedAt: at(30),
    createdAt: at(120),
    company: { legalName: name, cnpj: '11222333000181' },
    adminEmail: `admin@${slug}.example`,
    configuration: {
      mode: 'managed',
      size: 'P',
      cloudAccounts: 2,
      monthlyGib: 10,
      agents: 0,
      historyDays: 30,
      support: 'standard',
    },
    limits: { maxCloudAccounts: 2, monthlyGib: 10, historyDays: 30, maxAgents: 0, maxUsers: 10 },
    pricing: {
      priceTableVersion: 'teste-v2',
      quoteId: '01JC00000000000000000000Q1',
      monthlyTotal: 100_000,
      setupTotal: 0,
    },
    urls: {
      panelUrl: `https://${slug}.control.veraxsistemas.com.br`,
      apiUrl: `https://api-${slug}.veraxsistemas.com.br`,
    },
    access: {},
    lifecycle: {},
  };
}

/**
 * Quatro clientes FICTÍCIOS: um de contrato direto parado no túnel, um pago ativo, um de contrato que não começou e um
 * de contrato ativo (para suspender, cancelar, apagar e exportar).
 */
export function createFakeTenants(now: () => Date): FakeTenantsState {
  const at = (minutes: number): string => new Date(now().getTime() - minutes * MINUTE).toISOString();
  const tenants = new Map<string, TenantDetail>();
  const failed = '01JC0000000000000000000A01';
  tenants.set(
    failed,
    withActions(
      {
        ...base(failed, 'cliente-demo-a', 'Cliente Demo A Ltda', at),
        state: 'provisioning_failed',
        billingMode: 'contract',
        provisioning: {
          runId: '01JC0000000000000000000R01',
          step: 'cloudflare.tunnel',
          attempts: 0,
          lastError: { code: 'cloudflare_denied', at: at(30) },
        },
        run: {
          runId: '01JC0000000000000000000R01',
          kind: 'provision',
          startedAt: at(60),
          finishedAt: at(30),
          outcome: 'failed',
          failureCode: 'cloudflare_denied',
          release: 'node-v1.2.3',
        },
        timeline: timeline(at, 1, { status: 'failed', errorCode: 'cloudflare_denied', attempts: 2 }),
        transitions: [
          { from: null, to: 'pending', reason: 'contract_created', at: at(120) },
          { from: 'pending', to: 'provisioning', reason: 'contract_provisioning_started', at: at(119) },
          {
            from: 'provisioning',
            to: 'provisioning_failed',
            reason: 'provisioning_failed:cloudflare_denied',
            at: at(30),
          },
        ],
      },
      now(),
    ),
  );
  const paid = '01JC0000000000000000000B01';
  tenants.set(
    paid,
    withActions(
      {
        ...base(paid, 'cliente-demo-b', 'Cliente Demo B S.A.', at),
        createdAt: at(240),
        state: 'active',
        billingMode: 'stripe',
        provisioning: {
          runId: '01JC0000000000000000000R02',
          step: 'access.ready',
          attempts: 0,
          nodeVersion: 'node-v1.2.3',
        },
        run: {
          runId: '01JC0000000000000000000R02',
          kind: 'provision',
          startedAt: at(230),
          finishedAt: at(200),
          outcome: 'succeeded',
          release: 'node-v1.2.3',
        },
        timeline: timeline(at, 10),
        access: { passwordRevealedAt: at(190) },
        transitions: [
          { from: null, to: 'pending', reason: 'checkout.session.completed', at: at(240) },
          { from: 'pending', to: 'provisioning', reason: 'first_invoice_paid', at: at(235) },
          {
            from: 'provisioning',
            to: 'waiting_customer_connection',
            reason: 'provisioning_finished',
            at: at(200),
          },
          {
            from: 'waiting_customer_connection',
            to: 'active',
            reason: 'first_account_connected',
            at: at(180),
          },
        ],
      },
      now(),
    ),
  );
  const pending = '01JC0000000000000000000C01';
  tenants.set(
    pending,
    withActions(
      {
        ...base(pending, 'cliente-demo-c', 'Cliente Demo C ME', at),
        createdAt: at(10),
        stateUpdatedAt: at(10),
        state: 'pending',
        billingMode: 'contract',
        timeline: timeline(at, 0),
        transitions: [{ from: null, to: 'pending', reason: 'contract_created', at: at(10) }],
      },
      now(),
    ),
  );
  const active = '01JC0000000000000000000D01';
  tenants.set(
    active,
    withActions(
      {
        ...base(active, 'contrato-ativo', 'Cliente Demo Z Ltda', at),
        createdAt: at(300),
        state: 'active',
        billingMode: 'contract',
        provisioning: {
          runId: '01JC0000000000000000000R03',
          step: 'access.ready',
          attempts: 0,
          nodeVersion: 'node-v1.2.3',
        },
        run: {
          runId: '01JC0000000000000000000R03',
          kind: 'provision',
          startedAt: at(290),
          finishedAt: at(250),
          outcome: 'succeeded',
          release: 'node-v1.2.3',
        },
        timeline: timeline(at, 10),
        access: { revealEmailSentAt: at(250), passwordRevealedAt: at(240) },
        transitions: [
          { from: null, to: 'pending', reason: 'contract_created', at: at(300) },
          { from: 'pending', to: 'provisioning', reason: 'contract_provisioning_started', at: at(299) },
          {
            from: 'provisioning',
            to: 'waiting_customer_connection',
            reason: 'provisioning_finished',
            at: at(250),
          },
          {
            from: 'waiting_customer_connection',
            to: 'active',
            reason: 'first_account_connected',
            at: at(200),
          },
        ],
      },
      now(),
    ),
  );
  return { tenants, workerDown: false };
}

function listItem(tenant: TenantDetail): TenantListItem {
  const provisioning = tenant.state === 'provisioning' || tenant.state === 'provisioning_failed';
  return {
    id: tenant.id,
    slug: tenant.slug,
    companyName: tenant.company.legalName,
    state: tenant.state,
    stateUpdatedAt: tenant.stateUpdatedAt,
    billingMode: tenant.billingMode,
    size: tenant.configuration.size,
    ...(provisioning && tenant.provisioning?.step !== undefined ? { step: tenant.provisioning.step } : {}),
    ...(tenant.state === 'provisioning_failed' && tenant.provisioning?.lastError !== undefined
      ? { lastErrorCode: tenant.provisioning.lastError.code }
      : {}),
    createdAt: tenant.createdAt,
  };
}

function problemsOf(configuration: { mode: string; size: string; agents: number }): NodeFitProblem[] {
  const problems: NodeFitProblem[] = [];
  if (configuration.mode !== 'managed') problems.push('mode');
  if (configuration.size !== 'P') problems.push('size');
  if (configuration.agents !== 0) problems.push('agents');
  return problems;
}

function configurationIssues(configuration: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of ['cloudAccounts', 'monthlyGib', 'agents', 'historyDays'] as const) {
    const value = isRecord(configuration) ? configuration[key] : undefined;
    if (typeof value !== 'number' || value < 0) {
      issues.push({
        path: `configuration.${key}`,
        message: 'Entrada inválida: esperado number, recebido undefined',
      });
    }
  }
  return issues;
}

/** Uma mudança de estado do cliente, com a transição no histórico. */
function transition(
  tenant: TenantDetail,
  to: TenantState,
  reason: string,
  now: Date,
  patch: Partial<TenantDetail> = {},
): TenantDetail {
  const { actions: _actions, ...rest } = tenant;
  return withActions(
    {
      ...rest,
      ...patch,
      state: to,
      stateUpdatedAt: now.toISOString(),
      transitions: [...tenant.transitions, { from: tenant.state, to, reason, at: now.toISOString() }],
    },
    now,
  );
}

/** Um novo começo do provisionamento: a conferência inicial em andamento numa execução nova. */
function startRun(
  tenant: TenantDetail,
  now: Date,
  kind: 'provision' | 'resume',
  runId: string,
): TenantDetail {
  const at = (minutes: number): string => new Date(now.getTime() - minutes * MINUTE).toISOString();
  return transition(
    tenant,
    'provisioning',
    kind === 'resume' ? 'provisioning_resumed' : 'contract_provisioning_started',
    now,
    {
      provisioning: {
        runId,
        step: 'preflight',
        attempts: kind === 'resume' ? (tenant.provisioning?.attempts ?? 0) + 1 : 0,
      },
      run: { runId, kind, startedAt: now.toISOString() },
      timeline: timeline(at, 0, { status: 'running' }),
    },
  );
}

let runSequence = 0;
function nextRunId(): string {
  runSequence += 1;
  return `01JC00000000000000000R${String(runSequence).padStart(4, '0')}`;
}

const ACTION_FLAGS: Readonly<Record<string, keyof TenantActions>> = {
  start: 'start',
  resume: 'resume',
  cancel: 'cancel',
  suspend: 'suspend',
  reactivate: 'reactivate',
  'delete-now': 'deleteNow',
  export: 'export',
};

/** Uma operação do responsável, com as recusas do cp-worker. */
function act(
  state: FakeTenantsState,
  tenant: TenantDetail,
  action: string,
  body: Record<string, unknown>,
  now: Date,
): FakeResponse {
  if (body['confirmSlug'] !== tenant.slug) {
    return error(400, 'O subdomínio não confere com o do cliente: nada mudou.', 'confirmation_mismatch', {
      issues: [{ path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' }],
    });
  }
  if (state.workerDown) return error(503, 'Serviço indisponível', 'worker_unavailable');
  const flag = ACTION_FLAGS[action];
  if (flag === undefined) return error(404, 'Recurso não encontrado', 'not_found');
  if (tenant.billingMode === 'stripe' && ['start', 'cancel', 'suspend', 'reactivate'].includes(action)) {
    return error(
      409,
      'Cliente da Stripe: o provisionamento e o resto seguem a assinatura.',
      'stripe_managed',
    );
  }
  if (!tenant.actions[flag]) {
    return error(
      409,
      'O cliente não está num estado que permita isso.',
      action === 'resume' ? 'not_resumable' : 'not_allowed',
    );
  }
  switch (action) {
    case 'start':
    case 'resume': {
      const runId = nextRunId();
      state.tenants.set(tenant.id, startRun(tenant, now, action === 'start' ? 'provision' : 'resume', runId));
      return { status: 200, body: { action, runId, step: 'preflight' } };
    }
    case 'suspend':
      state.tenants.set(
        tenant.id,
        transition(tenant, 'suspended', 'contract_suspended_by_owner', now, {
          lifecycle: { ...tenant.lifecycle, suspendedReason: 'owner', nodeStoppedAt: now.toISOString() },
        }),
      );
      return { status: 200, body: { action, state: 'suspended' } };
    case 'reactivate': {
      const { suspendedReason: _reason, nodeStoppedAt: _stopped, ...lifecycle } = tenant.lifecycle;
      state.tenants.set(
        tenant.id,
        transition(tenant, 'active', 'contract_reactivated_by_owner', now, { lifecycle }),
      );
      return { status: 200, body: { action, state: 'active' } };
    }
    case 'cancel': {
      const at = typeof body['at'] === 'string' ? new Date(body['at']) : undefined;
      if (at !== undefined && at.getTime() > now.getTime() + MINUTE) {
        if (at.getTime() > now.getTime() + 2 * 366 * DAY) {
          return error(
            400,
            'A data do cancelamento tem de ser agora ou futura (até 2 anos).',
            'invalid_date',
            {
              issues: [
                { path: 'at', message: 'A data do cancelamento tem de ser agora ou futura (até 2 anos).' },
              ],
            },
          );
        }
        const { actions: _actions, ...rest } = tenant;
        state.tenants.set(
          tenant.id,
          withActions(
            { ...rest, lifecycle: { ...tenant.lifecycle, cancelScheduledFor: at.toISOString() } },
            now,
          ),
        );
        return { status: 200, body: { action, result: 'scheduled', cancelAt: at.toISOString() } };
      }
      if (at !== undefined && at.getTime() < now.getTime() - MINUTE) {
        return error(400, 'A data do cancelamento tem de ser agora ou futura (até 2 anos).', 'invalid_date', {
          issues: [
            { path: 'at', message: 'A data do cancelamento tem de ser agora ou futura (até 2 anos).' },
          ],
        });
      }
      const deleteAfter = new Date(now.getTime() + 30 * DAY).toISOString();
      const cryptoDestroyAfter = new Date(now.getTime() + 97 * DAY).toISOString();
      const { cancelScheduledFor: _scheduled, ...lifecycle } = tenant.lifecycle;
      state.tenants.set(
        tenant.id,
        transition(tenant, 'canceled', 'contract_canceled_by_owner', now, {
          lifecycle: {
            ...lifecycle,
            canceledAt: now.toISOString(),
            exportUntil: deleteAfter,
            deleteAfter,
            cryptoDestroyAfter,
            nodeStoppedAt: now.toISOString(),
          },
        }),
      );
      return { status: 200, body: { action, result: 'canceled', deleteAfter, cryptoDestroyAfter } };
    }
    case 'delete-now': {
      const { actions: _actions, ...rest } = tenant;
      state.tenants.set(
        tenant.id,
        withActions(
          {
            ...rest,
            lifecycle: {
              ...tenant.lifecycle,
              run: { kind: 'delete', step: 'node.destroy', startedAt: now.toISOString() },
            },
          },
          now,
        ),
      );
      return { status: 200, body: { action, deletion: 'started', phase: 'delete' } };
    }
    case 'export': {
      const object = typeof body['object'] === 'string' ? body['object'] : '';
      if (!BACKUP_PATTERN.test(object)) {
        return error(400, 'O backup deve ser postgres/verax-<AAAAMMDD>T<HHMMSS>Z.dump.', 'invalid_object', {
          issues: [
            { path: 'object', message: 'O backup deve ser postgres/verax-<AAAAMMDD>T<HHMMSS>Z.dump.' },
          ],
        });
      }
      return {
        status: 200,
        body: {
          action,
          object,
          url: `https://storage.googleapis.com/projeto-dos-nos-demo-vx-${tenant.slug}-backups/${object}?X-Goog-Signature=teste`,
          expiresAt: new Date(now.getTime() + DAY).toISOString(),
        },
      };
    }
    default:
      return error(404, 'Recurso não encontrado', 'not_found');
  }
}

/** Atende `/v1/admin/tenants...` (as partes do caminho depois de `/v1/admin/tenants`). */
export function handleTenantsRequest(
  state: FakeTenantsState,
  table: PriceTable | undefined,
  tableVersion: string | undefined,
  now: Date,
  method: string,
  second: string | undefined,
  third: string | undefined,
  body: unknown,
): FakeResponse {
  if (second === undefined && method === 'GET') {
    const tenants = [...state.tenants.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(listItem);
    return { status: 200, body: { tenants, unreadable: 0, limit: 200 } };
  }
  if (second === 'preview' && method === 'POST') {
    const configuration = isRecord(body) ? body['configuration'] : undefined;
    const issues = configurationIssues(configuration);
    if (issues.length > 0) return invalid(issues);
    if (table === undefined || tableVersion === undefined) {
      return error(409, 'Nenhuma tabela de preços vigente.', 'pricing_table_missing');
    }
    const outcome = quote(configuration as ConfigurationInput, table);
    if (outcome.kind === 'contact_us') {
      return {
        status: 200,
        body: { priceTableVersion: tableVersion, contactUs: true, reason: outcome.reason },
      };
    }
    return {
      status: 200,
      body: {
        priceTableVersion: tableVersion,
        contactUs: false,
        quote: outcome.quote,
        problems: problemsOf(outcome.quote.configuration),
      },
    };
  }
  if (second === undefined && method === 'POST') return create(state, table, tableVersion, now, body);
  if (second === undefined) return error(404, 'Recurso não encontrado', 'not_found');

  const tenant = state.tenants.get(second);
  if (tenant === undefined) return error(404, 'Cliente não encontrado.', 'tenant_not_found');
  if (third === undefined && method === 'GET') return { status: 200, body: tenant };
  if (third !== undefined && method === 'POST')
    return act(state, tenant, third, isRecord(body) ? body : {}, now);
  return error(404, 'Recurso não encontrado', 'not_found');
}

function create(
  state: FakeTenantsState,
  table: PriceTable | undefined,
  tableVersion: string | undefined,
  now: Date,
  body: unknown,
): FakeResponse {
  if (!isRecord(body)) return invalid([{ path: '(raiz)', message: 'Entrada inválida' }]);
  const issues: ValidationIssue[] = [];
  for (const field of ['companyName', 'cnpj', 'adminEmail', 'slug'] as const) {
    const value = body[field];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({ path: field, message: 'Entrada inválida: esperado string, recebido undefined' });
    }
  }
  const slug = typeof body['slug'] === 'string' ? body['slug'] : '';
  if (slug !== '' && !SLUG_PATTERN.test(slug)) issues.push({ path: 'slug', message: 'subdomínio inválido' });
  const email = typeof body['adminEmail'] === 'string' ? body['adminEmail'] : '';
  if (email !== '' && !email.includes('@')) {
    issues.push({ path: 'adminEmail', message: 'Endereço de e-mail inválido' });
  }
  issues.push(...configurationIssues(body['configuration']));
  if (issues.length > 0) return invalid(issues);
  if (body['confirmSlug'] !== slug) {
    return error(400, 'O subdomínio não confere com o do cliente: nada mudou.', 'confirmation_mismatch', {
      issues: [{ path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' }],
    });
  }
  const key = String(body['idempotencyKey']);
  const existing = state.tenants.get(key);
  if (existing !== undefined) {
    if (existing.slug !== slug) {
      return error(
        409,
        'Este cadastro já foi usado para outro cliente. Recarregue a página para começar um cadastro novo.',
        'idempotency_conflict',
      );
    }
    return {
      status: 201,
      body: {
        id: existing.id,
        slug,
        replayed: true,
        provisioning:
          existing.provisioning?.runId === undefined
            ? { started: false, failure: 'worker_unavailable' }
            : {
                started: true,
                runId: existing.provisioning.runId,
                step: existing.provisioning.step ?? 'preflight',
              },
      },
    };
  }
  const taken = [...state.tenants.values()].some((tenant) => tenant.slug === slug);
  if (taken || RESERVED.has(slug)) {
    return error(409, 'Este subdomínio não está disponível.', 'slug_unavailable', {
      issues: [{ path: 'slug', message: 'Este subdomínio não está disponível. Escolha outro.' }],
    });
  }
  if (table === undefined || tableVersion === undefined) {
    return error(409, 'Nenhuma tabela de preços vigente.', 'pricing_table_missing');
  }
  const outcome = quote(body['configuration'] as ConfigurationInput, table);
  if (outcome.kind === 'contact_us') {
    return error(
      422,
      'Esta configuração está acima do que a tabela de preços vende.',
      'configuration_contact_us',
      {
        reason: outcome.reason,
        issues: [{ path: 'configuration', message: 'Acima do que a tabela vende.' }],
      },
    );
  }
  const problems = problemsOf(outcome.quote.configuration);
  if (problems.length > 0) {
    return error(
      422,
      'O provisionamento ainda não sabe criar esta configuração.',
      'configuration_unsupported',
      {
        problems,
        issues: [{ path: 'configuration', message: 'O provisionamento ainda não cria esta configuração.' }],
      },
    );
  }
  const at = (minutes: number): string => new Date(now.getTime() - minutes * MINUTE).toISOString();
  const pending = withActions(
    {
      ...base(key, slug, String(body['companyName']).trim(), at),
      createdAt: now.toISOString(),
      stateUpdatedAt: now.toISOString(),
      adminEmail: email.trim(),
      configuration: outcome.quote.configuration,
      limits: outcome.quote.limits,
      pricing: {
        priceTableVersion: tableVersion,
        quoteId: '01JC00000000000000000000Q9',
        monthlyTotal: outcome.quote.monthlyTotal,
        setupTotal: outcome.quote.setupTotal,
      },
      state: 'pending',
      billingMode: 'contract',
      timeline: timeline(at, 0),
      transitions: [{ from: null, to: 'pending', reason: 'contract_created', at: now.toISOString() }],
    },
    now,
  );
  if (state.workerDown) {
    state.tenants.set(key, pending);
    return {
      status: 201,
      body: {
        id: key,
        slug,
        replayed: false,
        provisioning: { started: false, failure: 'worker_unavailable' },
      },
    };
  }
  const runId = nextRunId();
  state.tenants.set(key, startRun(pending, now, 'provision', runId));
  return {
    status: 201,
    body: { id: key, slug, replayed: false, provisioning: { started: true, runId, step: 'preflight' } },
  };
}
