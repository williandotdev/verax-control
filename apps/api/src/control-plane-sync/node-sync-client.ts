import {
  NODE_SYNC_MAX_CLOCK_SKEW_MS,
  NODE_SYNC_RESPONSE_MAX_BYTES,
  type NodeSyncRequest,
  type NodeSyncResponse,
  nodeSyncRequestSchema,
  nodeSyncResponseSchema,
} from '@verax/shared';
import { z } from 'zod';

/** Tempo máximo de uma chamada ao plano de controle (do pedido ao fim da leitura da resposta). */
export const NODE_SYNC_REQUEST_TIMEOUT_MS = 20_000;

/**
 * O que deu errado numa chamada, só o código (nunca o corpo, que não é lido além do necessário, nem a credencial):
 * - `unauthenticated` (401): o plano de controle não reconheceu o nó (token ou chave);
 * - `not_found` (404): o cliente não está apto à sincronização (ainda não ativo, removido, outra plataforma);
 * - `stale_sequence` (409): a sequência não é maior que a última aceita (o banco do nó voltou de um backup);
 * - `bad_request` (400): o plano de controle recusou o pedido (contrato ou relógio fora dos 10 min);
 * - `rate_limited` (429), `unavailable` (5xx, rede, tempo esgotado);
 * - `invalid_response`: 200 com um corpo grande demais, que não é JSON ou fora do contrato;
 * - `unexpected_status`: qualquer outro código.
 */
export type NodeSyncFailureCode =
  | 'unauthenticated'
  | 'not_found'
  | 'stale_sequence'
  | 'bad_request'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'unexpected_status';

export type NodeSyncResult =
  | { ok: true; response: NodeSyncResponse }
  | {
      ok: false;
      code: NodeSyncFailureCode;
      /** O status HTTP, quando houve resposta (só para o log). */
      status?: number;
      /** 429: o `Retry-After`, em segundos. */
      retryAfterSeconds?: number;
      /** 409: a última sequência aceita, se o plano de controle a disser. */
      acceptedSequence?: number;
      /** 400: a diferença entre o relógio do plano de controle (o `Date` da resposta) e o do nó, em ms. */
      clockSkewMs?: number;
    };

/** O 409 pode dizer a última sequência aceita; qualquer outro corpo é ignorado. */
const staleSequenceBodySchema = z.object({ sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

class ResponseTooLarge extends Error {
  constructor() {
    super('resposta do plano de controle maior que o limite');
    this.name = 'ResponseTooLarge';
  }
}

/** O corpo da resposta, até `max` bytes: passou disso (pelo `Content-Length` ou na leitura), recusa sem ler o resto. */
async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `Retry-After` em segundos (a forma de data é ignorada). */
function retryAfterOf(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/** A diferença entre o relógio de quem respondeu (o `Date`) e o do nó, em ms; undefined sem o cabeçalho. */
function clockSkewOf(response: Response, now: number): number | undefined {
  const value = response.headers.get('date');
  if (value === null) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at - now;
}

export interface NodeSyncPostOptions {
  /** O endereço da rota (`<origem>/v1/node-sync`). */
  url: string;
  /** O valor do `Authorization` sem o `Bearer `: o token do Google ou a chave do nó. Nunca vai para log nem erro. */
  credential: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Uma chamada ao `POST /v1/node-sync`: o pedido conferido pelo contrato antes de sair (um pedido fora dele é um erro do
 * nó, lançado), sem seguir redirecionamento, com tempo máximo e a resposta lida até o limite e conferida pelo contrato
 * estrito. O cancelamento do worker (o sinal) passa adiante; qualquer outra falha vira um código.
 */
export async function postNodeSync(
  request: NodeSyncRequest,
  signal: AbortSignal,
  {
    url,
    credential,
    fetch: fetchImpl = fetch,
    timeoutMs = NODE_SYNC_REQUEST_TIMEOUT_MS,
    now = Date.now,
  }: NodeSyncPostOptions,
): Promise<NodeSyncResult> {
  const body = JSON.stringify(nodeSyncRequestSchema.parse(request));
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([signal, timeout]),
    });
    if (response.status !== 200 && response.status !== 409) {
      await response.body?.cancel().catch(() => undefined);
      return failureOf(response, now());
    }
    text = await readCapped(response, NODE_SYNC_RESPONSE_MAX_BYTES);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ResponseTooLarge) return { ok: false, code: 'invalid_response', status: 200 };
    return { ok: false, code: 'unavailable' };
  }
  if (response.status === 409) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // O corpo é genérico; sem a sequência, o nó só avança a própria.
    }
    const stale = staleSequenceBodySchema.safeParse(parsed);
    return {
      ok: false,
      code: 'stale_sequence',
      status: 409,
      ...(stale.success && { acceptedSequence: stale.data.sequence }),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_response', status: 200 };
  }
  const parsed = nodeSyncResponseSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: 'invalid_response', status: 200 };
  return { ok: true, response: parsed.data };
}

function failureOf(response: Response, now: number): NodeSyncResult {
  const status = response.status;
  if (status === 401) return { ok: false, code: 'unauthenticated', status };
  if (status === 404) return { ok: false, code: 'not_found', status };
  if (status === 400) {
    const skew = clockSkewOf(response, now);
    return { ok: false, code: 'bad_request', status, ...(skew !== undefined && { clockSkewMs: skew }) };
  }
  if (status === 429) {
    const retryAfterSeconds = retryAfterOf(response);
    return {
      ok: false,
      code: 'rate_limited',
      status,
      ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    };
  }
  if (status >= 500) return { ok: false, code: 'unavailable', status };
  return { ok: false, code: 'unexpected_status', status };
}

/** O relógio do nó passou do que o plano de controle aceita no `sentAt`. */
export function clockSkewExceeded(skewMs: number | undefined): boolean {
  return skewMs !== undefined && Math.abs(skewMs) > NODE_SYNC_MAX_CLOCK_SKEW_MS;
}
