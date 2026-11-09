import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../common/config/config.module.js';
import { ApiError } from '../../common/http/api-error.js';
import { rateLimitKey, type RateLimitRule, type TokenBucketLimiter } from '../../common/http/rate-limiter.js';
import { type OwnerRequest, PublicAdminRoute, sessionOf } from '../owner.guard.js';
import { parseBody } from '../validation.js';
import {
  enrollmentConfirmRequestSchema,
  loginRequestSchema,
  passwordChangeRequestSchema,
  setupStartRequestSchema,
  totpResetStartRequestSchema,
} from './admin-auth.schema.js';
import { AdminAuthService, type AuthRequestContext, type TotpEnrollmentView } from './admin-auth.service.js';
import {
  clearedSessionCookieOptions,
  clearTossedSessionCookies,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  sessionCookieValues,
} from './session-cookie.js';

/**
 * Limites do login, do cadastro e da conta, em memória (o cp-admin roda com uma instância só). Só contam as tentativas
 * que falham: o corpo é validado antes (um `{}` não gasta nada), a tentativa é tirada do balde antes de conferir (sem
 * janela para pedidos em paralelo passarem de graça) e devolvida no sucesso ou num erro do servidor (5xx).
 *
 * O IP é o `req.ip` pela regra de `common/http/client-ip.ts`. No cp-admin, `TRUSTED_PROXIES` fica vazia de propósito:
 * listar as saídas da CDN do Hosting deixaria qualquer um com um serviço na mesma CDN chamar o `run.app` direto com um
 * `X-Forwarded-For` escolhido. Sem a lista, quem chega pelo Hosting conta no balde da saída do Hosting (vários acessos
 * no mesmo balde: degradação, não forja), e quem chama o `run.app` direto, no do próprio IP. O teto global segura uma
 * enxurrada de muitos IPs; o bloqueio da conta (`AdminAuthService`) só conta a senha certa com o segundo fator errado.
 */
export const LOGIN_PER_IP: RateLimitRule = { capacity: 10, windowMs: 15 * 60_000 };
export const LOGIN_GLOBAL: RateLimitRule = { capacity: 100, windowMs: 15 * 60_000 };
export const SETUP_PER_IP: RateLimitRule = { capacity: 10, windowMs: 15 * 60_000 };
export const ACCOUNT_PER_IP: RateLimitRule = { capacity: 10, windowMs: 15 * 60_000 };

export const ADMIN_AUTH_LIMITS = Symbol('ADMIN_AUTH_LIMITS');
export interface AdminAuthLimits {
  login: TokenBucketLimiter;
  loginGlobal: TokenBucketLimiter;
  setup: TokenBucketLimiter;
  account: TokenBucketLimiter;
}

const GLOBAL_KEY = 'todos';

interface Bucket {
  limiter: TokenBucketLimiter;
  key: string;
}

function contextOf(req: OwnerRequest): AuthRequestContext {
  return typeof req.id === 'string' ? { requestId: req.id } : {};
}

/** Uma falha que conta nos limites: qualquer 4xx depois da validação do corpo (credencial, token ou código errados). */
function countsAsFailure(error: unknown): boolean {
  return error instanceof ApiError && error.getStatus() >= 400 && error.getStatus() < 500;
}

/**
 * Tira uma tentativa de cada balde (todos ou nenhum: o primeiro estourado devolve os anteriores e responde 429), roda a
 * ação e devolve as tentativas se ela não falhar por credencial.
 */
async function counted<T>(buckets: readonly Bucket[], res: Response, run: () => Promise<T>): Promise<T> {
  const taken: Bucket[] = [];
  for (const bucket of buckets) {
    const decision = bucket.limiter.take(bucket.key);
    if (!decision.allowed) {
      for (const done of taken) done.limiter.refund(done.key);
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'Muitas tentativas. Tente novamente mais tarde.',
        'rate_limited',
      );
    }
    taken.push(bucket);
  }
  try {
    const result = await run();
    for (const done of taken) done.limiter.refund(done.key);
    return result;
  } catch (error) {
    if (!countsAsFailure(error)) for (const done of taken) done.limiter.refund(done.key);
    throw error;
  }
}

