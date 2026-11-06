import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { type TenantChange, TenantStore } from '../tenants/tenant-store.js';
import { billingModeOf, type TenantRecord, type TenantState } from '../tenants/tenant.schema.js';
import {
  contractCancelChange,
  contractReactivateChange,
  contractScheduleCancelChange,
  contractSuspendChange,
  MAX_CANCEL_SCHEDULE_MS,
  mayHaveNode,
} from './lifecycle-rules.js';
import { nodePowerAfterTransition, requestNodePower } from './node-power-request.js';

export type ContractOperation = 'cancel' | 'suspend' | 'reactivate';

export type ContractOutcome =
  | { kind: 'canceled'; deleteAfter?: Date; cryptoDestroyAfter?: Date }
  | { kind: 'scheduled'; cancelAt: Date }
  | { kind: 'suspended' | 'reactivated'; state: TenantState }
  | { kind: 'not_found' | 'confirmation_mismatch' | 'not_contract' | 'invalid_date' }
  | { kind: 'not_allowed'; state: TenantState };

/** Uma data de cancelamento no passado (com 1 min de folga do relógio) é recusada: nada de prazo de exclusão encurtado. */
const PAST_TOLERANCE_MS = 60_000;

/**
 * As operações do responsável sobre um cliente de contrato direto (`billing.mode = contract`, CP-11): sem a Stripe,
 * nada suspende, cancela nem exclui esse cliente sozinho; só estas operações, com o subdomínio de confirmação e a
 * auditoria `owner:<e-mail>`. Um cliente da Stripe recusa as três (`not_contract`): para ele vale a assinatura (o
 * Portal e o Dashboard da Stripe, que o webhook acompanha).
 * - `cancel` (com data opcional): agora, com os prazos de sempre (D+30 e D+97); ou marcado para uma data futura (o fim
 *   do contrato), que o `tick` aplica. Data no passado: recusada;
 * - `suspend`: a VM para; só `reactivate` volta (o cliente volta ao estado de antes e a VM liga).
 */
@Injectable()
export class ContractService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly audit: AuditService,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(ContractService.name) private readonly logger: PinoLogger,
  ) {}

  async cancel(
    tenantId: string,
    confirmSlug: string,
    at: Date | undefined,
    actor: string,
    requestId?: string,
  ): Promise<ContractOutcome> {
    const now = this.clock.now();
    const checked = await this.precheck(tenantId, confirmSlug, 'cancel', actor, requestId);
    if (checked.outcome !== undefined) return checked.outcome;
    const audit = { actor, requestId };
    if (at !== undefined && at.getTime() > now.getTime() + PAST_TOLERANCE_MS) {
      if (at.getTime() > now.getTime() + MAX_CANCEL_SCHEDULE_MS) return { kind: 'invalid_date' };
      const result = await this.tenants.change(tenantId, (current) =>
        contractScheduleCancelChange(current, at, audit),
      );
      if (!result.changed && result.tenant.lifecycle?.cancelScheduledFor?.getTime() !== at.getTime()) {
        return { kind: 'not_allowed', state: result.tenant.state };
      }
      await this.record('cancel_scheduled', tenantId, actor, requestId, { cancelAt: at.toISOString() });
      return { kind: 'scheduled', cancelAt: at };
    }
    if (at !== undefined && at.getTime() < now.getTime() - PAST_TOLERANCE_MS) return { kind: 'invalid_date' };
    const result = await this.apply(tenantId, (current) => contractCancelChange(current, now, audit));
    if (result === undefined) return { kind: 'not_allowed', state: checked.tenant.state };
    await this.record('canceled', tenantId, actor, requestId, {});
    return {
      kind: 'canceled',
      deleteAfter: result.lifecycle?.deleteAfter,
      cryptoDestroyAfter: result.lifecycle?.cryptoDestroyAfter,
    };
  }

  async suspend(
    tenantId: string,
    confirmSlug: string,
    actor: string,
    requestId?: string,
  ): Promise<ContractOutcome> {
    const checked = await this.precheck(tenantId, confirmSlug, 'suspend', actor, requestId);
    if (checked.outcome !== undefined) return checked.outcome;
    const result = await this.apply(tenantId, (current) =>
      contractSuspendChange(current, { actor, requestId }),
    );
    if (result === undefined) return { kind: 'not_allowed', state: checked.tenant.state };
    await this.record('suspended', tenantId, actor, requestId, {});
    return { kind: 'suspended', state: result.state };
  }

  async reactivate(
    tenantId: string,
    confirmSlug: string,
    actor: string,
    requestId?: string,
  ): Promise<ContractOutcome> {
    const checked = await this.precheck(tenantId, confirmSlug, 'reactivate', actor, requestId);
    if (checked.outcome !== undefined) return checked.outcome;
    const result = await this.apply(tenantId, (current) =>
      contractReactivateChange(current, { actor, requestId }),
    );
    if (result === undefined) return { kind: 'not_allowed', state: checked.tenant.state };
    await this.record('reactivated', tenantId, actor, requestId, {});
    return { kind: 'reactivated', state: result.state };
  }

  /** O cliente existe, a confirmação é o subdomínio dele e ele é de contrato direto; as recusas ficam na auditoria. */
  private async precheck(
    tenantId: string,
    confirmSlug: string,
    operation: ContractOperation,
    actor: string,
    requestId?: string,
  ): Promise<{ tenant: TenantRecord; outcome?: undefined } | { outcome: ContractOutcome }> {
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) return { outcome: { kind: 'not_found' } };
    const refusal =
      confirmSlug !== tenant.slug
        ? 'confirmation_mismatch'
        : billingModeOf(tenant) !== 'contract'
          ? 'not_contract'
          : undefined;
    if (refusal === undefined) return { tenant };
    await this.audit.write({
      actor,
      action: `tenant.contract_${operation}_refused`,
      tenantId,
      details: { reason: refusal, state: tenant.state },
      requestId,
    });
    return { outcome: { kind: refusal } };
  }

  /** A transição e, se ela pede, o passo que para ou liga a VM. `undefined` se a regra recusou. */
  private async apply(
    tenantId: string,
    decide: (current: TenantRecord) => TenantChange | undefined,
  ): Promise<TenantRecord | undefined> {
    const result = await this.tenants.change(tenantId, decide);
    if (!result.transitioned) return undefined;
    const step = nodePowerAfterTransition(result.before.state, result.tenant.state);
    if (step !== undefined && mayHaveNode(result.tenant)) {
      try {
        await requestNodePower(this.queue, this.clock, tenantId, step);
      } catch {
        this.logger.warn({ event: 'node_power_enqueue_failed', tenantId, step }, 'o tick pede de novo');
      }
    }
    return result.tenant;
  }

  private async record(
    what: string,
    tenantId: string,
    actor: string,
    requestId: string | undefined,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.write({ actor, action: `tenant.contract_${what}`, tenantId, details, requestId });
    this.logger.info({ event: `contract_${what}`, tenantId }, 'operação do responsável num contrato direto');
  }
}
