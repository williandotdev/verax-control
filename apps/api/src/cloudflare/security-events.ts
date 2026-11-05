import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type GraphqlRequest, isHex32 } from './cloudflare.client.js';

/**
 * Eventos de segurança das zonas do Cloudflare pela API GraphQL de analytics (fase 2, PR-13): as janelas, as consultas,
 * a validação das respostas, o orçamento de consultas por token e a chave estável de cada achado.
 *
 * - **Conjunto de dados:** `firewallEventsAdaptiveGroups`, agregado por `clientIP`, `action`, `source` e
 *   `clientRequestHTTPHost`, em ordem decrescente de `count`. Os eventos são amostrados pelo Cloudflare (amostragem
 *   adaptativa): as contagens são estimativas, e os limites das regras são aproximados.
 * - **Limites por zona:** o nó `settings` de cada zona (`enabled`, `maxDuration`, `maxPageSize`, `notOlderThan`) diz se
 *   o plano dá acesso ao conjunto de dados, a maior janela por consulta, o maior número de linhas e até onde se pode
 *   voltar. Documentação: https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/.
 * - **Janelas:** de 15 min, alinhadas em UTC, lidas só 5 min depois de fechar; no máximo 24 h por execução.
 * - **Consultas:** até 10 zonas por consulta (`zoneTag_in`); cada zona multiplicada por cada nó conta como uma consulta
 *   no limite do Cloudflare (300 a cada 5 min por usuário ou token). O coletor se limita a 250 (`QueryBudget`).
 *
 * As consultas são texto fixo; os valores vão nas variáveis, com os tipos dos exemplos da documentação (`string` e
 * `Time`), declarados não nulos para valer em qualquer posição. Só o `limit` entra como literal inteiro, já conferido,
 * porque o tipo do argumento não está documentado.
 */

/** Janela de leitura: 15 min alinhados em UTC (00, 15, 30, 45). */
export const SECURITY_WINDOW_MS = 15 * 60 * 1000;
/** A janela só é lida 5 min depois de fechar: os eventos chegam ao conjunto de dados com atraso. */
export const SECURITY_SETTLE_MS = 5 * 60 * 1000;
/** No máximo 24 h de janelas atrasadas recuperadas por execução (96 janelas). */
export const SECURITY_MAX_CATCH_UP_MS = 24 * 60 * 60 * 1000;
/** A primeira leitura de uma conta pega as últimas 24 h. */
export const SECURITY_FIRST_READ_MS = 24 * 60 * 60 * 1000;
/** Base da regra de pico (990334): as 24 h antes da janela. */
export const SECURITY_BASELINE_MS = 24 * 60 * 60 * 1000;
/** Base menor que 1 h não serve para comparar: a regra de pico não é avaliada. */
export const SECURITY_MIN_BASELINE_MS = 60 * 60 * 1000;
/** Folga sobre a retenção da zona (`notOlderThan`): uma janela no limite pode vencer entre o cálculo e a consulta. */
export const SECURITY_RETENTION_MARGIN_MS = 15 * 60 * 1000;
/** Zonas por consulta: o máximo do Cloudflare. */
export const SECURITY_ZONES_PER_QUERY = 10;
/** Linhas por zona em cada consulta (o `maxPageSize` da zona, quando menor, vale no lugar). */
export const SECURITY_MAX_GROUPS = 1000;
/** Zonas lidas por conta (o limite do cadastro; com a lista vazia, as primeiras 50 da conta, pelo nome). */
export const SECURITY_MAX_ZONES = 50;

/** Orçamento de consultas GraphQL de cada token: 250 a cada 5 min (o Cloudflare permite 300). */
export const GRAPHQL_BUDGET_UNITS = 250;
export const GRAPHQL_BUDGET_PERIOD_MS = 5 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

// --- Janelas ---

/** Início da janela de 15 min que contém `at`. */
export function windowStartOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / SECURITY_WINDOW_MS) * SECURITY_WINDOW_MS);
}

/** O primeiro limite de janela em `at` ou depois dele. */
export function windowCeil(at: Date): Date {
  return new Date(Math.ceil(at.getTime() / SECURITY_WINDOW_MS) * SECURITY_WINDOW_MS);
}

/** Fim da janela mais recente que já pode ser lida: fechada há pelo menos 5 min. */
export function lastReadableWindowEnd(now: Date): Date {
  return windowStartOf(new Date(now.getTime() - SECURITY_SETTLE_MS));
}

