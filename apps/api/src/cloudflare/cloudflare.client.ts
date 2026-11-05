import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { CloudflareToken } from '../credentials/credential-vault.js';
import { CLOUDFLARE_API_BASE_URL, isAllowedBaseUrl, rfc3339 } from './cloudflare-token-check.js';

/**
 * Cliente da API REST do Cloudflare para o coletor do worker (fase 2, PR-12), só com `fetch` e zod:
 * - auditoria v2 da conta: `GET /accounts/{account_id}/logs/audit`, com `since` e `before` (RFC 3339), `direction`,
 *   `limit` (1 a 1000) e o `cursor` opaco que a resposta devolve em `result_info.cursor`;
 * - zonas da conta: `GET /zones?account.id=<conta>&per_page=50&page=<n>`.
 *
 * O token só vai no header `Authorization`, e só para o host oficial (fixo, sem variável de ambiente que o troque; o
 * construtor aceita outra base só em `http://127.0.0.1:<porta>`, para os testes). Sem seguir redirecionamento.
 *
 * Erros: `CloudflareApiError`, com um código e nada da resposta (a mensagem do Cloudflare pode citar recursos da conta
 * e até repetir o token). O nome do erro é o próprio código, que é o que vai para o banco e para o log
 * (`errorKind`). Cada tentativa tem tempo limite; 5xx, falha de rede e tempo esgotado são tentados de novo poucas
 * vezes, com espera crescente; 401, 403 e 429 nunca (o 429 devolve a espera pedida pelo `retry-after`, e o coletor
 * só volta depois dela). O corpo é lido até um teto de bytes.
 */

/** Códigos dos erros da API, gravados como estão em `CloudAccount.connectionError` e no cursor. */
export type CloudflareErrorCode =
  | 'credential_rejected'
  | 'credential_forbidden'
  | 'rate_limited'
  | 'bad_request'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'response_too_large'
  | `http_${number}`;

export class CloudflareApiError extends Error {
  constructor(
    readonly code: CloudflareErrorCode,
    /** Status HTTP, quando houve resposta. */
    readonly status?: number,
    /** Espera pedida pelo `retry-after` de um 429, em milissegundos. */
    readonly retryAfterMs?: number,
  ) {
    super(`API do Cloudflare: ${code}`);
    // O nome é o código: é o que `errorKind` grava, sem nada da resposta.
    this.name = code;
  }
}

/** Falhas passageiras: vale tentar de novo na mesma execução. */
function isRetryable(error: CloudflareApiError): boolean {
  return (
    error.code === 'timeout' ||
    error.code === 'network' ||
    (error.status !== undefined && error.status >= 500)
  );
}

/** Teto da espera pedida pelo `retry-after`: uma hora. O Cloudflare bloqueia por 5 minutos ao estourar o limite. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** `retry-after` em segundos (o que o Cloudflare manda) ou como data HTTP; fora disso, sem espera conhecida. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header.trim());
  let wait: number;
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    wait = Math.ceil(seconds) * 1000;
  } else {
    const at = Date.parse(header);
    if (Number.isNaN(at)) return undefined;
    wait = at - now;
  }
  return Math.min(Math.max(wait, 1000), MAX_RETRY_AFTER_MS);
}

/** Lê o corpo até `max` bytes; acima disso, desiste sem guardar o resto. */
async function readBounded(response: Response, max: number): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudflareApiError('response_too_large', response.status);
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) return { text: '', bytes: 0 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => undefined);
      throw new CloudflareApiError('response_too_large', response.status);
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
}

/** O envelope da auditoria: as entradas ficam como `unknown` e são validadas uma a uma por quem lê. */
const auditPageSchema = z.object({
  success: z.literal(true),
  result: z.array(z.unknown()).max(1000).nullish(),
  result_info: z.object({ cursor: z.string().max(4096).nullish() }).nullish(),
});

const zoneSchema = z.object({
  name: z.string().min(1).max(253),
  account: z.object({ id: z.string().max(64).nullish() }).nullish(),
});

const zonesPageSchema = z.object({
  success: z.literal(true),
  result: z.array(z.unknown()).max(1000).nullish(),
  result_info: z.object({ total_pages: z.number().int().min(0).nullish() }).nullish(),
});

export interface AuditPageRequest {
  since: Date;
  before: Date;
  limit: number;
  /** O `result_info.cursor` da página anterior, para seguir na mesma janela. */
  cursor?: string | null;
}

export interface AuditPage {
  /** Entradas como vieram, ainda sem validar. */
  entries: unknown[];
  /** O cursor da próxima página; `null` quando acabou. */
  cursor: string | null;
  /** Bytes do corpo da resposta (o medidor de uso conta o que foi lido). */
  bytes: number;
}

export interface AccountZones {
  /** Nomes das zonas da conta, em minúsculas (só as que o Cloudflare diz serem desta conta). */
  names: Set<string>;
  /** Todas as páginas lidas (sem bater no teto). */
  complete: boolean;
}

export interface CloudflareClientOptions {
  /** Só para os testes (servidor falso em 127.0.0.1); fora deles, o host oficial. */
  baseUrl?: string;
  /** Tempo limite de cada tentativa. */
  timeoutMs?: number;
  /** Esperas antes de cada nova tentativa (5xx, rede, tempo esgotado); o tamanho é o número de novas tentativas. */
  retryDelaysMs?: readonly number[];
  /** Teto do corpo de uma resposta. */
  maxBodyBytes?: number;
}

