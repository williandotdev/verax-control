import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { casesVisibleTo } from './cases-mode.js';

/**
 * As rotas dos casos só existem para quem pode vê-los (`CASES_MODE`). Para os outros, a resposta é a de uma rota que não
 * existe: 404 genérico, antes de conferir a query ou o id. Roda depois dos guards globais: sem sessão continua 401, e sem
 * permissão, 403.
 */
@Injectable()
export class CasesVisibleGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'CASES_MODE'>) {}

  canActivate(context: ExecutionContext): boolean {
    const { auth } = context.switchToHttp().getRequest<Request>();
    if (auth === undefined || !casesVisibleTo(this.config.CASES_MODE, auth.role)) {
      throw new NotFoundException();
    }
    return true;
  }
}
