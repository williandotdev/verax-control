import { type CanActivate, type ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ApiError } from '../common/http/api-error.js';
import type { OwnerContext } from '../pricing/pricing-store.js';
import { IAP_JWT_HEADER, IAP_VERIFIER, type IapJwtVerifier } from './iap-verifier.js';

/** O responsável autenticado, preso à requisição pela guarda. */
export type OwnerRequest = Request & { owner?: OwnerContext; id?: unknown };

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
/** O que um navegador manda em `Sec-Fetch-Site` numa chamada da própria página (ou digitada): o resto é recusado. */
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** O tipo de mídia do `Content-Type`, sem parâmetros (`application/json; charset=utf-8` → `application/json`). */
function mediaType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.split(';', 1)[0]?.trim().toLowerCase();
}

/**
 * Guarda global do `cp-admin` (só nesse papel): toda rota, exceto `/health` (a sonda do Cloud Run não passa pelo IAP),
 * exige o JWT do IAP válido e de um e-mail em `OWNER_PRINCIPALS` (401 sem token ou com token inválido; 403 com um token
 * válido de outra pessoa). Escritas exigem `Content-Type: application/json` (415) e recusam `Sec-Fetch-Site` de outro
 * site (403): o IAP autentica por cookie, e um formulário de outra página não pode publicar uma tabela. O console não
 * tem CORS: uma página de outra origem nem consegue mandar JSON para cá.
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  constructor(
    @Inject(IAP_VERIFIER) private readonly verifier: IapJwtVerifier,
    @InjectPinoLogger(OwnerGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const req = context.switchToHttp().getRequest<OwnerRequest>();
    if (req.method === 'GET' && req.path === '/health') return true;

    const result = await this.verifier.verify(headerValue(req.headers[IAP_JWT_HEADER]));
    if (!result.ok) {
      // Só o motivo: nem o token, nem o e-mail de quem não é responsável.
      this.logger.warn({ event: 'admin_auth_failed', reason: result.reason }, 'acesso ao console recusado');
      if (result.reason === 'not_owner') {
        throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'forbidden');
      }
      if (result.reason === 'keys_unavailable') {
        throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Console indisponível', 'admin_unavailable');
      }
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
    }

    if (!SAFE_METHODS.has(req.method)) {
      const site = headerValue(req.headers['sec-fetch-site']);
      if (site !== undefined && !ALLOWED_FETCH_SITES.has(site)) {
        this.logger.warn({ event: 'admin_cross_site_refused' }, 'escrita de outro site recusada');
        throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'cross_site');
      }
      if (mediaType(headerValue(req.headers['content-type'])) !== 'application/json') {
        throw new ApiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'Envie JSON', 'unsupported_media_type');
      }
    }
    req.owner = { email: result.email, ...(typeof req.id === 'string' ? { requestId: req.id } : {}) };
    return true;
  }
}

/** O responsável da requisição; a guarda global garante que ele existe em toda rota do console. */
export function ownerOf(req: OwnerRequest): OwnerContext {
  if (req.owner === undefined)
    throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
  return req.owner;
}