export const CLOUDFLARE_REQUEST_TIMEOUT_MS = 20_000;
export const CLOUDFLARE_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];
/** 16 MiB por página: 500 entradas de até cerca de 32 KB cada, dentro do heap de 160 MB do worker. */
export const CLOUDFLARE_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Zonas por página (o máximo da API) e teto de páginas por leitura. */
const ZONES_PER_PAGE = 50;
const MAX_ZONE_PAGES = 20;

export class CloudflareClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retryDelaysMs: readonly number[];
  readonly #maxBodyBytes: number;

  constructor({
    baseUrl = CLOUDFLARE_API_BASE_URL,
    timeoutMs = CLOUDFLARE_REQUEST_TIMEOUT_MS,
    retryDelaysMs = CLOUDFLARE_RETRY_DELAYS_MS,
    maxBodyBytes = CLOUDFLARE_MAX_BODY_BYTES,
  }: CloudflareClientOptions = {}) {
    if (!isAllowedBaseUrl(baseUrl)) {
      throw new Error(
        'a API do Cloudflare só é chamada no host oficial (ou num servidor falso local, nos testes)',
      );
    }
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
    this.#retryDelaysMs = retryDelaysMs;
    this.#maxBodyBytes = maxBodyBytes;
  }

  /** Uma página da auditoria da conta, em ordem crescente de horário. */
  async auditPage(
    token: CloudflareToken,
    accountId: string,
    request: AuditPageRequest,
    signal?: AbortSignal,
  ): Promise<AuditPage> {
    const query = new URLSearchParams({
      since: rfc3339(request.since),
      before: rfc3339(request.before),
      direction: 'asc',
      limit: String(request.limit),
    });
    if (request.cursor) query.set('cursor', request.cursor);
    const { text, bytes } = await this.get(`/accounts/${accountId}/logs/audit`, query, token, signal);
    const page = auditPageSchema.safeParse(parseJson(text));
    if (!page.success) throw new CloudflareApiError('bad_response', 200);
    const cursor = page.data.result_info?.cursor;
    return { entries: page.data.result ?? [], cursor: cursor ? cursor : null, bytes };
  }

  /** Zonas da conta, para conferir as zonas cadastradas. */
  async zones(token: CloudflareToken, accountId: string, signal?: AbortSignal): Promise<AccountZones> {
    const names = new Set<string>();
    for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
      const query = new URLSearchParams({
        'account.id': accountId,
        per_page: String(ZONES_PER_PAGE),
        page: String(page),
      });
      const { text } = await this.get('/zones', query, token, signal);
      const body = zonesPageSchema.safeParse(parseJson(text));
      if (!body.success) throw new CloudflareApiError('bad_response', 200);
      const result = body.data.result ?? [];
      for (const item of result) {
        const zone = zoneSchema.safeParse(item);
        // Só a zona que o próprio Cloudflare diz ser desta conta; sem a conta na resposta, vale o filtro da consulta.
        if (zone.success && (zone.data.account?.id ?? accountId) === accountId) {
          names.add(zone.data.name.toLowerCase());
        }
      }
      const totalPages = body.data.result_info?.total_pages ?? undefined;
      const last = totalPages === undefined ? result.length < ZONES_PER_PAGE : page >= totalPages;
      if (last) return { names, complete: true };
    }
    return { names, complete: false };
  }

  /** GET com novas tentativas nas falhas passageiras. O sinal do agendador interrompe também a espera. */
  private async get(
    path: string,
    query: URLSearchParams,
    token: CloudflareToken,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; bytes: number }> {
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try {
        return await this.once(path, query, token, signal);
      } catch (error) {
        const delay = this.#retryDelaysMs[attempt];
        if (!(error instanceof CloudflareApiError) || !isRetryable(error) || delay === undefined) throw error;
        await sleep(delay, undefined, { signal });
      }
    }
  }

  private async once(
    path: string,
    query: URLSearchParams,
    token: CloudflareToken,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; bytes: number }> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}?${query.toString()}`, {
        headers: { authorization: `Bearer ${token.value()}`, accept: 'application/json' },
        redirect: 'error',
        signal: combined,
      });
    } catch {
      // Parada do worker ou estouro do orçamento: o cancelamento sobe como está.
      signal?.throwIfAborted();
      throw new CloudflareApiError(timeout.aborted ? 'timeout' : 'network');
    }
    const { status } = response;
    if (status === 200) {
      try {
        return await readBounded(response, this.#maxBodyBytes);
      } catch (error) {
        if (error instanceof CloudflareApiError) throw error;
        signal?.throwIfAborted();
        throw new CloudflareApiError(timeout.aborted ? 'timeout' : 'network', status);
      }
    }
    // O corpo de erro nunca é lido: pode repetir o token ou citar recursos da conta.
    await response.body?.cancel().catch(() => undefined);
    if (status === 401) throw new CloudflareApiError('credential_rejected', status);
    if (status === 403) throw new CloudflareApiError('credential_forbidden', status);
    if (status === 429) {
      throw new CloudflareApiError('rate_limited', status, retryAfterMs(response.headers.get('retry-after')));
    }
    if (status === 400) throw new CloudflareApiError('bad_request', status);
    throw new CloudflareApiError(`http_${status}`, status);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
