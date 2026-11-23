import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeCloudflareServer, FakeToken } from './fake-cloudflare.js';

/** Uma autorização no servidor falso: o acesso e a renovação que valem agora, e o que o acesso lê. */
export interface FakeGrant {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Os tokens de renovação já trocados: o reuso derruba a cadeia (quando `reuseRevokes`). */
  usedRefresh: Set<string>;
  revoked: boolean;
  access: FakeToken;
}

/** Uma resposta roteirizada da renovação, uma por pedido. */
export interface FakeOAuthReply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Não responde. */
  hang?: boolean;
  /** Fecha a conexão antes de processar: nada muda do lado do servidor. */
  dropBefore?: boolean;
  /** Processa (troca os tokens) e fecha a conexão sem responder. */
  dropAfter?: boolean;
  /** Espera antes de responder a resposta normal. */
  delayMs?: number;
}

export const oauthToken = (prefix = 'at') => `${prefix}_${randomBytes(32).toString('base64url')}`;

/**
 * O OAuth do Cloudflare falso em 127.0.0.1: só a renovação (`grant_type=refresh_token`, app sem segredo). Os acessos que
 * ele emite passam a valer no `FakeCloudflareServer`. A troca do token de renovação a cada uso, o reuso que derruba a
 * cadeia e a validade são ligáveis: o comportamento real só um app registrado responde. As mensagens de erro repetem os
 * tokens recebidos, para provar que nada da resposta chega ao log.
 */
export class FakeCloudflareOAuthServer {
  readonly grants: FakeGrant[] = [];
  readonly script: FakeOAuthReply[] = [];
  /** Os pedidos recebidos: o corpo, já lido. */
  readonly requests: URLSearchParams[] = [];
  rotate = true;
  reuseRevokes = true;
  /** O acesso anterior deixa de valer quando um novo sai. */
  expireOldAccess = true;
  expiresIn: unknown = 3600;
  scope: string | undefined;
  /** Chamado depois de trocar os tokens e antes de responder (uma queda do banco, uma exclusão no meio). */
  beforeReply: (() => Promise<void> | void) | undefined;
  tokenUrl = '';
  private server: Server | undefined;
  private readonly hanging: ServerResponse[] = [];

  constructor(private readonly cloudflare: FakeCloudflareServer) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void this.handle(request, response, Buffer.concat(chunks).toString('utf8'));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.tokenUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/oauth2/token`;
  }

  async stop(): Promise<void> {
    for (const response of this.hanging) response.destroy();
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections();
    });
  }

  reset(): void {
    this.script.length = 0;
    this.requests.length = 0;
    this.rotate = true;
    this.reuseRevokes = true;
    this.expireOldAccess = true;
    this.expiresIn = 3600;
    this.scope = undefined;
    this.beforeReply = undefined;
  }

  /** Uma autorização nova, com o acesso já valendo na API falsa. */
  grant(access: Partial<FakeToken>): FakeGrant {
    const grant: FakeGrant = {
      clientId: `cliente${randomBytes(8).toString('hex')}`,
      accessToken: oauthToken('at'),
      refreshToken: oauthToken('rt'),
      usedRefresh: new Set(),
      revoked: false,
      access: { id: randomBytes(16).toString('hex'), owner: 'user', ...access },
    };
    this.grants.push(grant);
    this.cloudflare.tokens.set(grant.accessToken, grant.access);
    return grant;
  }

  revoke(grant: FakeGrant): void {
    grant.revoked = true;
    this.cloudflare.tokens.delete(grant.accessToken);
  }

  private async handle(request: IncomingMessage, response: ServerResponse, body: string): Promise<void> {
    const form = new URLSearchParams(body);
    this.requests.push(form);
    const reply = this.script.shift();
    if (reply?.dropBefore) {
      request.socket.destroy();
      return;
    }
    if (reply?.hang) {
      this.hanging.push(response);
      return;
    }
    const send = (status: number, text: string) => {
      response.writeHead(status, { 'content-type': 'application/json', ...reply?.headers });
      response.end(text);
    };
    const error = (status: number, code: string) =>
      send(
        status,
        JSON.stringify({ error: code, error_description: `recusado ${form.get('refresh_token')}` }),
      );
    if (reply?.status !== undefined) {
      send(reply.status, reply.body ?? JSON.stringify({ error: `falha ${form.get('refresh_token')}` }));
      return;
    }
    const sent = form.get('refresh_token') ?? '';
    if (request.method !== 'POST' || form.get('grant_type') !== 'refresh_token') {
      return error(400, 'unsupported_grant_type');
    }
    const reused = this.grants.find((grant) => grant.usedRefresh.has(sent));
    if (reused !== undefined) {
      if (this.reuseRevokes) this.revoke(reused);
      return error(400, 'invalid_grant');
    }
    const grant = this.grants.find((candidate) => candidate.refreshToken === sent);
    if (grant === undefined || grant.revoked) return error(400, 'invalid_grant');
    if (form.get('client_id') !== grant.clientId) return error(401, 'invalid_client');

    if (this.expireOldAccess) this.cloudflare.tokens.delete(grant.accessToken);
    grant.accessToken = oauthToken('at');
    this.cloudflare.tokens.set(grant.accessToken, grant.access);
    if (this.rotate) {
      grant.usedRefresh.add(sent);
      grant.refreshToken = oauthToken('rt');
    }
    await this.beforeReply?.();
    if (reply?.dropAfter) {
      request.socket.destroy();
      return;
    }
    if (reply?.delayMs !== undefined) {
      const { delayMs } = reply;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    send(
      200,
      JSON.stringify({
        access_token: grant.accessToken,
        token_type: 'bearer',
        ...(this.expiresIn !== undefined && { expires_in: this.expiresIn }),
        ...(this.rotate && { refresh_token: grant.refreshToken }),
        ...(this.scope !== undefined && { scope: this.scope }),
      }),
    );
  }
}