/** Quando a janela seguinte a `windowEnd` passa a poder ser lida. */
export function nextReadableAt(windowEnd: Date): Date {
  return new Date(windowEnd.getTime() + SECURITY_WINDOW_MS + SECURITY_SETTLE_MS);
}

/** RFC 3339 em segundos (o formato `Time` do GraphQL). */
export function graphqlTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

// --- Limites de cada zona (`settings`) ---

export interface ZoneLimits {
  /** O plano dá acesso ao conjunto de dados. */
  enabled: boolean;
  /** Maior intervalo de uma consulta, em segundos. */
  maxDuration: number;
  /** Mais linhas numa consulta. */
  maxPageSize: number;
  /** Até onde se pode voltar, em segundos. */
  notOlderThan: number;
}

const zoneTagSchema = z.string().refine(isHex32);
const seconds = z
  .number()
  .int()
  .min(0)
  .max(10 * 365 * 24 * 60 * 60);

const limitsSchema = z.object({
  enabled: z.boolean(),
  maxDuration: seconds,
  maxPageSize: z.number().int().min(0).max(1_000_000),
  notOlderThan: seconds,
});

const settingsResponseSchema = z.object({
  viewer: z.object({
    zones: z
      .array(
        z.object({
          zoneTag: zoneTagSchema,
          settings: z.object({ firewallEventsAdaptiveGroups: limitsSchema.nullish() }).nullish(),
        }),
      )
      .max(SECURITY_ZONES_PER_QUERY),
  }),
});

const SETTINGS_QUERY = `query VeraxSecuritySettings($zoneTags: [string!]!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      settings {
        firewallEventsAdaptiveGroups {
          enabled
          maxDuration
          maxPageSize
          notOlderThan
        }
      }
    }
  }
}`;

export function settingsRequest(zoneTags: readonly string[]): GraphqlRequest {
  assertZoneTags(zoneTags);
  return { query: SETTINGS_QUERY, variables: { zoneTags: [...zoneTags] } };
}

/**
 * Os limites de cada zona pedida. Zona que não voltou (o token não a lê) fica de fora do mapa; zona sem o nó
 * (`null`) vale como sem acesso ao conjunto de dados. Uma zona que não foi pedida torna a resposta inválida.
 */
export function parseSettings(data: unknown, zoneTags: readonly string[]): Map<string, ZoneLimits> | null {
  const parsed = settingsResponseSchema.safeParse(data);
  if (!parsed.success) return null;
  const asked = new Set(zoneTags);
  const limits = new Map<string, ZoneLimits>();
  for (const zone of parsed.data.viewer.zones) {
    if (!asked.has(zone.zoneTag) || limits.has(zone.zoneTag)) return null;
    limits.set(
      zone.zoneTag,
      zone.settings?.firewallEventsAdaptiveGroups ?? {
        enabled: false,
        maxDuration: 0,
        maxPageSize: 0,
        notOlderThan: 0,
      },
    );
  }
  return limits;
}

/** A zona dá para ler janelas de 15 min com o mínimo de retenção (a janela mais recente fechada e a folga). */
export function usableLimits(limits: ZoneLimits): boolean {
  return (
    limits.enabled &&
    limits.maxPageSize >= 1 &&
    limits.maxDuration * 1000 >= SECURITY_WINDOW_MS &&
    limits.notOlderThan * 1000 >= SECURITY_WINDOW_MS + SECURITY_SETTLE_MS + SECURITY_RETENTION_MARGIN_MS
  );
}

/** O começo mais antigo que a zona ainda guarda, com a folga. */
export function retentionFloor(limits: ZoneLimits, now: Date): Date {
  return new Date(now.getTime() - limits.notOlderThan * 1000 + SECURITY_RETENTION_MARGIN_MS);
}

// --- Eventos de uma janela ---

const dimensionText = (max: number) => z.string().transform((value) => value.slice(0, max));

const groupSchema = z.object({
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  dimensions: z.object({
    action: dimensionText(64),
    source: dimensionText(64),
    clientIP: dimensionText(64),
    clientRequestHTTPHost: dimensionText(253)
      .nullish()
      .transform((value) => value ?? null),
  }),
});

const pathGroupSchema = z.object({
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  dimensions: z.object({
    clientIP: dimensionText(64),
    source: dimensionText(64),
    clientRequestPath: dimensionText(2048)
      .nullish()
      .transform((value) => value ?? null),
  }),
});

