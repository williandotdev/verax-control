import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { type DestinationStream, type LoggerOptions, stdSerializers, stdTimeFunctions } from 'pino';
import type { Options } from 'pino-http';
import type { AppConfig } from '../config/config.module.js';
import { REDACTED, isSensitiveKey, sanitize, scrubString } from './sanitize.js';

/** Aceito vindo do proxy só neste formato; qualquer outra coisa é trocada por um UUID novo. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
export const REQUEST_ID_HEADER = 'x-request-id';

/** Health check do Cloud Run e do workflow de implantação: não gera log por requisição. */
const QUIET_PATHS = new Set(['/health']);

/**
 * Severidade reconhecida pelo Cloud Logging (campo `severity`), a partir do nível do pino. Sem ela, toda linha
 * apareceria como "Default" no console e os alertas por nível não funcionariam.
 */
const SEVERITY: Readonly<Record<string, string>> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

function pathOnly(url: string | undefined): string | undefined {
  // A query string fica fora do log: pode carregar o id da sessão do Checkout ou um token de uso único.
  return url?.split('?', 1)[0];
}

interface SerializedRequestLike {
  id?: unknown;
  method?: unknown;
  url?: unknown;
  remoteAddress?: unknown;
  /** O IncomingMessage original (o pino-http o anexa), já com o `req.ip` do Express. */
  raw?: { ip?: unknown };
}

/**
 * Só o necessário para investigar: nunca headers, corpo ou query string. `remoteAddress` é o socket (no Cloud Run,
 * o front end interno); `ip` é o IP do cliente pela regra de `common/http/client-ip.ts`, o mesmo dos limites por
 * IP. É por ele que o responsável descobre as saídas do Hosting a listar em TRUSTED_PROXIES.
 */
function serializeRequest(req: SerializedRequestLike): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    url: typeof req.url === 'string' ? pathOnly(req.url) : undefined,
    remoteAddress: req.remoteAddress,
    ip: typeof req.raw?.ip === 'string' ? req.raw.ip : undefined,
  };
}

function serializeResponse(res: { statusCode?: unknown }): Record<string, unknown> {
  return { statusCode: res.statusCode };
}

function serializeError(err: unknown): unknown {
  // Com pino-http o erro já chega serializado; com o pino direto chega o Error original.
  return sanitize(err instanceof Error ? stdSerializers.err(err) : err);
}

/** Chaves com serializer próprio: chegam crus (IncomingMessage, ServerResponse, Error) e saem já limpas. */
const SERIALIZED_KEYS = new Set(['req', 'res', 'err']);

function sanitizeLogObject(object: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (SERIALIZED_KEYS.has(key)) result[key] = value;
    else result[key] = isSensitiveKey(key) ? REDACTED : sanitize(value);
  }
  return result;
}

function isValidRequestId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  // Classe de caracteres única, ancorada e com tamanho limitado: tempo linear, sem backtracking.
  return REQUEST_ID_PATTERN.test(value); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
}

function genReqId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = isValidRequestId(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/** Opções do pino compartilhadas entre o serviço, o worker e os testes. */
export function buildPinoOptions(config: Pick<AppConfig, 'LOG_LEVEL'>): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    // Campos no formato que o Cloud Logging entende: `message`, `severity` e `time` em ISO 8601.
    messageKey: 'message',
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      level: (label, number) => ({ level: number, severity: SEVERITY[label] ?? 'DEFAULT' }),
      // Camada 1: o objeto de cada linha passa pela limpeza por chave e por valor.
      log: sanitizeLogObject,
    },
    // Camada 2: a mensagem de texto também passa pela limpeza por valor.
    hooks: {
      logMethod(args, method) {
        const cleaned = args.map((arg) => (typeof arg === 'string' ? scrubString(arg) : arg));
        method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
    serializers: {
      req: serializeRequest,
      res: serializeResponse,
      err: serializeError,
    },
    // Camada 3: caminhos conhecidos, caso algum serializer seja alterado no futuro.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["stripe-signature"]',
        'res.headers["set-cookie"]',
      ],
      censor: REDACTED,
    },
  };
}

export interface LoggerParamsOptions {
  /** Destino alternativo (testes capturam as linhas por aqui). */
  destination?: DestinationStream;
}

export function buildLoggerParams(config: AppConfig, options: LoggerParamsOptions = {}): Params {
  const pinoHttp: Options = {
    ...buildPinoOptions(config),
    genReqId,
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: {
      ignore: (req) => QUIET_PATHS.has(pathOnly(req.url) ?? ''),
    },
    // Em desenvolvimento, saída legível no terminal; em qualquer outro ambiente, JSON puro.
    ...(config.NODE_ENV === 'development' && !options.destination
      ? { transport: { target: 'pino-pretty', options: { singleLine: true, messageKey: 'message' } } }
      : {}),
  };

  return { pinoHttp: options.destination ? [pinoHttp, options.destination] : pinoHttp };
}
