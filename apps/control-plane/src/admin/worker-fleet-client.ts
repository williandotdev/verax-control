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
/** ULID (Crockford, 26 caracteres, sem I, L, O e U). */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-';

function onlyFrom(alphabet: string, value: string): boolean {
  for (const ch of value) if (!alphabet.includes(ch)) return false;
  return true;
}

function isUlid(value: string): boolean {
  return value.length === 26 && onlyFrom(ULID_ALPHABET, value);
}

/** O nó numa rodada: `cell-<3 a 32 de [a-z0-9-]>` ou `tenant-<ULID>`. */
function isNodeKey(value: string): boolean {
  if (value.startsWith('cell-')) {
    const slug = value.slice('cell-'.length);
    return slug.length >= 3 && slug.length <= 32 && onlyFrom(SLUG_ALPHABET, slug);
  }
  return value.startsWith('tenant-') && isUlid(value.slice('tenant-'.length));
}

/**
 * Os caminhos da frota no cp-worker, conferidos segmento a segmento (sem expressão regular sobre o caminho):
 * `releases`, `inventory`, `plan`, `rollouts`, `rollouts/<ULID>/(pause|resume|abort)` e
 * `rollouts/<ULID>/nodes/<nó>/(skip|rollback)`.
 */
export function isFleetPath(path: string): boolean {
  const parts = path.split('/');
  const [head, id, third, node, action] = parts;
  if (parts.length === 1) return ['releases', 'inventory', 'plan', 'rollouts'].includes(head ?? '');
  if (head !== 'rollouts' || id === undefined || !isUlid(id)) return false;
  if (parts.length === 3) return ['pause', 'resume', 'abort'].includes(third ?? '');
  if (parts.length === 5) {
    return (
      third === 'nodes' &&
      node !== undefined &&
      isNodeKey(node) &&
      ['skip', 'rollback'].includes(action ?? '')
    );
  }
  return false;
}

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
    if (!isFleetPath(path)) throw new TypeError('caminho da frota inválido');
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
