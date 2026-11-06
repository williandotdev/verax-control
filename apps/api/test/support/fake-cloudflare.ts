import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Valores no formato do Cloudflare, gerados na hora: nenhum token, ID ou conta real no repositório. */
export const fakeCloudflare = {
  accountId: () => randomBytes(16).toString('hex'),
  tokenId: () => randomBytes(16).toString('hex'),
  /** Token de conta no formato novo: `cfat_`, 40 caracteres e o checksum. */
  accountToken: () => `cfat_${randomBytes(30).toString('base64url')}${randomBytes(4).toString('hex')}`,
  userToken: () => `cfut_${randomBytes(30).toString('base64url')}${randomBytes(4).toString('hex')}`,
  /** Formato antigo, sem prefixo: 40 caracteres. */
  legacyToken: () => randomBytes(30).toString('base64url'),
  /** A Global API Key antiga: 37 hexadecimais minúsculos. */
  globalApiKey: () => randomBytes(19).toString('hex').slice(0, 37),
  /** ID da zona (o `zoneTag` do GraphQL): 32 hexadecimais derivados da conta e do nome, únicos por conta. */
  zoneTag: (accountId: string, name: string) =>
    createHash('sha256').update(`${accountId}|${name}`).digest('hex').slice(0, 32),
};

/** Os limites de uma zona no nó `settings` (os do exemplo da documentação, por padrão). */
export interface FakeZoneLimits {
  enabled: boolean;
  maxDuration: number;
  maxPageSize: number;
  notOlderThan: number;
}

export const DEFAULT_ZONE_LIMITS: FakeZoneLimits = {
  enabled: true,
  maxDuration: 259_200,
  maxPageSize: 10_000,
  notOlderThan: 2_678_400,
};

/** Um evento de segurança da zona (a contagem já agregada daquele minuto). */
export interface FakeSecurityEvent {
  at: string;
  action: string;
  source: string;
  ip: string;
  host?: string;
  path?: string;
  count?: number;
}

/** Zona com eventos de segurança: a conta dona, o nome, os limites (`null`: sem o nó) e os eventos. */
export interface FakeSecurityZone {
  accountId: string;
  name: string;
  limits: FakeZoneLimits | null;
  events: FakeSecurityEvent[];
}

/** Um pedido ao GraphQL, já lido: a operação (pelo nome da consulta), as variáveis e o `limit` do primeiro nó. */
export interface FakeGraphqlRequest {
  operation: 'settings' | 'events' | 'paths' | 'unknown';
  query: string;
  variables: Record<string, unknown>;
  limit: number | null;
  authorization: string | undefined;
}

/** Como o Cloudflare falso trata um token. */
export interface FakeToken {
  id: string;
  /** Quem é dono: o verify responde 200 só no endpoint dele (de conta, só na conta `accountId`). */
  owner: 'account' | 'user';
  accountId?: string;
  status?: 'active' | 'disabled' | 'expired';
  expiresOn?: string | null;
  notBefore?: string;
  /** Contas cuja auditoria o token lê (Account Settings: Read nelas). */
  auditAccounts?: string[];
  /** O verify responde este status (5xx, 429) em vez do resultado. */
  verifyStatus?: number;
  /** O verify responde 200 com este corpo, fora do formato. */
  verifyBody?: string;
  /** Não responde nada (para o tempo limite). */
  hang?: boolean;
  /** Sem `Zone Read`: a lista de zonas responde 403. */
  zoneRead?: boolean;
  /** Sem `Analytics Read`: o GraphQL responde 403. */
  analyticsRead?: boolean;
  /** Zonas que o GraphQL deixa o token ler (as outras somem da resposta); sem a lista, as da conta do token. */
  analyticsZones?: string[];
}

/** Uma resposta roteirizada da auditoria. Sem corpo, o corpo de erro repete o token (que nunca pode ir para o log). */
export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  hang?: boolean;
  /** Responde como a API responderia (a página normal), sem roteiro de erro; com `delayMs`, devagar. */
  pass?: boolean;
  /** Espera antes de responder a página normal (com `pass`). */
  delayMs?: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
}

const INVALID_TOKEN = JSON.stringify({
  success: false,
  errors: [{ code: 1000, message: 'Invalid API Token' }],
  messages: [],
  result: null,
});

/**
 * O Cloudflare falso em 127.0.0.1: `GET /accounts/:id/tokens/verify`, `GET /user/tokens/verify` e
 * `GET /accounts/:id/logs/audit`, com o envelope da API (`success`, `errors`, `messages`, `result`). As mensagens de
 * erro repetem o token recebido, para provar que nada da resposta da origem chega ao log nem ao painel.
 */
