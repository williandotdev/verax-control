import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  enforceRateLimit,
  type RateLimitRule,
  type TokenBucketLimiter,
} from '../../common/http/rate-limiter.js';
import { type OwnerRequest, PublicAdminRoute, sessionOf } from '../owner.guard.js';
import { AdminAuthService, type AuthRequestContext, type TotpEnrollmentView } from './admin-auth.service.js';
import {
  clearedSessionCookieOptions,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  sessionCookieValues,
} from './session-cookie.js';

/**
 * Limites por IP do login e do cadastro, em memória (o cp-admin roda com uma instância só). O IP é o `req.ip` pela
 * regra de `common/http/client-ip.ts`: atrás do Firebase Hosting, só é o IP de quem acessa quando as saídas do Hosting
 * estão em `TRUSTED_PROXIES`; sem a lista, todo acesso pelo Hosting conta no balde das saídas dele (degradação, não
 * forja). O bloqueio por conta (5 falhas em 15 min) vale de qualquer IP; o teto global segura uma enxurrada de vários
 * IPs (e as escritas no Firestore que cada falha gera).
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

function contextOf(req: OwnerRequest): AuthRequestContext {
  return typeof req.id === 'string' ? { requestId: req.id } : {};
}

/**
 * O login próprio do console (`/v1/admin/...`, só no cp-admin): entrar, sair, o primeiro cadastro (`/configurar`) e,
 * com sessão, a troca da senha e do aplicativo autenticador. O cookie da sessão só sai no `Set-Cookie`; o corpo nunca
 * traz o id dela. Toda resposta do console já sai com `Cache-Control: private, no-store`.
 */
@Controller('admin')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    @Inject(ADMIN_AUTH_LIMITS) private readonly limits: AdminAuthLimits,
  ) {}

  @PublicAdminRoute()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ email: string }> {
    enforceRateLimit(this.limits.login, req, res);
    enforceRateLimit(this.limits.loginGlobal, { ip: GLOBAL_KEY }, res);
    const grant = await this.auth.login(body, contextOf(req));
    res.cookie(SESSION_COOKIE_NAME, grant.sessionId, sessionCookieOptions());
    return { email: grant.email };
  }

  /** Sai: apaga a sessão no servidor e o cookie. Sem sessão, a mesma resposta (nada a revelar). */
  @PublicAdminRoute()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: OwnerRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(sessionCookieValues(req.headers.cookie), contextOf(req));
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
    enforceRateLimit(this.limits.setup, req, res);
    return this.auth.setupStart(body);
  }

  @PublicAdminRoute()
  @Post('setup/confirm')
  @HttpCode(HttpStatus.OK)
  async setupConfirm(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ email: string; recoveryCodes: string[] }> {
    enforceRateLimit(this.limits.setup, req, res);
    const result = await this.auth.setupConfirm(body, contextOf(req));
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
    enforceRateLimit(this.limits.account, req, res);
    await this.auth.changePassword(sessionOf(req), body, contextOf(req));
  }

  @Post('account/totp/start')
  @HttpCode(HttpStatus.OK)
  totpStart(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TotpEnrollmentView> {
    enforceRateLimit(this.limits.account, req, res);
    return this.auth.totpResetStart(sessionOf(req), body, contextOf(req));
  }

  @Post('account/totp/confirm')
  @HttpCode(HttpStatus.OK)
  totpConfirm(
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ recoveryCodes: string[] }> {
    enforceRateLimit(this.limits.account, req, res);
    return this.auth.totpResetConfirm(sessionOf(req), body, contextOf(req));
  }
}
