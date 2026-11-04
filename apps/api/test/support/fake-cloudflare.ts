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
        if (!token) return send(401, INVALID_TOKEN);
        if (!token.auditAccounts?.includes(audit[1] ?? '')) {
          return send(
            403,
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: `Authentication error ${value}` }],
            }),
          );
        }
        return send(
          200,
          JSON.stringify({ success: true, errors: [], result: [], result_info: { count: 0, cursor: '' } }),
        );
      }
      return send(404, JSON.stringify({ success: false, errors: [{ code: 7003, message: 'No route' }] }));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
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