export class FakeCloudflareServer {
  readonly tokens = new Map<string, FakeToken>();
  readonly requests: FakeRequest[] = [];
  private server: Server | undefined;
  private readonly hanging: ServerResponse[] = [];
  /** Respostas lentas ainda por sair (a parada do servidor as cancela). */
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Auditoria de cada conta: a entrada (como a API devolve, ou fora do formato) e o horário do filtro. */
  readonly auditLogs = new Map<string, { at: string; entry: unknown }[]>();
  /** Respostas roteirizadas, uma por pedido do coletor à auditoria, antes da resposta normal (429, 5xx, sem resposta). */
  readonly auditScript: FakeResponse[] = [];
  /** Cursores que a API passa a recusar (continuação vencida). */
  readonly expiredCursors = new Set<string>();
  /** Zonas de cada conta. */
  readonly zones = new Map<string, string[]>();
  /** Eventos de segurança de cada zona, pelo `zoneTag`. */
  readonly securityZones = new Map<string, FakeSecurityZone>();
  /** Respostas roteirizadas, uma por pedido ao GraphQL, antes da resposta normal. */
  readonly graphqlScript: FakeResponse[] = [];
  /** Os pedidos ao GraphQL, na ordem. */
  readonly graphqlRequests: FakeGraphqlRequest[] = [];
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => this.handle(request, response, Buffer.concat(chunks).toString('utf8')));
        return;
      }
      this.handle(request, response, '');
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private handle(request: IncomingMessage, response: ServerResponse, body: string): void {
    {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const authorization = request.headers.authorization;
      this.requests.push({
        method: request.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        authorization,
      });
      const value = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
      const token = this.tokens.get(value);
      response.setHeader('content-type', 'application/json');
      if (token?.hang) {
        this.hanging.push(response);
        return;
      }
      const send = (status: number, body: string) => {
        response.statusCode = status;
        response.end(body);
      };
      const verify = verifyPathOf(url.pathname);
      if (verify) {
        if (token?.verifyStatus)
          return send(token.verifyStatus, JSON.stringify({ success: false, errors: [] }));
        if (token?.verifyBody !== undefined) return send(200, token.verifyBody);
        const accountPath = verify.accountId;
        const owns =
          token !== undefined &&
          (accountPath === undefined
            ? token.owner === 'user'
            : token.owner === 'account' && token.accountId === accountPath);
        if (!owns) {
          return send(401, INVALID_TOKEN.replace('Invalid API Token', `Invalid API Token ${value}`));
        }
        return send(
          200,
          JSON.stringify({
            success: true,
            errors: [],
            messages: [{ code: 10000, message: 'This API Token is valid and active' }],
            result: {
              id: token.id,
              status: token.status ?? 'active',
              ...(token.expiresOn !== undefined && { expires_on: token.expiresOn }),
              ...(token.notBefore !== undefined && { not_before: token.notBefore }),
            },
          }),
        );
      }
      const audit = accountPathOf(url.pathname, ['logs', 'audit']);
      if (audit !== null) {
        // O coletor pede em ordem (`direction`); a leitura de prova da conferência do token, não.
        const scripted = url.searchParams.has('direction') ? this.auditScript.shift() : undefined;
        const delayMs = scripted?.delayMs;
        // Resposta normal, mas devagar: o corpo só sai depois da espera (se o cliente ainda estiver ouvindo).
        const deliver =
          delayMs === undefined
            ? send
            : (status: number, body: string) => {
                const timer = setTimeout(() => {
                  this.timers.delete(timer);
                  if (!response.destroyed) send(status, body);
                }, delayMs);
                this.timers.add(timer);
              };
        if (scripted && scripted.pass !== true) {
          if (scripted.hang) {
            this.hanging.push(response);
            return;
          }
          for (const [name, header] of Object.entries(scripted.headers ?? {}))
            response.setHeader(name, header);
          return send(
            scripted.status,
            scripted.body ??
              JSON.stringify({
                success: false,
                errors: [{ code: 10000, message: `Erro da origem ${value}` }],
              }),
          );
        }
        if (!token) return send(401, INVALID_TOKEN);
        const accountId = audit;
        if (!token.auditAccounts?.includes(accountId)) {
          return send(
            403,
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: `Authentication error ${value}` }],
            }),
          );
        }
        const page = this.auditPage(accountId, url.searchParams);
        if (page === null) {
          return send(
            400,
            JSON.stringify({ success: false, errors: [{ code: 1003, message: 'Bad cursor' }] }),
          );
        }
        return deliver(200, page);
      }
      if (url.pathname === '/zones') {
        if (!token) return send(401, INVALID_TOKEN);
        if (token.zoneRead === false) {
          return send(
            403,
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: `Authentication error ${value}` }],
            }),
          );
        }
        return send(200, this.zonesPage(url.searchParams));
      }
      if (url.pathname === '/graphql' && request.method === 'POST') {
        const parsed = parseGraphql(body);
        this.graphqlRequests.push({ ...parsed, authorization });
        const scripted = this.graphqlScript.shift();
        const delayMs = scripted?.delayMs;
        const deliver =
          delayMs === undefined
            ? send
            : (status: number, text: string) => {
                const timer = setTimeout(() => {
                  this.timers.delete(timer);
                  if (!response.destroyed) send(status, text);
                }, delayMs);
                this.timers.add(timer);
              };
        if (scripted && scripted.pass !== true) {
          if (scripted.hang) {
            this.hanging.push(response);
            return;
          }
          for (const [name, header] of Object.entries(scripted.headers ?? {}))
            response.setHeader(name, header);
          return send(
            scripted.status,
            scripted.body ?? JSON.stringify({ data: null, errors: [{ message: `Erro da origem ${value}` }] }),
          );
        }
        if (!token) return send(401, INVALID_TOKEN);
        if (token.analyticsRead === false) {
          return send(
            403,
            JSON.stringify({ data: null, errors: [{ message: `not authorized for that account ${value}` }] }),
          );
        }
        return deliver(200, this.graphqlResponse(token, parsed));
      }
      return send(404, JSON.stringify({ success: false, errors: [{ code: 7003, message: 'No route' }] }));
    }
  }

  /** A resposta do GraphQL como a API daria: só as zonas pedidas que o token lê, com o nó da operação. */
  private graphqlResponse(token: FakeToken, request: ReturnType<typeof parseGraphql>): string {
    const tags = Array.isArray(request.variables['zoneTags'])
      ? (request.variables['zoneTags'] as string[])
      : [];
    const readable = tags.filter((tag) => {
      const zone = this.securityZones.get(tag);
      if (zone === undefined) return false;
      return token.analyticsZones ? token.analyticsZones.includes(tag) : zone.accountId === token.accountId;
    });
    const time = (name: string) => {
      const value = request.variables[name];
      return typeof value === 'string' ? Date.parse(value) : Number.NaN;
    };
    if (request.operation === 'settings') {
      return JSON.stringify({
        data: {
          viewer: {
            zones: readable.map((tag) => ({
              zoneTag: tag,
              settings: { firewallEventsAdaptiveGroups: this.securityZones.get(tag)?.limits ?? null },
            })),
          },
        },
        errors: null,
      });
    }
    const blocked = readable.find((tag) => this.securityZones.get(tag)?.limits?.enabled === false);
    if (blocked !== undefined) {
      return JSON.stringify({
        data: null,
        errors: [
          { message: `zone '${blocked}' does not have access to the path`, path: ['viewer', 'zones', '0'] },
        ],
      });
    }
    const since = time('since');
    const until = time('until');
    const limit = request.limit ?? 100;
    const inside = (event: FakeSecurityEvent, from: number, to: number) => {
      const at = Date.parse(event.at);
      return at >= from && at < to;
    };
    if (request.operation === 'paths') {
      const ips = new Set(
        Array.isArray(request.variables['clientIPs']) ? (request.variables['clientIPs'] as string[]) : [],
      );
      return JSON.stringify({
        data: {
          viewer: {
            zones: readable.map((tag) => {
              const groups = new Map<string, { count: number; dimensions: Record<string, string | null> }>();
              for (const event of this.securityZones.get(tag)?.events ?? []) {
                if (!inside(event, since, until) || !ips.has(event.ip)) continue;
                const key = [event.ip, event.source, event.path ?? ''].join('|');
                const group = groups.get(key) ?? {
                  count: 0,
                  dimensions: {
                    clientIP: event.ip,
                    source: event.source,
                    clientRequestPath: event.path ?? null,
                  },
                };
                group.count += event.count ?? 1;
                groups.set(key, group);
              }
              return { zoneTag: tag, paths: sortGroups([...groups.values()]).slice(0, limit) };
            }),
          },
        },
        errors: null,
      });
    }
    const baselineSince = time('baselineSince');
    return JSON.stringify({
      data: {
        viewer: {
          zones: readable.map((tag) => {
            const events = this.securityZones.get(tag)?.events ?? [];
            const groups = new Map<string, { count: number; dimensions: Record<string, string | null> }>();
            for (const event of events) {
              if (!inside(event, since, until)) continue;
              const key = [event.action, event.source, event.ip, event.host ?? ''].join('|');
              const group = groups.get(key) ?? {
                count: 0,
                dimensions: {
                  action: event.action,
                  source: event.source,
                  clientIP: event.ip,
                  clientRequestHTTPHost: event.host ?? null,
                },
              };
              group.count += event.count ?? 1;
              groups.set(key, group);
            }
            const baseline = events
              .filter((event) => inside(event, baselineSince, since))
              .reduce((sum, event) => sum + (event.count ?? 1), 0);
            return {
              zoneTag: tag,
              events: sortGroups([...groups.values()]).slice(0, limit),
              ...(!Number.isNaN(baselineSince) && { baseline: [{ count: baseline }] }),
            };
          }),
        },
      },
      errors: null,
    });
  }

  /** Uma zona da conta, na lista de zonas (REST) e no GraphQL, e o `zoneTag` dela. */
  addSecurityZone(
    accountId: string,
    name: string,
    { limits = DEFAULT_ZONE_LIMITS }: { limits?: FakeZoneLimits | null } = {},
  ): string {
    const tag = fakeCloudflare.zoneTag(accountId, name);
    this.zones.set(accountId, [...(this.zones.get(accountId) ?? []), name]);
    this.securityZones.set(tag, { accountId, name, limits, events: [] });
    return tag;
  }

  addSecurityEvents(zoneTag: string, ...events: FakeSecurityEvent[]): void {
    const zone = this.securityZones.get(zoneTag);
    if (zone === undefined) throw new Error('zona desconhecida no Cloudflare falso');
    zone.events.push(...events);
  }

  /** Pedidos ao GraphQL com o token (e da operação, quando informada). */
  graphqlReads(token?: string, operation?: FakeGraphqlRequest['operation']): FakeGraphqlRequest[] {
    return this.graphqlRequests.filter(
      (request) =>
        (token === undefined || request.authorization === `Bearer ${token}`) &&
        (operation === undefined || request.operation === operation),
    );
  }

  /**
   * A auditoria da conta, filtrada por `since` (inclusive) e `before` (exclusive), em ordem crescente, `limit` por
   * página e um `cursor` opaco (a conta, o deslocamento e a janela em base64url). Sem `since` ou `before`, ou com um
   * cursor de outra conta ou de outra janela, `null` (400), como a API, que exige os dois.
   */
  private auditPage(accountId: string, query: URLSearchParams): string | null {
    const since = Date.parse(query.get('since') ?? '');
    const before = Date.parse(query.get('before') ?? '');
    if (Number.isNaN(since) || Number.isNaN(before)) return null;
    const limit = Math.min(Math.max(Number(query.get('limit') ?? '100') || 100, 1), 1000);
    let offset = 0;
    const cursor = query.get('cursor');
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          a: string;
          o: number;
          s: number;
          b: number;
        };
        const sameQuery = decoded.a === accountId && decoded.s === since && decoded.b === before;
        if (!sameQuery || this.expiredCursors.has(cursor)) return null;
        offset = decoded.o;
      } catch {
        return null;
      }
    }
    const window = (this.auditLogs.get(accountId) ?? [])
      .filter(({ at }) => {
        const time = Date.parse(at);
        return time >= since && time < before;
      })
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const slice = window.slice(offset, offset + limit);
    const nextOffset = offset + slice.length;
    const next =
      nextOffset < window.length
        ? Buffer.from(JSON.stringify({ a: accountId, o: nextOffset, s: since, b: before })).toString(
            'base64url',
          )
        : '';
    return JSON.stringify({
      success: true,
      errors: [],
      result: slice.map(({ entry }) => entry),
      result_info: { count: String(slice.length), cursor: next },
    });
  }

  /** `GET /zones?account.id=...&page=...&per_page=...`: as zonas da conta, com `result_info.total_pages`. */
  private zonesPage(query: URLSearchParams): string {
    const accountId = query.get('account.id') ?? '';
    const perPage = Number(query.get('per_page') ?? '20') || 20;
    const page = Number(query.get('page') ?? '1') || 1;
    const names = this.zones.get(accountId) ?? [];
    const slice = names.slice((page - 1) * perPage, page * perPage);
    return JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: slice.map((name) => ({
        id: fakeCloudflare.zoneTag(accountId, name),
        name,
        status: 'active',
        paused: false,
        type: 'full',
        account: { id: accountId, name: 'Conta fictícia' },
      })),
      result_info: {
        page,
        per_page: perPage,
        count: slice.length,
        total_count: names.length,
        total_pages: Math.max(1, Math.ceil(names.length / perPage)),
      },
    });
  }

  /** Grava entradas na auditoria da conta; `at` é o horário usado no filtro (a entrada pode vir sem ele). */
  addAudit(accountId: string, ...entries: { at: string; entry: unknown }[]): void {
    this.auditLogs.set(accountId, [...(this.auditLogs.get(accountId) ?? []), ...entries]);
  }

  /** Pedidos do coletor à auditoria (com `direction`), sem os da leitura de prova. */
  auditReads(token?: string): FakeRequest[] {
    return this.requests.filter(
      (request) =>
        request.path.endsWith('/logs/audit') &&
        request.query.has('direction') &&
        (token === undefined || request.authorization === `Bearer ${token}`),
    );
  }

  /** Um token de conta que lê a auditoria da própria conta: o caso que a tela pede. */
  readableAccountToken(accountId: string, overrides: Partial<FakeToken> = {}): string {
    const value = fakeCloudflare.accountToken();
    this.tokens.set(value, {
      id: fakeCloudflare.tokenId(),
      owner: 'account',
      accountId,
      auditAccounts: [accountId],
      ...overrides,
    });
    return value;
  }

  callsWith(token: string): FakeRequest[] {
    return this.requests.filter((request) => request.authorization === `Bearer ${token}`);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    for (const response of this.hanging) response.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

/** O corpo de um pedido ao GraphQL: a operação pelo nome da consulta, as variáveis e o primeiro `limit` literal. */
function parseGraphql(body: string): Omit<FakeGraphqlRequest, 'authorization'> {
  let json: { query?: unknown; variables?: unknown } = {};
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    json = {};
  }
  const query = typeof json.query === 'string' ? json.query : '';
  const variables =
    typeof json.variables === 'object' && json.variables !== null
      ? (json.variables as Record<string, unknown>)
      : {};
  const operation = query.includes('VeraxSecuritySettings')
    ? 'settings'
    : query.includes('VeraxSecurityEvents')
      ? 'events'
      : query.includes('VeraxRateLimitPaths')
        ? 'paths'
        : 'unknown';
  return { operation, query, variables, limit: firstLimit(query) };
}

