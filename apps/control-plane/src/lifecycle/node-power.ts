import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { tenantUrls } from '../access/tenant-urls.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import type { StepContext, StepHandler, StepInput } from '../internal/step-handler.js';
import { CloudApiError } from '../provisioning/cloud-http.js';
import { PROVISIONING_APIS, type ProvisioningApis } from '../provisioning/provisioning-settings.js';
import { STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { TenantStore } from '../tenants/tenant-store.js';
import type { TenantRecord, TenantState } from '../tenants/tenant.schema.js';
import { mayHaveNode, NODE_RUNNING_STATES, NODE_STOPPED_STATES } from './lifecycle-rules.js';
import {
  NODE_START_STEP,
  NODE_STOP_STEP,
  type NodePowerStep,
  requestNodePower,
} from './node-power-request.js';

/** O ritmo das consultas: a cada 30 s; parar espera até 10 min, ligar (com o `/health`) até 15 min. */
export const NODE_POWER_WAITS = { everyMs: 30_000, stopPolls: 20, startPolls: 30 } as const;

/** Estados do Compute em que a VM já está parada (o disco e os snapshots ficam). */
const STOPPED = new Set(['TERMINATED', 'STOPPED', 'SUSPENDED']);
/** Estados de passagem: espera e consulta de novo. */
const SETTLING = new Set(['STOPPING', 'SUSPENDING', 'PROVISIONING', 'STAGING', 'REPAIRING']);

/** O subdomínio é deste cliente (`slugs/{slug}` tomado por ele): nada `vx-<slug>` de outro cliente é tocado. */
export async function ownsSlug(tenants: TenantStore, tenant: TenantRecord): Promise<boolean> {
  const slug = await tenants.getSlug(tenant.slug);
  return slug?.state === 'taken' && slug.tenantId === tenant.id;
}

/**
 * A base dos dois passos: relê o cliente, confere que o estado ainda pede esta ação, que ele pode ter VM e que o
 * subdomínio é dele; consulta a VM e age; reagenda a si mesmo (o número da consulta no corpo da task) até o estado
 * final. Erro repetível (rede, 429, 5xx) responde 503 e o Cloud Tasks repete; recusa (403, outro 4xx) para com a
 * linha `event=node_power_failed`, e o `tick` pede de novo na hora seguinte.
 */
abstract class NodePowerBase implements StepHandler {
  abstract readonly name: NodePowerStep;
  protected abstract readonly wanted: readonly TenantState[];

  protected constructor(
    protected readonly tenants: TenantStore,
    protected readonly apis: ProvisioningApis,
    protected readonly queue: StepQueue,
    protected readonly clock: Clock,
    protected readonly logger: PinoLogger,
  ) {}

  async run(input: StepInput, context: StepContext): Promise<string> {
    const tenant = await this.tenants.get(input.tenantId);
    if (tenant === undefined) return 'unknown_tenant';
    if (!this.wanted.includes(tenant.state)) return 'not_needed';
    if (!mayHaveNode(tenant)) return 'no_node';
    const project = tenant.resources?.nodesProject;
    const zone = tenant.resources?.zone;
    if (project === undefined || zone === undefined) return 'no_node';
    if (!(await ownsSlug(this.tenants, tenant))) {
      this.logger.error(
        { event: 'node_power_failed', tenantId: tenant.id, step: this.name, code: 'slug_not_owned' },
        'subdomínio de outro cliente: a VM não é tocada',
      );
      return 'slug_not_owned';
    }
    try {
      return await this.act(tenant, project, zone, input, context);
    } catch (error) {
      if (error instanceof CloudApiError && !error.retryable) {
        this.logger.error(
          {
            event: 'node_power_failed',
            tenantId: tenant.id,
            step: this.name,
            code: `${error.service}_${error.denied ? 'denied' : 'rejected'}`,
          },
          'a VM não mudou de estado',
        );
        return 'failed';
      }
      const reason = error instanceof CloudApiError ? `${error.service}_${error.status}` : 'error';
      this.logger.warn(
        { event: 'node_power_retry', tenantId: tenant.id, step: this.name, reason },
        'vai repetir',
      );
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'step_retry');
    }
  }

  protected abstract act(
    tenant: TenantRecord,
    project: string,
    zone: string,
    input: StepInput,
    context: StepContext,
  ): Promise<string>;

  /** Consulta de novo daqui a 30 s, até o limite de consultas; depois, só o aviso (o `tick` pede de novo). */
  protected async again(tenant: TenantRecord, input: StepInput, limit: number): Promise<string> {
    const next = (input.poll ?? 0) + 1;
    if (next > limit) {
      this.logger.warn(
        { event: 'node_power_slow', tenantId: tenant.id, step: this.name },
        'a VM não chegou ao estado esperado no prazo',
      );
      return 'slow';
    }
    await this.queue.enqueue({
      queue: 'lifecycle',
      step: this.name,
      tenantId: tenant.id,
      runId: input.runId,
      poll: next,
      scheduleAt: new Date(this.clock.now().getTime() + NODE_POWER_WAITS.everyMs),
    });
    return 'waiting';
  }
}

