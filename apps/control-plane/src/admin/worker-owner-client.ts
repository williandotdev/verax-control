import { isUlid } from '../common/ulid.js';
import type { IdTokenSource } from '../status/id-token.js';

/**
 * O cliente que o console do responsável (`cp-admin`, atrás do IAP) usa para as operações dele no cp-worker (CP-11):
 * um `POST <WORKER_URL>/internal/tenants/<id>/<operação>` com o token de identidade da conta do `cp-admin` (audiência
 * `WORKER_URL`, pelo servidor de metadados) e quem agiu no corpo (`actor`, o e-mail que o IAP deu ao console). O token
 * de quem está no navegador nunca sai do console. O worker confere a conta (`ADMIN_SA_EMAIL`) e que `actor` é um
 * responsável (`OWNER_PRINCIPALS`), e audita como `owner:<actor>`.
 */
export type OwnerOperation = 'resume' | 'delete-now' | 'export' | 'cancel' | 'suspend' | 'reactivate';

export type OwnerCallResult =
  { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; code: string };

export interface WorkerOwnerClient {
  resume(tenantId: string, actor: string): Promise<OwnerCallResult>;
  deleteNow(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult>;
  exportLink(tenantId: string, object: string, actor: string): Promise<OwnerCallResult>;
  /** `at`: a data do fim do contrato (futura); sem ela, agora. */
  cancel(tenantId: string, confirmSlug: string, actor: string, at?: Date): Promise<OwnerCallResult>;
  suspend(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult>;
  reactivate(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult>;
}

const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_CHARS = 64 * 1024;
const CODE_PATTERN = /^[a-z][a-z_]{0,63}$/;

export class HttpWorkerOwnerClient implements WorkerOwnerClient {
  constructor(
    private readonly workerUrl: string,
    private readonly idTokens: IdTokenSource,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    const url = new URL(workerUrl);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1')
      throw new TypeError('WORKER_URL precisa ser https');
  }

  resume(tenantId: string, actor: string): Promise<OwnerCallResult> {
    return this.call(tenantId, 'resume', { actor });
  }

  deleteNow(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult> {
    return this.call(tenantId, 'delete-now', { confirmSlug, actor });
  }

  exportLink(tenantId: string, object: string, actor: string): Promise<OwnerCallResult> {
    return this.call(tenantId, 'export', { object, actor });
  }

  cancel(tenantId: string, confirmSlug: string, actor: string, at?: Date): Promise<OwnerCallResult> {
    return this.call(tenantId, 'cancel', {
      confirmSlug,
      actor,
      ...(at === undefined ? {} : { at: at.toISOString() }),
    });
  }

  suspend(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult> {
    return this.call(tenantId, 'suspend', { confirmSlug, actor });
  }

  reactivate(tenantId: string, confirmSlug: string, actor: string): Promise<OwnerCallResult> {
    return this.call(tenantId, 'reactivate', { confirmSlug, actor });
  }

  private async call(
    tenantId: string,
    operation: OwnerOperation,
    body: Record<string, unknown>,
  ): Promise<OwnerCallResult> {
    if (!isUlid(tenantId)) throw new TypeError('id de cliente inválido');
    const audience = this.workerUrl.replace(/\/+$/, '');
    const token = await this.idTokens.get(audience);
    let response: Response;
    try {
      response = await this.fetchFn(`${audience}/internal/tenants/${tenantId}/${operation}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // A mensagem do fetch pode trazer a URL: fica só o fato.
      return { ok: false, status: 0, code: 'worker_unreachable' };
    }
    const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const object = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    if (response.ok) return { ok: true, status: response.status, body: object };
    const code =
      typeof object.code === 'string' && CODE_PATTERN.test(object.code) ? object.code : 'worker_error';
    return { ok: false, status: response.status, code };
  }
}