/**
 * O login próprio do console (`/v1/admin/...`, só no cp-admin): entrar, sair, o primeiro cadastro (`/configurar`) e,
 * com sessão, a troca da senha e do aplicativo autenticador. O cookie da sessão só sai no `Set-Cookie`; o corpo nunca
 * traz o id dela. Toda resposta do console já sai com `Cache-Control: private, no-store`.
 */
@Controller('admin')
export class AdminAuthController {
  private readonly zone: string;

  constructor(
    private readonly auth: AdminAuthService,
    @Inject(ADMIN_AUTH_LIMITS) private readonly limits: AdminAuthLimits,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.zone = config.CLOUDFLARE_ZONE_NAME;
  }

  @PublicAdminRoute()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ email: string }> {
    const request = parseBody(loginRequestSchema, body);
    const grant = await counted(
      [
        { limiter: this.limits.login, key: rateLimitKey(req.ip) },
        { limiter: this.limits.loginGlobal, key: GLOBAL_KEY },
      ],
      res,
      () => this.auth.login(request, contextOf(req)),
    );
    clearTossedSessionCookies(res, this.zone);
    res.cookie(SESSION_COOKIE_NAME, grant.sessionId, sessionCookieOptions());
    return { email: grant.email };
  }

  /** Sai: apaga a sessão no servidor e o cookie. Sem sessão, a mesma resposta (nada a revelar). */
  @PublicAdminRoute()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: OwnerRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(sessionCookieValues(req.headers.cookie), contextOf(req));
    clearTossedSessionCookies(res, this.zone);
    res.clearCookie(SESSION_COOKIE_NAME, clearedSessionCookieOptions());
  }

  @PublicAdminRoute()
  @Get('setup')
  async setupStatus(): Promise<{ open: boolean }> {
    return { open: await this.auth.setupOpen() };
  }

  @PublicAdminRoute()
  @Post('setup/start')
  @HttpCode(HttpStatus.OK)
  setupStart(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TotpEnrollmentView> {
    const request = parseBody(setupStartRequestSchema, body);
    return counted([{ limiter: this.limits.setup, key: rateLimitKey(req.ip) }], res, () =>
      this.auth.setupStart(request),
    );
  }

  @PublicAdminRoute()
  @Post('setup/confirm')
  @HttpCode(HttpStatus.OK)
  async setupConfirm(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ email: string; recoveryCodes: string[] }> {
    const request = parseBody(enrollmentConfirmRequestSchema, body);
    const result = await counted([{ limiter: this.limits.setup, key: rateLimitKey(req.ip) }], res, () =>
      this.auth.setupConfirm(request, contextOf(req)),
    );
    clearTossedSessionCookies(res, this.zone);
    res.cookie(SESSION_COOKIE_NAME, result.sessionId, sessionCookieOptions());
    return { email: result.email, recoveryCodes: result.recoveryCodes };
  }

  @Post('account/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const request = parseBody(passwordChangeRequestSchema, body);
    await counted([{ limiter: this.limits.account, key: rateLimitKey(req.ip) }], res, () =>
      this.auth.changePassword(sessionOf(req), request, contextOf(req)),
    );
  }

  @Post('account/totp/start')
  @HttpCode(HttpStatus.OK)
  totpStart(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TotpEnrollmentView> {
    const request = parseBody(totpResetStartRequestSchema, body);
    return counted([{ limiter: this.limits.account, key: rateLimitKey(req.ip) }], res, () =>
      this.auth.totpResetStart(sessionOf(req), request, contextOf(req)),
    );
  }

  @Post('account/totp/confirm')
  @HttpCode(HttpStatus.OK)
  totpConfirm(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ recoveryCodes: string[] }> {
    const request = parseBody(enrollmentConfirmRequestSchema, body);
    return counted([{ limiter: this.limits.account, key: rateLimitKey(req.ip) }], res, () =>
      this.auth.totpResetConfirm(sessionOf(req), request, contextOf(req)),
    );
  }
}
