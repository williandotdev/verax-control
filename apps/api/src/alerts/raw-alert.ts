/**
 * Evento bruto do alerta para o detalhe do achado (T5.4), relido do indexer e saneado antes de sair da API.
 *
 * - `full_log` e `previous_output` saem: o primeiro repete o evento, e o segundo traz eventos anteriores de uma
 *   correlação, que podiam ser de outra conta antes da correção das regras (T4.4 a T4.6).
 * - Cabeçalhos HTTP de credencial (WAF) têm o valor trocado: o conector já omite os principais no log, mas uma Web
 *   ACL configurada fora dele pode mandá-los.
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
const MAX_DEPTH = 24;
const REDACTED = '[removido]';
const TRUNCATED = '[truncado]';

function sanitize(value: unknown, depth: number, inHeaders: boolean): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1, false));
  if (value === null || typeof value !== 'object') return value;
  // Object.fromEntries cria propriedades próprias: nenhuma chave vinda do documento altera o protótipo.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DROPPED_KEYS.has(key))
      .map(([key, child]) => [
        key,
        inHeaders && CREDENTIAL_HEADERS.has(key.toLowerCase())
          ? REDACTED
          : sanitize(child, depth + 1, key === 'headers'),
      ]),
  );
}

export function sanitizeRawAlert(document: unknown): unknown {
  return sanitize(document, 0, false);
}
