import { type NodeSyncRequest, type NodeSyncResponse, nodeSyncResponseSchema } from '@verax/shared';
import type { IdTokenSource } from '../status/id-token.js';

/** Os desfechos da sincronização que o nó vê pelo código; qualquer outra falha é `unavailable`. */
export type NodeSyncFailureCode =
  | 'invalid_request'
  | 'clock_skew'
  | 'unauthenticated'
  | 'not_found'
  | 'stale_sequence'
  | 'too_soon'
  | 'unavailable';

export class NodeSyncGatewayError extends Error {
  constructor(
    readonly code: NodeSyncFailureCode,
    /** Só em `too_soon`: os segundos do `Retry-After` do cp-worker. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`sincronização recusada: ${code}`);
    this.name = 'NodeSyncGatewayError';
  }
}

/**
 * O caminho do cp-public até a sincronização no cp-worker. O cp-public não lê nem grava nada do estado do nó: repassa a
 * credencial do nó (conferida de novo no worker) e o corpo já conferido, com a identidade dele, como o registro da VM.
 * Um método por credencial, cada um com a sua rota no worker (a rota diz qual credencial é; o corpo, nunca).
 * Implementações: `WorkerNodeSyncGateway` (produção) e, nos testes, um dublê.
 */
export interface NodeSyncGateway {
  /** O nó gerenciado: o token de identidade do Google (`/internal/node-sync/managed`). */
  syncManaged(token: string, request: NodeSyncRequest, requestId?: string): Promise<NodeSyncResponse>;
  /** A VM do cliente: a chave do nó (`/internal/node-sync/customer`). */
  syncCustomer(nodeKey: string, request: NodeSyncRequest, requestId?: string): Promise<NodeSyncResponse>;
}

export const NODE_SYNC_GATEWAY = Symbol('NODE_SYNC_GATEWAY');

/** Os códigos do worker que o nó pode ver, por status; o resto vira `unavailable`. */
const KNOWN_FAILURES: ReadonlyMap<number, NodeSyncFailureCode> = new Map([
  [400, 'invalid_request'],
  [401, 'unauthenticated'],
  [404, 'not_found'],
  [409, 'stale_sequence'],
  [429, 'too_soon'],
]);

/** Até a resposta do worker (com a partida a frio dele): menos que os 60 s do rewrite do Hosting. */
const WORKER_TIMEOUT_MS = 25_000;

function retryAfterOf(response: Response): number {
  const value = Number(response.headers.get('retry-after'));
  return Number.isInteger(value) && value >= 1 && value <= 3600 ? value : 20;
}

function codeOf(text: string): unknown {
  try {
    return (JSON.parse(text) as { code?: unknown } | null)?.code;
  } catch {
    return undefined;
  }
}

/**
 * `POST <WORKER_URL>/internal/node-sync/managed` `{token, request}` ou `/internal/node-sync/customer` `{nodeKey,
 * request}`, com o token de identidade do cp-public. A resposta é conferida com o schema do protocolo antes de voltar ao nó; o texto dela nunca vai a log.
 */
export class WorkerNodeSyncGateway implements NodeSyncGateway {
  constructor(
    private readonly workerUrl: string,
    private readonly idTokens: IdTokenSource,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs: number = WORKER_TIMEOUT_MS,
  ) {}

  syncManaged(token: string, request: NodeSyncRequest, requestId?: string): Promise<NodeSyncResponse> {
    return this.post('/internal/node-sync/managed', { token, request }, requestId);
  }

  syncCustomer(nodeKey: string, request: NodeSyncRequest, requestId?: string): Promise<NodeSyncResponse> {
    return this.post('/internal/node-sync/customer', { nodeKey, request }, requestId);
  }

  private async post(path: string, payload: unknown, requestId?: string): Promise<NodeSyncResponse> {
    const identity = await this.idTokens.get(this.workerUrl);
    const response = await this.fetchFn(new URL(path, this.workerUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity}`,
        'content-type': 'application/json',
        ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
      },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (response.status !== 200) {
      const code = KNOWN_FAILURES.get(response.status) ?? 'unavailable';
      if (code === 'too_soon') throw new NodeSyncGatewayError(code, retryAfterOf(response));
      if (code === 'invalid_request' && codeOf(text) === 'clock_skew') {
        throw new NodeSyncGatewayError('clock_skew');
      }
      throw new NodeSyncGatewayError(code);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new NodeSyncGatewayError('unavailable');
    }
    const parsed = nodeSyncResponseSchema.safeParse(body);
    if (!parsed.success) throw new NodeSyncGatewayError('unavailable');
    return parsed.data;
  }
}

/** Sem `WORKER_URL`: a sincronização responde 503 e nada é lido nem gravado. */
export class UnconfiguredNodeSyncGateway implements NodeSyncGateway {
  syncManaged(): Promise<never> {
    return Promise.reject(new NodeSyncGatewayError('unavailable'));
  }

  syncCustomer(): Promise<never> {
    return Promise.reject(new NodeSyncGatewayError('unavailable'));
  }
}
