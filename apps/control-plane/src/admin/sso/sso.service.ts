import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  SSO_AMR,
  SSO_CLIENT_ID,
  SSO_CODE_TTL_SECONDS,
  SSO_ID_TOKEN_TTL_SECONDS,
  SSO_PATHS,
  type SsoAuthorizeQuery,
  ssoAuthorizeQuerySchema,
  type SsoIdTokenClaims,
  type SsoJwk,
  type SsoTokenResponse,
  ssoTokenRequestSchema,
} from '@verax/shared';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../../common/config/config.module.js';
import { ApiError } from '../../common/http/api-error.js';
import { COLLECTIONS } from '../../firestore/collections.js';
import { DOCUMENT_STORE, type DocumentStore, parseDocument } from '../../firestore/document-store.js';
import {
  accountRef,
  adminSessionSchema,
  newOpaqueId,
  opaqueRef,
  sessionState,
} from '../auth/admin-auth.schema.js';
import { AdminAuthService } from '../auth/admin-auth.service.js';
import { ADMIN_SECRETS, type AdminSecretSource, SecretUnavailableError } from '../auth/admin-secrets.js';
import { parseSsoSigningKey, signIdToken, type SsoSigningKey } from './sso-keys.js';

const date = z.date();

/** `adminSsoCodes/{sha256 do código}`: um código de autorização pendente (60 s, uso único). */
export const adminSsoCodeSchema = z.strictObject({
  clientId: z.literal(SSO_CLIENT_ID),
  redirectUri: z.string().min(1).max(200),
  /** O desafio do PKCE (SHA-256 do verificador, base64url). */
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  email: z.string().min(3).max(254),
  /** A sessão do console que pediu o código: sair dela (ou ela vencer) invalida o código. */
  sessionRef: z.string().regex(/^[0-9a-f]{64}$/),
  /** Quando o responsável entrou no console (o `createdAt` da sessão), o `auth_time` do token. */
  authTime: date,
  createdAt: date,
  expiresAt: date,
});
export type AdminSsoCode = z.infer<typeof adminSsoCodeSchema>;

/** Contexto de uma requisição para a auditoria. */
export interface SsoRequestContext {
  requestId?: string | undefined;
}

/** Por que um pedido de `/sso/authorize` não seguiu (vai ao log; a tela é genérica). */
export type AuthorizeRefusal =
  | 'unavailable'
  | 'cross_site'
  | 'invalid_request'
  | 'unknown_client'
  | 'redirect_uri_not_allowed'
  | 'not_owner';

export type AuthorizeOutcome =
  /** O código emitido: o navegador volta ao endereço de retorno (da lista) com `code`, `state` e `iss`. */
  | { kind: 'code'; location: string }
  /** Sem sessão do console: o login do próprio console, que volta a este mesmo pedido. */
  | { kind: 'login'; location: string }
  /** Recusado: uma tela genérica, sem redirecionar a lugar nenhum. */
  | { kind: 'refused'; status: 400 | 403 | 503; reason: AuthorizeRefusal };

/** Por que uma troca de código foi recusada (log e auditoria; a resposta é sempre a mesma). */
type TokenRefusal =
  | 'unknown_code'
  | 'expired_code'
  | 'client_mismatch'
  | 'redirect_uri_mismatch'
  | 'pkce_mismatch'
  | 'session_gone'
  | 'not_owner';

/** A mensagem única da troca recusada (código desconhecido, vencido, usado, PKCE ou endereço errados). */
const INVALID_GRANT_MESSAGE = 'Código inválido ou vencido.';

