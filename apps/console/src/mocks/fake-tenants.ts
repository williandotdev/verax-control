import type {
  ConfigurationInput,
  ContractAmendmentView,
  ContractedConfiguration,
  ContractPricing,
  ContractTermsView,
  ContractValues,
  Hosting,
  NodeFitProblem,
  PriceTable,
  ProvisioningStepName,
  TenantActions,
  TenantDetail,
  TenantInstallation,
  TenantListItem,
  TenantState,
  TimelineStep,
  ValidationIssue,
} from '@/lib/api-types';
import {
  addMonths,
  PLATAFORMA_CONTRACT_MONTHS,
  VCISO_CONTRACT_MONTHS,
} from '@/features/tenants/contract-term';
import { additionalGbDayAmount, quote } from './fake-engine';

/**
 * Os clientes na API simulada do console (`/v1/admin/tenants...`), em memória: a lista, o detalhe com a linha do tempo,
 * a cotação de referência, o cadastro de contrato direto (com a chave de idempotência) e as operações do responsável.
 * Imita os contratos de `apps/control-plane/src/admin/admin-tenants.*` e as regras do cp-worker (CP-07 e CP-11), com
 * uma amostra da validação (a de verdade é a da API). Clientes FICTÍCIOS ("Cliente Demo A/B/C/E"), CNPJ de exemplo,
 * nenhum dado real. Inclui o contrato direto com o ambiente na infraestrutura do cliente (nada provisionado) e a versão
 * FICTÍCIA que o console mostra para ele instalar, e um cliente contratado no modelo de preço anterior (o B, sem plano).
 */
export interface FakeTenantsState {
  tenants: Map<string, TenantDetail>;
  /** O cp-worker fora do alcance do console: o cadastro fica em `pending`, e as operações respondem 503. */
  workerDown: boolean;
  /** A versão vigente do nó é de antes do instalador da VM do cliente (o manifesto sem `installer`). */
  withoutInstaller?: boolean;
  /** A senha temporária no cofre já venceu (a revelação responde `password_expired`, sem marcar nada). */
  bootstrapExpired?: boolean;
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
  'secrets.smtp_password',
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
  'waiting_customer_install',
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
  const verax = tenant.hosting === 'verax';
  const exportUntil = tenant.lifecycle.exportUntil;
  return {
    start: verax && contract && tenant.state === 'pending',
    resume: verax && (tenant.state === 'provisioning_failed' || tenant.state === 'provisioning'),
    cancel: contract && CANCELABLE.includes(tenant.state),
    suspend:
      verax &&
      contract &&
      (tenant.state === 'active' ||
        tenant.state === 'waiting_customer_connection' ||
        tenant.state === 'past_due'),
    reactivate:
      verax && contract && tenant.state === 'suspended' && tenant.lifecycle.suspendedReason === 'owner',
    deleteNow: tenant.state === 'canceled',
    export: verax && tenant.state === 'canceled' && exportUntil !== undefined && new Date(exportUntil) > now,
    enrollmentCode:
      !verax &&
      [
        'waiting_customer_install',
        'provisioning',
        'provisioning_failed',
        'waiting_customer_connection',
        'active',
      ].includes(tenant.state),
    amend: amendable(tenant),
    amendHosting: amendable(tenant) && hostingChangeAllowed(tenant),
  };
}

/** O aditivo cabe: contrato direto, antes do fim do contrato e no modelo por GB/dia (`amendRefusalOf` do cp-admin). */
function amendable(tenant: Omit<TenantDetail, 'actions'>): boolean {
  return (
    tenant.billingMode === 'contract' &&
    tenant.state !== 'canceled' &&
    tenant.state !== 'deleted' &&
    'plan' in tenant.configuration
  );
}

/** Onde o ambiente roda ainda muda: nada instalado nem provisionado (`hostingChangeAllowed` do cp-admin). */
function hostingChangeAllowed(tenant: Omit<TenantDetail, 'actions'>): boolean {
  if (tenant.provisioning?.runId !== undefined) return false;
  return tenant.hosting === 'customer'
    ? tenant.state === 'waiting_customer_install'
    : tenant.state === 'pending';
}

