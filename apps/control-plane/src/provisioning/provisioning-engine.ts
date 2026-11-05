import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import type { StepContext, StepHandler, StepInput } from '../internal/step-handler.js';
import { STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { LockHeldError, LockNotHeldError, TenantStore } from '../tenants/tenant-store.js';
import type { Tenant, TenantRecord } from '../tenants/tenant.schema.js';
import { CloudApiError } from './cloud-http.js';
import { ExecutorInputError } from './executor-env.js';
import { PanelBundleError } from './panel-bundle.js';
import {
  ProvisioningStore,
  type RunDocument,
  type StepDocument,
  SubnetPoolExhaustedError,
} from './provisioning-store.js';
import { ReleaseManifestError } from './release-manifest.js';

/**
 * Os passos do provisionamento na ordem (plano §4c): o certificado do domínio do painel (`firebase.site`) começa antes
 * do Terraform, para correr em paralelo com a instalação da VM. Os mesmos nomes da página de status
 * (`status/status-view.ts`, conferido por teste) e das tasks (`POST /internal/steps/<passo>`).
 */
export const PROVISIONING_STEPS = [
  'preflight',
  'cloudflare.tunnel',
  'firebase.site',
  'terraform.apply',
  'terraform.wait',
  'secrets.tunnel_token',
  'node.wait_ready',
  'node.health',
  'panel.domain_wait',
  'access.ready',
] as const;
export type ProvisioningStepName = (typeof PROVISIONING_STEPS)[number];

/** A trava do cliente durante a execução (plano §4c: dono `runId`, 20 min, renovada a cada passo). */
export const LOCK_TTL_MS = 20 * 60_000;
/** As tentativas da fila `provisioning` (`max_attempts` em `envs/control-plane/tasks.tf`). */
export const MAX_TASK_ATTEMPTS = 8;

/**
 * Falha que não melhora com nova tentativa (configuração, recusa, conteúdo inválido, prazo esgotado): o cliente vai para
 * `provisioning_failed` com o código, a Verax é avisada (linha `event=provisioning_failed`) e nada mais é enfileirado.
 * O código é curto e sem dado do cliente (`provisioning_disabled`, `node_error:install_failed`).
 */
export class DefinitiveStepError extends Error {
  constructor(readonly code: string) {
    super(`passo parou: ${code}`);
    this.name = 'DefinitiveStepError';
  }
}

/** Uma mudança no cliente que acompanha o passo (os recursos criados): sobre o documento relido na transação. */
export type TenantPatch = (tenant: Tenant) => Tenant;
export type StepOutputs = Record<string, string | number | boolean>;

/**
 * O que um passo decide:
 * - `next`: terminou; o próximo passo vai para a fila (com espera opcional);
 * - `wait`: ainda não (um `apply` em andamento, a VM instalando, o certificado saindo): o mesmo passo volta à fila
 *   depois de `delayMs`, com o número da consulta seguinte;
 * - `finish`: o último passo; o cliente vai para `waiting_customer_connection`.
 */
export type StepOutcome =
  | { kind: 'next'; patch?: TenantPatch; outputs?: StepOutputs; delayMs?: number }
  | { kind: 'wait'; delayMs: number; patch?: TenantPatch; outputs?: StepOutputs }
  | { kind: 'finish' };

export interface StepRun {
  tenant: TenantRecord;
  runId: string;
  /** O documento da execução (o `preflight` o cria; nos outros passos sempre existe). */
  run: RunDocument | undefined;
  /** O documento deste passo, já com esta entrega contada. */
  step: StepDocument;
  /** O número desta consulta (0 na primeira entrega de um passo que espera). */
  poll: number;
  /** Desde quando o passo espera (a primeira entrega). */
  waitedMs: number;
  now: Date;
  requestId?: string;
}

/** Um passo do provisionamento: o motor (`ProvisioningEngine`) cuida do resto. */
export interface ProvisioningStep extends StepHandler {
  readonly name: ProvisioningStepName;
  execute(run: StepRun): Promise<StepOutcome>;
}

export function stepIndex(name: string): number {
  return (PROVISIONING_STEPS as readonly string[]).indexOf(name);
}

export function nextStepOf(name: ProvisioningStepName): ProvisioningStepName | undefined {
  return PROVISIONING_STEPS[stepIndex(name) + 1];
}

/**
 * O código definitivo de uma falha, ou `undefined` se ela é repetível. Erro de uma API externa: rede, 408, 429 e 5xx
 * repetem; 401 e 403 são credencial ou permissão (`<serviço>_denied`); outro 4xx é recusa (`<serviço>_rejected`).
 */
export function definitiveCodeOf(error: unknown): string | undefined {
  if (error instanceof DefinitiveStepError) return error.code;
  if (error instanceof ReleaseManifestError || error instanceof PanelBundleError) return error.code;
  if (error instanceof ExecutorInputError) return 'executor_input_invalid';
  if (error instanceof SubnetPoolExhaustedError) return 'subnet_pool_exhausted';
  if (error instanceof CloudApiError && !error.retryable) {
    return `${error.service}_${error.denied ? 'denied' : error.status === 404 ? 'not_found' : 'rejected'}`;
  }
  return undefined;
}

/** O motivo curto de uma falha repetível, para o log e o documento do passo (sem mensagem de terceiro). */
function retryReasonOf(error: unknown): string {
  if (error instanceof CloudApiError)
    return `${error.service}_${error.status === 0 ? 'unreachable' : String(error.status)}`;
  if (error instanceof LockHeldError) return 'lock_held';
  return error instanceof Error ? error.name.slice(0, 40) : 'unknown';
}

/**
 * O motor dos passos (plano §4c). Cada task `POST /internal/steps/<passo>` com `{tenantId, runId, poll?}`:
 *
 * 1. relê o cliente: fora de `provisioning` (suspenso ou cancelado no meio, CP-04) termina sem fazer nada e sem
 *    enfileirar o seguinte; outra execução (`runId` diferente, depois de um `resume`) também;
 * 2. confere a ordem: um passo já passado (entrega repetida) só garante que o passo atual está na fila; um passo à
 *    frente do atual não roda; nos passos que esperam, uma consulta já feita é ignorada;
 * 3. toma a trava do cliente (dono = `runId`, 20 min; de outro dono → a task repete depois);
 * 4. executa o passo (idempotente: nomes determinísticos, "já existe" é sucesso);
 * 5. grava primeiro o avanço no cliente (`provisioning.step`) e só então enfileira o seguinte: se a fila falhar, a
 *    repetição desta task vê o passo já avançado e enfileira o atual (o id da task é determinístico);
 * 6. falha repetível → a task responde 503 e o Cloud Tasks repete com recuo; na última tentativa da fila (8), ou numa
 *    falha definitiva, o cliente vai para `provisioning_failed` com o código, sem mais nenhuma task.
 */
@Injectable()
export class ProvisioningEngine {
  constructor(
    private readonly tenants: TenantStore,
    private readonly store: ProvisioningStore,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(ProvisioningEngine.name) private readonly logger: PinoLogger,
  ) {}

  async run(step: ProvisioningStep, input: StepInput, context: StepContext): Promise<string> {
    const tenant = await this.tenants.get(input.tenantId);
    if (tenant === undefined) return 'unknown_tenant';
    if (tenant.state !== 'provisioning') return 'not_provisioning';
    if (tenant.provisioning?.runId !== input.runId) return 'stale_run';
    const current = tenant.provisioning.step ?? PROVISIONING_STEPS[0];
    const order = stepIndex(current) - stepIndex(step.name);
    if (order > 0) {
      // Entrega repetida de um passo já feito: garante o atual na fila (no-op se já está) e para.
      if (stepIndex(current) >= 0) await this.enqueue(tenant.id, input.runId, current);
      return 'already_done';
    }
    if (order < 0) return 'not_current';

    const poll = input.poll ?? 0;
    const existing = await this.store.getStep(input.runId, step.name);
    const expected = existing?.nextPoll ?? 0;
    if (poll < expected) {
      // A consulta seguinte já foi decidida; se a fila falhou ao recebê-la, esta repetição a põe de novo.
      if (poll === expected - 1 && existing?.status === 'waiting') {
        await this.enqueue(tenant.id, input.runId, step.name, expected);
      }
      return 'stale_poll';
    }
    if (poll > expected) return 'not_current';

    try {
      await this.tenants.acquireLock(tenant.id, input.runId, LOCK_TTL_MS);
    } catch (error) {
      if (error instanceof LockHeldError) this.retry(tenant.id, step.name, error);
      throw error;
    }
    const now = this.clock.now();
    const doc = await this.store.updateStep(input.runId, step.name, (current, at) => ({
      ...(current ?? this.store.newStep(at)),
      status: 'running',
      attempts: (current?.attempts ?? 0) + 1,
      waitingSince: current?.waitingSince ?? at,
      updatedAt: at,
    }));
    const runDoc = await this.store.getRun(input.runId);
    let outcome: StepOutcome;
    try {
      outcome = await step.execute({
        tenant,
        runId: input.runId,
        run: runDoc,
        step: doc,
        poll,
        waitedMs: now.getTime() - (doc.waitingSince ?? now).getTime(),
        now,
        requestId: context.requestId,
      });
    } catch (error) {
      const code = definitiveCodeOf(error);
      if (code !== undefined) return this.fail(tenant.id, input.runId, step.name, code, context);
      if (context.retryCount !== undefined && context.retryCount >= MAX_TASK_ATTEMPTS - 1) {
        return this.fail(tenant.id, input.runId, step.name, 'retries_exhausted', context);
      }
      await this.store
        .updateStep(input.runId, step.name, (current, at) => ({
          ...(current ?? this.store.newStep(at)),
          errorCode: retryReasonOf(error),
          updatedAt: at,
        }))
        .catch(() => undefined);
      this.retry(tenant.id, step.name, error);
    }
    switch (outcome.kind) {
      case 'next':
        return this.advance(tenant.id, input.runId, step.name, outcome, context);
      case 'wait':
        return this.wait(tenant.id, input.runId, step.name, poll, outcome, context);
      case 'finish':
        return this.finish(tenant.id, input.runId, step.name, context);
    }
  }

  /** Para o cliente em `provisioning_failed` com o código (sem mais tasks), solta a trava e avisa a Verax. */
  async fail(
    tenantId: string,
    runId: string,
    step: string,
    code: string,
    context: StepContext,
  ): Promise<string> {
    const at = this.clock.now();
    const result = await this.tenants.change(tenantId, (current) => {
      if (current.state !== 'provisioning' || current.provisioning?.runId !== runId) return undefined;
      return {
        to: 'provisioning_failed',
        reason: `provisioning_failed:${code}`.slice(0, 200),
        audit: { actor: 'system', requestId: context.requestId },
        mutate: (tenant) => ({
          ...tenant,
          provisioning: {
            ...(tenant.provisioning ?? { attempts: 0 }),
            lastError: { code: code.slice(0, 64), at },
          },
        }),
      };
    });
    await this.store.updateStep(runId, step, (current, now) => ({
      ...(current ?? this.store.newStep(now)),
      status: 'failed',
      errorCode: code.slice(0, 64),
      finishedAt: now,
      updatedAt: now,
    }));
    await this.store
      .updateRun(runId, (run) => ({
        ...run,
        outcome: 'failed',
        failureCode: code.slice(0, 64),
        finishedAt: at,
      }))
      .catch(() => undefined);
    await this.releaseLock(tenantId, runId);
    if (result.transitioned) {
      // A linha que o alerta do responsável procura (CP-12): o cliente, o passo e o código, nunca dado pessoal.
      this.logger.error({ event: 'provisioning_failed', tenantId, step, code }, 'provisionamento parou');
    }
    return 'failed';
  }

  private retry(tenantId: string, step: string, error: unknown): never {
    const reason = retryReasonOf(error);
    this.logger.warn({ event: 'provisioning_step_retry', tenantId, step, reason }, 'passo vai repetir');
    throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'step_retry');
  }

  private async advance(
    tenantId: string,
    runId: string,
    step: ProvisioningStepName,
    outcome: Extract<StepOutcome, { kind: 'next' }>,
    context: StepContext,
  ): Promise<string> {
    const next = nextStepOf(step);
    if (next === undefined) throw new Error(`o passo ${step} não tem seguinte`);
    const result = await this.tenants.change(tenantId, (current) => {
      if (
        current.state !== 'provisioning' ||
        current.provisioning?.runId !== runId ||
        current.provisioning.step !== step
      ) {
        return undefined;
      }
      return {
        reason: `provisioning_step:${step}`,
        audit: { actor: 'system', requestId: context.requestId },
        mutate: (tenant) => {
          const patched = outcome.patch === undefined ? tenant : outcome.patch(tenant);
          return {
            ...patched,
            provisioning: { ...(patched.provisioning ?? { attempts: 0 }), step: next },
          };
        },
      };
    });
    if (!result.changed) return 'already_done';
    await this.store.updateStep(runId, step, (current, now) => ({
      ...(current ?? this.store.newStep(now)),
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
    step: ProvisioningStepName,
    poll: number,
    outcome: Extract<StepOutcome, { kind: 'wait' }>,
    context: StepContext,
  ): Promise<string> {
    if (outcome.patch !== undefined) {
      const patch = outcome.patch;
      await this.tenants.change(tenantId, (current) =>
        current.state === 'provisioning' && current.provisioning?.runId === runId
          ? {
              reason: `provisioning_wait:${step}`,
              audit: { actor: 'system', requestId: context.requestId },
              mutate: patch,
            }
          : undefined,
      );
    }
    const nextPoll = poll + 1;
    await this.store.updateStep(runId, step, (current, now) => ({
      ...(current ?? this.store.newStep(now)),
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
    step: ProvisioningStepName,
    context: StepContext,
  ): Promise<string> {
    const result = await this.tenants.change(tenantId, (current) => {
      if (current.state !== 'provisioning' || current.provisioning?.runId !== runId) return undefined;
      return {
        to: 'waiting_customer_connection',
        reason: 'provisioning_finished',
        audit: { actor: 'system', requestId: context.requestId },
        mutate: (tenant) => {
          const { lastError: _cleared, ...provisioning } = tenant.provisioning ?? { attempts: 0 };
          return { ...tenant, provisioning };
        },
      };
    });
    const at = this.clock.now();
    await this.store.updateStep(runId, step, (current, now) => ({
      ...(current ?? this.store.newStep(now)),
      status: 'done',
      errorCode: undefined,
      finishedAt: now,
      updatedAt: now,
    }));
    await this.store
      .updateRun(runId, (run) => ({ ...run, outcome: 'succeeded', finishedAt: at }))
      .catch(() => undefined);
    await this.releaseLock(tenantId, runId);
    if (result.transitioned) {
      this.logger.info({ event: 'provisioning_finished', tenantId, runId }, 'ambiente pronto');
    }
    return result.transitioned ? 'ready' : 'already_done';
  }

  private async releaseLock(tenantId: string, runId: string): Promise<void> {
    try {
      await this.tenants.releaseLock(tenantId, runId);
    } catch (error) {
      // Trava de outro dono (um `resume` no meio): fica com ele.
      if (!(error instanceof LockNotHeldError)) throw error;
    }
  }

  private async enqueue(
    tenantId: string,
    runId: string,
    step: string,
    poll?: number,
    delayMs?: number,
  ): Promise<void> {
    await this.queue.enqueue({
      queue: 'provisioning',
      step,
      tenantId,
      runId,
      ...(poll === undefined || poll === 0 ? {} : { poll }),
      ...(delayMs === undefined ? {} : { scheduleAt: new Date(this.clock.now().getTime() + delayMs) }),
    });
  }
}
