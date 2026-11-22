/**
 * As formas que a API do console (`/v1/admin/...`, `apps/control-plane/src/admin`) devolve e aceita, como chegam no
 * JSON (datas em texto ISO). Espelham os tipos do plano de controle; o teste de contrato
 * `apps/control-plane/test/console-contract.test.ts` falha no `pnpm typecheck` se um dos dois lados mudar sem o outro.
 *
 * Valores em centavos de real (`amount`, `fixed`, `hourlyCost`, `monthly`...), custos de nuvem em dólares e taxas entre
 * 0 e 1. Este arquivo não importa nada: o teste de contrato o lê do plano de controle.
 */

export type PlanId = 'plataforma' | 'dedicado' | 'vciso';
export type DeploymentMode = 'managed' | 'self_hosted';
export type SizeId = 'P' | 'M' | 'G';
export type PaymentMethod = 'card' | 'boleto';
/** `inclusive`: o valor da tabela já tem o imposto; `exclusive`: o imposto vai por cima na fatura ("+ impostos"). */
export type TaxMode = 'inclusive' | 'exclusive';
export type ComponentId = 'base' | 'additional_gb_day' | 'overage_gb_day' | 'gb_day' | 'service' | 'setup';
export type ContactReason = 'above_online_max' | 'above_max' | 'above_largest_size' | 'mode_unavailable';
export type VersionStatus = 'draft' | 'published' | 'retired';

export interface Priced {
  amount: number;
  lookupKey: string;
}

/** Um degrau da regra de porte: o porte cabe no volume se ele não passar de `maxGbDay`. */
export interface SizeRule {
  size: SizeId;
  maxGbDay: number;
  description: string;
}

/** O plano, o volume em GB/dia e onde o ambiente roda (a entrada do simulador e da cotação de referência). */
export interface ConfigurationInput {
  plan: PlanId;
  gbDay: number;
  mode: DeploymentMode;
}

/** A configuração já normalizada para a tabela, com o porte calculado. */
export interface Configuration {
  plan: PlanId;
  mode: DeploymentMode;
  gbDay: number;
  size: SizeId;
  historyDays: number;
}

/** O contratado no modelo de preço anterior (portes, contas, volume mensal, agentes e suporte): só leitura. */
export interface LegacyConfiguration {
  mode: DeploymentMode;
  size: SizeId;
  cloudAccounts: number;
  monthlyGib: number;
  agents: number;
  historyDays: number;
  support: 'standard' | 'priority';
}

/** O que um cliente contratou: no modelo por GB/dia ou, de antes dele, no anterior (sem `plan`). */
export type ContractedConfiguration = Configuration | LegacyConfiguration;

/** O conteúdo de uma tabela de preços (o que o responsável edita). */
export interface PriceTable {
  currency: 'brl';
  interval: 'month';
  taxMode: TaxMode;
  sizing: { sizes: SizeRule[] };
  plans: {
    plataforma: {
      base: Priced;
      includedGbDay: number;
      additionalGbDay: Priced;
      overageGbDay: Priced;
      maxOnlineGbDay: number;
      maxCloudAccounts: number;
    };
    dedicado: {
      gbDay: Priced;
      minGbDay: number;
      maxGbDay: number;
      contractMonths: number;
      maxCloudAccounts: number;
    };
    vciso: { service: Priced; setup: Priced };
  };
  history: { includedDays: number };
  users: { max: number };
}

/** Uma máquina: a VM (US$/mês), o disco (GB) e os snapshots estimados (GiB). */
export interface Machine {
  vmUsdPerMonth: number;
  diskGb: number;
  snapshotGib: number;
}

/** O conteúdo de um modelo de custos (confidencial: só no Firestore e neste console). */
export interface CostModel {
  currency: 'brl';
  exchange: { brlPerUsd: number; quotedOn: string; cloudBuffer: number };
  infrastructure: {
    sharedCell: Machine & { capacityGbDay: number; perCustomerUsdPerMonth: number };
    sizes: Partial<Record<SizeId, Machine>>;
    diskUsdPerGibMonth: number;
    snapshotUsdPerGibMonth: number;
    natUsdPerVmMonth: number;
    natIpUsdPerMonth: number;
    otherUsdPerNodeMonth: number;
    ingestionUsdPerGbDay: number;
  };
  paymentFees: { card: { rate: number; fixed: number }; boleto: { fixed: number }; billingRate: number };
  taxes: { rates: { id: string; label: string; rate: number }[]; defaultRateId: string };
  refundReserveRate: number;
  support: {
    hourlyCost: number;
    hours: {
      plataforma: number;
      dedicado: number;
      vcisoService: number;
      selfHosted: number;
      setupPlataforma: number;
      setupDedicado: number;
      setupVciso: number;
      setupSelfHosted: number;
    };
  };
  fixedCosts: { items: { name: string; monthly: number }[]; allocationCustomers: number };
  margins: { minimum: number; alert: number };
  customerCloudEstimateSpread: number;
  sources?: { item: string; url: string; checkedOn: string }[];
}

