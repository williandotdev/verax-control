import type {
  AdminSession,
  CheckResult,
  LoginRequest,
  PasswordChangeRequest,
  RecoveryCodes,
  SetupCompleted,
  SetupStartRequest,
  SetupStatus,
  TotpConfirmRequest,
  TotpEnrollment,
  TotpResetStartRequest,
  CostModel,
  DirectConfiguration,
  DirectTenantCreated,
  DirectTenantPreview,
  DirectTenantRequest,
  GuardReport,
  Hosting,
  LegalAuditEntry,
  LegalCreateRequest,
  LegalKind,
  LegalOverview,
  LegalPublishRequest,
  LegalTextRecord,
  LegalUpdateRequest,
  LegalVersionSummary,
  PriceTable,
  PublishResult,
  SimulationRequest,
  SimulationResult,
  TenantAction,
  TenantActionRequest,
  TenantActionResult,
  TenantDetail,
  TenantInstallation,
  TenantList,
  ValidationIssue,
  VersionedRecord,
  VersionSummary,
} from './api-types';

/**
 * Erro de uma chamada ao console, com o status, o código estável da API e o que ela mandou de detalhe: os problemas
 * de validação (`details.issues`, para mostrar ao lado de cada campo) e o relatório da checagem recusada
 * (`details.report`, no 422 da publicação).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly issues: readonly ValidationIssue[] = [],
    readonly report?: GuardReport,
    readonly requestId?: string,
    /** O modelo de custos com que a checagem recusada rodou (`details.costModelVersion`). */
    readonly costModelVersion?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A sessão do console terminou (30 minutos sem uso, 12 horas desde a entrada, saída em outra aba ou senha trocada): a
 * API respondeu 401 `unauthenticated` numa rota protegida. O console leva o responsável à tela de entrada.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Sua sessão no console terminou. Entre de novo para continuar.');
    this.name = 'SessionExpiredError';
  }
}

type Method = 'GET' | 'POST' | 'PUT';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issuesOf(details: unknown): ValidationIssue[] {
  if (!isRecord(details) || !Array.isArray(details['issues'])) return [];
  return details['issues'].flatMap((issue: unknown) =>
    isRecord(issue) && typeof issue['path'] === 'string' && typeof issue['message'] === 'string'
      ? [{ path: issue['path'], message: issue['message'] }]
      : [],
  );
}

function reportOf(details: unknown): GuardReport | undefined {
  if (!isRecord(details) || !isRecord(details['report'])) return undefined;
  return details['report'] as unknown as GuardReport;
}

function costModelVersionOf(details: unknown): string | undefined {
  return isRecord(details) && typeof details['costModelVersion'] === 'string'
    ? details['costModelVersion']
    : undefined;
}

/**
 * Cliente do console: sempre a mesma origem (o `cp-admin` serve as telas e a API), com o cookie de sessão `__session`
 * (HttpOnly: o JavaScript nunca o lê). Escritas em JSON (a guarda recusa outro tipo). Um 401 `unauthenticated` é a
 * sessão que terminou (`SessionExpiredError`); o 401 da entrada (`login_failed`) é um erro comum do formulário. 204
 * devolve `undefined`.
 */
export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Não foi possível falar com o console. Verifique a conexão.');
  }
  if (response.status === 204) return undefined as T;
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload: unknown = isJson ? await response.json().catch(() => undefined) : undefined;
  const data = isRecord(payload) ? payload : {};
  const code = typeof data['code'] === 'string' ? data['code'] : undefined;
  if (!response.ok) {
    if (response.status === 401 && (code === undefined || code === 'unauthenticated')) {
      throw new SessionExpiredError();
    }
    const message = typeof data['message'] === 'string' ? data['message'] : 'Erro inesperado';
    throw new ApiError(
      response.status,
      message,
      code,
      issuesOf(data['details']),
      reportOf(data['details']),
      typeof data['requestId'] === 'string' ? data['requestId'] : undefined,
      costModelVersionOf(data['details']),
    );
  }
  if (!isJson) throw new ApiError(response.status, 'Resposta inesperada do console.');
  return payload as T;
}

/** Os dois documentos versionados do console: tabelas de preço e modelos de custo, com o mesmo ciclo de vida. */
export type VersionKind = 'pricing-tables' | 'cost-models';
export type ContentOf<K extends VersionKind> = K extends 'pricing-tables' ? PriceTable : CostModel;

const BASE = '/v1/admin';

function versionPath(kind: VersionKind, version?: string, action?: string): string {
  const parts = [BASE, kind];
  if (version !== undefined) parts.push(encodeURIComponent(version));
  if (action !== undefined) parts.push(action);
  return parts.join('/');
}

