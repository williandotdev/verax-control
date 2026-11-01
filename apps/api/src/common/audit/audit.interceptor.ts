import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { type AuditDetails, requestContext } from '../context/request-context.js';
import { toErrorResponse } from '../http/all-exceptions.filter.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type AuditActor, type AuditEntry, AuditService } from './audit.service.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Limites da transação de uma requisição de escrita. */
const TRANSACTION_MAX_WAIT_MS = 5_000;
const TRANSACTION_TIMEOUT_MS = 15_000;

type RequestEntry = Omit<AuditEntry, 'outcome' | 'statusCode'>;

function resolveActor(request: Request): AuditActor {
  return request.auth
    ? { type: 'user', id: request.auth.userId, tenantId: request.auth.tenantId }
    : { type: 'anonymous' };
}

function routeOf(request: Request): string {
  const route = (request.route as { path?: unknown } | undefined)?.path;
  return typeof route === 'string' ? route : request.path;
}

function successStatus(context: ExecutionContext, method: string): number {
  const declared = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as number | undefined;
  return declared ?? (method === 'POST' ? 201 : 200);
}

/**
 * Trilha de auditoria de toda operação de escrita (POST, PUT, PATCH e DELETE).
 *
 * O handler roda dentro de uma transação, exposta aos services por `PrismaService.db`. No sucesso, o
 * registro de auditoria entra na mesma transação: ou a alteração e a auditoria são gravadas juntas, ou
 * nada é gravado. Na falha (validação, permissão, erro), a transação é desfeita e a tentativa é registrada
 * à parte com o status do erro.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @InjectPinoLogger(AuditInterceptor.name) private readonly logger: PinoLogger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request & { id?: unknown }>();
    if (!WRITE_METHODS.has(request.method)) return next.handle();

    const entry: RequestEntry = {
      actor: resolveActor(request),
      action: `${request.method} ${routeOf(request)}`,
      resourceId: typeof request.params['id'] === 'string' ? request.params['id'] : undefined,
      ip: request.ip,
      userAgent: request.get('user-agent'),
      requestId: typeof request.id === 'string' ? request.id : undefined,
    };
    return from(this.runAudited(entry, successStatus(context, request.method), next));
  }

  private async runAudited(entry: RequestEntry, statusCode: number, next: CallHandler): Promise<unknown> {
    const details: AuditDetails = {};
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const result: unknown = await requestContext.run({ tx, audit: details }, () =>
            lastValueFrom(next.handle() as Observable<unknown>, { defaultValue: undefined }),
          );
          await this.auditService.write(tx, { ...entry, ...details, outcome: 'success', statusCode });
          return result;
        },
        { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (error) {
      await this.recordFailure(entry, details, error);
      throw error;
    }
  }

  private async recordFailure(entry: RequestEntry, details: AuditDetails, error: unknown): Promise<void> {
    const { statusCode } = toErrorResponse(error);
    try {
      // A alteração foi desfeita: registra-se a tentativa, sem estado anterior nem novo.
      await this.auditService.write(this.prisma, {
        ...entry,
        action: details.action ?? entry.action,
        resourceType: details.resourceType,
        resourceId: details.resourceId ?? entry.resourceId,
        outcome: statusCode === 401 || statusCode === 403 ? 'denied' : 'failure',
        statusCode,
      });
    } catch (auditError) {
      // Sem banco não há onde gravar; o log (com redaction) guarda a tentativa para não perdê-la.
      this.logger.error({ err: auditError, audit: { ...entry, statusCode } }, 'falha ao gravar auditoria');
    }
  }
}
