import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/internal';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { isSelfManaged } from '../../auth/decorators.js';
import { ValidationException } from './api-error.js';

function declaredInputs(context: ExecutionContext): Set<number> {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, context.getClass(), context.getHandler().name) as
    Record<string, unknown> | undefined;
  return new Set(Object.keys(args ?? {}).map((key) => Number(key.split(':')[0])));
}

function hasBody(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  if (typeof body === 'object' && Object.keys(body).length === 0) return false;
  return true;
}

/**
 * Completa a validação global: uma rota que não declara `@Query` não aceita query string, e uma que
 * não declara `@Body` não aceita corpo. Assim nenhum campo chega à aplicação sem passar por um schema.
 */
@Injectable()
export class UndeclaredInputInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || isSelfManaged(this.reflector, context)) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    const inputs = declaredInputs(context);

    if (!inputs.has(RouteParamtypes.QUERY) && Object.keys(request.query).length > 0) {
      throw new ValidationException([
        { path: '', code: 'unrecognized_keys', message: 'Esta rota não aceita parâmetros de consulta' },
      ]);
    }
    if (!inputs.has(RouteParamtypes.BODY) && hasBody(request.body)) {
      throw new ValidationException([
        { path: '', code: 'unrecognized_keys', message: 'Esta rota não aceita corpo na requisição' },
      ]);
    }
    return next.handle();
  }
}