export const api = {
  me: (): Promise<AdminSession> => request('GET', `${BASE}/me`),
  list: (kind: VersionKind): Promise<VersionSummary[]> => request('GET', versionPath(kind)),
  get: <K extends VersionKind>(kind: K, version: string): Promise<VersionedRecord<ContentOf<K>>> =>
    request('GET', versionPath(kind, version)),
  create: <K extends VersionKind>(
    kind: K,
    version: string,
    content: unknown,
  ): Promise<VersionedRecord<ContentOf<K>>> => request('POST', versionPath(kind), { version, content }),
  update: <K extends VersionKind>(
    kind: K,
    version: string,
    content: unknown,
  ): Promise<VersionedRecord<ContentOf<K>>> => request('PUT', versionPath(kind, version), { content }),
  check: (version: string, costModelVersion?: string): Promise<CheckResult> =>
    request(
      'POST',
      versionPath('pricing-tables', version, 'check'),
      costModelVersion === undefined ? {} : { costModelVersion },
    ),
  publish: (kind: VersionKind, version: string, effectiveFrom?: string): Promise<PublishResult> =>
    request(
      'POST',
      versionPath(kind, version, 'publish'),
      effectiveFrom === undefined ? {} : { effectiveFrom },
    ),
  simulate: (body: SimulationRequest): Promise<SimulationResult> =>
    request('POST', `${BASE}/dre/simulate`, body),
};

const TENANTS = `${BASE}/tenants`;

/** Os clientes: a lista, o detalhe, a cotação de referência, o cadastro de contrato direto e as operações. */
export const tenantsApi = {
  list: (): Promise<TenantList> => request('GET', TENANTS),
  get: (id: string): Promise<TenantDetail> => request('GET', `${TENANTS}/${encodeURIComponent(id)}`),
  preview: (hosting: Hosting, configuration: DirectConfiguration): Promise<DirectTenantPreview> =>
    request('POST', `${TENANTS}/preview`, { hosting, configuration }),
  installation: (id: string): Promise<TenantInstallation> =>
    request('GET', `${TENANTS}/${encodeURIComponent(id)}/installation`),
  create: (body: DirectTenantRequest): Promise<DirectTenantCreated> => request('POST', TENANTS, body),
  act: (id: string, action: TenantAction, body: TenantActionRequest): Promise<TenantActionResult> =>
    request('POST', `${TENANTS}/${encodeURIComponent(id)}/${action}`, body),
};

const ACCOUNT = `${BASE}/account`;

/**
 * A entrada no console e a conta do responsável: o primeiro acesso (`/configurar`, com o token de configuração), a
 * entrada com e-mail, senha e código do aplicativo (ou um código de recuperação), a saída e a troca de senha e de
 * aplicativo. Nada disso vai para a URL, o `localStorage` ou o log: só no corpo do pedido.
 */
export const authApi = {
  setupStatus: (): Promise<SetupStatus> => request('GET', `${BASE}/setup`),
  setupStart: (body: SetupStartRequest): Promise<TotpEnrollment> =>
    request('POST', `${BASE}/setup/start`, body),
  setupConfirm: (body: TotpConfirmRequest): Promise<SetupCompleted> =>
    request('POST', `${BASE}/setup/confirm`, body),
  login: (body: LoginRequest): Promise<AdminSession> => request('POST', `${BASE}/login`, body),
  logout: (): Promise<void> => request('POST', `${BASE}/logout`, {}),
  changePassword: (body: PasswordChangeRequest): Promise<void> =>
    request('POST', `${ACCOUNT}/password`, body),
  totpStart: (body: TotpResetStartRequest): Promise<TotpEnrollment> =>
    request('POST', `${ACCOUNT}/totp/start`, body),
  totpConfirm: (body: TotpConfirmRequest): Promise<RecoveryCodes> =>
    request('POST', `${ACCOUNT}/totp/confirm`, body),
};

const LEGAL = `${BASE}/legal`;

function legalVersionPath(kind: LegalKind, version?: string): string {
  const path = `${LEGAL}/${kind}/versions`;
  return version === undefined ? path : `${path}/${encodeURIComponent(version)}`;
}

/** Os textos legais (Termos, Privacidade e DPA): a lista, o rascunho, a edição, a publicação e a trilha. */
export const legalApi = {
  overview: (): Promise<LegalOverview> => request('GET', LEGAL),
  get: (kind: LegalKind, version: string): Promise<LegalTextRecord> =>
    request('GET', legalVersionPath(kind, version)),
  create: (kind: LegalKind, body: LegalCreateRequest): Promise<LegalTextRecord> =>
    request('POST', legalVersionPath(kind), body),
  update: (kind: LegalKind, version: string, body: LegalUpdateRequest): Promise<LegalTextRecord> =>
    request('PUT', legalVersionPath(kind, version), body),
  publish: (kind: LegalKind, version: string, body: LegalPublishRequest): Promise<LegalVersionSummary> =>
    request('POST', `${legalVersionPath(kind, version)}/publish`, body),
  audit: (kind: LegalKind): Promise<LegalAuditEntry[]> => request('GET', `${LEGAL}/${kind}/audit`),
};