/** Grupos em ordem decrescente de contagem (e pelas dimensões, no empate, para a ordem ser estável). */
function sortGroups<T extends { count: number; dimensions: Record<string, string | null> }>(
  groups: T[],
): T[] {
  return groups.sort(
    (a, b) => b.count - a.count || JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)),
  );
}

/** 32 hexadecimais minúsculos (ID de conta do Cloudflare), sem regex. */
function isHex32(value: string | undefined): value is string {
  if (value?.length !== 32) return false;
  for (const char of value) {
    if (!((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f'))) return false;
  }
  return true;
}

/** `/accounts/<conta>/<resto>`: a conta, quando o caminho é esse; senão, `null`. Por partes, sem regex. */
function accountPathOf(pathname: string, rest: readonly string[]): string | null {
  const [empty, accounts, accountId, ...tail] = pathname.split('/');
  if (empty !== '' || accounts !== 'accounts' || !isHex32(accountId)) return null;
  if (tail.length !== rest.length || tail.some((part, index) => part !== rest[index])) return null;
  return accountId;
}

/** O verify de conta (`/accounts/<conta>/tokens/verify`) ou de usuário (`/user/tokens/verify`). */
function verifyPathOf(pathname: string): { accountId: string | undefined } | null {
  if (pathname === '/user/tokens/verify') return { accountId: undefined };
  const accountId = accountPathOf(pathname, ['tokens', 'verify']);
  return accountId === null ? null : { accountId };
}

/** O primeiro `limit: <número>` literal da consulta (o do nó dos eventos). */
function firstLimit(query: string): number | null {
  const marker = 'limit: ';
  const at = query.indexOf(marker);
  if (at < 0) return null;
  let digits = '';
  for (const char of query.slice(at + marker.length)) {
    if (char < '0' || char > '9') break;
    digits += char;
  }
  return digits === '' ? null : Number(digits);
}
