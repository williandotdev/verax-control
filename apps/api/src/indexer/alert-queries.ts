/**
 * Consultas aos alertas do Wazuh (T5.1), montadas só por estes construtores tipados. O query DSL é sempre estruturado:
 * valores vindos de fora entram como valores de `term`, `terms` e `range`, nunca como texto interpretado pelo indexer
 * (query_string, wildcard, regexp, script). Os campos de filtro são uma lista fechada, conferida também em execução.
 */

import { z } from 'zod';

/** Único padrão de índice que a API lê (o usuário do indexer só tem leitura nele, T4.8). */
export const ALERTS_INDEX = 'wazuh-alerts-*';

export const FILTER_FIELDS = [
  'id',
  'rule.id',
  'rule.level',
  'rule.groups',
  'data.integration',
  'data.aws.aws_account_id',
  'data.aws.source',
  'agent.id',
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export type FilterValue = string | number;

export type AlertFilter =
  | { field: FilterField; equals: FilterValue }
  | { field: FilterField; oneOf: readonly FilterValue[] }
  | { field: 'rule.level'; atLeast: number };

/** Posição na leitura incremental: o último alerta já processado. */
export interface AlertCursor {
  timestamp: string;
  id: string;
}

export interface AlertSearch {
  index: typeof ALERTS_INDEX;
  body: Record<string, unknown>;
}

export const MAX_PAGE_SIZE = 1000;
const MAX_TERMS = 100;
// Data e hora ISO 8601 com fuso (validador do zod, sem regex própria).
const isoTimestamp = z.iso.datetime({ offset: true });
const ALERT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// Texto livre não entra no indexer: valor de filtro é curto e sem caractere de controle.
const SAFE_TEXT = /^[^\p{Cc}]{1,256}$/u;

function timestamp(value: string, label: string): string {
  if (!isoTimestamp.safeParse(value).success) {
    throw new RangeError(`${label}: data fora do formato ISO 8601`);
  }
  return value;
}

function filterValue(value: FilterValue): FilterValue {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('valor numérico inválido');
    return value;
  }
  if (typeof value !== 'string' || !SAFE_TEXT.test(value)) {
    throw new RangeError('valor de filtro inválido');
  }
  return value;
}

function filterClause(filter: AlertFilter): Record<string, unknown> {
  if (!(FILTER_FIELDS as readonly string[]).includes(filter.field)) {
    throw new RangeError('campo de filtro não permitido');
  }
  if ('atLeast' in filter) {
    if (filter.field !== 'rule.level' || !Number.isInteger(filter.atLeast)) {
      throw new RangeError('"atLeast" só vale para rule.level, com número inteiro');
    }
    return { range: { 'rule.level': { gte: filter.atLeast } } };
  }
  if ('oneOf' in filter) {
    if (filter.oneOf.length === 0 || filter.oneOf.length > MAX_TERMS) {
      throw new RangeError(`"oneOf" precisa de 1 a ${MAX_TERMS} valores`);
    }
    return { terms: { [filter.field]: filter.oneOf.map(filterValue) } };
  }
  return { term: { [filter.field]: filterValue(filter.equals) } };
}

/**
 * Alertas em ordem de chegada, a partir do cursor (exclusivo) ou da data `since`. Ordena por timestamp e, no empate,
 * pelo id do alerta, para a paginação não pular nem repetir alertas.
 */
export function alertsAfter(options: {
  cursor: AlertCursor | null;
  since?: string;
  size?: number;
  filters?: readonly AlertFilter[];
}): AlertSearch {
  const size = options.size ?? 500;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new RangeError(`size precisa ser um inteiro de 1 a ${MAX_PAGE_SIZE}`);
  }
  const filter: Record<string, unknown>[] = [];
  if (options.since !== undefined) {
    filter.push({ range: { timestamp: { gte: timestamp(options.since, 'since') } } });
  }
  for (const item of options.filters ?? []) {
    filter.push(filterClause(item));
  }

  const body: Record<string, unknown> = {
    size,
    track_total_hits: false,
    sort: [{ timestamp: 'asc' }, { id: 'asc' }],
    query: { bool: { filter } },
  };
  if (options.cursor !== null) {
    if (!ALERT_ID.test(options.cursor.id)) {
      throw new RangeError('cursor: id de alerta inválido');
    }
    body['search_after'] = [timestamp(options.cursor.timestamp, 'cursor'), options.cursor.id];
  }
  return { index: ALERTS_INDEX, body };
}

/** Um alerta pelo id do Wazuh (os índices são diários, então a busca é por campo, não por documento). */
export function alertById(id: string): AlertSearch {
  if (!ALERT_ID.test(id)) {
    throw new RangeError('id de alerta inválido');
  }
  return {
    index: ALERTS_INDEX,
    body: { size: 1, track_total_hits: false, query: { bool: { filter: [{ term: { id } }] } } },
  };
}

/** Construções que interpretam texto ou executam código no indexer. Nenhuma consulta da API usa. */
const FORBIDDEN_KEYS = new Set([
  'query_string',
  'simple_query_string',
  'intervals',
  'wildcard',
  'regexp',
  'fuzzy',
  'prefix',
  'script',
  'script_score',
  'scripted_metric',
  'runtime_mappings',
  'stored_fields',
]);

/** Defesa extra no cliente: recusa uma consulta montada fora destes construtores com algo interpretável. */
export function assertStructuredQuery(value: unknown, path = 'body'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertStructuredQuery(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new RangeError(`consulta recusada: "${key}" em ${path}`);
      }
      assertStructuredQuery(child, `${path}.${key}`);
    }
  }
}
