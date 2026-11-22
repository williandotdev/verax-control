import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { type NodeSyncResponse, nodeSyncRequestSchema } from '@verax/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../common/http/api-error.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { ENROLLMENT_SECRET_PATTERN } from '../enrollment/enrollment.js';
import { WorkerCallerGuard, WorkerCallers } from '../internal/worker-caller.js';
import { isSignedJwtShape } from './node-identity.js';
import { NodeSyncService } from './node-sync.service.js';

/**
 * O pedido do cp-public: a credencial do nó (do `Authorization` dele, conferida aqui de novo) e o corpo do nó. O worker
 * confere tudo outra vez: um cp-public comprometido não escolhe o cliente nem passa um corpo fora do protocolo.
 */
export const internalNodeSyncRequestSchema = z.strictObject({
  credential: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('gcp_identity'), token: z.string().refine(isSignedJwtShape) }),
    z.strictObject({ kind: z.literal('node_key'), nodeKey: z.string().regex(ENROLLMENT_SECRET_PATTERN) }),
  ]),
  request: nodeSyncRequestSchema,
});

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** A credencial (`token` ou `nodeKey`), se houver uma string no corpo, para a máscara do logger antes de validar. */
function credentialValue(body: unknown): string | undefined {
  const credential = (body as { credential?: { token?: unknown; nodeKey?: unknown } } | null)?.credential;
  const value = credential?.token ?? credential?.nodeKey;
  return typeof value === 'string' ? value : undefined;
}

/**
 * `POST /internal/node-sync`: a sincronização do nó dedicado, chamada só pelo cp-public (o token dele,
 * `PUBLIC_SA_EMAIL`), que recebe a chamada do nó e não lê nem grava o estado. 200 com a resposta do protocolo; 400
 * (`invalid_request` ou `clock_skew`), 401, 404, 409 `stale_sequence`, 429 com `Retry-After` ou 503.
 */
@Controller('internal/node-sync')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('public')
export class InternalNodeSyncController {
  constructor(private readonly sync: NodeSyncService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NodeSyncResponse> {
    const presented = credentialValue(body);
    if (typeof presented === 'string') {
      registerLiveSecret(presented);
      res.on('close', () => forgetLiveSecret(presented));
    }
    const parsed = internalNodeSyncRequestSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
    let outcome;
    try {
      outcome = await this.sync.sync(parsed.data.credential, parsed.data.request, requestIdOf(req));
    } catch {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'node_sync_unavailable');
    }
    if (outcome.ok) return outcome.response;
    switch (outcome.reason) {
      case 'invalid_request':
        throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
      case 'clock_skew':
        throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'clock_skew');
      case 'unauthenticated':
        throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
      case 'not_found':
        throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
      case 'stale_sequence':
        throw new ApiError(HttpStatus.CONFLICT, 'Pedido repetido', 'stale_sequence');
      case 'too_soon':
        res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        throw new ApiError(
          HttpStatus.TOO_MANY_REQUESTS,
          'Muitas tentativas. Tente novamente mais tarde.',
          'rate_limited',
        );
    }
  }
}
