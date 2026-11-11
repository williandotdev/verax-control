import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { panelOriginOf } from '../auth/host-tenant.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Limite por IP das rotas públicas dos links: 10 chamadas em 15 min, somadas as duas rotas. */
export const LINK_ATTEMPT_MAX = 10;
export const LINK_ATTEMPT_WINDOW_MINUTES = 15;
/** As linhas de IPs que não voltaram em um dia saem na chamada seguinte de qualquer IP. */
const LINK_ATTEMPT_KEEP_HOURS = 24;

/**
 * Reserva uma chamada do IP e diz se ela pode seguir. Conta e decide numa única instrução (janela fixa), como o
 * bloqueio do login: chamadas simultâneas não passam juntas pelo limite. Fora da transação da requisição: a recusa do
 * link não desfaz a contagem.
 */
export async function reserveLinkAttempt(db: Prisma.TransactionClient, ip: string): Promise<boolean> {
  const key = `escalation-link:${ip}`.slice(0, 100);
  await db.$executeRaw`
    DELETE FROM "PublicLinkAttempt"
    WHERE "windowStart" < now() - make_interval(hours => ${LINK_ATTEMPT_KEEP_HOURS})`;
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "PublicLinkAttempt" (key, count, "windowStart")
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN "PublicLinkAttempt"."windowStart" > now() - make_interval(mins => ${LINK_ATTEMPT_WINDOW_MINUTES})
          THEN "PublicLinkAttempt".count + 1
        ELSE 1
      END,
      "windowStart" = CASE
        WHEN "PublicLinkAttempt"."windowStart" > now() - make_interval(mins => ${LINK_ATTEMPT_WINDOW_MINUTES})
          THEN "PublicLinkAttempt"."windowStart"
        ELSE now()
      END
    RETURNING count`;
  return (rows[0]?.count ?? Number.POSITIVE_INFINITY) <= LINK_ATTEMPT_MAX;
}

/**
 * Portão das rotas públicas dos links do contato de escalonamento (D8), antes do handler:
 * - só o painel chama: o `POST` precisa vir da origem do painel (como as rotas de autenticação) e em JSON. Formulário
 *   HTML de outro site não chega aqui;
 * - limite por IP (`LINK_ATTEMPT_MAX` em `LINK_ATTEMPT_WINDOW_MINUTES`), o mesmo interruptor do limite das rotas de
 *   autenticação (`AUTH_RATE_LIMIT_ENABLED`, que só os testes desligam e a produção exige ligado).
 *
 * As recusas vão só para o log, sem o corpo (o token) e sem endereço: quem chama não tem sessão, e a trilha de
 * auditoria não recebe registro anônimo recusado.
 */
@Injectable()
export class EscalationLinkGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    @InjectPinoLogger(EscalationLinkGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    // Na célula (CE-01), o painel do cliente do endereço.
    const panelOrigin = panelOriginOf(this.config, request);
    if (panelOrigin === undefined || request.get('origin') !== panelOrigin) {
      this.logger.warn({ escalationLink: { refused: 'origin' } }, 'link do contato recusado');
      throw new ApiError(HttpStatus.FORBIDDEN, 'Requisição recusada', 'ORIGIN_REFUSED');
    }
    if (request.is('application/json') !== 'application/json') throw new UnsupportedMediaTypeException();
    if (this.config.AUTH_RATE_LIMIT_ENABLED && !(await reserveLinkAttempt(this.prisma, request.ip ?? ''))) {
      this.logger.warn({ escalationLink: { refused: 'rate_limit' } }, 'link do contato recusado');
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'Muitas tentativas. Tente novamente em alguns minutos.',
        'TOO_MANY_REQUESTS',
      );
    }
    return true;
  }
}
