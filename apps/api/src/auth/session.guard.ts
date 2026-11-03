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
import { DenialAudit } from '../common/audit/denial-audit.service.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { PASSWORD_CHANGE_REQUIRED_CODE } from '@verax/shared';
import {
  AUTH,
  MFA_REQUIRED_CODE,
  MFA_REQUIRED_MESSAGE,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
} from './auth.constants.js';
import type { Auth } from './auth.factory.js';
import { ALLOW_WITH_TEMPORARY_PASSWORD_KEY, ALLOW_WITHOUT_MFA_KEY, IS_PUBLIC_KEY } from './decorators.js';
import { resolveSession } from './session-validation.js';

/**
 * Guard global: toda rota exige sessão válida, exceto as marcadas com `@Public()`.
 *
 * Além da validação do Better Auth (assinatura do cookie, expiração por inatividade), aplica as regras de
 * `resolveSession` (12 h, usuário e cliente ativos) e o MFA a cada requisição, e repassa o cookie renovado.
 * Desativar um usuário ou um cliente derruba as sessões abertas na requisição seguinte.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly denials: DenialAudit,
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
    const auth = await resolveSession(this.prisma, data);
    if (!auth) throw new UnauthorizedException();
    request.auth = auth;

    // Senha temporária: antes de tudo, a pessoa define a própria senha (depois vem o MFA).
    const allowWithTemporaryPassword = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_WITH_TEMPORARY_PASSWORD_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (auth.mustChangePassword && !allowWithTemporaryPassword) {
      await this.denials.record(request, HttpStatus.FORBIDDEN);
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        PASSWORD_CHANGE_REQUIRED_MESSAGE,
        PASSWORD_CHANGE_REQUIRED_CODE,
      );
    }

    // MFA obrigatório (T2.2): sem ele, a sessão só alcança as rotas marcadas para o cadastro do MFA.
    const allowWithoutMfa = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WITHOUT_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!auth.mfaEnabled && !allowWithoutMfa) {
      await this.denials.record(request, HttpStatus.FORBIDDEN);
      throw new ApiError(HttpStatus.FORBIDDEN, MFA_REQUIRED_MESSAGE, MFA_REQUIRED_CODE);
    }
    return true;
  }
}
