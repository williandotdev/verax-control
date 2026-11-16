import type { IdTokenSource } from '../status/id-token.js';
import type { OwnerCallResult } from './worker-owner-client.js';

/**
 * O cliente que o console do responsável usa para a frota no cp-worker (`POST <WORKER_URL>/internal/fleet/<caminho>`),
 * como o `HttpWorkerOwnerClient` das operações sobre um cliente: o token de identidade da conta do `cp-admin`
 * (audiência `WORKER_URL`) e quem agiu no corpo (`actor`). O cookie de quem está no navegador nunca sai do console.
 */
export interface WorkerFleetClient {
  /** `caminho`: `releases`, `inventory`, `plan`, `rollouts`, `rollouts/<id>/<ação>` ou `rollouts/<id>/nodes/<nó>/<ação>`. */
  post(path: string, body: Record<string, unknown>, actor: string): Promise<OwnerCallResult>;
}

export const CONSOLE_FLEET_CLIENT = Symbol('CONSOLE_FLEET_CLIENT');

const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_CHARS = 512 * 1024;
const CODE_PATTERN = /^[a-z][a-z_]{0,63}$/;
/** Só os caminhos da frota, com ids no formato (nada vindo do navegador monta outra URL). */
const PATH_PATTERN =
  /^(releases|inventory|plan|rollouts|rollouts\/[0-9A-HJKMNP-TV-Z]{26}\/(pause|resume|abort)|rollouts\/[0-9A-HJKMNP-TV-Z]{26}\/nodes\/(cell-[a-z0-9-]{3,32}|tenant-[0-9A-HJKMNP-TV-Z]{26})\/(skip|rollback))$/;

export class HttpWorkerFleetClient implements WorkerFleetClient {
  constructor(
    private readonly workerUrl: string,
    private readonly idTokens: IdTokenSource,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    const url = new URL(workerUrl);
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1')
      throw new TypeError('WORKER_URL precisa ser https');
  }

  async post(path: string, body: Record<string, unknown>, actor: string): Promise<OwnerCallResult> {
    if (!PATH_PATTERN.test(path)) throw new TypeError('caminho da frota inválido');
    const audience = this.workerUrl.replace(/\/+$/, '');
    const token = await this.idTokens.get(audience);
    let response: Response;
    try {
      response = await this.fetchFn(`${audience}/internal/fleet/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, actor }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
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
