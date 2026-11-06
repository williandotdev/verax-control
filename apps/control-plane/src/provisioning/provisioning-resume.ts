import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { isUlid, newUlid } from '../common/ulid.js';
import { ownerActorOf, WorkerCallerGuard, WorkerCallers } from '../internal/worker-caller.js';
import { FIRST_PROVISIONING_STEP, STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { LockNotHeldError, TenantStore } from '../tenants/tenant-store.js';
import { hostingOf } from '../tenants/tenant.schema.js';
import { customerHostedError } from './provisioning-start.js';

export type ResumeOutcome =
  | { resumed: true; runId: string; step: string }
  | { resumed: false; reason: 'not_found' | 'not_resumable' | 'customer_hosted' };

/**
 * `resume` do responsável (plano §4b e §9 item 17): um cliente em `provisioning_failed` (ou parado em `provisioning`,
 * como os que o webhook do CP-04 deixou no `preflight` antes de existir o worker) recomeça com uma execução nova (outro
 * `runId`: as tasks da anterior que ainda chegarem viram `stale_run`) a partir do `preflight`. Todos os passos são
 * idempotentes: o que já existe (túnel, site, VM) é reconhecido e só o que falta é feito; a versão do nó já criado é
 * mantida (`preflight`). A trava da execução anterior é solta. Auditado com o e-mail de quem pediu.
 */
@Injectable()
export class ProvisioningResumeService {
  constructor(
    private readonly tenants: TenantStore,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(ProvisioningResumeService.name) private readonly logger: PinoLogger,
  ) {}

  async resume(tenantId: string, actor: string, requestId?: string): Promise<ResumeOutcome> {
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) return { resumed: false, reason: 'not_found' };
    // O ambiente na infraestrutura do cliente nunca provisiona (nem chega a estes estados): recusa explícita.
    if (hostingOf(tenant) === 'customer') return { resumed: false, reason: 'customer_hosted' };
    if (tenant.state !== 'provisioning_failed' && tenant.state !== 'provisioning') {
      return { resumed: false, reason: 'not_resumable' };
    }
    const previousRun = tenant.provisioning?.runId;
    if (previousRun !== undefined && tenant.lock?.owner === previousRun) {
      try {
        await this.tenants.releaseLock(tenantId, previousRun);
      } catch (error) {
        if (!(error instanceof LockNotHeldError)) throw error;
      }
    }
    const runId = newUlid(this.clock.now().getTime());
    const result = await this.tenants.change(tenantId, (current) => {
      if (current.state !== 'provisioning_failed' && current.state !== 'provisioning') return undefined;
      return {
        ...(current.state === 'provisioning_failed' ? { to: 'provisioning' as const } : {}),
        reason: 'provisioning_resumed',
        audit: { actor, requestId },
        mutate: (t) => ({
          ...t,
          provisioning: {
            ...(t.provisioning ?? { attempts: 0 }),
            runId,
            step: FIRST_PROVISIONING_STEP,
            attempts: (t.provisioning?.attempts ?? 0) + 1,
          },
        }),
      };
    });
    if (!result.changed) return { resumed: false, reason: 'not_resumable' };
    await this.queue.enqueue({ queue: 'provisioning', step: FIRST_PROVISIONING_STEP, tenantId, runId });
    this.logger.info({ event: 'provisioning_resumed', tenantId, runId }, 'provisionamento retomado');
    return { resumed: true, runId, step: FIRST_PROVISIONING_STEP };
  }
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

const resumeBodySchema = z.strictObject({ actor: z.email().max(254).optional() });

/**
 * `POST /internal/tenants/:tenantId/resume`: o responsável, direto (`OWNER_PRINCIPALS`) ou pelo console (`cp-admin`,
 * `ADMIN_SA_EMAIL`, com quem agiu em `{actor}`, CP-11). Nem as tasks nem o cp-public chamam.
 */
@Controller('internal/tenants')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner', 'console')
export class ProvisioningResumeController {
  constructor(
    private readonly resumes: ProvisioningResumeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post(':tenantId/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ runId: string; step: string }> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const parsed = resumeBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
    const actor = ownerActorOf(req, this.config, parsed.data.actor);
    if (actor === undefined) throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'actor_not_owner');
    const outcome = await this.resumes.resume(tenantId, actor, requestIdOf(req));
    if (outcome.resumed) return { runId: outcome.runId, step: outcome.step };
    if (outcome.reason === 'not_found')
      throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    if (outcome.reason === 'customer_hosted') throw customerHostedError();
    throw new ApiError(HttpStatus.CONFLICT, 'O cliente não está parado no provisionamento', 'not_resumable');
  }
}
