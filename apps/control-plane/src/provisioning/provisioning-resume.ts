import {
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
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { isUlid, newUlid } from '../common/ulid.js';
import { WorkerCallerGuard, WorkerCallers, workerCallerOf } from '../internal/worker-caller.js';
import { FIRST_PROVISIONING_STEP, STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { LockNotHeldError, TenantStore } from '../tenants/tenant-store.js';

export type ResumeOutcome =
  { resumed: true; runId: string; step: string } | { resumed: false; reason: 'not_found' | 'not_resumable' };

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

/**
 * `POST /internal/tenants/:tenantId/resume`: só o responsável (`OWNER_PRINCIPALS`), com o token de identidade dele
 * (`gcloud auth print-identity-token`). Nem as tasks nem o cp-public chamam.
 */
@Controller('internal/tenants')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner')
export class ProvisioningResumeController {
  constructor(private readonly resumes: ProvisioningResumeService) {}

  @Post(':tenantId/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ): Promise<{ runId: string; step: string }> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const outcome = await this.resumes.resume(
      tenantId,
      `owner:${workerCallerOf(req) ?? 'desconhecido'}`,
      requestIdOf(req),
    );
    if (outcome.resumed) return { runId: outcome.runId, step: outcome.step };
    if (outcome.reason === 'not_found')
      throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    throw new ApiError(HttpStatus.CONFLICT, 'O cliente não está parado no provisionamento', 'not_resumable');
  }
}
