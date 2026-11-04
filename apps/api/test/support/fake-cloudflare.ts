import { randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
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
};

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
}

/** Uma resposta roteirizada da auditoria. Sem corpo, o corpo de erro repete o token (que nunca pode ir para o log). */
export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  hang?: boolean;
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
  /** Auditoria de cada conta: a entrada (como a API devolve, ou fora do formato) e o horário do filtro. */
  readonly auditLogs = new Map<string, { at: string; entry: unknown }[]>();
  /** Respostas roteirizadas, uma por pedido do coletor à auditoria, antes da resposta normal (429, 5xx, sem resposta). */
  readonly auditScript: FakeResponse[] = [];
  /** Cursores que a API passa a recusar (continuação vencida). */
  readonly expiredCursors = new Set<string>();
  /** Zonas de cada conta. */
  readonly zones = new Map<string, string[]>();
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
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
      const verify = /^\/(?:accounts\/([0-9a-f]{32})|user)\/tokens\/verify$/.exec(url.pathname);
      if (verify) {
        if (token?.verifyStatus)
          return send(token.verifyStatus, JSON.stringify({ success: false, errors: [] }));
        if (token?.verifyBody !== undefined) return send(200, token.verifyBody);
        const accountPath = verify[1];
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
      const audit = /^\/accounts\/([0-9a-f]{32})\/logs\/audit$/.exec(url.pathname);
      if (audit) {
        // O coletor pede em ordem (`direction`); a leitura de prova da conferência do token, não.
        const scripted = url.searchParams.has('direction') ? this.auditScript.shift() : undefined;
        if (scripted) {
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
        const accountId = audit[1] ?? '';
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
        return send(200, page);
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
      return send(404, JSON.stringify({ success: false, errors: [{ code: 7003, message: 'No route' }] }));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /**
   * A auditoria da conta, filtrada por `since` (inclusive) e `before` (exclusive), em ordem crescente, `limit` por
   * página e um `cursor` opaco (o deslocamento e a janela em base64url). Sem `since` ou `before`, ou com um cursor de
   * outra janela, `null` (400), como a API, que exige os dois.
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
          o: number;
          s: number;
          b: number;
        };
        if (decoded.s !== since || decoded.b !== before || this.expiredCursors.has(cursor)) return null;
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
        ? Buffer.from(JSON.stringify({ o: nextOffset, s: since, b: before })).toString('base64url')
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
      result: slice.map((name, index) => ({
        id: `${(page * 1000 + index).toString(16).padStart(32, '0')}`,
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
    for (const response of this.hanging) response.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