const countSchema = z.object({ count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

/** Uma linha agregada: quantos eventos daquele IP, com aquela ação e origem, naquele host, na janela. */
export type SecurityGroup = {
  action: string;
  source: string;
  clientIP: string;
  host: string | null;
  count: number;
};

export interface ZoneEvents {
  zoneTag: string;
  groups: SecurityGroup[];
  /** A zona bateu no limite de linhas: os grupos com menos eventos ficaram de fora (contagens são piso). */
  truncated: boolean;
  /** Total de eventos da zona na base de 24 h antes da janela; `null` sem a base. */
  baselineCount: number | null;
}

const eventsZoneSchema = (limit: number, baseline: boolean) =>
  z.object({
    zoneTag: zoneTagSchema,
    events: z.array(groupSchema).max(limit),
    ...(baseline && { baseline: z.array(countSchema).max(1) }),
  });

/** O `limit` do nó: inteiro conferido, de 1 ao teto. */
function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SECURITY_MAX_GROUPS) {
    throw new RangeError(`limite de linhas por zona fora de 1 a ${SECURITY_MAX_GROUPS}`);
  }
  return limit;
}

function assertZoneTags(zoneTags: readonly string[]): void {
  if (zoneTags.length === 0 || zoneTags.length > SECURITY_ZONES_PER_QUERY || !zoneTags.every(isHex32)) {
    throw new RangeError(`de 1 a ${SECURITY_ZONES_PER_QUERY} zonas, cada uma com 32 hexadecimais`);
  }
}

export interface EventsQuery {
  zoneTags: readonly string[];
  since: Date;
  until: Date;
  /** Linhas por zona. */
  limit: number;
  /** Início da base de comparação (a regra de pico); sem ele, a consulta não traz a base. */
  baselineSince: Date | null;
}

/** Quantos nós a consulta tem: cada zona conta uma vez por nó no limite do Cloudflare. */
export function eventsQueryNodes(query: Pick<EventsQuery, 'baselineSince'>): number {
  return query.baselineSince === null ? 1 : 2;
}

export function eventsRequest(query: EventsQuery): GraphqlRequest {
  assertZoneTags(query.zoneTags);
  const limit = checkedLimit(query.limit);
  const baseline = query.baselineSince !== null;
  const text = `query VeraxSecurityEvents($zoneTags: [string!]!, $since: Time!, $until: Time!${
    baseline ? ', $baselineSince: Time!' : ''
  }) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      events: firewallEventsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_lt: $until }
        limit: ${limit}
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          action
          source
          clientIP
          clientRequestHTTPHost
        }
      }${
        baseline
          ? `
      baseline: firewallEventsAdaptiveGroups(
        filter: { datetime_geq: $baselineSince, datetime_lt: $since }
        limit: 1
      ) {
        count
      }`
          : ''
      }
    }
  }
}`;
  return {
    query: text,
    variables: {
      zoneTags: [...query.zoneTags],
      since: graphqlTime(query.since),
      until: graphqlTime(query.until),
      ...(query.baselineSince !== null && { baselineSince: graphqlTime(query.baselineSince) }),
    },
  };
}

/** Os eventos de cada zona; `null` quando a resposta não é a da consulta (formato, zona não pedida ou repetida). */
export function parseEvents(data: unknown, query: EventsQuery): ZoneEvents[] | null {
  const baseline = query.baselineSince !== null;
  const schema = z.object({
    viewer: z.object({
      zones: z.array(eventsZoneSchema(query.limit, baseline)).max(SECURITY_ZONES_PER_QUERY),
    }),
  });
  const parsed = schema.safeParse(data);
  if (!parsed.success) return null;
  const asked = new Set(query.zoneTags);
  const seen = new Set<string>();
  const zones: ZoneEvents[] = [];
  for (const zone of parsed.data.viewer.zones) {
    if (!asked.has(zone.zoneTag) || seen.has(zone.zoneTag)) return null;
    seen.add(zone.zoneTag);
    const baselineRows = (zone as { baseline?: { count: number }[] }).baseline;
    zones.push({
      zoneTag: zone.zoneTag,
      groups: zone.events.map(({ count, dimensions }) => ({
        action: dimensions.action,
        source: dimensions.source,
        clientIP: dimensions.clientIP,
        host: dimensions.clientRequestHTTPHost,
        count,
      })),
      truncated: zone.events.length >= query.limit,
      baselineCount: baselineRows === undefined ? null : (baselineRows[0]?.count ?? 0),
    });
  }
  return zones;
}

// --- Rotas do limite de taxa (regra 990332) ---