function sha256Base64url(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function unavailable(): ApiError {
  return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Entrada única indisponível.', 'sso_unavailable');
}

/**
 * O console como provedor de identidade do SIEM da Verax (decisão de 15/11/2026; `docs/ARQUITETURA.md`, "Entrada
 * única"). Fluxo de código de autorização com PKCE (S256), no formato do OpenID Connect, reduzido ao mínimo:
 *
 * - **`authorize`**: um cliente só (`verax-siem`) e a lista exata de endereços de retorno (`SSO_REDIRECT_URIS`),
 *   conferidos antes de qualquer outra coisa: um endereço fora da lista recebe uma tela de recusa, nunca um
 *   redirecionamento (nada de redirecionamento aberto). Pedido vindo de outro site (`Sec-Fetch-Site: cross-site`) é
 *   recusado. Sem a sessão do console, o login do próprio console, que volta ao mesmo pedido. Com ela, um código
 *   aleatório de 32 bytes, guardado só como SHA-256, preso ao cliente, ao endereço, ao desafio do PKCE, ao `nonce`, ao
 *   e-mail e à sessão, que vale 60 segundos e uma vez.
 * - **`token`**: de servidor para servidor. O código sai do Firestore na mesma transação que o confere (usado ou
 *   recusado, não vale de novo: nem um palpite errado do verificador deixa tentar outro), e a sessão do console que o
 *   pediu precisa continuar valendo (sair do console derruba o código). O token de identidade é assinado com a chave
 *   Ed25519 do cofre `cp-admin-sso-signing-key` e vale 5 minutos.
 *
 * O console nunca aceita esse token de volta: nenhuma rota dele lê `Authorization` (meta-teste). A sessão do console
 * continua só no cookie `__session` do próprio console.
 */
@Injectable()
export class SsoService {
  private readonly issuer: string | undefined;
  private readonly redirectUris: ReadonlySet<string>;
  private keyCache: SsoSigningKey | undefined;

  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'SSO_ISSUER' | 'SSO_REDIRECT_URIS'>,
    @Inject(ADMIN_SECRETS) private readonly secrets: AdminSecretSource,
    private readonly auth: AdminAuthService,
    private readonly audit: AuditService,
    @InjectPinoLogger(SsoService.name) private readonly logger: PinoLogger,
  ) {
    this.issuer = config.SSO_ISSUER;
    this.redirectUris = new Set(config.SSO_REDIRECT_URIS ?? []);
  }

  /** O JWKS: a chave pública de hoje (para conferir a fixada no nó). Sem a chave no cofre, 503. */
  async jwks(): Promise<{ keys: SsoJwk[] }> {
    if (this.issuer === undefined) throw unavailable();
    const key = await this.signingKey();
    return { keys: [key.jwk] };
  }

  async authorize(
    query: unknown,
    cookies: readonly string[],
    fetchSite: string | undefined,
    context: SsoRequestContext,
  ): Promise<AuthorizeOutcome> {
    const issuer = this.issuer;
    if (issuer === undefined) return this.refuseAuthorize(503, 'unavailable');
    // Um site de fora não começa a entrada única (o cookie do console é `SameSite=Strict`, e isto fecha o resto).
    if (fetchSite === 'cross-site') return this.refuseAuthorize(403, 'cross_site');
    const parsed = ssoAuthorizeQuerySchema.safeParse(query);
    if (!parsed.success) return this.refuseAuthorize(400, 'invalid_request');
    const request = parsed.data;
    // O cliente e o endereço de retorno antes de tudo: fora da lista, nunca se redireciona para ele.
    if (request.client_id !== SSO_CLIENT_ID) return this.refuseAuthorize(400, 'unknown_client');
    if (!this.redirectUris.has(request.redirect_uri)) {
      return this.refuseAuthorize(400, 'redirect_uri_not_allowed');
    }
    // Sem a chave de assinatura, nenhum código sai: ele não teria como virar token.
    try {
      await this.signingKey();
    } catch {
      return this.refuseAuthorize(503, 'unavailable');
    }

    const session = await this.auth.authenticate(cookies);
    if (!session.ok) {
      if (session.reason === 'not_owner') return this.refuseAuthorize(403, 'not_owner');
      return { kind: 'login', location: loginLocation(request) };
    }

    const code = newOpaqueId();
    const now = this.clock.now();
    const issued = await this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.adminSessions, session.sessionRef);
      if (data === undefined) return false;
      const current = parseDocument(adminSessionSchema, COLLECTIONS.adminSessions, session.sessionRef, data);
      if (sessionState(current, now) !== 'valid' || current.email !== session.email) return false;
      const document: AdminSsoCode = {
        clientId: SSO_CLIENT_ID,
        redirectUri: request.redirect_uri,
        codeChallenge: request.code_challenge,
        nonce: request.nonce,
        email: session.email,
        sessionRef: session.sessionRef,
        authTime: current.createdAt,
        createdAt: now,
        expiresAt: new Date(now.getTime() + SSO_CODE_TTL_SECONDS * 1000),
      };
      tx.create(COLLECTIONS.adminSsoCodes, opaqueRef(code), adminSsoCodeSchema.parse(document));
      this.audit.record(tx, {
        actor: `owner:${session.email}`,
        action: 'admin.sso_code_issued',
        details: { clientId: SSO_CLIENT_ID },
        requestId: context.requestId,
      });
      return true;
    });
    // A sessão caiu entre a conferência e a transação: o login de novo.
    if (!issued) return { kind: 'login', location: loginLocation(request) };

    this.logger.info({ event: 'admin_sso_code_issued', clientId: SSO_CLIENT_ID }, 'código da entrada única');
    const target = new URL(request.redirect_uri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', request.state);
    // RFC 9207: o cliente confere de quem veio a resposta.
    target.searchParams.set('iss', issuer);
    return { kind: 'code', location: target.toString() };
  }

  async token(body: unknown, context: SsoRequestContext): Promise<SsoTokenResponse> {
    const issuer = this.issuer;
    if (issuer === undefined) throw unavailable();
    const key = await this.signingKey();
    const parsed = ssoTokenRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      this.logger.warn({ event: 'admin_sso_refused', reason: 'invalid_request' }, 'troca de código recusada');
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido.', 'invalid_request');
    }
    const request = parsed.data;
    if (request.client_id !== SSO_CLIENT_ID) throw this.invalidGrant('client_mismatch');

    const now = this.clock.now();
    const jti = newOpaqueId();
    const ref = opaqueRef(request.code);
    const outcome = await this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.adminSsoCodes, ref);
      if (data === undefined) return { ok: false as const, reason: 'unknown_code' as TokenRefusal };
      const code = parseDocument(adminSsoCodeSchema, COLLECTIONS.adminSsoCodes, ref, data);
      const sessionData = await tx.get(COLLECTIONS.adminSessions, code.sessionRef);
      const reason = this.checkCode(code, request, sessionData, now);
      // Usado ou recusado, o código sai: não vale de novo, nem para outro palpite do verificador.
      tx.delete(COLLECTIONS.adminSsoCodes, ref);
      this.audit.record(tx, {
        actor: `owner:${code.email}`,
        action: reason === undefined ? 'admin.sso_token_issued' : 'admin.sso_refused',
        details:
          reason === undefined ? { clientId: SSO_CLIENT_ID, jti } : { clientId: SSO_CLIENT_ID, reason },
        requestId: context.requestId,
      });
      return reason === undefined ? { ok: true as const, code } : { ok: false as const, reason };
    });
    if (!outcome.ok) throw this.invalidGrant(outcome.reason);

    const iat = Math.floor(now.getTime() / 1000);
    const claims: SsoIdTokenClaims = {
      iss: issuer,
      aud: SSO_CLIENT_ID,
      sub: accountRef(outcome.code.email),
      email: outcome.code.email,
      nonce: outcome.code.nonce,
      iat,
      exp: iat + SSO_ID_TOKEN_TTL_SECONDS,
      auth_time: Math.floor(outcome.code.authTime.getTime() / 1000),
      jti,
      amr: [...SSO_AMR],
    };
    this.logger.info({ event: 'admin_sso_token_issued', clientId: SSO_CLIENT_ID }, 'token da entrada única');
    return { id_token: signIdToken(key, claims), token_type: 'Bearer', expires_in: SSO_ID_TOKEN_TTL_SECONDS };
  }

  /** O motivo da recusa de um código achado, ou `undefined` se ele vale. */
  private checkCode(
    code: AdminSsoCode,
    request: { client_id: string; redirect_uri: string; code_verifier: string },
    sessionData: Record<string, unknown> | undefined,
    now: Date,
  ): TokenRefusal | undefined {
    if (code.expiresAt.getTime() <= now.getTime()) return 'expired_code';
    if (request.client_id !== code.clientId) return 'client_mismatch';
    if (!sameText(request.redirect_uri, code.redirectUri)) return 'redirect_uri_mismatch';
    if (!sameText(sha256Base64url(request.code_verifier), code.codeChallenge)) return 'pkce_mismatch';
    if (sessionData === undefined) return 'session_gone';
    const session = parseDocument(
      adminSessionSchema,
      COLLECTIONS.adminSessions,
      code.sessionRef,
      sessionData,
    );
    if (sessionState(session, now) !== 'valid' || session.email !== code.email) return 'session_gone';
    if (!this.auth.isOwner(code.email)) return 'not_owner';
    return undefined;
  }

  private invalidGrant(reason: TokenRefusal): ApiError {
    this.logger.warn({ event: 'admin_sso_refused', reason }, 'troca de código recusada');
    return new ApiError(HttpStatus.BAD_REQUEST, INVALID_GRANT_MESSAGE, 'invalid_grant');
  }

  private refuseAuthorize(status: 400 | 403 | 503, reason: AuthorizeRefusal): AuthorizeOutcome {
    if (reason === 'unavailable') {
      this.logger.error({ event: 'admin_sso_unavailable' }, 'entrada única sem configuração ou sem chave');
    } else {
      this.logger.warn({ event: 'admin_sso_refused', reason }, 'pedido de entrada única recusado');
    }
    return { kind: 'refused', status, reason };
  }

  /** A chave do cofre, lida uma vez. Sem ela (cofre vazio ou fora do formato), 503. */
  private async signingKey(): Promise<SsoSigningKey> {
    if (this.keyCache !== undefined) return this.keyCache;
    let pem: string | undefined;
    try {
      pem = await this.secrets.ssoSigningKey();
    } catch (error) {
      if (error instanceof SecretUnavailableError) throw unavailable();
      throw error;
    }
    const key = pem === undefined ? undefined : parseSsoSigningKey(pem);
    if (key === undefined) {
      this.logger.error(
        { event: 'admin_sso_key_missing', present: pem !== undefined },
        'chave da entrada única ausente ou fora do formato (cp-admin-sso-signing-key)',
      );
      throw unavailable();
    }
    this.keyCache = key;
    return key;
  }
}

/**
 * O login do console, que volta ao mesmo pedido (`/entrar?voltar=/sso/authorize?...`). O pedido é remontado dos campos
 * já conferidos, e não copiado da URL recebida.
 */
function loginLocation(request: SsoAuthorizeQuery): string {
  const query = new URLSearchParams({
    response_type: request.response_type,
    client_id: request.client_id,
    redirect_uri: request.redirect_uri,
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.code_challenge,
    code_challenge_method: request.code_challenge_method,
  });
  return `/entrar?voltar=${encodeURIComponent(`${SSO_PATHS.authorize}?${query.toString()}`)}`;
}
