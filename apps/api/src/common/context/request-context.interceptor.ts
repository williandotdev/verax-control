import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { requestContext } from './request-context.js';

/**
 * Abre o contexto da requisição com a identidade montada pelos guards. É o primeiro interceptor global:
 * a assinatura do handler acontece dentro do `run`, então todo código chamado por ele enxerga o contexto.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    return new Observable((subscriber) =>
      requestContext.run({ auth: request.auth }, () => next.handle().subscribe(subscriber)),
    );
  }
}
