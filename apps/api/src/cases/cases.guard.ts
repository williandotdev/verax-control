import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { DenialAudit } from '../common/audit/denial-audit.service.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { casesOperable, casesVisibleTo } from './cases-mode.js';

/** A resposta de uma rota que não existe. A escrita recusada de quem tem sessão fica na trilha, como nos outros guards. */
async function hide(denials: DenialAudit, request: Request): Promise<never> {
  await denials.record(request, HttpStatus.NOT_FOUND);
  throw new NotFoundException();
}

/**
 * As rotas dos casos só existem para quem pode vê-los (`CASES_MODE`). Para os outros, a resposta é a de uma rota que não
 * existe: 404 genérico, antes de conferir a query ou o id. Roda depois dos guards globais: sem sessão continua 401, e sem
 * permissão, 403.
 */
@Injectable()
export class CasesVisibleGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'CASES_MODE'>,
    private readonly denials: DenialAudit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const { auth } = request;
    if (auth === undefined || !casesVisibleTo(this.config.CASES_MODE, auth.role)) {
      return hide(this.denials, request);
    }
    return true;
  }
}

/** As escritas dos casos só existem com eles ligados (`casesOperable`), para todos os papéis. */
@Injectable()
export class CasesOperableGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'CASES_MODE'>,
    private readonly denials: DenialAudit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (casesOperable(this.config.CASES_MODE)) return true;
    return hide(this.denials, context.switchToHttp().getRequest<Request>());
  }
}
