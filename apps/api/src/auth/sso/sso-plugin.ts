import { createHash, randomBytes } from 'node:crypto';
import { SSO_CLIENT_ID, ssoOpaqueSchema } from '@verax/shared';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import type { AppConfig } from '../../common/config/config.module.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { type AuthAuditSink, requestMetadata } from '../auth-audit.js';
import { AUTH_BASE_PATH } from '../auth.constants.js';
import { belongsToHost, currentHostTenant, type HostTenant } from '../host-tenant.js';
import { normalizeEmail } from '../login-attempts.js';
import { sameSecret, verifyIdToken } from './id-token.js';
import { exchangeCode, type SsoFetch } from './token-exchange.js';

/**
 * Entrada única no SIEM da Verax pelo console do responsável, do lado do painel (o cliente do OAuth; `docs/
 * ARQUITETURA.md`, "Entrada única"). Um plugin do Better Auth, para a sessão aberta no fim ser a mesma de sempre (o
 * cookie, o hook de criação da sessão com as regras da célula, o limite de 30 min sem uso e de 12 h, o CSRF das
 * escritas): nada de sessão própria. Só na célula, no endereço da equipe (`api-<CELL_STAFF_SLUG>`) e com a entrada
 * única configurada; em qualquer outro caso, as duas rotas respondem 404 (o `AuthController` e, de novo, aqui).
 *
 * - `GET /v1/auth/sso/start`: gera o `state`, o `nonce` e o verificador do PKCE (32 bytes aleatórios cada), grava os três
 *   no banco presos ao SHA-256 de um cookie de pré-login (`__Host-verax-sso`, 10 min, `HttpOnly`, `SameSite=Strict`) e
 *   manda o navegador ao `authorize` do console.
 * - `GET /v1/auth/sso/callback`: apaga o pedido do banco antes de conferir (uso único), confere o `state` (o pedido
 *   veio deste navegador: protege contra o login forçado, CSRF), o `iss` da resposta, troca o código no console
 *   (`token-exchange.ts`), confere o token com a chave FIXADA (`id-token.ts`), gasta o `jti` e abre a sessão do
 *   `admin_verax` que já existe com aquele e-mail. Não cria usuário: e-mail desconhecido, de outro papel, de um cliente,
 *   inativo ou sem a conta pronta (senha definitiva e MFA do painel) recebe a mesma recusa.
 *
 * A recusa é sempre a mesma: volta ao login do painel com `?sso=recusado`, sem dizer o motivo (ele vai ao log e à
 * auditoria, `auth.sso_login`). Nenhum segredo vai a log: nem o código, nem o token, nem o `state`.
 */

/** O cookie de pré-login: prende o pedido ao navegador que o começou. */
export const SSO_ATTEMPT_COOKIE = '__Host-verax-sso';
/** Quanto tempo o navegador tem entre o início e o retorno (o login do console cabe folgado). */
export const SSO_ATTEMPT_TTL_SECONDS = 10 * 60;
/** O caminho do retorno na API (o mesmo da lista `SSO_REDIRECT_URIS` do console). */
export const SSO_CALLBACK_PATH = `${AUTH_BASE_PATH}/sso/callback`;
export const SSO_START_PATH = `${AUTH_BASE_PATH}/sso/start`;
/** A ação da trilha de auditoria. */
export const SSO_AUDIT_ACTION = 'auth.sso_login';

export interface SsoPluginDependencies {
  config: Pick<AppConfig, 'sso' | 'cell' | 'API_ORIGIN'>;
  prisma: PrismaService;
  record: AuthAuditSink;
  fetch: SsoFetch;
  logger: { warn: (object: object, message: string) => void };
  now?: () => Date;
}

type Refusal =
  | 'missing_attempt'
  | 'unknown_attempt'
  | 'invalid_callback'
  | 'provider_error'
  | 'state_mismatch'
  | 'issuer_mismatch'
  | 'exchange_refused'
  | 'exchange_unavailable'
  | 'exchange_bad_response'
  | 'token_rejected'
  | 'replayed_token'
  | 'user_refused'
  | 'session_refused';

/** O retorno de sucesso do console: `code`, `state` e `iss` (RFC 9207), nada mais. */
const callbackSuccessSchema = z.strictObject({
  code: ssoOpaqueSchema,
  state: ssoOpaqueSchema,
  iss: z.string().min(1).max(200),
});

