import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpStatus,
  Inject,
  Injectable,
  Req,
  Res,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { doubleCsrf } from 'csrf-csrf';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { AllowWithoutMfa, Authenticated, isSelfManaged } from './decorators.js';

export const CSRF_HEADER = 'x-csrf-token';
export const CSRF_COOKIE = '__Host-verax.csrf';
const SESSION_COOKIE = '__Secure-verax.session_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CSRF_UTILITIES = Symbol('CSRF_UTILITIES');
export type CsrfUtilities = ReturnType<typeof doubleCsrf>;

/**
 * Token CSRF por sessão (padrão "double submit" assinado, da csrf-csrf): o token vai no corpo de
 * `GET /v1/csrf-token`, o cookie `__Host-` guarda o HMAC, e o par só vale para o cookie de sessão atual.
 */
export function createCsrfUtilities(config: AppConfig): CsrfUtilities {
  return doubleCsrf({
    getSecret: () => config.CSRF_SECRET,
    getSessionIdentifier: (request) => {
      const session = (request.cookies as Record<string, unknown>)[SESSION_COOKIE];
      return typeof session === 'string' ? session : '';
    },
    cookieName: CSRF_COOKIE,
    cookieOptions: { httpOnly: true, secure: true, sameSite: 'strict', path: '/' },
    getCsrfTokenFromRequest: (request) => request.get(CSRF_HEADER),
  });
}

/** Entrega o token CSRF da sessão atual ao painel. */
@Controller('csrf-token')
export class CsrfController {
  constructor(@Inject(CSRF_UTILITIES) private readonly csrf: CsrfUtilities) {}

  @Get()
  @Authenticated()
  @AllowWithoutMfa()
  token(@Req() request: Request, @Res({ passthrough: true }) response: Response): { token: string } {
    return { token: this.csrf.generateCsrfToken(request, response, { overwrite: true }) };
  }
}

/**
 * Proteção CSRF (T2.3) em toda escrita autenticada: origem do painel e token válido para a sessão. Roda
 * depois do `SessionGuard`. A autenticação (`@SelfManaged`) tem a própria checagem de origem.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(CSRF_UTILITIES) private readonly csrf: CsrfUtilities,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http' || isSelfManaged(this.reflector, context)) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method) || request.auth === undefined) return true;

    if (request.get('origin') !== this.config.WEB_ORIGIN || !this.csrf.validateRequest(request)) {
      throw new ApiError(HttpStatus.FORBIDDEN, 'Requisição recusada pela proteção CSRF', 'CSRF_INVALID');
    }
    return true;
  }
}