/** Resumo da checagem guardado na versão publicada. */
export interface PublishCheck {
  priceTableVersion: string;
  costModelVersion: string;
  ok: boolean;
  checkedConfigurations: number;
  belowMinimum: number;
  belowAlert: number;
  worstMargin: number | null;
  minimumMargin: number;
  alertMargin: number;
  at: string;
}

/** Uma linha da lista de versões. */
export interface VersionSummary {
  version: string;
  status: VersionStatus;
  current: boolean;
  /** Do modelo de preço anterior: só aparece na lista (não abre, não é editada, não vale como vigente). */
  legacy?: true;
  effectiveFrom?: string;
  publishedAt?: string;
  publishedBy?: string;
  retiredAt?: string;
  supersededBy?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface VersionedRecord<C> {
  version: string;
  status: VersionStatus;
  content: C;
  effectiveFrom?: string;
  publishedAt?: string;
  publishedBy?: string;
  retiredAt?: string;
  supersededBy?: string;
  publishCheck?: PublishCheck;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface GuardConfiguration {
  configuration: Configuration;
  monthlyTotal: number;
  contributionMargin: number;
  contributionMarginRatio: number;
}

export interface GuardScenario {
  taxRateId: string;
  paymentMethod: PaymentMethod;
  worst: GuardConfiguration | null;
}

export interface MonotonicityViolation {
  from: Configuration;
  to: Configuration;
  fromTotal: number;
  toTotal: number;
}

/** O relatório da checagem de publicação (a grade inteira no cartão e na alíquota padrão). */
export interface GuardReport {
  ok: boolean;
  problems: string[];
  paymentMethod: PaymentMethod;
  taxRateId: string;
  minimumMargin: number;
  alertMargin: number;
  checkedConfigurations: number;
  contactUsConfigurations: number;
  belowMinimum: { count: number; configurations: GuardConfiguration[] };
  belowAlert: { count: number; configurations: GuardConfiguration[] };
  worst: GuardConfiguration[];
  worstByPlan: Partial<Record<PlanId, GuardConfiguration>>;
  worstByMode: Partial<Record<DeploymentMode, GuardConfiguration>>;
  otherScenarios: GuardScenario[];
  monotonicity: { violations: number; examples: MonotonicityViolation[] };
  startingAt: Partial<Record<PlanId, number>>;
  gridMinimum: Partial<Record<PlanId, number>>;
}

/** `POST .../check`. */
export interface CheckResult {
  costModelVersion: string;
  report: GuardReport;
}

/** `POST .../publish` aprovado: o resumo da versão e o relatório (nulo no modelo de custos sem tabela vigente). */
export interface PublishResult {
  version: string;
  status: VersionStatus;
  legacy?: true;
  effectiveFrom?: string;
  publishedAt?: string;
  publishedBy?: string;
  retiredAt?: string;
  supersededBy?: string;
  updatedAt: string;
  updatedBy: string;
  report: GuardReport | null;
}

export interface QuoteLineItem {
  component: ComponentId;
  variant: PlanId;
  lookupKey: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  recurring: boolean;
}

export interface NodeLimits {
  maxCloudAccounts: number;
  monthlyGib: number;
  historyDays: number;
  maxAgents: number;
  maxUsers: number;
}

export interface Quote {
  configuration: Configuration;
  sizeDescription: string;
  lineItems: QuoteLineItem[];
  monthlyTotal: number;
  setupTotal: number;
  firstInvoiceTotal: number;
  limits: NodeLimits;
  included: { gbDay: number; historyDays: number; users: number };
}

export interface DreLines {
  /** O valor da tabela (os itens mensais menos o desconto). */
  tableRevenue: number;
  /** O que o cliente paga: o valor da tabela ou, com o imposto por cima, o valor ÷ (1 − alíquota). */
  grossRevenue: number;
  taxes: number;
  refundReserve: number;
  netRevenue: number;
  infrastructure: number;
  paymentFees: number;
  support: number;
  contributionMargin: number;
  contributionMarginRatio: number;
  contributionMarginNetRatio: number;
  fixedCosts: number;
  result: number;
  resultRatio: number;
}

export interface SetupDre {
  revenue: number;
  taxes: number;
  refundReserve: number;
  paymentFees: number;
  supportHours: number;
  support: number;
  contributionMargin: number;
  contributionMarginRatio: number | null;
}

export interface DreResult {
  quote: Quote;
  paymentMethod: PaymentMethod;
  taxRateId: string;
  taxMode: TaxMode;
  supportHours: number;
  monthly: DreLines;
  setup: SetupDre;
  twelveMonths: { grossRevenue: number; contributionMargin: number; result: number };
  customerCloudEstimate: { monthly: number; low: number; high: number } | null;
}

/** `POST /v1/admin/dre/simulate`. */
export type SimulationResult =
  | { contactUs: true; reason: ContactReason; priceTableVersion: string; costModelVersion: string }
  | {
      contactUs: false;
      priceTableVersion: string;
      costModelVersion: string;
      dre: DreResult;
      margins: { minimum: number; alert: number };
      taxRate: { id: string; label: string; rate: number };
    };

export interface SimulationRequest {
  configuration: ConfigurationInput;
  paymentMethod: PaymentMethod;
  priceTableVersion?: string;
  costModelVersion?: string;
  taxRateId?: string;
  discountRate?: number;
  allocationCustomers?: number;
}

/** `GET /v1/admin/me`. */
export interface AdminSession {
  email: string;
}

// --- Acesso ao console (e-mail, senha e código do aplicativo autenticador) ------------------------------------------

/** O aplicativo autenticador a cadastrar: o URI do QR, o segredo para digitar à mão e até quando vale o cadastro. */
export interface TotpEnrollment {
  enrollmentId: string;
  otpauthUri: string;
  secret: string;
  expiresAt: string;
}

/** `POST /v1/admin/account/totp/confirm`: o primeiro código do aplicativo novo. */
export interface TotpConfirmRequest {
  enrollmentId: string;
  code: string;
}

/** Os códigos de recuperação, mostrados uma única vez. */
export interface RecoveryCodes {
  recoveryCodes: string[];
}

/** O segundo fator: o código do aplicativo ou, sem o celular, um código de recuperação. */
export type SecondFactor = { code: string } | { recoveryCode: string };

/** `GET /v1/admin/client-config`: o que a entrada precisa saber antes do login (sem sessão). */
export interface AdminClientConfig {
  /** A chave do site do Cloudflare Turnstile (pública); `null` com ele desligado. */
  turnstileSiteKey: string | null;
}

/** `POST /v1/admin/login`. */
export type LoginRequest = { email: string; password: string } & SecondFactor;

/** `POST /v1/admin/account/password`. */
export interface PasswordChangeRequest {
  currentPassword: string;
  code: string;
  newPassword: string;
}

/** `POST /v1/admin/account/totp/start`. */
export type TotpResetStartRequest = { currentPassword: string } & SecondFactor;

/** Um problema de validação (`details.issues` no 400): o caminho do campo e a mensagem. */
export interface ValidationIssue {
  path: string;
  message: string;
}

// --- Clientes (contrato direto e a linha do tempo do provisionamento) ----------------------------------------------

export type TenantState =
  | 'pending'
  | 'provisioning'
  | 'provisioning_failed'
  | 'waiting_customer_install'
  | 'waiting_customer_connection'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'canceled'
  | 'deleted';

/** `stripe`: o checkout do site e a assinatura; `contract`: contrato direto, criado aqui, sem Stripe. */
export type BillingMode = 'stripe' | 'contract';

/**
 * Onde o ambiente roda: `verax` (na infraestrutura da Verax, o provisionamento de sempre; todo cliente do site) ou
 * `customer` (na infraestrutura do cliente, só por contrato direto: nada é criado na Verax).
 */
export type Hosting = 'verax' | 'customer';

/**
 * Os passos do provisionamento, na ordem. Na VM do cliente, a sequência reduzida: `preflight`, `cloudflare.tunnel`,
 * `firebase.site`, `enrollment.wait` (o registro da VM), `node.health`, `panel.domain_wait` e `access.ready`.
 */
export type ProvisioningStepName =
  | 'preflight'
  | 'cloudflare.tunnel'
  | 'firebase.site'
  | 'terraform.apply'
  | 'terraform.wait'
  | 'secrets.smtp_password'
  | 'secrets.tunnel_token'
  | 'node.wait_ready'
  | 'enrollment.wait'
  | 'node.health'
  | 'panel.domain_wait'
  | 'access.ready';

export type RunKind = 'provision' | 'resume' | 'delete' | 'crypto_destroy';

/** As duas fases da exclusão (CP-11). */
export type LifecycleRunKind = 'delete' | 'crypto_destroy';

export type SuspensionReason = 'unpaid' | 'grace_expired' | 'fraud_review' | 'owner';

/** O que o provisionamento ainda não sabe criar. */
export type NodeFitProblem = 'mode' | 'size' | 'agents' | 'limits';

/** Uma linha da lista de clientes. */
export interface TenantListItem {
  id: string;
  slug: string;
  companyName: string;
  state: TenantState;
  stateUpdatedAt: string;
  billingMode: BillingMode;
  hosting: Hosting;
  /** O plano; ausente num cliente do modelo de preço anterior. */
  plan?: PlanId;
  size: SizeId;
  step?: string;
  lastErrorCode?: string;
  createdAt: string;
}

/** `GET /v1/admin/tenants`. */
export interface TenantList {
  tenants: TenantListItem[];
  unreadable: number;
  limit: number;
}

export type TimelineStepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed';

export interface TimelineStep {
  name: ProvisioningStepName;
  status: TimelineStepStatus;
  attempts: number;
  startedAt?: string;
  waitingSince?: string;
  finishedAt?: string;
  errorCode?: string;
}

export interface TenantTransitionView {
  from: TenantState | null;
  to: TenantState;
  reason: string;
  at: string;
}

export interface OrderPricing {
  priceTableVersion: string;
  quoteId: string;
  monthlyTotal: number;
  setupTotal: number;
}

/** Os valores de um contrato direto, em centavos: o mensal e o de cada GB/dia adicional (por mês). */
export interface ContractValues {
  monthlyTotal: number;
  additionalGbDayAmount: number;
}

/**
 * A referência da tabela e o contratado (negociado ou não) de um contrato direto. `setup`: só depois de um aditivo para
 * o SIEM + vCISO, a implantação da tabela e a contratada (0 quando já foi paga).
 */
export interface ContractPricing {
  reference: ContractValues;
  contracted: ContractValues;
  setup?: { reference: number; contracted: number };
}

/** A vigência do contrato direto: a duração do plano e as datas, contadas do último aditivo. */
export interface ContractTerm {
  months: number;
  startsAt: string;
  endsAt: string;
}

/** O contrato como um aditivo o encontrou ou deixou. */
export interface ContractTermsView {
  hosting: Hosting;
  configuration: Configuration;
  limits: NodeLimits;
  pricing: OrderPricing;
  contractPricing?: ContractPricing;
  contractTerm?: ContractTerm;
}

/** Um aditivo do contrato: quem, quando, a observação, o antes e o depois. */
export interface ContractAmendmentView {
  id: string;
  at: string;
  by: string;
  note?: string;
  before: ContractTermsView;
  after: ContractTermsView;
  stateBefore: TenantState;
  stateAfter: TenantState;
  /** Os limites do nó mudaram com o ambiente já instalado: o nó em execução ainda não os tem. */
  nodeLimitsPending: boolean;
}

/** Os planos de um aditivo: os três do cadastro (o SIEM Cloud só na infraestrutura da Verax). */
export type AmendablePlan = PlanId;

/** O que o console manda em `POST /v1/admin/tenants/:id/amend`. */
export interface AmendmentRequest {
  hosting: Hosting;
  configuration: { plan: AmendablePlan; gbDay: number };
  contracted?: ContractValues;
  /** No SIEM + vCISO: a implantação contratada, em centavos (ausente: a da tabela). */
  contractedSetup?: number;
  note?: string;
  confirmSlug: string;
}

/** `POST /v1/admin/tenants/:id/amend`: o aditivo gravado. */
export interface ContractAmendmentResult {
  amendmentId: string;
  state: TenantState;
  hosting: Hosting;
  hostingChanged: boolean;
  nodeLimitsPending: boolean;
  contractTerm: ContractTerm;
}

/** `GET /v1/admin/tenants/:id`. */
export interface TenantDetail {
  id: string;
  slug: string;
  state: TenantState;
  stateUpdatedAt: string;
  createdAt: string;
  billingMode: BillingMode;
  hosting: Hosting;
  company: { legalName: string; cnpj: string };
  adminEmail?: string;
  configuration: ContractedConfiguration;
  limits: NodeLimits;
  pricing: OrderPricing;
  /** Só no contrato direto cadastrado com os valores do contrato: a referência da tabela e o contratado. */
  contractPricing?: ContractPricing;
  /** A vigência do contrato direto, gravada pelo último aditivo. */
  contractTerm?: ContractTerm;
  /** Os aditivos do contrato, do mais antigo ao mais novo. */
  amendments: ContractAmendmentView[];
  /** Os endereços na infraestrutura da Verax; ausentes no ambiente do cliente. */
  urls?: { panelUrl: string; apiUrl: string };
  provisioning?: {
    runId?: string;
    step?: string;
    attempts: number;
    lastError?: { code: string; at: string };
    nodeVersion?: string;
  };
  run?: {
    runId: string;
    kind: RunKind;
    startedAt: string;
    finishedAt?: string;
    outcome?: 'succeeded' | 'failed';
    failureCode?: string;
    release?: string;
  };
  timeline: TimelineStep[];
  access: { passwordRevealedAt?: string; revealEmailSentAt?: string };
  lifecycle: TenantLifecycleView;
  transitions: TenantTransitionView[];
  actions: TenantActions;
}

/** O ciclo de vida depois da venda (CP-11): os prazos e o que já aconteceu. */
export interface TenantLifecycleView {
  suspendedReason?: SuspensionReason;
  canceledAt?: string;
  cancelScheduledFor?: string;
  exportUntil?: string;
  deleteAfter?: string;
  deletedAt?: string;
  cryptoDestroyAfter?: string;
  cryptoDestroyedAt?: string;
  purgedAt?: string;
  nodeStoppedAt?: string;
  run?: { kind: LifecycleRunKind; step: string; startedAt: string; lastError?: { code: string; at: string } };
}

/**
 * O que o console oferece agora para o cliente (a API e o cp-worker conferem de novo). `enrollmentCode`: gerar o código
 * de instalação da VM do cliente. `amend`: o aditivo do contrato; `amendHosting`: o aditivo ainda pode mudar onde o
 * ambiente roda (nada instalado nem provisionado).
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

/** As operações do responsável (`POST /v1/admin/tenants/:id/<operação>`). */
export type TenantAction = 'start' | 'resume' | 'cancel' | 'suspend' | 'reactivate' | 'delete-now' | 'export';

/** `POST /v1/admin/tenants/preview`. `reference`: os valores da tabela que preenchem o contratado. */
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
 * O pedido ao cp-worker depois do cadastro. Sem sucesso, o código: `worker_unavailable`, `worker_refused`,
 * `worker_unconfigured` ou um do worker (`not_allowed`...).
 */
export type ProvisioningRequestOutcome =
  { started: true; runId: string; step: string } | { started: false; failure: string };

/** O plano e o volume do contrato direto: o modo da tabela sai de `hosting`. */
export type DirectConfiguration = Omit<ConfigurationInput, 'mode'>;

/** O que o console manda em `POST /v1/admin/tenants`. */
export interface DirectTenantRequest {
  idempotencyKey: string;
  companyName: string;
  cnpj: string;
  adminEmail: string;
  slug: string;
  hosting: Hosting;
  configuration: DirectConfiguration;
  /** O contratado; ausente, vale a referência da tabela. */
  contracted?: ContractValues;
  confirmSlug: string;
}

/** `POST /v1/admin/tenants`. Sem `provisioning` no ambiente do cliente (nada é pedido ao cp-worker). */
export interface DirectTenantCreated {
  id: string;
  slug: string;
  replayed: boolean;
  hosting: Hosting;
  provisioning?: ProvisioningRequestOutcome;
}

/** Uma linha do `node.conf` do cliente que o contrato define (o plano e os limites). */
export interface NodeConfLine {
  name: string;
  value: string;
}

/**
 * `GET /v1/admin/tenants/:id/installation`: o que mandar ao cliente que instala o ambiente na infraestrutura dele (a
 * versão conferida, os endereços do release, as imagens pelo digest, o guia e o `node.conf` do contrato).
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
  /** O instalador da VM do cliente e o SHA-256 dele (o manifesto assinado); ausente numa versão de antes dele. */
  installer?: { url: string; sha256: string };
  images: { api: string; migrate: string };
  thirdPartyImages: string[];
  /** A chave de release que assinou o manifesto e a impressão digital dela (SHA-256 da pública em DER). */
  releaseKey: { name: string; sha256: string };
  /** O porte do contrato, para sugerir o perfil da VM. */
  size: SizeId;
  nodeConf: NodeConfLine[];
}

/**
 * `POST /v1/admin/tenants/:id/enrollment-code` `{confirmSlug}`: o código de instalação de uso único da VM do cliente,
 * mostrado uma vez, com o vencimento (7 dias). `reinstall`: a VM anterior deixou de valer. `runId` e `step`: a execução
 * do provisionamento reduzido em andamento.
 */
export interface EnrollmentCodeIssued {
  code: string;
  expiresAt: string;
  reinstall: boolean;
  runId?: string;
  step?: string;
}

/**
 * `POST /v1/admin/tenants/:id/reveal-access` `{confirmSlug}`: a senha inicial do administrador do cliente, mostrada uma
 * única vez para o responsável copiar e mandar. É a revelação única: depois dela, a versão do cofre é apagada e o link
 * que o cliente recebeu por e-mail deixa de funcionar. O console guarda só no estado da tela, nunca no cache.
 */
export interface AccessRevealed {
  panelUrl: string;
  adminEmail: string;
  password: string;
  passwordExpiresAt: string;
}

/** Os papéis que um usuário do cliente pode ter (`TENANT_ROLES` do `@verax/shared`). */
export type TenantRole = 'admin_cliente' | 'analista_cliente' | 'leitura';

/** A situação da conta no painel do cliente (`USER_STATUSES` do `@verax/shared`). */
export type CustomerUserStatus = 'invited' | 'active' | 'disabled';

/** Por que o nó não criou o usuário pedido pela Verax (`NODE_SYNC_USER_CODES` do `@verax/shared`). */
export type NodeSyncUserCode =
  | 'email_taken'
  | 'plan_limit_reached'
  | 'tenant_plan_missing'
  | 'expired'
  | 'vault_disabled'
  | 'envelope_unreadable'
  | 'tenant_ambiguous'
  | 'users_disabled'
  | 'internal_error';

/** A situação de um pedido de usuário: esperando o nó, criado, recusado pelo nó, vencido. */
export type NodeUserStatus = 'pending' | 'created' | 'failed' | 'expired';

/** Por que o console não pode pedir usuário agora (a mesma conferência da criação). */
export type NodeUserBlock =
  | 'not_allowed'
  | 'placement_unsupported'
  | 'node_not_synced'
  | 'node_outdated'
  | 'platform_mismatch'
  | 'vault_disabled'
  | 'vault_key_invalid';

/** Um usuário que a Verax pediu ao nó do cliente, com o último relato do nó. Nunca a senha. */
export interface NodeUserView {
  requestId: string;
  name: string;
  email: string;
  role: TenantRole;
  notAfter: string;
  createdAt: string;
  createdBy: string;
  status: NodeUserStatus;
  code?: NodeSyncUserCode;
  user?: { status: CustomerUserStatus; mfaEnabled: boolean; mustChangePassword: boolean };
  reportedAt?: string;
}

/** `POST /v1/admin/tenants/:id/users`. */
export interface NodeUserCreateRequest {
  name: string;
  email: string;
  role: TenantRole;
}

/**
 * A resposta da criação, uma única vez: o painel, o login, o papel, a senha temporária e a validade. O console guarda só
 * no estado da tela, nunca no cache.
 */
export interface NodeUserCreated {
  requestId: string;
  panelUrl: string;
  email: string;
  role: TenantRole;
  temporaryPassword: string;
  notAfter: string;
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
  /** O link assinado (24 h) de um backup: mostrado uma vez, nunca guardado. */
  | { action: 'export'; url: string; expiresAt: string; object: string };

/** O corpo de cada operação: o subdomínio digitado e, no cancelamento, a data; na exportação, o backup. */
export interface TenantActionRequest {
  confirmSlug: string;
  at?: string;
  object?: string;
}

/** Os três textos legais que o cliente aceita no checkout. */
export type LegalKind = 'terms' | 'privacy' | 'dpa';
/** Rascunho (editável) ou publicada (imutável; a mais recente é a vigente). */
export type LegalStatus = 'draft' | 'published';

/** Uma linha da lista de versões de um texto legal (sem o texto). */
export interface LegalVersionSummary {
  kind: LegalKind;
  version: string;
  status: LegalStatus;
  current: boolean;
  basedOn?: string;
  publishedAt?: string;
  publishedBy?: string;
  contentSha256?: string;
  bytes: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** `GET /v1/admin/legal`: as versões de cada texto, da mais nova para a mais antiga. */
export type LegalOverview = Record<LegalKind, LegalVersionSummary[]>;

/** Uma versão de um texto legal, com o texto em Markdown. */
export interface LegalTextRecord {
  kind: LegalKind;
  version: string;
  status: LegalStatus;
  content: string;
  basedOn?: string;
  publishedAt?: string;
  publishedBy?: string;
  contentSha256?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** `POST /v1/admin/legal/:kind/versions`: em branco ou cópia de outra versão do mesmo texto. */
export interface LegalCreateRequest {
  version: string;
  from?: string;
}

/** `PUT /v1/admin/legal/:kind/versions/:version`: o texto e a revisão lida (o `updatedAt`). */
export interface LegalUpdateRequest {
  content: string;
  expectedUpdatedAt: string;
}

/** `POST .../publish`: a revisão conferida e a versão digitada de novo. */
export interface LegalPublishRequest {
  expectedUpdatedAt: string;
  confirmVersion: string;
}

/** `GET /v1/admin/legal/:kind/audit`: a trilha de um texto (nunca o texto). */
export interface LegalAuditEntry {
  id: string;
  at: string;
  actor: string;
  event: 'draft.created' | 'draft.updated' | 'published';
  version: string;
  basedOn?: string;
  bytes?: number;
  contentSha256?: string;
}

// --- Fontes de log do cliente (a sincronização com o nó) ----------------------------------------------------------

/** Onde o nó roda: na GCP (o gerenciado) ou na VM própria do cliente. */
export type NodePlatform = 'gcp' | 'vm';

/** Os provedores de uma fonte de log. */
export type LogSourceProvider = 'aws' | 'gcp' | 'cloudflare';

/** As fontes da AWS lidas de buckets S3 (um bucket por fonte). */
export type AwsLogBucketSource = 'cloudtrail' | 'guardduty' | 'waf';

/** Os tipos de credencial que o console cola (o Cloudflare em todo nó; a AWS e a GCP só na VM do cliente). */
export type CredentialKind = 'cloudflare_api_token' | 'aws_access_key' | 'gcp_service_account_key';

/** Por que o nó não aplicou uma fonte (ou a credencial dela): `NODE_SYNC_SOURCE_CODES` de `@verax/shared`. */
export type NodeSyncSourceCode =
  | 'invalid_spec'
  | 'immutable_changed'
  | 'tenant_ambiguous'
  | 'plan_limit_reached'
  | 'tenant_plan_missing'
  | 'account_exists_panel'
  | 'origin_conflict'
  | 'vault_disabled'
  | 'credential_kind_not_allowed'
  | 'credential_unreadable'
  | 'credential_rejected_invalid'
  | 'credential_rejected_inactive'
  | 'credential_rejected_expired'
  | 'credential_rejected_not_yet_valid'
  | 'credential_rejected_no_account_access'
  | 'credential_rejected_wrong_identity'
  | 'source_unavailable'
  | 'internal_error';

/** O problema do nó inteiro: mais de um cliente no banco, ou o cofre ilegível. */
export type NodeSyncNodeError = 'tenant_ambiguous' | 'vault_unreadable';

/** Os buckets de log de uma conta AWS por fonte (`null` tira o bucket numa alteração). */
export interface AwsLogBuckets {
  cloudtrail?: string | null;
  guardduty?: string | null;
  waf?: string | null;
}

/** O cadastro de uma fonte, com as regras do painel do nó (`cloudAccountCreateSchema`). */
export type LogSourceSpec =
  | { provider: 'aws'; accountId: string; regions: string[]; buckets?: AwsLogBuckets }
  | {
      provider: 'gcp';
      accountId: string;
      pubsubSubscription?: string | null;
      sinkWriterIdentity?: string | null;
    }
  | { provider: 'cloudflare'; accountId: string; zones?: string[] };

/** A credencial colada no console: só no corpo do pedido, nunca volta (`cloudCredentialInputSchema`). */
export type LogSourceCredentialInput =
  | { kind: 'cloudflare_api_token'; token: string }
  | { kind: 'aws_access_key'; accessKeyId: string; secretAccessKey: string }
  | {
      kind: 'gcp_service_account_key';
      projectId: string;
      clientEmail: string;
      privateKeyId: string;
      privateKey: string;
    };

/** `POST /v1/admin/tenants/:id/log-sources`. */
export interface LogSourceCreateRequest {
  spec: LogSourceSpec;
  credential?: LogSourceCredentialInput;
}

/** `PATCH /v1/admin/tenants/:id/log-sources/:sourceId`: só os campos do provedor (o provedor e a conta não mudam). */
export interface LogSourceUpdateRequest {
  regions?: string[];
  buckets?: AwsLogBuckets;
  pubsubSubscription?: string | null;
  sinkWriterIdentity?: string | null;
  zones?: string[];
}

/** `POST .../log-sources/:sourceId/remove`: o subdomínio do cliente, digitado de novo. */
export interface LogSourceRemoveRequest {
  confirmSlug: string;
}

/** O que o nó disse de si na última sincronização aceita. Nada aqui é segredo. */
export interface NodeSyncView {
  lastSeenAt: string;
  /** Mais de 15 minutos sem sincronizar. */
  stale: boolean;
  platform: NodePlatform;
  /** A plataforma informada não é a do lugar do cliente. */
  platformMismatch: boolean;
  commit: string;
  capabilities: string[];
  authKind: 'gcp_identity' | 'node_key';
  nodeTenantId: string | null;
  /** O nó tem o cofre com a chave pública conferida: o console pode cifrar para ele. */
  vaultReady: boolean;
  keyVersion: number | null;
  /** SHA-256 da chave pública do cofre (o painel do cliente mostra a mesma). */
  fingerprint: string | null;
  keySince: string | null;
  serviceAccountId: string | null;
  egressIps: string[];
  audience: string;
  error: NodeSyncNodeError | null;
}

/** Os metadados da credencial colada no console (nunca o envelope nem o texto claro). */
export interface LogSourceCredentialView {
  kind: CredentialKind;
  revision: number;
  keyVersion: number;
  fingerprint: string;
  submittedAt: string;
  submittedBy: string;
  /** O envelope ainda espera o nó (falso: consumido, descartado ou vencido). */
  envelopeStored: boolean;
}

/** A credencial como está no nó: a do console (com a revisão) ou a colada no painel (revisão null). */
export interface NodeSyncCredentialReport {
  revision: number | null;
  outcome: 'applied' | 'failed';
  code: NodeSyncSourceCode | null;
  kind: CredentialKind | null;
  /** Os 4 últimos caracteres do ID da credencial na origem, nunca do segredo. */
  keyIdSuffix: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
}

/** A conta como está no nó (a coleta). */
export interface NodeSyncAccountReport {
  status: 'active' | 'inactive';
  connection: 'waiting' | 'connected' | 'error';
  connectionError: string | null;
  collectionError: 'aws_token_stale' | 'wazuh_apply_failed' | null;
  /** AWS: a data (AAAA-MM-DD) a partir da qual o nó lê os buckets. */
  ingestFrom: string | null;
  lastEventAt: string | null;
  lastCollectedAt: string | null;
  checkRequestedAt: string | null;
}

/** O último relato do nó sobre a fonte, com quando chegou. */
export interface LogSourceReport {
  id: string;
  revision: number;
  outcome: 'applied' | 'failed' | 'removed';
  code: NodeSyncSourceCode | null;
  credential: NodeSyncCredentialReport | null;
  account: NodeSyncAccountReport | null;
  reportedAt: string;
}

/**
 * A situação da fonte: `pending` (o nó ainda não processou a revisão ou a credencial nova), `applied`, `failed` (com o
 * código), `removing` (a lápide ainda não chegou ao nó) e `removed`.
 */
export type LogSourceStatus = 'pending' | 'applied' | 'failed' | 'removing' | 'removed';

export type AwsStackMismatchField = 'serviceAccountId' | 'egressIps' | 'audience';

/** A pilha do papel de leitura sem chave (nó gerenciado), com os valores que o plano de controle conhece. */
export interface AwsStackView {
  stackName: string;
  roleArn: string;
  /** null: o provisionamento ainda não gravou (o comando leva o marcador). */
  nodeServiceAccountId: string | null;
  egressIps: string[];
  audience: string;
  bucketArns: string[];
  deployCommand: string;
  consoleUrl: string;
  templateUrl: string;
  mismatch: boolean;
  mismatches: AwsStackMismatchField[];
}

/** As chaves de leitura que o cliente cria na conta dele (VM do cliente). */
export type ReadKeysView =
  | {
      provider: 'aws';
      userArn: string;
      readerPolicyName: string;
      readerPolicyFile: string;
      readerPolicy: unknown;
      guardrailsPolicyName: string;
      guardrailsPolicyFile: string;
      guardrailsPolicy: unknown;
      commands: string;
      egressIps: string[];
    }
  | {
      provider: 'gcp';
      subscription: string;
      serviceAccountEmail: string;
      role: string;
      keyFile: string;
      commands: string;
    };

/** O token de leitura do Cloudflare: o link com as permissões marcadas e os IPs para o filtro do token. */
export interface CloudflareTokenView {
  templateUrl: string;
  tokenName: string;
  egressIps: string[];
}

export interface LogSourceView {
  id: string;
  spec: LogSourceSpec;
  state: 'active' | 'removed';
  revision: number;
  credential: LogSourceCredentialView | null;
  report: LogSourceReport | null;
  pending: boolean;
  status: LogSourceStatus;
  code: NodeSyncSourceCode | null;
  awsStack: AwsStackView | null;
  readKeys: ReadKeysView | null;
  cloudflareToken: CloudflareTokenView | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** `GET /v1/admin/tenants/:id/node-sync`. */
export interface NodeSyncOverview {
  hosting: Hosting;
  platform: NodePlatform;
  /** Os tipos de credencial que o console aceita colar para este cliente. */
  credentialKinds: CredentialKind[];
  generation: number;
  /** null: o nó nunca sincronizou. */
  node: NodeSyncView | null;
  sources: LogSourceView[];
  templateUrl: string;
  /** Os usuários do cliente pedidos pelo console, do mais novo ao mais antigo, com o relato do nó. */
  users: NodeUserView[];
  /** O nó anunciou a criação de usuários (`users`) na última sincronização. */
  usersSupported: boolean;
  /** Por que o console não pode pedir usuário agora; null: pode. */
  usersBlockedBy: NodeUserBlock | null;
}

/** O resultado de toda escrita: a fonte como ficou e a geração nova. */
export interface LogSourceWriteResult {
  source: LogSourceView;
  generation: number;
}
