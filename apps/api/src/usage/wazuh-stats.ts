import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { registerLiveSecret } from '../common/logger/sanitize.js';

/**
 * Leitura dos contadores do analysisd pela API do manager do Wazuh do nó (fase 2, PR-V6), para a tarefa `wazuh-usage`.
 *
 * - Usuário `verax_stats`, que só tem `manager:read` (criado e mantido pelo `infra/wazuh/scripts/init-api-users.sh`).
 * - TLS conferido com a CA do nó (o volume público dos certificados, a mesma do indexer) e o nome do serviço
 *   (`wazuh.manager`, o do certificado que o `manager-api-tls.sh` põe na API). Nunca sem conferir.
 * - Duas chamadas por leitura: `POST /security/user/authenticate?raw=true` (o token vale 15 min; a leitura é a cada 5) e
 *   `GET /manager/daemons/stats?daemons_list=wazuh-analysisd`. Nenhum corpo é enviado.
 * - A resposta é entrada de fora: tamanho limitado, JSON conferido com zod e só os campos usados saem daqui. Os erros
 *   dizem só o tipo (nunca a resposta, a senha ou o token).
 */

/** O usuário da API do manager para o worker; o mesmo nome no init-api-users.sh (o teste de contrato confere). */
export const WAZUH_STATS_ACCOUNT = 'verax_stats';
export const ANALYSISD_STATS_PATH = '/manager/daemons/stats?daemons_list=wazuh-analysisd';
const AUTHENTICATE_PATH = '/security/user/authenticate?raw=true';
/** A resposta dos contadores tem uns 5 KB; um token, menos de 2 KB. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/** Os contadores que a tarefa usa, desde a partida do analysisd. */
export interface AnalysisdCounters {
  /** Partida do analysisd (`uptime`): outra partida quer dizer contadores zerados. */
  startedAt: Date;
  /** Bytes recebidos pelo analysisd (`metrics.bytes.received`): tudo o que ele leu. */
  bytesReceived: number;
  /** Eventos do módulo da AWS decodificados (`…modules_breakdown.aws`). */
  awsEvents: number;
}

/** De onde a tarefa lê os contadores (a API do manager; um dublê nos testes). */
export interface AnalysisdStatsSource {
  read(signal: AbortSignal): Promise<AnalysisdCounters>;
}

/** O tipo do problema, a única coisa que vai para o log e para o relatório da tarefa. */
export type WazuhApiErrorKind = 'auth' | 'status' | 'format' | 'timeout' | 'connection' | 'ca';

export class WazuhApiError extends Error {
  constructor(readonly kind: WazuhApiErrorKind) {
    super(`API do manager do Wazuh: ${kind}`);
    this.name = 'WazuhApiError';
  }
}

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * O que a tarefa lê da resposta de `GET /manager/daemons/stats?daemons_list=wazuh-analysisd` (Wazuh 4.14; o contrato é
 * conferido contra o manager de verdade no `infra/wazuh/scripts/test-api-users.sh`). Os campos que não usamos podem
 * mudar entre versões e ficam de fora da conferência; os que usamos têm de estar lá, no formato.
 */
export const analysisdStatsSchema = z.object({
  error: z.literal(0),
  data: z.object({
    affected_items: z
      .array(
        z.object({
          name: z.literal('wazuh-analysisd'),
          uptime: z.iso.datetime({ offset: true }),
          metrics: z.object({
            bytes: z.object({ received: counter }),
            events: z.object({
              received_breakdown: z.object({
                decoded_breakdown: z.object({ modules_breakdown: z.object({ aws: counter }) }),
              }),
            }),
          }),
        }),
      )
      .length(1),
  }),
});

/** Os contadores de uma resposta da API, conferida com o schema; fora dele, `WazuhApiError('format')`. */
export function parseAnalysisdStats(json: unknown): AnalysisdCounters {
  const parsed = analysisdStatsSchema.safeParse(json);
  if (!parsed.success) throw new WazuhApiError('format');
  const [item] = parsed.data.data.affected_items;
  if (item === undefined) throw new WazuhApiError('format');
  return {
    startedAt: new Date(item.uptime),
    bytesReceived: item.metrics.bytes.received,
    awsEvents: item.metrics.events.received_breakdown.decoded_breakdown.modules_breakdown.aws,
  };
}

/** O token que a API devolve com `raw=true`: um JWT, sem nada que caiba num cabeçalho além dele. */
const tokenSchema = z
  .string()
  .max(8192)
  .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/);

interface Response {
  status: number;
  body: string;
}

export interface WazuhStatsClientOptions {
  /** A URL base da API do manager (https). */
  url: string;
  /** O arquivo da CA do nó (PEM). Lido a cada leitura: uma CA trocada vale sem reiniciar o worker. */
  caFile: string;
  password: string;
  timeoutMs?: number;
}

/** A API do manager com o usuário `verax_stats` e o TLS conferido com a CA do nó. */
export class WazuhStatsClient implements AnalysisdStatsSource {
  private readonly base: URL;
  private readonly authorization: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: WazuhStatsClientOptions) {
    this.base = new URL(options.url);
    if (this.base.protocol !== 'https:') throw new Error('a API do manager só por https');
    this.authorization = `Basic ${Buffer.from(`${WAZUH_STATS_ACCOUNT}:${options.password}`).toString('base64')}`;
    registerLiveSecret(options.password);
    registerLiveSecret(this.authorization);
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async read(signal: AbortSignal): Promise<AnalysisdCounters> {
    const ca = await this.certificateAuthority();
    const login = await this.call('POST', AUTHENTICATE_PATH, this.authorization, ca, signal);
    if (login.status === 401) throw new WazuhApiError('auth');
    if (login.status !== 200) throw new WazuhApiError('status');
    // O token é um JWT, que o logger já oculta pelo formato (e ele nunca vai para log nem erro).
    const token = tokenSchema.safeParse(login.body.trim());
    if (!token.success) throw new WazuhApiError('format');
    const stats = await this.call('GET', ANALYSISD_STATS_PATH, `Bearer ${token.data}`, ca, signal);
    if (stats.status === 401 || stats.status === 403) throw new WazuhApiError('auth');
    if (stats.status !== 200) throw new WazuhApiError('status');
    let json: unknown;
    try {
      json = JSON.parse(stats.body);
    } catch {
      throw new WazuhApiError('format');
    }
    return parseAnalysisdStats(json);
  }

  private async certificateAuthority(): Promise<Buffer> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho da configuração do nó, não do request
      return await readFile(this.options.caFile);
    } catch {
      throw new WazuhApiError('ca');
    }
  }

  /** Uma chamada sem corpo, com o TLS conferido, prazo e teto de resposta. */
  private call(
    method: 'GET' | 'POST',
    path: string,
    authorization: string,
    ca: Buffer,
    signal: AbortSignal,
  ): Promise<Response> {
    const target = new URL(path, this.base);
    return new Promise<Response>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const req = httpsRequest(
        target,
        {
          method,
          headers: { authorization, accept: 'application/json' },
          ca,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          timeout: this.timeoutMs,
          signal,
        },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new WazuhApiError('format'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', (error) => reject(errorOf(error, signal)));
        },
      );
      req.on('timeout', () => req.destroy(new WazuhApiError('timeout')));
      req.on('error', (error) => reject(errorOf(error, signal)));
      req.end();
    });
  }
}

/** O erro da chamada sem nada da requisição: o cancelamento do worker passa como está; o resto vira o tipo. */
function errorOf(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted && signal.reason instanceof Error) return signal.reason;
  if (error instanceof WazuhApiError) return error;
  return new WazuhApiError('connection');
}
