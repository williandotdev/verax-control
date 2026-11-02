import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasPermission, type Permission } from '@verax/shared';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DenialAudit } from '../common/audit/denial-audit.service.js';
import { AUTHENTICATED_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY } from './decorators.js';

/**
 * Autorização por papel com negação por padrão (T2.4). Roda depois do `SessionGuard`:
 * - rota `@Public()`: liberada;
 * - rota com `@RequirePermission(...)`: o papel da sessão precisa ter todas;
 * - rota com `@Authenticated()`: basta a sessão;
 * - rota sem nada declarado: negada, e o descuido vai para o log (o meta-teste de rotas pega antes).
 *
 * Escrita negada vai para a trilha de auditoria.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly denials: DenialAudit,
    @InjectPinoLogger(PermissionsGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.auth;
    if (!auth) throw new ForbiddenException();

    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    if (required && required.length > 0) {
      if (required.every((permission) => hasPermission(auth.role, permission))) return true;
      return this.deny(request);
    }
    if (this.reflector.getAllAndOverride<boolean | undefined>(AUTHENTICATED_KEY, targets)) return true;

    this.logger.error(
      { route: `${context.getClass().name}.${context.getHandler().name}` },
      'rota sem permissão declarada: negada por padrão',
    );
    return this.deny(request);
  }

  private async deny(request: Request): Promise<never> {
    await this.denials.record(request, HttpStatus.FORBIDDEN);
    throw new ForbiddenException();
  }
}