export interface PathsQuery {
  zoneTags: readonly string[];
  since: Date;
  until: Date;
  /** IPs que dispararam o limite de taxa na janela. */
  clientIPs: readonly string[];
  limit: number;
}

/** Os IPs da consulta das rotas: até 100, para a consulta continuar pequena. */
export const SECURITY_MAX_PATH_IPS = 100;

/**
 * A consulta das rotas: só quando a janela teve limite de taxa disparado, para saber se foi contra uma rota de login.
 * Os IPs vão no filtro (`clientIP_in`), e a origem é conferida aqui, sem depender do nome exato do valor no esquema.
 */
export function pathsRequest(query: PathsQuery): GraphqlRequest {
  assertZoneTags(query.zoneTags);
  const limit = checkedLimit(query.limit);
  if (query.clientIPs.length === 0 || query.clientIPs.length > SECURITY_MAX_PATH_IPS) {
    throw new RangeError(`de 1 a ${SECURITY_MAX_PATH_IPS} IPs na consulta das rotas`);
  }
  return {
    query: `query VeraxRateLimitPaths($zoneTags: [string!]!, $since: Time!, $until: Time!, $clientIPs: [string!]!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      paths: firewallEventsAdaptiveGroups(
        filter: { datetime_geq: $since, datetime_lt: $until, clientIP_in: $clientIPs }
        limit: ${limit}
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          clientIP
          source
          clientRequestPath
        }
      }
    }
  }
}`,
    variables: {
      zoneTags: [...query.zoneTags],
      since: graphqlTime(query.since),
      until: graphqlTime(query.until),
      clientIPs: [...query.clientIPs],
    },
  };
}

export type PathGroup = { clientIP: string; source: string; path: string | null; count: number };

export function parsePaths(data: unknown, query: PathsQuery): Map<string, PathGroup[]> | null {
  const schema = z.object({
    viewer: z.object({
      zones: z
        .array(z.object({ zoneTag: zoneTagSchema, paths: z.array(pathGroupSchema).max(query.limit) }))
        .max(SECURITY_ZONES_PER_QUERY),
    }),
  });
  const parsed = schema.safeParse(data);
  if (!parsed.success) return null;
  const asked = new Set(query.zoneTags);
  const byZone = new Map<string, PathGroup[]>();
  for (const zone of parsed.data.viewer.zones) {
    if (!asked.has(zone.zoneTag) || byZone.has(zone.zoneTag)) return null;
    byZone.set(
      zone.zoneTag,
      zone.paths.map(({ count, dimensions }) => ({
        clientIP: dimensions.clientIP,
        source: dimensions.source,
        path: dimensions.clientRequestPath,
        count,
      })),
    );
  }
  return byZone;
}

// --- Chave do achado ---

/** Até onde cabe na chave única do achado (`sourceEventId`, 128). */
const MAX_EVENT_ID = 128;

/**
 * Chave do achado de um evento de segurança: `cf/<conta>/sec:<sha256(regra|zona|IP|início da janela)[0..40]>` (80
 * caracteres). A mesma regra, zona, IP e janela caem sempre na mesma chave: reler a janela não duplica. O achado da
 * zona inteira (DDoS, pico) usa o IP vazio; o resumo dos IPs além do teto, `*`.
 */
export function securityEventId(
  accountId: string,
  ruleId: string,
  zoneTag: string,
  ip: string,
  windowStart: Date,
): string {
  const digest = createHash('sha256')
    .update(`${ruleId}|${zoneTag}|${ip}|${windowStart.toISOString()}`)
    .digest('hex')
    .slice(0, 40);
  return `cf/${accountId}/sec:${digest}`.slice(0, MAX_EVENT_ID);
}

// --- Orçamento de consultas por token ---

/**
 * Orçamento de consultas GraphQL de um token (o Cloudflare permite 300 a cada 5 min; o coletor se limita a 250). O
 * gasto fica em baldes de um minuto, e vale a soma dos últimos 6 minutos (o atual e os 5 anteriores): qualquer
 * intervalo de 5 min, alinhado ou não, cai dentro de 6 baldes, então nunca passa de 250. Cada zona de cada nó conta
 * uma unidade, como no Cloudflare. O estado (os baldes ainda valendo) vai para o banco a cada consulta, antes dela.
 */
export class QueryBudget {
  private readonly buckets = new Map<number, number>();

