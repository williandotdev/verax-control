import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { ApiError } from '../common/http/api-error.js';
import { ULID_PATTERN } from '../common/ulid.js';
import { MAX_STEP_POLL } from '../queue/step-queue.js';
import { STEP_HANDLERS, type StepHandler } from './step-handler.js';
import { WorkerCallerGuard, WorkerCallers } from './worker-caller.js';

const stepBodySchema = z.strictObject({
  tenantId: z.string().regex(ULID_PATTERN),
  runId: z.string().regex(ULID_PATTERN),
  poll: z.number().int().min(1).max(MAX_STEP_POLL).optional(),
});

/** O cabeçalho que o Cloud Tasks põe em toda entrega: quantas vezes a task já foi repetida (0 na primeira). */
const RETRY_COUNT_HEADER = 'x-cloudtasks-taskretrycount';
const RETRY_COUNT_PATTERN = /^[0-9]{1,6}$/;

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** Só dígitos, no máximo 6: qualquer outra coisa conta como ausente (chamada à mão, sem o Cloud Tasks). */
function retryCountOf(req: Request): number | undefined {
  const value = req.headers[RETRY_COUNT_HEADER];
  return typeof value === 'string' && RETRY_COUNT_PATTERN.test(value) ? Number(value) : undefined;
}

/**
 * `POST /internal/steps/:name` (plano §4c): uma task do Cloud Tasks por passo, com o corpo `{tenantId, runId}` e o
 * token da cp-invoker. Só no cp-worker e fora do prefixo `/v1` (`app.setup.ts`). Passo desconhecido → 404 (o Cloud
 * Tasks repete e desiste; nada acontece). Os passos do CP-05 são `secrets.destroy_bootstrap` e `access.reveal_email`;
 * o CP-07 e o CP-11 acrescentam os seus em `STEP_HANDLERS`.
 */
@Controller('internal/steps')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('tasks')
export class InternalStepsController {
  private readonly handlers: ReadonlyMap<string, StepHandler>;

  constructor(
    @Inject(STEP_HANDLERS) handlers: readonly StepHandler[],
    @InjectPinoLogger(InternalStepsController.name) private readonly logger: PinoLogger,
  ) {
    this.handlers = new Map(handlers.map((handler) => [handler.name, handler]));
  }

  @Post(':name')
  @HttpCode(HttpStatus.OK)
  async run(
    @Param('name') name: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ step: string; outcome: string }> {
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new ApiError(HttpStatus.NOT_FOUND, 'Passo desconhecido', 'unknown_step');
    const parsed = stepBodySchema.safeParse(body);
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Corpo da task inválido', 'invalid_step');
    const outcome = await handler.run(parsed.data, {
      requestId: requestIdOf(req),
      retryCount: retryCountOf(req),
    });
    this.logger.info(
      { event: 'step_done', step: handler.name, tenantId: parsed.data.tenantId, outcome },
      'passo',
    );
    return { step: handler.name, outcome };
  }
}
