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
import { TenantNotFoundError, TenantStore } from '../tenants/tenant-store.js';
import { billingModeOf } from '../tenants/tenant.schema.js';

export type StartOutcome =
  | { started: true; runId: string; step: string }
  | { started: false; reason: 'not_found' | 'confirmation_mismatch' | 'not_contract' | 'not_allowed' };

/**
 * O início do provisionamento de um cliente de contrato direto (criado pelo responsável no console, sem checkout): o
 * equivalente ao `invoice.paid` do webhook (CP-04) para quem não paga pela Stripe. Só um cliente `contract` em
 * `pending` entra em `provisioning`, com um `runId` novo e o `preflight` na fila; daí em diante são exatamente os mesmos
 * passos de um cliente pago (CP-07). Um cliente da Stripe nunca começa por aqui (409 `stripe_managed`): o pagamento é
 * a única porta dele.
 *
 * Idempotente: repetido com o cliente já em `provisioning` no `preflight`, só garante a task (o id é determinístico,
 * `preflight-<runId>`), que é o que completa uma chamada que mudou o estado e falhou ao enfileirar; mais adiante, só
 * devolve a execução. Auditado com o e-mail de quem pediu.
 */
@Injectable()
export class ProvisioningStartService {
  constructor(
    private readonly tenants: TenantStore,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(ProvisioningStartService.name) private readonly logger: PinoLogger,
  ) {}

  async start(
    tenantId: string,
    confirmSlug: string,
    actor: string,
    requestId?: string,
  ): Promise<StartOutcome> {
    const runId = newUlid(this.clock.now().getTime());
    let refusal: 'confirmation_mismatch' | 'not_contract' | undefined;
    let result;
    try {
      result = await this.tenants.change(tenantId, (current) => {
        refusal =
          current.slug !== confirmSlug
            ? 'confirmation_mismatch'
            : billingModeOf(current) !== 'contract'
              ? 'not_contract'
              : undefined;
        if (refusal !== undefined || current.state !== 'pending') return undefined;
        return {
          to: 'provisioning',
          reason: 'contract_provisioning_started',
          audit: { actor, requestId },
          mutate: (tenant) => ({
            ...tenant,
            provisioning: { runId, step: FIRST_PROVISIONING_STEP, attempts: 0 },
          }),
        };
      });
    } catch (error) {
      if (error instanceof TenantNotFoundError) return { started: false, reason: 'not_found' };
      throw error;
    }
    if (refusal !== undefined) return { started: false, reason: refusal };
    const tenant = result.tenant;
    if (tenant.state !== 'provisioning' || tenant.provisioning?.runId === undefined) {
      return { started: false, reason: 'not_allowed' };
    }
    const current = {
      runId: tenant.provisioning.runId,
      step: tenant.provisioning.step ?? FIRST_PROVISIONING_STEP,
    };
    if (current.step === FIRST_PROVISIONING_STEP) {
      await this.queue.enqueue({
        queue: 'provisioning',
        step: FIRST_PROVISIONING_STEP,
        tenantId,
        runId: current.runId,
      });
    }
    if (result.transitioned) {
      this.logger.info(
        { event: 'contract_provisioning_started', tenantId, runId: current.runId },
        'provisionamento de contrato direto iniciado',
      );
    }
    return { started: true, ...current };
  }
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** O subdomínio de confirmação e, quando quem chama é o console, quem agiu (o e-mail que o IAP deu a ele). */
const provisionBodySchema = z.strictObject({
  confirmSlug: z.string().min(1).max(64),
  actor: z.email().max(254).optional(),
});

/**
 * `POST /internal/tenants/:tenantId/provision` `{confirmSlug}`: o cadastro de um cliente de contrato direto no console
 * (logo depois de criá-lo) e o botão "Iniciar provisionamento". Quem chama: o console (`cp-admin`, com quem agiu em
 * `actor`) ou um responsável direto, como as outras operações do responsável (CP-11); nunca a cp-invoker nem o
 * cp-public.
 */
@Controller('internal/tenants')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner', 'console')
export class ProvisioningStartController {
  constructor(
    private readonly starts: ProvisioningStartService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post(':tenantId/provision')
  @HttpCode(HttpStatus.OK)
  async provision(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ runId: string; step: string }> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const parsed = provisionBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'Informe o subdomínio do cliente para confirmar',
        'invalid_request',
      );
    }
    const actor = ownerActorOf(req, this.config, parsed.data.actor);
    if (actor === undefined) throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'actor_not_owner');
    const outcome = await this.starts.start(tenantId, parsed.data.confirmSlug, actor, requestIdOf(req));
    if (outcome.started) return { runId: outcome.runId, step: outcome.step };
    switch (outcome.reason) {
      case 'not_found':
        throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
      case 'confirmation_mismatch':
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'O subdomínio não confere com o do cliente: nada mudou',
          'confirmation_mismatch',
        );
      case 'not_contract':
        throw new ApiError(
          HttpStatus.CONFLICT,
          'Cliente da Stripe: o provisionamento começa só com o pagamento',
          'stripe_managed',
        );
      case 'not_allowed':
        throw new ApiError(
          HttpStatus.CONFLICT,
          'O cliente não está num estado que permita isso',
          'not_allowed',
        );
    }
  }
}