/** A versão FICTÍCIA que o cliente instala na infraestrutura dele (o manifesto conferido pelo cp-worker, simulado). */
function installationOf(tenant: TenantDetail, withInstaller: boolean): TenantInstallation {
  const github = 'https://github.com/williandotdev/verax-control';
  const release = 'node-v1.2.3';
  return {
    ...(withInstaller
      ? {
          installer: {
            url: `${github}/releases/download/${release}/verax-install.sh`,
            sha256: '5'.repeat(64),
          },
        }
      : {}),
    release,
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    releasedAt: '2026-11-05T12:00:00Z',
    releaseUrl: `${github}/releases/tag/${release}`,
    manifestUrl: `${github}/releases/download/${release}/manifest.json`,
    signatureUrl: `${github}/releases/download/${release}/manifest.json.sig`,
    guideUrl: `${github}/blob/main/docs/runbooks/instalacao-no-cliente.md`,
    package: {
      url: `${github}/releases/download/${release}/verax-node.tar.gz`,
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    images: {
      api: `ghcr.io/williandotdev/verax-control/api@sha256:${'1'.repeat(64)}`,
      migrate: `ghcr.io/williandotdev/verax-control/migrate@sha256:${'2'.repeat(64)}`,
    },
    thirdPartyImages: [`postgres:18-alpine@sha256:${'3'.repeat(64)}`],
    releaseKey: { name: 'release-node-manifest-v1', sha256: '4'.repeat(64) },
    size: tenant.configuration.size,
    nodeConf: [
      { name: 'PLAN', value: 'enterprise' },
      { name: 'PLAN_MAX_CLOUD_ACCOUNTS', value: String(tenant.limits.maxCloudAccounts) },
      { name: 'PLAN_MONTHLY_GIB', value: String(tenant.limits.monthlyGib) },
      { name: 'PLAN_HISTORY_DAYS', value: String(tenant.limits.historyDays) },
      { name: 'PLAN_MAX_USERS', value: String(tenant.limits.maxUsers) },
      { name: 'WAZUH_AGENTS', value: tenant.limits.maxAgents > 0 ? 'true' : 'false' },
      ...(tenant.limits.maxAgents > 0
        ? [{ name: 'WAZUH_AGENTS_MAX', value: String(tenant.limits.maxAgents) }]
        : []),
    ],
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
    hosting: 'verax',
    stateUpdatedAt: at(30),
    createdAt: at(120),
    company: { legalName: name, cnpj: '11222333000181' },
    adminEmail: `admin@${slug}.example`,
    configuration: { plan: 'plataforma', mode: 'managed', gbDay: 2, size: 'P', historyDays: 30 },
    limits: { maxCloudAccounts: 50, monthlyGib: 58, historyDays: 30, maxAgents: 0, maxUsers: 10 },
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
    amendments: [],
  };
}

/**
 * Cinco clientes FICTÍCIOS: um de contrato direto parado no túnel, um pago ativo, um de contrato que não começou, um
 * de contrato ativo (para suspender, cancelar, apagar e exportar) e um de contrato com o ambiente na infraestrutura do
 * cliente, esperando a instalação.
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
        // Contratado no modelo de preço anterior: a configuração de antes, só para leitura.
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
        timeline: timeline(at, STEPS.length),
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
        timeline: timeline(at, STEPS.length),
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
  const customer = '01JC0000000000000000000E01';
  const { urls: _urls, ...customerBase } = base(customer, 'cliente-demo-e', 'Cliente Demo E Ltda', at);
  tenants.set(
    customer,
    withActions(
      {
        ...customerBase,
        createdAt: at(60),
        stateUpdatedAt: at(60),
        state: 'waiting_customer_install',
        billingMode: 'contract',
        hosting: 'customer',
        configuration: { plan: 'dedicado', mode: 'self_hosted', gbDay: 3, size: 'P', historyDays: 30 },
        limits: { maxCloudAccounts: 100, monthlyGib: 87, historyDays: 30, maxAgents: 0, maxUsers: 10 },
        pricing: { ...customerBase.pricing, monthlyTotal: 150_000, setupTotal: 0 },
        // Negociado por fora (FICTÍCIO): abaixo da referência da tabela.
        contractPricing: {
          reference: { monthlyTotal: 150_000, additionalGbDayAmount: 50_000 },
          contracted: { monthlyTotal: 135_000, additionalGbDayAmount: 45_000 },
        },
        timeline: [],
        transitions: [
          {
            from: null,
            to: 'waiting_customer_install',
            reason: 'contract_created_customer_hosted',
            at: at(60),
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
    hosting: tenant.hosting,
    ...('plan' in tenant.configuration ? { plan: tenant.configuration.plan } : {}),
    size: tenant.configuration.size,
    ...(provisioning && tenant.provisioning?.step !== undefined ? { step: tenant.provisioning.step } : {}),
    ...(tenant.state === 'provisioning_failed' && tenant.provisioning?.lastError !== undefined
      ? { lastErrorCode: tenant.provisioning.lastError.code }
      : {}),
    createdAt: tenant.createdAt,
  };
}

function problemsOf(configuration: ContractedConfiguration, hosting: Hosting): NodeFitProblem[] {
  const problems: NodeFitProblem[] = [];
  // No cliente, nada é provisionado: o porte não conta. Os agentes não são vendidos, e os limites ficam sempre dentro
  // das faixas na tabela FICTÍCIA.
  if (hosting === 'verax') {
    if (configuration.mode !== 'managed') problems.push('mode');
    if (configuration.size !== 'P') problems.push('size');
  }
  return problems;
}

function hostingOf(body: unknown): Hosting | undefined {
  const value = isRecord(body) ? body['hosting'] : undefined;
  return value === 'verax' || value === 'customer' ? value : undefined;
}

const HOSTING_ISSUE: ValidationIssue = {
  path: 'hosting',
  message: 'Escolha onde o ambiente roda: na infraestrutura da Verax ou na do cliente.',
};

/** O plano e o volume do contrato direto com o modo do lugar escolhido. */
function configurationFor(hosting: Hosting, configuration: unknown): ConfigurationInput {
  return {
    ...(configuration as Omit<ConfigurationInput, 'mode'>),
    mode: hosting === 'customer' ? 'self_hosted' : 'managed',
  };
}

const PLANS: readonly unknown[] = ['plataforma', 'dedicado', 'vciso'];

function configurationIssues(configuration: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const plan = isRecord(configuration) ? configuration['plan'] : undefined;
  if (!PLANS.includes(plan)) {
    issues.push({ path: 'configuration.plan', message: 'Escolha o plano.' });
  }
  const gbDay = isRecord(configuration) ? configuration['gbDay'] : undefined;
  if (typeof gbDay !== 'number' || !Number.isInteger(gbDay) || gbDay < 1) {
    issues.push({
      path: 'configuration.gbDay',
      message: 'Entrada inválida: esperado number, recebido undefined',
    });
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
  if (tenant.hosting === 'customer' && (action === 'start' || action === 'resume')) {
    return error(
      409,
      'O ambiente deste cliente roda na infraestrutura dele: a Verax não provisiona, não para, não liga nem apaga nada lá.',
      'customer_hosted',
    );
  }
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
      const verax = tenant.hosting === 'verax';
      state.tenants.set(
        tenant.id,
        transition(tenant, 'canceled', 'contract_canceled_by_owner', now, {
          lifecycle: {
            ...lifecycle,
            canceledAt: now.toISOString(),
            // No cliente: sem exportação (os dados nunca estiveram na Verax) e sem VM para parar.
            ...(verax ? { exportUntil: deleteAfter } : {}),
            deleteAfter,
            cryptoDestroyAfter,
            ...(verax ? { nodeStoppedAt: now.toISOString() } : {}),
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

/** Os passos da execução reduzida, na VM do cliente. */
const CUSTOMER_STEPS: readonly ProvisioningStepName[] = [
  'preflight',
  'cloudflare.tunnel',
  'firebase.site',
  'enrollment.wait',
  'node.health',
  'panel.domain_wait',
  'access.ready',
];

/** Um código FICTÍCIO no formato do de verdade (32 bytes em base64url: 43 caracteres). */
let codeSequence = 0;
function fakeEnrollmentCode(): string {
  codeSequence += 1;
  return `FICTICIO${String(codeSequence).padStart(4, '0')}`.padEnd(43, 'x');
}

/**
 * `POST .../enrollment-code`: o código de uso único (7 dias), como o cp-worker: revoga o anterior; na espera da
 * instalação ou parado, começa a execução reduzida; com o ambiente pronto, é uma reinstalação.
 */
function enrollmentCode(
  state: FakeTenantsState,
  tenant: TenantDetail,
  body: Record<string, unknown>,
  now: Date,
): FakeResponse {
  if (body['confirmSlug'] !== tenant.slug) {
    return error(400, 'O subdomínio não confere com o do cliente: nada mudou.', 'confirmation_mismatch', {
      issues: [{ path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' }],
    });
  }
  if (tenant.hosting !== 'customer') {
    return error(
      409,
      'O ambiente deste cliente roda na infraestrutura da Verax: não há instalação para enviar.',
      'not_customer_hosted',
    );
  }
  if (state.workerDown) return error(503, 'Serviço indisponível', 'worker_unavailable');
  if (!tenant.actions.enrollmentCode) {
    return error(409, 'O cliente não está num estado que permita isso.', 'not_allowed');
  }
  const code = fakeEnrollmentCode();
  const expiresAt = new Date(now.getTime() + 7 * DAY).toISOString();
  const reinstall = tenant.state === 'waiting_customer_connection' || tenant.state === 'active';
  if (tenant.state === 'waiting_customer_install' || tenant.state === 'provisioning_failed') {
    const runId = nextRunId();
    state.tenants.set(
      tenant.id,
      transition(tenant, 'provisioning', 'enrollment_provisioning_started', now, {
        provisioning: { runId, step: 'preflight', attempts: 0 },
        run: { runId, kind: 'provision', startedAt: now.toISOString() },
        timeline: CUSTOMER_STEPS.map((name, index) =>
          index === 0
            ? { name, status: 'running', attempts: 1, startedAt: now.toISOString() }
            : { name, status: 'pending', attempts: 0 },
        ),
      }),
    );
    return { status: 200, body: { code, expiresAt, reinstall, runId, step: 'preflight' } };
  }
  return { status: 200, body: { code, expiresAt, reinstall } };
}

/** Uma senha temporária FICTÍCIA, gerada a cada revelação (nada fixo no código). */
function fakeTemporaryPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `Tmp-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * `POST .../reveal-access`: a revelação única pelo responsável, como o cp-admin e o cp-worker: o subdomínio digitado,
 * o cliente esperando a conexão e ainda sem revelação; marca `access.passwordRevealedAt` e devolve o acesso uma vez.
 */
function revealAccess(
  state: FakeTenantsState,
  tenant: TenantDetail,
  body: Record<string, unknown>,
  now: Date,
): FakeResponse {
  if (body['confirmSlug'] !== tenant.slug) {
    return error(400, 'O subdomínio não confere com o do cliente: nada mudou.', 'confirmation_mismatch', {
      issues: [{ path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' }],
    });
  }
  if (state.workerDown) return error(503, 'Serviço indisponível', 'worker_unavailable');
  if (tenant.access.passwordRevealedAt !== undefined) {
    return error(
      409,
      'A senha inicial já foi revelada (pelo cliente ou pelo console): ela não aparece de novo.',
      'already_revealed',
    );
  }
  if (tenant.state !== 'waiting_customer_connection') {
    return error(
      409,
      'O cliente não está esperando o primeiro acesso: não há senha inicial a revelar.',
      'reveal_not_available',
    );
  }
  if (state.bootstrapExpired === true) {
    return error(
      410,
      'A senha temporária já venceu: renove pelo runbook de onboarding (§7).',
      'password_expired',
    );
  }
  state.tenants.set(tenant.id, {
    ...tenant,
    access: { ...tenant.access, passwordRevealedAt: now.toISOString() },
  });
  return {
    status: 200,
    body: {
      panelUrl: `https://${tenant.slug}.control.veraxsistemas.com.br`,
      adminEmail: tenant.adminEmail,
      password: fakeTemporaryPassword(),
      passwordExpiresAt: new Date(now.getTime() + 2 * DAY).toISOString(),
    },
  };
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
    const hosting = hostingOf(body);
    const issues = [...(hosting === undefined ? [HOSTING_ISSUE] : []), ...configurationIssues(configuration)];
    if (issues.length > 0 || hosting === undefined) return invalid(issues);
    if (table === undefined || tableVersion === undefined) {
      return error(409, 'Nenhuma tabela de preços vigente.', 'pricing_table_missing');
    }
    const outcome = quote(configurationFor(hosting, configuration), table);
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
        reference: {
          monthlyTotal: outcome.quote.monthlyTotal,
          additionalGbDayAmount: additionalGbDayAmount(table, outcome.quote.configuration.plan),
        },
        problems: problemsOf(outcome.quote.configuration, hosting),
      },
    };
  }
  if (second === undefined && method === 'POST') return create(state, table, tableVersion, now, body);
  if (second === undefined) return error(404, 'Recurso não encontrado', 'not_found');

  const tenant = state.tenants.get(second);
  if (tenant === undefined) return error(404, 'Cliente não encontrado.', 'tenant_not_found');
  if (third === undefined && method === 'GET') return { status: 200, body: tenant };
  if (third === 'installation' && method === 'GET') {
    if (tenant.hosting !== 'customer') {
      return error(
        409,
        'O ambiente deste cliente roda na infraestrutura da Verax: não há instalação para enviar.',
        'not_customer_hosted',
      );
    }
    if (state.workerDown) return error(503, 'Serviço indisponível', 'worker_unavailable');
    return { status: 200, body: installationOf(tenant, state.withoutInstaller !== true) };
  }
  if (third === 'enrollment-code' && method === 'POST') {
    return enrollmentCode(state, tenant, isRecord(body) ? body : {}, now);
  }
  if (third === 'reveal-access' && method === 'POST') {
    return revealAccess(state, tenant, isRecord(body) ? body : {}, now);
  }
  if (third === 'amend' && method === 'POST') {
    return amend(state, table, tableVersion, tenant, isRecord(body) ? body : {}, now);
  }
  if (third !== undefined && method === 'POST')
    return act(state, tenant, third, isRecord(body) ? body : {}, now);
  return error(404, 'Recurso não encontrado', 'not_found');
}

/** O contratado do pedido: ausente, `undefined`; fora dos limites da API (`contractValuesSchema`), `invalid`. */
function contractedOf(value: unknown): ContractValues | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length !== 2) return 'invalid';
  const monthly = value['monthlyTotal'];
  const additional = value['additionalGbDayAmount'];
  const cents = (amount: unknown, min: number): amount is number =>
    typeof amount === 'number' && Number.isInteger(amount) && amount >= min && amount <= 100_000_000;
  if (!cents(monthly, 1) || !cents(additional, 0)) return 'invalid';
  return { monthlyTotal: monthly, additionalGbDayAmount: additional };
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
  const hosting = hostingOf(body);
  if (hosting === undefined) issues.push(HOSTING_ISSUE);
  issues.push(...configurationIssues(body['configuration']));
  const contracted = contractedOf(body['contracted']);
  if (contracted === 'invalid') {
    issues.push({ path: 'contracted.monthlyTotal', message: 'Valor fora do permitido.' });
  }
  if (issues.length > 0 || hosting === undefined || contracted === 'invalid') return invalid(issues);
  if (body['confirmSlug'] !== slug) {
    return error(400, 'O subdomínio não confere com o do cliente: nada mudou.', 'confirmation_mismatch', {
      issues: [{ path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' }],
    });
  }
  const key = String(body['idempotencyKey']);
  const existing = state.tenants.get(key);
  if (existing !== undefined) {
    if (existing.slug !== slug || existing.hosting !== hosting) {
      return error(
        409,
        'Este cadastro já foi usado para outro cliente. Recarregue a página para começar um cadastro novo.',
        'idempotency_conflict',
      );
    }
    if (existing.hosting === 'customer') {
      return { status: 201, body: { id: existing.id, slug, replayed: true, hosting: 'customer' } };
    }
    return {
      status: 201,
      body: {
        id: existing.id,
        slug,
        replayed: true,
        hosting: 'verax',
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
  const outcome = quote(configurationFor(hosting, body['configuration']), table);
  if (outcome.kind === 'contact_us') {
    return error(
      422,
      'Esta configuração está acima do que a tabela de preços vende.',
      'configuration_contact_us',
      {
        reason: outcome.reason,
        issues: [
          outcome.reason === 'mode_unavailable'
            ? {
                path: 'configuration.plan',
                message:
                  'O SIEM Cloud roda só na célula da Verax: no ambiente do cliente, escolha o SIEM Dedicado ou o SIEM + vCISO.',
              }
            : { path: 'configuration.gbDay', message: 'Acima do que a tabela vende.' },
        ],
      },
    );
  }
  const reference: ContractValues = {
    monthlyTotal: outcome.quote.monthlyTotal,
    additionalGbDayAmount: additionalGbDayAmount(table, outcome.quote.configuration.plan),
  };
  const contractPricing = { reference, contracted: contracted ?? reference };
  const problems = problemsOf(outcome.quote.configuration, hosting);
  if (problems.length > 0) {
    return error(
      422,
      hosting === 'customer'
        ? 'Esta configuração ainda não pode ser instalada na infraestrutura do cliente.'
        : 'O provisionamento ainda não sabe criar esta configuração.',
      'configuration_unsupported',
      {
        problems,
        issues: [
          { path: 'configuration.gbDay', message: 'O provisionamento ainda não cria esta configuração.' },
        ],
      },
    );
  }
  const at = (minutes: number): string => new Date(now.getTime() - minutes * MINUTE).toISOString();
  if (hosting === 'customer') {
    // No cliente: nasce esperando a instalação, sem passos, sem endereços da Verax e sem pedir nada ao worker.
    const { urls: _urls, ...rest } = base(key, slug, String(body['companyName']).trim(), at);
    state.tenants.set(
      key,
      withActions(
        {
          ...rest,
          hosting: 'customer',
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
          contractPricing,
          state: 'waiting_customer_install',
          billingMode: 'contract',
          timeline: [],
          transitions: [
            {
              from: null,
              to: 'waiting_customer_install',
              reason: 'contract_created_customer_hosted',
              at: now.toISOString(),
            },
          ],
        },
        now,
      ),
    );
    return { status: 201, body: { id: key, slug, replayed: false, hosting: 'customer' } };
  }
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
      contractPricing,
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
        hosting: 'verax',
        provisioning: { started: false, failure: 'worker_unavailable' },
      },
    };
  }
  const runId = nextRunId();
  state.tenants.set(key, startRun(pending, now, 'provision', runId));
  return {
    status: 201,
    body: {
      id: key,
      slug,
      replayed: false,
      hosting: 'verax',
      provisioning: { started: true, runId, step: 'preflight' },
    },
  };
}

const AMENDABLE_PLANS: readonly unknown[] = ['plataforma', 'dedicado', 'vciso'];

function termsOf(tenant: Omit<TenantDetail, 'actions'>): ContractTermsView {
  return {
    hosting: tenant.hosting,
    configuration: tenant.configuration as ContractTermsView['configuration'],
    limits: tenant.limits,
    pricing: tenant.pricing,
    ...(tenant.contractPricing === undefined ? {} : { contractPricing: tenant.contractPricing }),
    ...(tenant.contractTerm === undefined ? {} : { contractTerm: tenant.contractTerm }),
  };
}

let amendmentSequence = 0;

/**
 * `POST .../amend`: o aditivo do contrato direto, com as regras do cp-admin (uma amostra da validação): o plano (Dedicado
 * ou vCISO), o volume, onde roda (só antes de qualquer instalação) e os valores; a vigência recomeça no aditivo.
 */
function amend(
  state: FakeTenantsState,
  table: PriceTable | undefined,
  tableVersion: string | undefined,
  tenant: TenantDetail,
  body: Record<string, unknown>,
  now: Date,
): FakeResponse {
  const hosting = hostingOf(body);
  const configuration = body['configuration'];
  const issues = [...(hosting === undefined ? [HOSTING_ISSUE] : []), ...configurationIssues(configuration)];
  const plan = isRecord(configuration) ? configuration['plan'] : undefined;
  if (PLANS.includes(plan) && !AMENDABLE_PLANS.includes(plan)) {
    issues.push({
      path: 'configuration.plan',
      message: 'No aditivo, o plano é o SIEM Dedicado ou o SIEM + vCISO.',
    });
  }
  const contracted = contractedOf(body['contracted']);
  if (contracted === 'invalid') {
    issues.push({ path: 'contracted.monthlyTotal', message: 'Valor fora do permitido.' });
  }
  const setup = body['contractedSetup'];
  if (setup !== undefined && (typeof setup !== 'number' || !Number.isInteger(setup) || setup < 0)) {
    issues.push({ path: 'contractedSetup', message: 'Valor fora do permitido.' });
  }
  const note = body['note'];
  if (note !== undefined && (typeof note !== 'string' || note.trim() === '' || note.length > 500)) {
    issues.push({ path: 'note', message: 'Observação longa demais: no máximo 500 caracteres.' });
  }
  if (issues.length > 0 || hosting === undefined || contracted === 'invalid') return invalid(issues);
  if (body['confirmSlug'] !== tenant.slug) {
    return error(400, 'O subdomínio não confere com o do cliente: nada mudou.', 'confirmation_mismatch', {
      issues: [{ path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' }],
    });
  }
  if (tenant.billingMode !== 'contract') {
    return error(
      409,
      'Cliente da Stripe: o contrato segue a assinatura, e o aditivo é só do contrato direto.',
      'stripe_managed',
    );
  }
  if (!tenant.actions.amend) {
    return error(409, 'O contrato já terminou (cancelado ou excluído): não há o que alterar.', 'not_allowed');
  }
  if (hosting !== tenant.hosting && !tenant.actions.amendHosting) {
    return error(
      409,
      'Onde o ambiente roda só muda antes de qualquer instalação: este ambiente já foi provisionado ou já teve o código de instalação gerado.',
      'hosting_locked',
      {
        issues: [
          {
            path: 'hosting',
            message:
              'O ambiente já começou a ser criado (provisionamento ou código de instalação): onde ele roda não muda mais num aditivo.',
          },
        ],
      },
    );
  }
  if (table === undefined || tableVersion === undefined) {
    return error(409, 'Nenhuma tabela de preços vigente.', 'pricing_table_missing');
  }
  const outcome = quote(configurationFor(hosting, configuration), table);
  if (outcome.kind === 'contact_us') {
    return error(
      422,
      'Esta configuração está acima do que a tabela de preços vende.',
      'configuration_contact_us',
      {
        reason: outcome.reason,
        issues: [
          outcome.reason === 'mode_unavailable'
            ? {
                path: 'configuration.plan',
                message:
                  'O SIEM Cloud roda só na célula da Verax: no ambiente do cliente, escolha o SIEM Dedicado ou o SIEM + vCISO.',
              }
            : { path: 'configuration.gbDay', message: 'Acima do que a tabela vende.' },
        ],
      },
    );
  }
  const problems = problemsOf(outcome.quote.configuration, hosting);
  if (problems.length > 0) {
    return error(
      422,
      'O provisionamento ainda não sabe criar esta configuração.',
      'configuration_unsupported',
      {
        problems,
        issues: [
          { path: 'configuration.gbDay', message: 'O provisionamento ainda não cria esta configuração.' },
        ],
      },
    );
  }
  const quoted = outcome.quote;
  if (typeof setup === 'number' && quoted.setupTotal === 0) {
    return invalid([{ path: 'contractedSetup', message: 'A implantação só existe no SIEM + vCISO.' }]);
  }
  const reference: ContractValues = {
    monthlyTotal: quoted.monthlyTotal,
    additionalGbDayAmount: additionalGbDayAmount(table, quoted.configuration.plan),
  };
  const contractPricing: ContractPricing = {
    reference,
    contracted: contracted ?? reference,
    ...(quoted.setupTotal > 0
      ? {
          setup: {
            reference: quoted.setupTotal,
            contracted: typeof setup === 'number' ? setup : quoted.setupTotal,
          },
        }
      : {}),
  };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (
    hosting === tenant.hosting &&
    same(quoted.configuration, tenant.configuration) &&
    same(contractPricing, tenant.contractPricing)
  ) {
    return error(
      409,
      'Nada muda neste aditivo: o plano, o volume, onde roda e os valores são os mesmos de hoje.',
      'no_change',
    );
  }
  const months =
    quoted.configuration.plan === 'vciso'
      ? VCISO_CONTRACT_MONTHS
      : quoted.configuration.plan === 'plataforma'
        ? PLATAFORMA_CONTRACT_MONTHS
        : table.plans.dedicado.contractMonths;
  const contractTerm = {
    months,
    startsAt: now.toISOString(),
    endsAt: addMonths(now, months).toISOString(),
  };
  const moving = hosting !== tenant.hosting;
  // Na amostra, o nó gerenciado já tem os limites dele depois do provisionamento (a regra de verdade é a do cp-admin).
  const installed =
    tenant.hosting === 'verax' && tenant.state !== 'pending' && tenant.state !== 'provisioning';
  const nodeLimitsPending = installed && !same(quoted.limits, tenant.limits);
  const { actions: _actions, provisioning, urls, ...rest } = tenant;
  const updated: Omit<TenantDetail, 'actions'> = {
    ...rest,
    ...(moving || provisioning === undefined ? {} : { provisioning }),
    ...(hosting === 'verax'
      ? {
          urls: urls ?? {
            panelUrl: `https://${tenant.slug}.control.veraxsistemas.com.br`,
            apiUrl: `https://api-${tenant.slug}.veraxsistemas.com.br`,
          },
        }
      : {}),
    hosting,
    configuration: quoted.configuration,
    limits: quoted.limits,
    pricing: {
      priceTableVersion: tableVersion,
      quoteId: '01JC00000000000000000000Q8',
      monthlyTotal: quoted.monthlyTotal,
      setupTotal: quoted.setupTotal,
    },
    contractPricing,
    contractTerm,
  };
  const stateAfter: TenantState = moving
    ? hosting === 'customer'
      ? 'waiting_customer_install'
      : 'pending'
    : tenant.state;
  const at = (minutes: number): string => new Date(now.getTime() - minutes * MINUTE).toISOString();
  amendmentSequence += 1;
  const amendment: ContractAmendmentView = {
    id: `01JC0000000000000000AM${String(amendmentSequence).padStart(4, '0')}`,
    at: now.toISOString(),
    by: 'responsavel@verax.example',
    ...(typeof note === 'string' ? { note: note.trim() } : {}),
    before: termsOf(tenant),
    after: termsOf(updated),
    stateBefore: tenant.state,
    stateAfter,
    nodeLimitsPending,
  };
  const withHistory = { ...updated, amendments: [...tenant.amendments, amendment] };
  const next = moving
    ? transition(
        { ...withHistory, actions: tenant.actions },
        stateAfter,
        `contract_amended_to_${hosting}`,
        now,
        { timeline: hosting === 'verax' ? timeline(at, 0) : [] },
      )
    : withActions(withHistory, now);
  state.tenants.set(tenant.id, next);
  return {
    status: 200,
    body: {
      amendmentId: amendment.id,
      state: stateAfter,
      hosting,
      hostingChanged: moving,
      nodeLimitsPending,
      contractTerm,
    },
  };
}
