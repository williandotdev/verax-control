import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { type NodeSyncResponse, nodeSyncRequestSchema } from '@verax/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../common/http/api-error.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { ENROLLMENT_SECRET_PATTERN } from '../enrollment/enrollment.js';
import { WorkerCallerGuard, WorkerCallers } from '../internal/worker-caller.js';
import { isSignedJwtShape } from './node-identity.js';
import { type NodeSyncOutcome, NodeSyncService } from './node-sync.service.js';

/**
 * Os pedidos do cp-public, um por credencial (a rota diz qual é; o corpo nunca): o token do nó gerenciado ou a chave do
 * nó da VM do cliente, do `Authorization` do nó e conferidos aqui de novo, e o corpo do nó. O worker confere tudo outra
 * vez: um cp-public comprometido não escolhe o cliente nem passa um corpo fora do protocolo.
 */
export const internalManagedSyncSchema = z.strictObject({
  token: z.string().refine(isSignedJwtShape),
  request: nodeSyncRequestSchema,
});
export const internalCustomerSyncSchema = z.strictObject({
  nodeKey: z.string().regex(ENROLLMENT_SECRET_PATTERN),
  request: nodeSyncRequestSchema,
});

const INVALID = (): ApiError => new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** Põe na máscara do logger, antes de validar, a credencial que o corpo trouxer (se for uma string). */
function mask(value: unknown, res: Response): void {
  if (typeof value !== 'string') return;
  registerLiveSecret(value);
  res.on('close', () => forgetLiveSecret(value));
}

/** O desfecho do serviço na resposta HTTP: 200 com o protocolo, ou o status de cada recusa. */
function respond(outcome: NodeSyncOutcome, res: Response): NodeSyncResponse {
  if (outcome.ok) return outcome.response;
  switch (outcome.reason) {
    case 'invalid_request':
      throw INVALID();
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

/** Uma falha inesperada do serviço é 503, sem detalhe. */
async function attempt(run: () => Promise<NodeSyncOutcome>): Promise<NodeSyncOutcome> {
  try {
    return await run();
  } catch {
    throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'node_sync_unavailable');
  }
}

/**
 * A sincronização do nó dedicado no cp-worker, chamada só pelo cp-public (o token dele, `PUBLIC_SA_EMAIL`), que recebe
 * a chamada do nó e não lê nem grava o estado. Uma rota por credencial, cada uma com a sua entrada no serviço, e nada
 * aqui lê do corpo qual credencial é:
 * - `POST /internal/node-sync/managed` `{token, request}`: o nó gerenciado (`NodeSyncService.syncManaged`);
 * - `POST /internal/node-sync/customer` `{nodeKey, request}`: a VM do cliente (`NodeSyncService.syncCustomer`).
 *
 * 200 com a resposta do protocolo; 400 (`invalid_request` ou `clock_skew`), 401, 404, 409 `stale_sequence`, 429 com
 * `Retry-After` ou 503.
 */
@Controller('internal/node-sync')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('public')
export class InternalNodeSyncController {
  constructor(private readonly sync: NodeSyncService) {}

  @Post('managed')
  @HttpCode(HttpStatus.OK)
  async managed(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NodeSyncResponse> {
    mask((body as { token?: unknown } | null)?.token, res);
    const parsed = internalManagedSyncSchema.safeParse(body);
    if (!parsed.success) throw INVALID();
    const { token, request } = parsed.data;
    return respond(await attempt(() => this.sync.syncManaged(token, request, requestIdOf(req))), res);
  }

  @Post('customer')
  @HttpCode(HttpStatus.OK)
  async customer(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NodeSyncResponse> {
    mask((body as { nodeKey?: unknown } | null)?.nodeKey, res);
    const parsed = internalCustomerSyncSchema.safeParse(body);
    if (!parsed.success) throw INVALID();
    const { nodeKey, request } = parsed.data;
    return respond(await attempt(() => this.sync.syncCustomer(nodeKey, request, requestIdOf(req))), res);
  }
}
