import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ApiError } from './api-error.js';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
  requestId?: string;
}

/** Mensagens fixas por status: nada do erro original chega ao cliente sem opt-in (`ApiError`). */
const GENERIC_MESSAGES: Readonly<Partial<Record<number, string>>> = {
  400: 'Requisição inválida',
  401: 'Não autenticado',
  403: 'Sem permissão',
  404: 'Recurso não encontrado',
  405: 'Método não permitido',
  406: 'Formato de resposta não suportado',
  409: 'Conflito com o estado atual do recurso',
  413: 'Requisição muito grande',
  415: 'Tipo de conteúdo não suportado',
  422: 'Não foi possível processar a requisição',
  429: 'Muitas requisições, tente novamente mais tarde',
};

const INTERNAL_ERROR_MESSAGE = 'Erro interno';
const UNAVAILABLE_MESSAGE = 'Serviço temporariamente indisponível';

function statusName(status: number): string {
  const name = (HttpStatus as unknown as Record<number, string | undefined>)[status];
  return name
    ? name
        .toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    : 'Error';
}

/**
 * Erros que o Express gera antes do Nest (JSON malformado, corpo grande demais, charset inválido) vêm
 * do pacote http-errors com `status` 4xx e `expose: true`.
 */
function clientErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, expose } = exception as { status?: unknown; expose?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && expose === true ? status : undefined;
}

export function toErrorResponse(exception: unknown): ErrorResponseBody {
  const status =
    exception instanceof HttpException ? exception.getStatus() : (clientErrorStatus(exception) ?? 500);

  if (status >= 500) {
    const message = status === 503 ? UNAVAILABLE_MESSAGE : INTERNAL_ERROR_MESSAGE;
    return { statusCode: status, error: statusName(status), message };
  }

  if (exception instanceof ApiError) {
    return {
      statusCode: status,
      error: statusName(status),
      message: exception.message,
      ...(exception.code === undefined ? {} : { code: exception.code }),
    };
  }
  const message = GENERIC_MESSAGES[status] ?? GENERIC_MESSAGES[400] ?? INTERNAL_ERROR_MESSAGE;
  return { statusCode: status, error: statusName(status), message };
}

/**
 * Filtro global de erros (regra 9): resposta genérica com o `requestId` para suporte; o detalhe
 * vai só para o log, já com redaction. Mesmo desenho do filtro da API.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(AllExceptionsFilter.name) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const body = toErrorResponse(exception);

    if (!(exception instanceof HttpException) && body.statusCode >= 500) {
      this.logger.error({ err: exception }, 'erro não tratado');
    } else if (body.statusCode >= 500) {
      // Exceção HTTP lançada de propósito; quem lançou já registrou o motivo.
      this.logger.warn({ err: exception, statusCode: body.statusCode }, 'serviço indisponível');
    } else {
      this.logger.debug({ err: exception, statusCode: body.statusCode }, 'requisição rejeitada');
    }

    if (response.headersSent) return;
    response.status(body.statusCode).json({
      ...body,
      ...(typeof request.id === 'string' ? { requestId: request.id } : {}),
    });
  }
}
