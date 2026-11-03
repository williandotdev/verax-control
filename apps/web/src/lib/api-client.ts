import { CREDENTIAL_CHANGE_REQUIRED_CODE } from '@verax/shared';
import type { z } from 'zod';
import { API_URL } from './env';

/** Erro de uma chamada à API, com o status e o código estável que a API devolve (ex.: `MFA_REQUIRED`). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly requestId?: string,
    readonly issues?: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** A resposta da API não tem o formato esperado: tratada como erro, nunca usada às cegas (regra 6). */
export class UnexpectedResponseError extends Error {
  constructor() {
    super('Resposta inesperada do servidor');
    this.name = 'UnexpectedResponseError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions<T> {
  method?: Method;
  body?: unknown;
  /** Schema zod da resposta. Toda resposta com corpo é validada antes de chegar à tela. */
  schema?: z.ZodType<T>;
}

export interface ApiClientHooks {
  /** Sessão ausente ou expirada: o painel leva ao login. */
  onUnauthorized?: () => void;
  /** Sessão sem MFA cadastrado: o painel leva ao cadastro do MFA. */
  onMfaRequired?: () => void;
  /** Sessão aberta com a senha temporária: o painel leva à troca de senha (antes do MFA). */
  onPasswordChangeRequired?: () => void;
}

const UNSAFE: ReadonlySet<Method> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface ErrorBody {
  message?: unknown;
  code?: unknown;
  requestId?: unknown;
  issues?: unknown;
}

/**
 * Cliente HTTP do painel. Sempre com o cookie de sessão (`credentials: 'include'`); em toda escrita, manda o
 * token CSRF da sessão (buscado uma vez e renovado se a API recusar). 401 leva ao login, 403 com
 * `PASSWORD_CHANGE_REQUIRED` leva à troca da senha temporária, 403 com `MFA_REQUIRED` leva ao cadastro do MFA, e
 * os demais erros chegam à tela como `ApiRequestError`.
 */
export class ApiClient {
  private csrfToken: Promise<string> | undefined;

  constructor(
    private readonly baseUrl: string = API_URL,
    private readonly hooks: ApiClientHooks = {},
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  get<T>(path: string, schema?: z.ZodType<T>): Promise<T> {
    return this.request(path, { method: 'GET', schema });
  }

  post<T>(path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    return this.request(path, { method: 'POST', body, schema });
  }

  patch<T>(path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    return this.request(path, { method: 'PATCH', body, schema });
  }

  delete<T>(path: string, schema?: z.ZodType<T>): Promise<T> {
    return this.request(path, { method: 'DELETE', schema });
  }

  /** Descarta o token CSRF (depois de login, logout ou troca de sessão). */
  resetCsrf(): void {
    this.csrfToken = undefined;
  }

  async request<T>(path: string, options: RequestOptions<T> = {}, retried = false): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (UNSAFE.has(method) && !path.startsWith('/v1/auth/')) headers['X-CSRF-Token'] = await this.csrf();

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      const error = await this.toError(response);
      if (error.code === 'CSRF_INVALID' && !retried) {
        this.resetCsrf();
        return this.request(path, options, true);
      }
      // Nas rotas de autenticação, 401 é resposta do próprio fluxo (senha ou código errados), não sessão expirada.
      const authRoute = path.startsWith('/v1/auth/');
      if (error.status === 401 && !authRoute) this.hooks.onUnauthorized?.();
      if (error.code === 'MFA_REQUIRED' && !authRoute) this.hooks.onMfaRequired?.();
      // Este código só vem de sessão com senha temporária, inclusive nas rotas de autenticação (o cadastro do MFA
      // também espera a troca da senha).
      if (error.code === CREDENTIAL_CHANGE_REQUIRED_CODE) this.hooks.onPasswordChangeRequired?.();
      throw error;
    }

    if (response.status === 204 || !options.schema) return undefined as T;
    const parsed = options.schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new UnexpectedResponseError();
    return parsed.data;
  }

  private csrf(): Promise<string> {
    this.csrfToken ??= this.fetchCsrf().catch((error: unknown) => {
      this.csrfToken = undefined;
      throw error;
    });
    return this.csrfToken;
  }

  private async fetchCsrf(): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/csrf-token`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw await this.toError(response);
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== 'string') throw new UnexpectedResponseError();
    return body.token;
  }

  private async toError(response: Response): Promise<ApiRequestError> {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    const issues = Array.isArray(body.issues)
      ? (body.issues as { path?: unknown; message?: unknown }[]).map((issue) => ({
          path: typeof issue.path === 'string' ? issue.path : '',
          message: typeof issue.message === 'string' ? issue.message : '',
        }))
      : undefined;
    return new ApiRequestError(
      response.status,
      typeof body.message === 'string' ? body.message : 'Não foi possível concluir a operação',
      typeof body.code === 'string' ? body.code : undefined,
      typeof body.requestId === 'string' ? body.requestId : undefined,
      issues,
    );
  }
}