/** `node.stop` (plano §4b e §4d): para a VM de um cliente suspenso ou cancelado (`instances.stop`). */
@Injectable()
export class NodeStopStep extends NodePowerBase {
  readonly name = NODE_STOP_STEP;
  protected readonly wanted = NODE_STOPPED_STATES;

  constructor(
    tenants: TenantStore,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
    @Inject(STEP_QUEUE) queue: StepQueue,
    @Inject(CLOCK) clock: Clock,
    @InjectPinoLogger(NodeStopStep.name) logger: PinoLogger,
  ) {
    super(tenants, apis, queue, clock, logger);
  }

  protected async act(
    tenant: TenantRecord,
    project: string,
    zone: string,
    input: StepInput,
    context: StepContext,
  ): Promise<string> {
    const instance = `vx-${tenant.slug}`;
    const status = await this.apis.compute.instanceStatus(project, zone, instance);
    if (status === undefined || STOPPED.has(status)) return this.stopped(tenant, status, context);
    if (status === 'RUNNING') await this.apis.compute.setPower(project, zone, instance, 'stop');
    else if (!SETTLING.has(status)) return 'unexpected_status';
    return this.again(tenant, input, NODE_POWER_WAITS.stopPolls);
  }

  /** Grava `nodeStoppedAt`; se o cliente foi reativado no meio, pede para ligar de novo. */
  private async stopped(
    tenant: TenantRecord,
    status: string | undefined,
    context: StepContext,
  ): Promise<string> {
    const now = this.clock.now();
    const result = await this.tenants.change(tenant.id, (current) => {
      if (!NODE_STOPPED_STATES.includes(current.state) || current.lifecycle?.nodeStoppedAt !== undefined) {
        return undefined;
      }
      return {
        reason: status === undefined ? 'node_missing_on_stop' : 'node_stopped',
        audit: { actor: 'system', requestId: context.requestId },
        mutate: (t) => ({ ...t, lifecycle: { ...t.lifecycle, nodeStoppedAt: now } }),
      };
    });
    if (NODE_RUNNING_STATES.includes(result.tenant.state)) {
      await requestNodePower(this.queue, this.clock, tenant.id, NODE_START_STEP);
      return 'reactivated_meanwhile';
    }
    if (result.changed) this.logger.info({ event: 'node_stopped', tenantId: tenant.id }, 'VM parada');
    return status === undefined ? 'no_instance' : 'stopped';
  }
}

/**
 * `node.start` (plano §4d, reativação): liga a VM de um cliente que voltou a pagar e espera a API responder pelo túnel
 * (`/health` e `/health/ready`). Só então apaga `nodeStoppedAt`.
 */
@Injectable()
export class NodeStartStep extends NodePowerBase {
  readonly name = NODE_START_STEP;
  protected readonly wanted = NODE_RUNNING_STATES;

  constructor(
    tenants: TenantStore,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
    @Inject(STEP_QUEUE) queue: StepQueue,
    @Inject(CLOCK) clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(NodeStartStep.name) logger: PinoLogger,
  ) {
    super(tenants, apis, queue, clock, logger);
  }

  protected async act(
    tenant: TenantRecord,
    project: string,
    zone: string,
    input: StepInput,
    context: StepContext,
  ): Promise<string> {
    const instance = `vx-${tenant.slug}`;
    const status = await this.apis.compute.instanceStatus(project, zone, instance);
    if (status === undefined) {
      // Um cliente pagante sem VM: nunca é criada aqui (isso é do provisionamento); a Verax precisa olhar.
      this.logger.error(
        { event: 'node_power_failed', tenantId: tenant.id, step: this.name, code: 'node_missing' },
        'a VM do cliente não existe',
      );
      return 'no_instance';
    }
    if (status === 'TERMINATED' || status === 'STOPPED') {
      await this.apis.compute.setPower(project, zone, instance, 'start');
      return this.again(tenant, input, NODE_POWER_WAITS.startPolls);
    }
    if (status !== 'RUNNING') {
      return SETTLING.has(status)
        ? this.again(tenant, input, NODE_POWER_WAITS.startPolls)
        : 'unexpected_status';
    }
    const { apiUrl } = tenantUrls(tenant.slug, this.config);
    if (!(await this.apis.probe.apiHealthy(apiUrl))) {
      return this.again(tenant, input, NODE_POWER_WAITS.startPolls);
    }
    return this.started(tenant, context);
  }

  private async started(tenant: TenantRecord, context: StepContext): Promise<string> {
    const result = await this.tenants.change(tenant.id, (current) => {
      if (!NODE_RUNNING_STATES.includes(current.state) || current.lifecycle?.nodeStoppedAt === undefined) {
        return undefined;
      }
      return {
        reason: 'node_started',
        audit: { actor: 'system', requestId: context.requestId },
        mutate: (t) => {
          const { nodeStoppedAt: _cleared, ...lifecycle } = t.lifecycle ?? {};
          return { ...t, lifecycle };
        },
      };
    });
    if (NODE_STOPPED_STATES.includes(result.tenant.state)) {
      await requestNodePower(this.queue, this.clock, tenant.id, NODE_STOP_STEP);
      return 'suspended_meanwhile';
    }
    if (result.changed) this.logger.info({ event: 'node_started', tenantId: tenant.id }, 'VM ligada');
    return 'started';
  }
}
