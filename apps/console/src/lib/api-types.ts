/**
 * As formas que a API do console (`/v1/admin/...`, `apps/control-plane/src/admin`) devolve e aceita, como chegam no
 * JSON (datas em texto ISO). Espelham os tipos do plano de controle; o teste de contrato
 * `apps/control-plane/test/console-contract.test.ts` falha no `pnpm typecheck` se um dos dois lados mudar sem o outro.
 *
 * Valores em centavos de real (`amount`, `fixed`, `hourlyCost`, `monthly`...), custos de nuvem em dólares e taxas entre
 * 0 e 1. Este arquivo não importa nada: o teste de contrato o lê do plano de controle.
 */

export type DeploymentMode = 'managed' | 'self_hosted';
export type SizeId = 'P' | 'M' | 'G';
export type SupportLevel = 'standard' | 'priority';
export type PaymentMethod = 'card' | 'boleto';
export type ComponentId =
  'environment' | 'cloud_accounts' | 'volume' | 'agents' | 'history' | 'priority_support' | 'setup';
export type ContactReason =
  | 'cloud_accounts_above_max'
  | 'volume_above_max'
  | 'agents_above_max'
  | 'history_above_max'
  | 'above_largest_size';
export type VersionStatus = 'draft' | 'published' | 'retired';

export interface Priced {
  amount: number;
  lookupKey: string;
}

export interface SizeRule {
  size: SizeId;
  maxCloudAccounts: number;
  maxMonthlyGib: number;
  maxAgents: number;
  description: string;
}

export interface ModePricing {
  environment: Partial<Record<SizeId, Priced>>;
  setup?: Priced;
}

/** As seis respostas do cliente (a entrada da cotação e do simulador). */
export interface ConfigurationInput {
  mode: DeploymentMode;
  cloudAccounts: number;
  monthlyGib: number;
  agents: number;
  historyDays: number;
  support: SupportLevel;
}

/** A configuração já normalizada para a tabela, com o porte calculado. */
export interface Configuration extends ConfigurationInput {
  size: SizeId;
}

export interface Preset {
  id: string;
  label: string;
  configuration: ConfigurationInput;
}

/** O conteúdo de uma tabela de preços (o que o responsável edita). */
export interface PriceTable {
  currency: 'brl';
  interval: 'month';
  sizing: { sizes: SizeRule[] };
  modes: { managed: ModePricing; self_hosted: ModePricing };
  cloudAccounts: { included: number; max: number; additional: Priced };
  volume: { includedMonthlyGib: number; bands: { monthlyGib: number; amount: number; lookupKey: string }[] };
  agents: { packSize: number; maxPacks: number; pack: Priced };
  history: { includedDays: number; extended: { days: number; amount: number; lookupKey: string }[] };
  prioritySupport: Priced;
  users: { max: number };
  presets?: Preset[];
}

/** O conteúdo de um modelo de custos (confidencial: só no Firestore e neste console). */
export interface CostModel {
  currency: 'brl';
  exchange: { brlPerUsd: number; quotedOn: string; cloudBuffer: number };
  infrastructure: {
    sizes: Partial<Record<SizeId, { vmUsdPerMonth: number; diskGb: number; snapshotGib: number }>>;
    diskUsdPerGibMonth: number;
    snapshotUsdPerGibMonth: number;
    natUsdPerVmMonth: number;
    natIpUsdPerMonth: number;
    otherUsdPerNodeMonth: number;
    ingestionUsdPerGib: number;
    agents: { entryUsdPerMonth: number; diskBaseGb: number; diskPerAgentGb: number };
  };
  paymentFees: { card: { rate: number; fixed: number }; boleto: { fixed: number }; billingRate: number };
  taxes: { rates: { id: string; label: string; rate: number }[]; defaultRateId: string };
  refundReserveRate: number;
  support: {
    hourlyCost: number;
    hours: {
      baseManaged: number;
      baseSelfHosted: number;
      perAdditionalAccount: number;
      perAgentPack: number;
      prioritySupport: number;
      perVolumeBand: { monthlyGib: number; hours: number }[];
      setupManaged: number;
      setupPriorityExtra: number;
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
  worstByMode: Partial<Record<DeploymentMode, GuardConfiguration>>;
  worstBySize: Partial<Record<SizeId, GuardConfiguration>>;
  otherScenarios: GuardScenario[];
  monotonicity: { violations: number; examples: MonotonicityViolation[] };
  startingAt: Partial<Record<DeploymentMode, number>>;
  gridMinimum: Partial<Record<DeploymentMode, number>>;
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
  variant: string;
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
  included: { cloudAccounts: number; monthlyGib: number; historyDays: number; users: number };
  agentPacks: number;
}

export interface DreLines {
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

/** Os passos do provisionamento, na ordem. */
export type ProvisioningStepName =
  | 'preflight'
  | 'cloudflare.tunnel'
  | 'firebase.site'
  | 'terraform.apply'
  | 'terraform.wait'
  | 'secrets.smtp_password'
  | 'secrets.tunnel_token'
  | 'node.wait_ready'
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
  configuration: Configuration;
  limits: NodeLimits;
  pricing: OrderPricing;
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

/** O que o console oferece agora para o cliente (a API e o cp-worker conferem de novo). */
export type TenantActions = Record<
  'start' | 'resume' | 'cancel' | 'suspend' | 'reactivate' | 'deleteNow' | 'export',
  boolean
>;

/** As operações do responsável (`POST /v1/admin/tenants/:id/<operação>`). */
export type TenantAction = 'start' | 'resume' | 'cancel' | 'suspend' | 'reactivate' | 'delete-now' | 'export';

/** `POST /v1/admin/tenants/preview`. */
export type DirectTenantPreview =
  | { priceTableVersion: string; contactUs: true; reason: ContactReason }
  | { priceTableVersion: string; contactUs: false; quote: Quote; problems: NodeFitProblem[] };

/**
 * O pedido ao cp-worker depois do cadastro. Sem sucesso, o código: `worker_unavailable`, `worker_refused`,
 * `worker_unconfigured` ou um do worker (`not_allowed`...).
 */
export type ProvisioningRequestOutcome =
  { started: true; runId: string; step: string } | { started: false; failure: string };

/** As respostas do contrato direto menos "onde roda": o modo da tabela sai de `hosting`. */
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
  images: { api: string; migrate: string };
  thirdPartyImages: string[];
  /** A chave de release que assinou o manifesto e a impressão digital dela (SHA-256 da pública em DER). */
  releaseKey: { name: string; sha256: string };
  nodeConf: NodeConfLine[];
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