/** O retorno de erro do OAuth (o console não manda, mas um retorno com `error` nunca vira sessão). */
const callbackErrorSchema = z.looseObject({ error: z.string() });

function opaque(): string {
  return randomBytes(32).toString('base64url');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** O desafio S256 do PKCE: SHA-256 do verificador, em base64url. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

class SsoRefused extends Error {
  constructor(
    readonly reason: Refusal,
    readonly email?: string,
  ) {
    super(reason);
    this.name = 'SsoRefused';
  }
}

export function ssoPlugin(deps: SsoPluginDependencies): BetterAuthPlugin {
  const { config, prisma, record, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const callbackUrl = `${config.API_ORIGIN}${SSO_CALLBACK_PATH}`;
  const cookieOptions = {
    httpOnly: true,
    secure: true,
    sameSite: 'strict' as const,
    path: '/',
  };

  /** O endereço da equipe, com a entrada única configurada; senão, 404 (a rota "não existe"). */
  function staffHost(): { host: HostTenant; sso: NonNullable<AppConfig['sso']> } | undefined {
    const host = currentHostTenant();
    if (config.sso === null || config.cell === null || host === undefined || !host.staff) return undefined;
    return { host, sso: config.sso };
  }

  return {
    id: 'verax-sso',
    endpoints: {
      ssoStart: createAuthEndpoint('/sso/start', { method: 'GET' }, async (ctx) => {
        const staff = staffHost();
        if (staff === undefined) throw ctx.error('NOT_FOUND');
        const binding = opaque();
        const state = opaque();
        const nonce = opaque();
        const verifier = opaque();
        const at = now();
        await prisma.$transaction([
          prisma.ssoLoginAttempt.deleteMany({ where: { expiresAt: { lt: at } } }),
          prisma.ssoLoginAttempt.create({
            data: {
              id: sha256Hex(binding),
              stateHash: sha256Hex(state),
              nonce,
              codeVerifier: verifier,
              hostTenantId: staff.host.tenantId,
              expiresAt: new Date(at.getTime() + SSO_ATTEMPT_TTL_SECONDS * 1000),
            },
          }),
        ]);
        ctx.setCookie(SSO_ATTEMPT_COOKIE, binding, { ...cookieOptions, maxAge: SSO_ATTEMPT_TTL_SECONDS });
        const target = new URL(staff.sso.authorizeUrl);
        target.searchParams.set('response_type', 'code');
        target.searchParams.set('client_id', SSO_CLIENT_ID);
        target.searchParams.set('redirect_uri', callbackUrl);
        target.searchParams.set('state', state);
        target.searchParams.set('nonce', nonce);
        target.searchParams.set('code_challenge', pkceChallenge(verifier));
        target.searchParams.set('code_challenge_method', 'S256');
        ctx.setHeader('Cache-Control', 'no-store');
        throw ctx.redirect(target.toString());
      }),

      ssoCallback: createAuthEndpoint('/sso/callback', { method: 'GET' }, async (ctx) => {
        const staff = staffHost();
        if (staff === undefined) throw ctx.error('NOT_FOUND');
        const { host, sso } = staff;
        const metadata = requestMetadata(ctx.request?.headers ?? ctx.headers);
        ctx.setHeader('Cache-Control', 'no-store');
        // O cookie de pré-login sai em toda resposta: o pedido vale uma vez, deu certo ou não.
        ctx.setCookie(SSO_ATTEMPT_COOKIE, '', { ...cookieOptions, maxAge: 0 });

        try {
          const binding = ctx.getCookie(SSO_ATTEMPT_COOKIE);
          if (binding === null || !ssoOpaqueSchema.safeParse(binding).success) {
            throw new SsoRefused('missing_attempt');
          }
          // Uso único: a linha sai antes de qualquer conferência (só quem a apagou segue).
          const id = sha256Hex(binding);
          const attempt = await prisma.ssoLoginAttempt.findUnique({ where: { id } });
          const removed = await prisma.ssoLoginAttempt.deleteMany({ where: { id } });
          if (
            attempt === null ||
            removed.count !== 1 ||
            attempt.expiresAt.getTime() <= now().getTime() ||
            attempt.hostTenantId !== host.tenantId
          ) {
            throw new SsoRefused('unknown_attempt');
          }

          const query: unknown = ctx.query ?? {};
          if (callbackErrorSchema.safeParse(query).success) throw new SsoRefused('provider_error');
          const callback = callbackSuccessSchema.safeParse(query);
          if (!callback.success) throw new SsoRefused('invalid_callback');
          if (!sameSecret(sha256Hex(callback.data.state), attempt.stateHash)) {
            throw new SsoRefused('state_mismatch');
          }
          if (callback.data.iss !== sso.issuer) throw new SsoRefused('issuer_mismatch');

          const exchanged = await exchangeCode(deps.fetch, {
            tokenUrl: sso.tokenUrl,
            code: callback.data.code,
            redirectUri: callbackUrl,
            codeVerifier: attempt.codeVerifier,
          });
          if (!exchanged.ok) {
            throw new SsoRefused(
              exchanged.reason === 'refused'
                ? 'exchange_refused'
                : exchanged.reason === 'unavailable'
                  ? 'exchange_unavailable'
                  : 'exchange_bad_response',
            );
          }
          const verified = verifyIdToken(exchanged.response.id_token, {
            publicKey: sso.publicKey,
            keyId: sso.keyId,
            issuer: sso.issuer,
            audience: sso.clientId,
            nonce: attempt.nonce,
            now: now(),
          });
          if (!verified.ok) {
            logger.warn(
              { event: 'sso_token_rejected', reason: verified.reason },
              'token da entrada única recusado',
            );
            throw new SsoRefused('token_rejected');
          }
          const claims = verified.claims;
          const email = normalizeEmail(claims.email);
          if (email === undefined) throw new SsoRefused('token_rejected');

          // O mesmo token não abre uma segunda sessão (até ele vencer).
          await prisma.ssoTokenUse.deleteMany({ where: { expiresAt: { lt: now() } } });
          try {
            await prisma.ssoTokenUse.create({
              data: { jti: claims.jti, expiresAt: new Date(claims.exp * 1000) },
            });
          } catch {
            throw new SsoRefused('replayed_token', email);
          }

          // Só o `admin_verax` que já existe, da equipe, ativo e com a conta pronta; nada é criado.
          const user = await prisma.user.findUnique({
            where: { email },
            select: {
              id: true,
              role: true,
              tenantId: true,
              status: true,
              mustChangePassword: true,
              twoFactorEnabled: true,
            },
          });
          if (
            user === null ||
            user.role !== 'admin_verax' ||
            user.status !== 'active' ||
            user.mustChangePassword ||
            !user.twoFactorEnabled ||
            !belongsToHost(user, host)
          ) {
            throw new SsoRefused('user_refused', email);
          }

          // A sessão normal do Better Auth: o hook de criação aplica as mesmas regras de sempre (endereço, usuário e
          // cliente ativos) e grava o cliente do endereço.
          const session = await ctx.context.internalAdapter.createSession(user.id);
          const fullUser = await ctx.context.internalAdapter.findUserById(user.id);
          if (!session || !fullUser) throw new SsoRefused('session_refused', email);
          await setSessionCookie(ctx, { session, user: fullUser });
          await record({
            actor: { type: 'user', id: user.id, tenantId: null },
            action: SSO_AUDIT_ACTION,
            resourceType: 'login',
            resourceId: email,
            outcome: 'success',
            statusCode: 200,
            ...metadata,
          });
        } catch (error) {
          if (!(error instanceof SsoRefused)) {
            // Um erro do Better Auth ao criar a sessão (o hook recusou) também é recusa; o resto sobe.
            if (!(error instanceof Error) || error.name !== 'APIError') throw error;
            return refuse(new SsoRefused('session_refused'));
          }
          return refuse(error);
        }
        throw ctx.redirect(`${host.panelOrigin}/`);

        async function refuse(refusal: SsoRefused): Promise<never> {
          logger.warn({ event: 'sso_login_refused', reason: refusal.reason }, 'entrada única recusada');
          await record({
            actor: { type: 'anonymous' },
            action: SSO_AUDIT_ACTION,
            resourceType: 'login',
            ...(refusal.email !== undefined && { resourceId: refusal.email }),
            outcome: 'denied',
            statusCode: 401,
            after: { reason: refusal.reason },
            ...metadata,
          });
          throw ctx.redirect(`${host.panelOrigin}/login?sso=recusado`);
        }
      }),
    },
  } satisfies BetterAuthPlugin;
}
