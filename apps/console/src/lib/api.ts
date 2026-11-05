import type {
  AdminSession,
  CheckResult,
  CostModel,
  GuardReport,
  PriceTable,
  PublishResult,
  SimulationRequest,
  SimulationResult,
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

/** O IAP respondeu no lugar do console (sessão vencida, redirecionamento ao login): só recarregar resolve. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Sua sessão no Google terminou. Recarregue a página para entrar de novo.');
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
 * Cliente do console: sempre a mesma origem (o `cp-admin` serve as telas e a API), com o cookie do IAP. Escritas em
 * JSON (a guarda recusa outro tipo). `X-Requested-With` pede ao IAP um 401 em vez do redirecionamento ao login
 * quando a sessão dele vence; a resposta sem JSON, ou redirecionada, vira `SessionExpiredError`.
 */
export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Não foi possível falar com o console. Verifique a conexão.');
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new SessionExpiredError();
  }
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload: unknown = isJson ? await response.json().catch(() => undefined) : undefined;
  if (!response.ok) {
    if (!isJson && (response.status === 401 || response.status === 403)) throw new SessionExpiredError();
    const data = isRecord(payload) ? payload : {};
    const message = typeof data['message'] === 'string' ? data['message'] : 'Erro inesperado';
    throw new ApiError(
      response.status,
      message,
      typeof data['code'] === 'string' ? data['code'] : undefined,
      issuesOf(data['details']),
      reportOf(data['details']),
      typeof data['requestId'] === 'string' ? data['requestId'] : undefined,
      costModelVersionOf(data['details']),
    );
  }
  if (!isJson) throw new SessionExpiredError();
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
