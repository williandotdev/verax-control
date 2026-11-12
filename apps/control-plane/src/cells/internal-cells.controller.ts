import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { cellIdSchema } from '@verax/shared';
import type { Request } from 'express';
import { ApiError } from '../common/http/api-error.js';
import { WorkerCallerGuard, WorkerCallers, workerCallerOf } from '../internal/worker-caller.js';
import { CellReportsService, pushEnvelopeSchema } from './cell-reports.service.js';

/**
 * `POST /internal/cells/:cellId/reports` (CE-06): a entrega push da assinatura de relatórios de cada célula. Só no
 * cp-worker, fora do prefixo `/v1`, e só com o token OIDC da conta de push da célula (`@WorkerCallers('cell-push')`): o
 * token das tasks, do cp-public ou do console não vale aqui, e o dessas contas não vale em nenhuma outra rota.
 *
 * Respostas: 200 para toda entrega lida (aplicada, repetida, guardada ou recusada pelo conteúdo: o Pub/Sub não precisa
 * repetir); 400 para o corpo que não é uma entrega push; 404 para a célula fora do registro e 403 para a entrega com a
 * conta de push ou a assinatura de outra célula (as duas não deveriam acontecer: o Pub/Sub repete e o log mostra).
 */
@Controller('internal/cells')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('cell-push')
export class InternalCellsController {
  constructor(private readonly reports: CellReportsService) {}

  @Post(':cellId/reports')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('cellId') cellId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ outcome: string; code?: string }> {
    if (!cellIdSchema.safeParse(cellId).success) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'Célula desconhecida', 'cell_unknown');
    }
    const push = pushEnvelopeSchema.safeParse(body);
    if (!push.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Entrega inválida', 'invalid_push');
    const result = await this.reports.receive(cellId, push.data, workerCallerOf(req));
    if (!result.delivered) {
      throw result.reason === 'cell_unknown'
        ? new ApiError(HttpStatus.NOT_FOUND, 'Célula desconhecida', 'cell_unknown')
        : new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', result.reason);
    }
    return { outcome: result.outcome, ...(result.code !== undefined && { code: result.code }) };
  }
}
