import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import type { StepContext, StepHandler, StepInput } from '../internal/step-handler.js';
import { CloudApiError } from '../provisioning/cloud-http.js';
import { definitiveCodeOf, LOCK_TTL_MS, MAX_TASK_ATTEMPTS } from '../provisioning/provisioning-engine.js';
import { ProvisioningStore, type StepDocument } from '../provisioning/provisioning-store.js';
import { STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { LockHeldError, LockNotHeldError, TenantStore } from '../tenants/tenant-store.js';
import type { LifecycleRunKind, Tenant, TenantRecord } from '../tenants/tenant.schema.js';
import { mayHaveExternalResources } from './lifecycle-rules.js';
import { ownsSlug } from './node-power.js';

/**
 * Os passos de cada execução da exclusão, na ordem (plano §4d; docs/ARQUITETURA.md, "Exclusão em dois tempos"):
 * - Exclusão 1 (`delete`): o `destroy` do Terraform do cliente pelo executor (com o `state rm` do disco, do IP do NAT,
 *   do bucket de backups e do cofre `credentials-key`, e o disco, os snapshots e o IP apagados pela API), o túnel e os
 *   registros de DNS do cliente no Cloudflare, o domínio e o site no Firebase, e o registro de exclusão;
 * - Exclusão 2 (`crypto_destroy`): as versões de `credentials-key` destruídas pelo cp-worker, o cofre, o bucket de
 *   backups e o estado apagados pelo executor, e o registro mínimo.
 */
export const DELETE_STEPS = [
  'deletion.terraform',
  'deletion.terraform_wait',
  'deletion.cloudflare',
  'deletion.firebase',
  'deletion.record',
] as const;
export const CRYPTO_DESTROY_STEPS = [
  'crypto.destroy_key',
  'crypto.purge',
  'crypto.purge_wait',
  'crypto.finish',
] as const;
export const LIFECYCLE_RUN_STEPS: Readonly<Record<LifecycleRunKind, readonly string[]>> = {
  delete: DELETE_STEPS,
  crypto_destroy: CRYPTO_DESTROY_STEPS,
};

export interface DeletionStepRun {
  tenant: TenantRecord;
  runId: string;
  kind: LifecycleRunKind;
  step: StepDocument;
  poll: number;
  waitedMs: number;
  now: Date;
  requestId?: string;
  retryCount?: number;
}

/** O que um passo decide (como no provisionamento): seguir, esperar e consultar de novo, ou terminar a execução. */
export type DeletionOutcome =
  | {
      kind: 'next';
      patch?: (tenant: Tenant) => Tenant;
      outputs?: Record<string, string | number | boolean>;
      delayMs?: number;
    }
  | { kind: 'wait'; delayMs: number; outputs?: Record<string, string | number | boolean> }
  | { kind: 'finish'; patch: (tenant: Tenant) => Tenant; action: string; details: Record<string, unknown> };

export interface DeletionStep extends StepHandler {
  readonly kind: LifecycleRunKind;
  /**
   * O passo fala com algo fora do Firestore (Cloudflare, Firebase, o executor, o Secret Manager). Um cliente que nunca
   * provisionou não tem nada lá (e o subdomínio pode ser de outro agora): o motor pula o passo sem chamar `execute`.
   */
  readonly external: boolean;
  execute(run: DeletionStepRun): Promise<DeletionOutcome>;
}

function retryReasonOf(error: unknown): string {
  if (error instanceof CloudApiError)
    return `${error.service}_${error.status === 0 ? 'unreachable' : String(error.status)}`;
  if (error instanceof LockHeldError) return 'lock_held';
  return error instanceof Error ? error.name.slice(0, 40) : 'unknown';
}

/**
 * O motor da exclusão (CP-11), o mesmo desenho do provisionamento (`provisioning-engine.ts`) sobre
 * `tenant.lifecycle.run`. Antes de qualquer coisa:
 * 1. o cliente tem de estar `deleted`, com esta execução e este passo (uma task velha ou de outro cliente não faz nada);
 *    um cliente em qualquer outro estado nunca é tocado: `not_deleting`;
 * 2. com recursos fora do Firestore, o subdomínio tem de ser dele (`slugs/{slug}` tomado por este id): o nome `vx-<slug>`
 *    de outro cliente nunca é apagado;
 * 3. a trava do cliente (dono = `runId`).
 * Falha definitiva para a execução com o código (`lifecycle.run.lastError`) e a linha `event=deletion_failed`; o
 * `delete-now` do responsável recomeça do primeiro passo (todos reconhecem o que já foi apagado).
 */
@Injectable()
export class DeletionEngine {
  constructor(
    private readonly tenants: TenantStore,
    private readonly runs: ProvisioningStore,
    private readonly audit: AuditService,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(DeletionEngine.name) private readonly logger: PinoLogger,
  ) {}

  async run(step: DeletionStep, input: StepInput, context: StepContext): Promise<string> {
    const tenant = await this.tenants.get(input.tenantId);
    if (tenant === undefined) return 'unknown_tenant';
    if (tenant.state !== 'deleted') return 'not_deleting';
    const run = tenant.lifecycle?.run;
    if (run?.runId !== input.runId || run.kind !== step.kind) return 'stale_run';
    if (run.lastError !== undefined) return 'run_failed';
    const steps = LIFECYCLE_RUN_STEPS[run.kind];
    const order = steps.indexOf(run.step) - steps.indexOf(step.name);
    if (order > 0) {
      if (steps.indexOf(run.step) >= 0) await this.enqueue(tenant.id, input.runId, run.step);
      return 'already_done';
    }
    if (order < 0) return 'not_current';

    const poll = input.poll ?? 0;
    const existing = await this.runs.getStep(input.runId, step.name);
    const expected = existing?.nextPoll ?? 0;
    if (poll < expected) {
      if (poll === expected - 1 && existing?.status === 'waiting') {
        await this.enqueue(tenant.id, input.runId, step.name, expected);
      }
      return 'stale_poll';
    }
    if (poll > expected) return 'not_current';

    const external = mayHaveExternalResources(tenant);
    if (external && !(await ownsSlug(this.tenants, tenant))) {
      return this.fail(tenant.id, input.runId, run.kind, step.name, 'slug_not_owned', context);
    }
    try {
      await this.tenants.acquireLock(tenant.id, input.runId, LOCK_TTL_MS);
    } catch (error) {
      if (error instanceof LockHeldError) this.retry(tenant.id, step.name, error);
      throw error;
    }
    const now = this.clock.now();
    const doc = await this.runs.updateStep(input.runId, step.name, (current, at) => ({
      ...(current ?? this.runs.newStep(at)),
      status: 'running',
      attempts: (current?.attempts ?? 0) + 1,
      waitingSince: current?.waitingSince ?? at,
      updatedAt: at,
    }));
    let outcome: DeletionOutcome;
    if (step.external && !external) {
      outcome = { kind: 'next', outputs: { skipped: true } };
    } else {
      try {
        outcome = await step.execute({
          tenant,
          runId: input.runId,
          kind: run.kind,
          step: doc,
          poll,
          waitedMs: now.getTime() - (doc.waitingSince ?? now).getTime(),
          now,
          requestId: context.requestId,
          retryCount: context.retryCount,
        });
      } catch (error) {
        const code = definitiveCodeOf(error);
        if (code !== undefined) return this.fail(tenant.id, input.runId, run.kind, step.name, code, context);
        if (context.retryCount !== undefined && context.retryCount >= MAX_TASK_ATTEMPTS - 1) {
          return this.fail(tenant.id, input.runId, run.kind, step.name, 'retries_exhausted', context);
        }
        await this.runs
          .updateStep(input.runId, step.name, (current, at) => ({
            ...(current ?? this.runs.newStep(at)),
            errorCode: retryReasonOf(error),
            updatedAt: at,
          }))
          .catch(() => undefined);
        this.retry(tenant.id, step.name, error);
      }
    }
    switch (outcome.kind) {
      case 'next':
        return this.advance(tenant.id, input.runId, run.kind, step.name, outcome, context);
      case 'wait':
        return this.wait(tenant.id, input.runId, step.name, poll, outcome);
      case 'finish':
        return this.finish(tenant.id, input.runId, run.kind, step.name, outcome, context);
    }
  }

  private retry(tenantId: string, step: string, error: unknown): never {
    this.logger.warn(
      { event: 'deletion_step_retry', tenantId, step, reason: retryReasonOf(error) },
      'passo da exclusão vai repetir',
    );
    throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'step_retry');
  }

  /** Para a execução com o código, solta a trava e avisa a Verax (o alerta procura `event=deletion_failed`). */
  private async fail(
    tenantId: string,
    runId: string,
    kind: LifecycleRunKind,
    step: string,
    code: string,
    context: StepContext,
  ): Promise<string> {
    const at = this.clock.now();
    const result = await this.tenants.change(tenantId, (current) => {
      const run = current.lifecycle?.run;
      if (current.state !== 'deleted' || run?.runId !== runId || run.lastError !== undefined)
        return undefined;
      return {
        reason: `deletion_failed:${code}`.slice(0, 200),
        audit: { actor: 'system', requestId: context.requestId },
        mutate: (t) => ({
          ...t,
          lifecycle: {
            ...t.lifecycle,
            run: { ...run, lastError: { code: code.slice(0, 64), at } },
          },
        }),
      };
    });
    await this.runs
      .updateStep(runId, step, (current, now) => ({
        ...(current ?? this.runs.newStep(now)),
        status: 'failed',
        errorCode: code.slice(0, 64),
        finishedAt: now,
        updatedAt: now,
      }))
      .catch(() => undefined);
    await this.runs
      .updateRun(runId, (run) => ({
        ...run,
        outcome: 'failed',
        failureCode: code.slice(0, 64),
        finishedAt: at,
      }))
      .catch(() => undefined);
    await this.releaseLock(tenantId, runId);
    if (result.changed) {
      this.logger.error({ event: 'deletion_failed', tenantId, kind, step, code }, 'exclusão parou');
    }
    return 'failed';
  }

  private async advance(
    tenantId: string,
    runId: string,
    kind: LifecycleRunKind,
    step: string,
    outcome: Extract<DeletionOutcome, { kind: 'next' }>,
    context: StepContext,
  ): Promise<string> {
    const steps = LIFECYCLE_RUN_STEPS[kind];
    const next = steps[steps.indexOf(step) + 1];
    if (next === undefined) throw new Error(`o passo ${step} não tem seguinte`);
    const result = await this.tenants.change(tenantId, (current) => {
      const run = current.lifecycle?.run;
      if (current.state !== 'deleted' || run?.runId !== runId || run.step !== step) return undefined;
      return {
        reason: `deletion_step:${step}`,
        audit: { actor: 'system', requestId: context.requestId },
        mutate: (tenant) => {
          const patched = outcome.patch === undefined ? tenant : outcome.patch(tenant);
          return { ...patched, lifecycle: { ...patched.lifecycle, run: { ...run, step: next } } };
        },
      };
    });
    if (!result.changed) return 'already_done';
    await this.runs.updateStep(runId, step, (current, now) => ({
      ...(current ?? this.runs.newStep(now)),
      status: 'done',
      ...(outcome.outputs === undefined ? {} : { outputs: { ...current?.outputs, ...outcome.outputs } }),
      errorCode: undefined,
      finishedAt: now,
      updatedAt: now,
    }));
    await this.enqueue(tenantId, runId, next, undefined, outcome.delayMs);
    return 'done';
  }

  private async wait(
    tenantId: string,
    runId: string,
    step: string,
    poll: number,
    outcome: Extract<DeletionOutcome, { kind: 'wait' }>,
  ): Promise<string> {
    const nextPoll = poll + 1;
    await this.runs.updateStep(runId, step, (current, now) => ({
      ...(current ?? this.runs.newStep(now)),
      status: 'waiting',
      nextPoll,
      ...(outcome.outputs === undefined ? {} : { outputs: { ...current?.outputs, ...outcome.outputs } }),
      errorCode: undefined,
      updatedAt: now,
    }));
    await this.enqueue(tenantId, runId, step, nextPoll, outcome.delayMs);
    return 'waiting';
  }

  private async finish(
    tenantId: string,
    runId: string,
    kind: LifecycleRunKind,
    step: string,
    outcome: Extract<DeletionOutcome, { kind: 'finish' }>,
    context: StepContext,
  ): Promise<string> {
    const result = await this.tenants.change(tenantId, (current) => {
      const run = current.lifecycle?.run;
      if (current.state !== 'deleted' || run?.runId !== runId || run.step !== step) return undefined;
      return {
        reason: kind === 'delete' ? 'deletion_completed' : 'crypto_destroy_completed',
        audit: { actor: 'system', requestId: context.requestId },
        mutate: outcome.patch,
      };
    });
    const at = this.clock.now();
    await this.runs.updateStep(runId, step, (current, now) => ({
      ...(current ?? this.runs.newStep(now)),
      status: 'done',
      errorCode: undefined,
      finishedAt: now,
      updatedAt: now,
    }));
    await this.runs
      .updateRun(runId, (run) => ({ ...run, outcome: 'succeeded', finishedAt: at }))
      .catch(() => undefined);
    await this.releaseLock(tenantId, runId);
    if (!result.changed) return 'already_done';
    await this.audit.write({
      actor: 'system',
      action: outcome.action,
      tenantId,
      details: outcome.details,
      requestId: context.requestId,
    });
    this.logger.info(
      { event: kind === 'delete' ? 'tenant_deleted' : 'tenant_purged', tenantId, runId },
      kind === 'delete' ? 'Exclusão 1 concluída' : 'Exclusão 2 concluída',
    );
    return 'finished';
  }

  private async releaseLock(tenantId: string, runId: string): Promise<void> {
    try {
      await this.tenants.releaseLock(tenantId, runId);
    } catch (error) {
      if (!(error instanceof LockNotHeldError)) throw error;
    }
  }

  async enqueue(
    tenantId: string,
    runId: string,
    step: string,
    poll?: number,
    delayMs?: number,
  ): Promise<void> {
    await this.queue.enqueue({
      queue: 'lifecycle',
      step,
      tenantId,
      runId,
      ...(poll === undefined || poll === 0 ? {} : { poll }),
      ...(delayMs === undefined ? {} : { scheduleAt: new Date(this.clock.now().getTime() + delayMs) }),
    });
  }
}
