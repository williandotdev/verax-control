import { maskEmbeddedUrls, maskQuery, maskUrl, REDACTED, sensitiveName, TRUNCATED } from './raw-url-mask.js';

/**
 * Evento bruto do alerta para o detalhe do achado (T5.4), relido do indexer e saneado antes de sair da API.
 *
 * - `full_log` e `previous_output` saem: o primeiro repete o evento, e o segundo traz eventos anteriores de uma
 *   correlação, que podiam ser de outra conta antes da correção das regras (T4.4 a T4.6).
 * - Cabeçalhos HTTP de credencial (WAF) têm o valor trocado: o conector já omite os principais no log, mas uma Web
 *   ACL configurada fora dele pode mandá-los. Vale para o objeto `{ nome: valor }` (o WAF lido do bucket) e para a lista
 *   `[{ name, value }]` (o WAF lido do CloudWatch Logs), e para os nomes de segredo ou de dado pessoal (`x-auth-token`).
 * - A URL e a query (`httpRequest.uri` e `args`, `Referer`, `Location` e o que mais carrega uma URL com query) saem com
 *   os segredos e os dados pessoais mascarados, e o resto, inclusive o ataque, legível (`raw-url-mask.ts`, com os
 *   limites).
 * - Chaves que mexem em protótipo são descartadas, e a profundidade é limitada.
 */

const DROPPED_KEYS = new Set(['full_log', 'previous_output', '__proto__', 'constructor', 'prototype']);
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-amz-security-token',
]);
/** O que vem antes de `-code` num código que não é segredo (`x-country-code`, `status-code`). */
const HARMLESS_CODES = new Set([
  'country',
  'currency',
  'error',
  'lang',
  'language',
  'locale',
  'region',
  'response',
  'status',
]);

/**
 * Cabeçalhos em que o nome engana: o código que não é segredo, só os da lista (`x-auth-code` e `authorization-code` são), e
 * as dicas do navegador (`sec-ch-ua-mobile`).
 */
function isHarmlessHeader(name: string): boolean {
  if (name.startsWith('sec-ch-')) return true;
  const parts = name.split(/[-_]/);
  if (parts.length < 2 || parts.at(-1) !== 'code' || !HARMLESS_CODES.has(parts.at(-2) ?? '')) return false;
  return sensitiveName(parts.slice(0, -2).join('-')) === null;
}

/** Os mesmos, quando o log os traz como campo solto (o CloudFront, um log de acesso): o texto sai inteiro. */
const CREDENTIAL_FIELDS = new Set([
  'authorization',
  'cookie',
  'cookies',
  'cs(cookie)',
  'cs_cookie',
  'http_cookie',
  'set-cookie',
  'set_cookie',
]);
/** Os objetos e listas de cabeçalhos. */
const HEADER_KEYS = new Set([
  'headers',
  'requestheaders',
  'request_headers',
  'responseheaders',
  'response_headers',
  'multivalueheaders',
  'requestheadersinserted',
  'responseheaderssent',
]);
/** Campos (e cabeçalhos) que são uma URL, um caminho ou uma linha de requisição. */
const URL_KEYS = new Set([
  'callback',
  'cs(referer)',
  'cs_referer',
  'cs_uri_stem',
  'cs-uri-stem',
  'http_referer',
  'http_referrer',
  'location',
  'matcheddata',
  'redirect',
  'redirect_uri',
  'redirect_url',
  'redirecturi',
  'referer',
  'referrer',
  'request',
  'request_uri',
  'request_url',
  'requesturi',
  'requesturl',
  'uri',
  'url',
  'x-forwarded-uri',
  'x-forwarded-url',
  'x-original-uri',
  'x-original-url',
  'x-rewrite-url',
]);
/** Campos que são só a query, como texto ou como objeto `{ parâmetro: valor }`. */
const QUERY_KEYS = new Set([
  'args',
  'cs_uri_query',
  'cs-uri-query',
  'fragment',
  'multivaluequerystringparameters',
  'query_string',
  'queryparams',
  'querystring',
  'querystringparameters',
  'uri_query',
]);
const MAX_DEPTH = 24;

/** O que o valor é, pelo campo em que está: decide o que sai mascarado. */
type Context = 'plain' | 'headers' | 'url' | 'query';

function contextOf(key: string): Context {
  const name = key.toLowerCase();
  if (HEADER_KEYS.has(name)) return 'headers';
  if (QUERY_KEYS.has(name)) return 'query';
  return URL_KEYS.has(name) ? 'url' : 'plain';
}

function sanitizeText(value: string, context: Context): string {
  if (context === 'query') return maskQuery(value);
  return context === 'url' ? maskUrl(value) : maskEmbeddedUrls(value);
}

/** O cabeçalho carrega credencial ou dado pessoal: o valor inteiro sai. */
function isSensitiveHeader(header: string): boolean {
  const name = header.toLowerCase();
  return CREDENTIAL_HEADERS.has(name) || (sensitiveName(name) !== null && !isHarmlessHeader(name));
}

/** Um filho de um objeto, pelo contexto do pai e pela chave. */
function sanitizeChild(key: string, child: unknown, depth: number, parent: Context): unknown {
  if (parent === 'headers' && isSensitiveHeader(key)) return REDACTED;
  if (typeof child === 'string' && CREDENTIAL_FIELDS.has(key.toLowerCase())) return REDACTED;
  // Na query já separada, o nome do parâmetro é a chave.
  if (parent === 'query' && sensitiveName(key) !== null) return REDACTED;
  return sanitize(child, depth + 1, parent === 'query' ? 'query' : contextOf(key));
}

/** Um item de lista de cabeçalhos (`{ name, value }`): o nome vem num campo, e o valor no outro. */
function sanitizeHeaderItem(item: object, depth: number): unknown {
  const name = Object.entries(item).find(
    ([key, value]) => key.toLowerCase() === 'name' && typeof value === 'string',
  );
  if (name === undefined) return sanitize(item, depth, 'headers');
  const header = name[1] as string;
  return Object.fromEntries(
    Object.entries(item)
      .filter(([key]) => !DROPPED_KEYS.has(key))
      .map(([key, value]) => [
        key,
        key.toLowerCase() === 'name' ? value : sanitizeChild(header, value, depth, 'headers'),
      ]),
  );
}

function sanitize(value: unknown, depth: number, context: Context): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (typeof value === 'string') return sanitizeText(value, context);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item: unknown) =>
      context === 'headers' && typeof item === 'object' && item !== null && !Array.isArray(item)
        ? sanitizeHeaderItem(item, depth + 1)
        : sanitize(item, depth + 1, context),
    );
  }
  // Object.fromEntries cria propriedades próprias: nenhuma chave vinda do documento altera o protótipo.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DROPPED_KEYS.has(key))
      .map(([key, child]: [string, unknown]) => [key, sanitizeChild(key, child, depth, context)]),
  );
}

export function sanitizeRawAlert(document: unknown): unknown {
  return sanitize(document, 0, 'plain');
}
