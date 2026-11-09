import { type CanActivate, type ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ApiError } from '../common/http/api-error.js';
import type { OwnerContext } from '../pricing/pricing-store.js';
import { AdminAuthService, type AuthenticatedSession } from './auth/admin-auth.service.js';
import { sessionCookieValues } from './auth/session-cookie.js';

/** O responsável autenticado e a sessão dele, presos à requisição pela guarda. */
export type OwnerRequest = Request & {
  owner?: OwnerContext;
  adminSession?: AuthenticatedSession;
  id?: unknown;
};

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
/** O que um navegador manda em `Sec-Fetch-Site` numa chamada da própria página (ou digitada): o resto é recusado. */
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

const PUBLIC_ADMIN_ROUTE = Symbol('PUBLIC_ADMIN_ROUTE');

/**
 * Marca uma rota do console que abre sem sessão: o login, a saída e o primeiro cadastro (`admin-auth.controller.ts`).
 * As escritas delas continuam exigindo JSON e a mesma origem.
 */
export const PublicAdminRoute = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ADMIN_ROUTE, true);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** O tipo de mídia do `Content-Type`, sem parâmetros (`application/json; charset=utf-8` → `application/json`). */
function mediaType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.split(';', 1)[0]?.trim().toLowerCase();
}

/**
 * Guarda global do `cp-admin` (só nesse papel). Toda rota, exceto `/health` (a sonda do Cloud Run) e as marcadas com
 * `@PublicAdminRoute()`, exige a sessão do login próprio do console (cookie `__session`, `AdminAuthService`): sem
 * sessão, ou com ela vencida, 401 `unauthenticated`; de um e-mail que saiu de `OWNER_PRINCIPALS`, 403. Escritas, com
 * sessão ou não, exigem `Content-Type: application/json` (415) e recusam `Sec-Fetch-Site` de outro site (403): o
 * cookie é `SameSite=Strict`, e mesmo assim um formulário de outra página não chega a publicar uma tabela nem a tentar
 * um login. O console não tem CORS: uma página de outra origem nem consegue mandar JSON para cá.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly reflector: Reflector,
    @InjectPinoLogger(OwnerGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const req = context.switchToHttp().getRequest<OwnerRequest>();
    if (req.method === 'GET' && req.path === '/health') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ADMIN_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      this.checkWrite(req);
      return true;
    }

    const result = await this.auth.authenticate(sessionCookieValues(req.headers.cookie));
    if (!result.ok) {
      // Só o motivo: nem o cookie, nem o e-mail. Sessão ausente ou vencida é o dia a dia (o console volta ao login).
      if (result.reason === 'not_owner') {
        this.logger.warn(
          { event: 'admin_auth_failed', reason: 'not_owner' },
          'sessão de quem não é responsável',
        );
        throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'forbidden');
      }
      this.logger.info(
        { event: 'admin_session_refused', reason: result.reason },
        'sessão do console ausente',
      );
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
    }

    this.checkWrite(req);
    req.owner = { email: result.email, ...(typeof req.id === 'string' ? { requestId: req.id } : {}) };
    req.adminSession = { email: result.email, sessionRef: result.sessionRef };
    return true;
  }

  private checkWrite(req: OwnerRequest): void {
    if (SAFE_METHODS.has(req.method)) return;
    const site = headerValue(req.headers['sec-fetch-site']);
    if (site !== undefined && !ALLOWED_FETCH_SITES.has(site)) {
      this.logger.warn({ event: 'admin_cross_site_refused' }, 'escrita de outro site recusada');
      throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'cross_site');
    }
    if (mediaType(headerValue(req.headers['content-type'])) !== 'application/json') {
      throw new ApiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'Envie JSON', 'unsupported_media_type');
    }
  }
}

/** O responsável da requisição; a guarda global garante que ele existe em toda rota do console com sessão. */
export function ownerOf(req: OwnerRequest): OwnerContext {
  if (req.owner === undefined)
    throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
  return req.owner;
}

/** A sessão da requisição (para trocar a senha ou o aplicativo); mesma garantia de `ownerOf`. */
export function sessionOf(req: OwnerRequest): AuthenticatedSession {
  if (req.adminSession === undefined)
    throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
  return req.adminSession;
}