  constructor(
    readonly capacity: number = GRAPHQL_BUDGET_UNITS,
    buckets: Iterable<readonly [number, number]> = [],
  ) {
    if (!(Number.isSafeInteger(capacity) && capacity >= 1)) throw new RangeError('orçamento de ao menos 1');
    for (const [minute, units] of buckets) this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + units);
  }

  private static minuteOf(at: Date): number {
    return Math.floor(at.getTime() / MINUTE_MS);
  }

  /** Baldes que ainda contam em `at`. */
  private live(at: Date): [number, number][] {
    const minute = QueryBudget.minuteOf(at);
    const windowMinutes = GRAPHQL_BUDGET_PERIOD_MS / MINUTE_MS;
    return [...this.buckets]
      .filter(([bucket]) => bucket > minute - windowMinutes - 1 && bucket <= minute)
      .sort(([a], [b]) => a - b);
  }

  spent(at: Date): number {
    return this.live(at).reduce((sum, [, units]) => sum + units, 0);
  }

  /** Gasta `units` se couberem; senão, nada muda. */
  take(units: number, at: Date): boolean {
    if (!(Number.isSafeInteger(units) && units >= 1)) throw new RangeError('consulta de ao menos 1 unidade');
    if (units > this.capacity || this.spent(at) + units > this.capacity) return false;
    const minute = QueryBudget.minuteOf(at);
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + units);
    return true;
  }

  /** Esvazia o orçamento em `at` (depois de um 429: o Cloudflare bloqueia o token). */
  exhaust(at: Date): void {
    const free = this.capacity - this.spent(at);
    if (free > 0) {
      const minute = QueryBudget.minuteOf(at);
      this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + free);
    }
  }

  /** Quando `units` passam a caber: o fim do balde mais antigo que libera o suficiente. */
  availableAt(units: number, at: Date): Date {
    const needed = Math.min(units, this.capacity);
    let spent = this.spent(at);
    if (spent + needed <= this.capacity) return at;
    const windowMinutes = GRAPHQL_BUDGET_PERIOD_MS / MINUTE_MS;
    for (const [minute, value] of this.live(at)) {
      spent -= value;
      if (spent + needed <= this.capacity) return new Date((minute + windowMinutes + 1) * MINUTE_MS);
    }
    return new Date((QueryBudget.minuteOf(at) + windowMinutes + 1) * MINUTE_MS);
  }

  /** Os baldes que ainda valem em `at`, para gravar. */
  snapshot(at: Date): [number, number][] {
    return this.live(at);
  }
}

// --- Estado do fluxo (`CollectorCursor.continuation`) ---

/**
 * O estado do fluxo `cloudflare_security`, em `CollectorCursor.continuation` (até 2048 caracteres): o orçamento de
 * consultas do token (`b`, os baldes de um minuto) e, no meio de uma janela, o progresso dela (`w`, o início da
 * janela; `d`, quantos lotes de zonas já foram gravados; `h`, o resumo da divisão das zonas em lotes, que precisa ser
 * a mesma para seguir dela). O cursor (`cursorAt`) é o fim da última janela gravada inteira.
 */
export interface SecurityStreamState {
  budget: [number, number][];
  progress: { windowStart: Date; done: number; layout: string } | null;
}

const stateSchema = z.strictObject({
  v: z.literal(1),
  b: z
    .array(
      z.tuple([
        z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        z.number().int().min(1).max(GRAPHQL_BUDGET_UNITS),
      ]),
    )
    .max(10),
  w: z.iso.datetime().optional(),
  d: z.number().int().min(0).max(SECURITY_MAX_ZONES).optional(),
  h: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
});

export function decodeState(text: string | null): SecurityStreamState {
  const empty: SecurityStreamState = { budget: [], progress: null };
  if (text === null) return empty;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty;
  }
  const parsed = stateSchema.safeParse(json);
  if (!parsed.success) return empty;
  const { b, w, d, h } = parsed.data;
  return {
    budget: b,
    progress:
      w !== undefined && d !== undefined && h !== undefined
        ? { windowStart: new Date(w), done: d, layout: h }
        : null,
  };
}

export function encodeState(state: SecurityStreamState): string {
  return JSON.stringify({
    v: 1,
    b: state.budget,
    ...(state.progress !== null && {
      w: state.progress.windowStart.toISOString(),
      d: state.progress.done,
      h: state.progress.layout,
    }),
  });
}

/** O resumo da divisão das zonas em lotes: o progresso de uma janela só vale com a mesma divisão. */
export function batchLayout(batches: readonly (readonly string[])[]): string {
  return createHash('sha256')
    .update(batches.map((batch) => batch.join(',')).join('|'))
    .digest('hex')
    .slice(0, 16);
}

/** Divide em lotes de até `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
