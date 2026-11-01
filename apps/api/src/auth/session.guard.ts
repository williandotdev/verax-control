import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request, Response } from 'express';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { UserRole } from '../generated/prisma/enums.js';
import { AUTH, MFA_REQUIRED_CODE, SESSION_ABSOLUTE_MAX_MS } from './auth.constants.js';
import type { Auth } from './auth.factory.js';
import { ALLOW_WITHOUT_MFA_KEY, IS_PUBLIC_KEY } from './decorators.js';

const ROLES = new Set<string>(Object.values(UserRole));

/**
 * Guard global: toda rota exige sessão válida, exceto as marcadas com `@Public()`.
 *
 * Além da validação do Better Auth (assinatura do cookie, expiração por inatividade), confere a duração
 * máxima de 12 h, o status do usuário e o MFA a cada requisição, e repassa o cookie renovado.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const result = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      returnHeaders: true,
    });
    // Renovação por atividade: o Better Auth devolve o cookie com a nova expiração.
    for (const cookie of result.headers.getSetCookie()) response.append('Set-Cookie', cookie);

    const data = result.response;
    if (!data) throw new UnauthorizedException();

    const { session, user } = data;
    const tooOld = Date.now() - new Date(session.createdAt).getTime() > SESSION_ABSOLUTE_MAX_MS;
    const inactive = user.status !== 'active' || !ROLES.has(user.role);
    if (tooOld || inactive) {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      throw new UnauthorizedException();
    }

    const role = user.role as UserRole;
    const tenantId = user.tenantId ?? null;
    const activeTenantId = role === 'admin_verax' ? (session.activeTenantId ?? null) : null;
    const auth: RequestAuth = {
      sessionId: session.id,
      userId: user.id,
      email: user.email,
      role,
      tenantId,
      activeTenantId,
      // Regra 4: o cliente do escopo vem sempre da sessão, nunca do corpo, da query ou da URL.
      scopeTenantId: role === 'admin_verax' ? activeTenantId : tenantId,
      mfaEnabled: user.twoFactorEnabled === true,
    };
    request.auth = auth;

    // MFA obrigatório (T2.2): sem ele, a sessão só alcança as rotas marcadas para o cadastro do MFA.
    const allowWithoutMfa = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WITHOUT_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!auth.mfaEnabled && !allowWithoutMfa) {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        'Cadastre a verificação em duas etapas para continuar',
        MFA_REQUIRED_CODE,
      );
    }
    return true;
  }
}
