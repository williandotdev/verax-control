import { createHash, randomBytes } from 'node:crypto';
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

/** Um código de autorização emitido pela tela do Cloudflare. */
interface FakeCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  access: FakeToken;
  /** A autorização que o código já virou: o reuso a derruba. */
  grant: FakeGrant | undefined;
}

/** Uma resposta roteirizada da renovação, da troca ou da revogação, uma por pedido. */
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
 * O OAuth do Cloudflare falso em 127.0.0.1, com app sem segredo: a tela de autorização (`authorize`), a troca do código com
 * o PKCE conferido de verdade, a renovação e a revogação. Os acessos que ele emite passam a valer no `FakeCloudflareServer`. A troca do token de renovação a cada uso, o reuso que derruba a
 * cadeia e a validade são ligáveis: o comportamento real só um app registrado responde. As mensagens de erro repetem os
 * tokens recebidos, para provar que nada da resposta chega ao log.
 */
export class FakeCloudflareOAuthServer {
  readonly grants: FakeGrant[] = [];
  readonly script: FakeOAuthReply[] = [];
  /** Respostas roteirizadas da revogação, uma por pedido. */
  readonly revokeScript: FakeOAuthReply[] = [];
  /** Os tokens que chegaram à revogação, na ordem. */
  readonly revocations: string[] = [];
  readonly codes = new Map<string, FakeCode>();
  /** A troca responde sem o token de renovação. */
  noRefresh = false;
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
  revokeUrl = '';
  /** Um servidor para os tokens e outro para a revogação, cada um com o próprio tratamento. */
  private readonly servers: Server[] = [];
  private readonly hanging: ServerResponse[] = [];

  constructor(private readonly cloudflare: FakeCloudflareServer) {}

  async start(): Promise<void> {
    const tokens = await this.listen((request, response, body) => this.handleToken(request, response, body));
    const revocations = await this.listen((request, response, body) =>
      this.handleRevocation(request, response, body),
    );
    this.tokenUrl = `http://127.0.0.1:${tokens}/oauth2/token`;
    this.revokeUrl = `http://127.0.0.1:${revocations}/oauth2/revoke`;
  }

  private async listen(
    handle: (request: IncomingMessage, response: ServerResponse, body: string) => Promise<void>,
  ): Promise<number> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void handle(request, response, Buffer.concat(chunks).toString('utf8'));
      });
    });
    this.servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const response of this.hanging) response.destroy();
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  }

  reset(): void {
    this.script.length = 0;
    this.revokeScript.length = 0;
    this.revocations.length = 0;
    this.requests.length = 0;
    this.noRefresh = false;
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

  /** O cliente autoriza na tela: o que volta no endereço de retorno. */
  authorize(authorizeUrl: string, access: Partial<FakeToken>): { code: string; state: string; iss: string } {
    const query = new URL(authorizeUrl).searchParams;
    const code = `codigo_${randomBytes(24).toString('base64url')}`;
    this.codes.set(code, {
      clientId: query.get('client_id') ?? '',
      redirectUri: query.get('redirect_uri') ?? '',
      challenge: query.get('code_challenge') ?? '',
      access: { id: randomBytes(16).toString('hex'), owner: 'user', ...access },
      grant: undefined,
    });
    return { code, state: query.get('state') ?? '', iss: 'https://dash.cloudflare.com' };
  }

  revoke(grant: FakeGrant): void {
    grant.revoked = true;
    this.cloudflare.tokens.delete(grant.accessToken);
  }

  /** Como responder, com o que o roteiro manda; null quando o roteiro já tratou o pedido. */
  private replier(
    request: IncomingMessage,
    response: ServerResponse,
    form: URLSearchParams,
    reply: FakeOAuthReply | undefined,
  ) {
    if (reply?.dropBefore) {
      request.socket.destroy();
      return null;
    }
    if (reply?.hang) {
      this.hanging.push(response);
      return null;
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
      return null;
    }
    return { send, error };
  }

  private async handleRevocation(
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ): Promise<void> {
    const form = new URLSearchParams(body);
    const token = form.get('token') ?? '';
    this.revocations.push(token);
    const replier = this.replier(request, response, form, this.revokeScript.shift());
    if (replier === null) return;
    const found = this.grants.find(
      (candidate) =>
        candidate.refreshToken === token ||
        candidate.accessToken === token ||
        candidate.usedRefresh.has(token),
    );
    if (found !== undefined && form.get('client_id') !== found.clientId) {
      return replier.error(401, 'invalid_client');
    }
    if (found !== undefined) this.revoke(found);
    await this.beforeReply?.();
    replier.send(200, '');
  }

  private async handleToken(request: IncomingMessage, response: ServerResponse, body: string): Promise<void> {
    const form = new URLSearchParams(body);
    this.requests.push(form);
    const reply = this.script.shift();
    const replier = this.replier(request, response, form, reply);
    if (replier === null) return;
    const { send, error } = replier;
    if (request.method === 'POST' && form.get('grant_type') === 'authorization_code') {
      const issued = this.codes.get(form.get('code') ?? '');
      if (issued === undefined) return error(400, 'invalid_grant');
      if (issued.grant !== undefined) {
        this.revoke(issued.grant);
        return error(400, 'invalid_grant');
      }
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (form.get('client_id') !== issued.clientId) return error(401, 'invalid_client');
      if (form.get('redirect_uri') !== issued.redirectUri || challenge !== issued.challenge) {
        return error(400, 'invalid_grant');
      }
      const created = this.grant(issued.access);
      created.clientId = issued.clientId;
      issued.grant = created;
      await this.beforeReply?.();
      if (reply?.dropAfter) {
        request.socket.destroy();
        return;
      }
      return send(
        200,
        JSON.stringify({
          access_token: created.accessToken,
          token_type: 'bearer',
          ...(this.expiresIn !== undefined && { expires_in: this.expiresIn }),
          ...(!this.noRefresh && { refresh_token: created.refreshToken }),
          ...(this.scope !== undefined && { scope: this.scope }),
        }),
      );
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
