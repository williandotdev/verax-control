import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import type { StepContext, StepHandler, StepInput } from '../internal/step-handler.js';
import { CloudApiError } from '../provisioning/cloud-http.js';
import type { PanelBundle } from '../provisioning/panel-bundle.js';
import { definitiveCodeOf } from '../provisioning/provisioning-engine.js';
import { STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { type FleetCloud, MetadataConflictError, ReleaseWithoutPanelError } from './fleet-cloud.js';
import { apiOriginOf } from './fleet-plan.js';
import { FLEET_CLOUD, FLEET_SETTINGS, type FleetSettings } from './fleet-settings.js';
import { FleetConflictError, FleetStore } from './fleet-store.js';
import {
  IN_FLIGHT_STATES,
  type NodeOperation,
  type RolloutNodeRecord,
  type RolloutRecord,
  SETTLED_STATES,
} from './fleet.schema.js';

/** A task de cada volta do motor: `POST /internal/steps/fleet.tick` com `{tenantId: <rodada>, runId: <rodada>, poll}`. */
export const FLEET_TICK_STEP = 'fleet.tick';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** Os prazos do motor. */
export const FLEET_WAITS = {
  /** Entre uma volta e a seguinte, enquanto houver nó mudando ou na fila. */
  tickMs: 30 * SECOND_MS,
  /** A volta em andamento: uma entrega repetida ao mesmo tempo espera; depois disso, a volta caiu e outra assume. */
  leaseMs: 5 * MINUTE_MS,
  /** A API pública depois do `ok` do host: 10 conferências, uma por volta (cerca de 5 min). */
  healthTries: 10,
  /** Com janela de manutenção, o host pode esperar até a próxima: o prazo ganha um dia. */
  windowExtraMs: 24 * 60 * MINUTE_MS,
} as const;

/** Sites do painel publicados por nó em cada volta (a volta fica curta; o resto vai na seguinte). */
export const PANELS_PER_TICK = 5;

const HOST_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const HOST_FAILURE_STATES = new Set(['failed', 'rolled_back', 'rollback_failed']);

/** A volta não pode seguir agora (outra entrega da mesma volta está rodando): o Cloud Tasks repete. */
function retryLater(reason: string): never {
  throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', `fleet_${reason}`.slice(0, 64));
}

/** O código definitivo de uma falha num nó, ou `undefined` se ela é repetível (a volta seguinte tenta de novo). */
export function fleetFailureCode(error: unknown): string | undefined {
  if (error instanceof MetadataConflictError) return undefined;
  if (error instanceof ReleaseWithoutPanelError) return 'panel_bundle_missing';
  if (error instanceof CloudApiError && error.retryable) return undefined;
  return definitiveCodeOf(error);
}

/** Estados do atualizador em que o nó ficou na versão de antes do pedido (`update-from`). */
const HOST_KEPT_PREVIOUS = new Set([
  'failed',
  'rolled_back',
  'waiting_window',
  'waiting_install',
  'accepted',
]);

/**
 * A versão instalada no nó agora, pelos guest attributes: o que o atualizador relatou por último manda (`ok` → a versão
 * do pedido; falhou ou voltou → a de antes do pedido, `update-from`); sem o atualizador, a da instalação (`ready`) ou a
 * do worker (`version`). A do boot ficaria velha depois de uma atualização e de uma volta automática.
 */
export function versionOfAttributes(attributes: ReadonlyMap<string, string>): string {
  const state = attributes.get('update-state');
  let value: string | undefined;
  if (state === 'ok') value = attributes.get('update-release');
  else if (state !== undefined && HOST_KEPT_PREVIOUS.has(state)) {
    const from = attributes.get('update-from');
    value = from === 'none' ? undefined : from;
  }
  value ??= attributes.get('ready') ?? attributes.get('version');
  return value !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : 'unknown';
}

/** O nó precisa de outra volta: está mudando, ou na fila de uma rodada que anda (ou forçado pelo responsável). */
function needsTick(rollout: Pick<RolloutRecord, 'state'>, nodes: readonly RolloutNodeRecord[]): boolean {
  return nodes.some(
    (node) =>
      IN_FLIGHT_STATES.has(node.state) ||
      (node.state === 'pending' && (node.forced === true || rollout.state === 'running')),
  );
}

/**
 * Os nós que a rodada começa agora: a onda mais baixa que ainda tem nó por fazer, até a capacidade dela (uma de cada vez
 * nas células, `concurrency` nos dedicados), contando os que já estão mudando. Os forçados (a volta pedida pelo
 * responsável) começam sempre, fora disso.
 */
export function nodesToStart(
  rollout: RolloutRecord,
  nodes: readonly RolloutNodeRecord[],
): RolloutNodeRecord[] {
  const forced = nodes.filter((node) => node.state === 'pending' && node.forced === true);
  if (rollout.state !== 'running') return forced;
  const open = nodes.filter((node) => node.forced !== true && !SETTLED_STATES.has(node.state));
  if (open.length === 0) return forced;
  const wave = Math.min(...open.map((node) => node.wave));
  const inFlight = open.filter((node) => node.wave === wave && IN_FLIGHT_STATES.has(node.state)).length;
  const capacity = (wave === 2 ? rollout.concurrency : 1) - inFlight;
  const pending = open.filter((node) => node.wave === wave && node.state === 'pending');
  return [...forced, ...pending.slice(0, Math.max(0, capacity))];
}

/**
 * O motor da frota. Cada volta (uma task `fleet.tick`, a cada 30 s enquanto houver o que fazer):
 *
 * 1. confere o número da volta (`nextTick`): uma entrega repetida de uma volta já feita só garante a seguinte na fila;
 *    a mesma volta rodando em outra entrega espera (a concessão `lease`, 5 min);
 * 2. acompanha cada nó que está mudando: o pedido nos metadados da VM, o `ok` do host nos guest attributes (com prazo),
 *    a API pública e, por fim, o painel de cada destino do nó, publicado só depois do nó (o painel nunca passa a API);
 * 3. com a rodada andando, começa os nós da onda atual até a capacidade dela; a primeira falha para a rodada
 *    (`paused_on_failure`) e nenhum nó novo começa (os que já mudavam terminam);
 * 4. grava a volta seguinte e só então a enfileira (se a fila falhar, a repetição desta volta a põe: o id é
 *    determinístico).
 *
 * Cada nó é gravado só se ninguém mexeu nele no meio (`rev`): uma operação do responsável vence a volta.
 */
@Injectable()
export class RolloutEngine {
  constructor(
    private readonly store: FleetStore,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FLEET_CLOUD) private readonly cloud: FleetCloud | null,
    @Inject(FLEET_SETTINGS) private readonly settings: FleetSettings | null,
    @InjectPinoLogger(RolloutEngine.name) private readonly logger: PinoLogger,
  ) {}

  /** Põe a volta `tick` da rodada na fila (o id é determinístico: repetir não duplica). */
  async enqueue(rolloutId: string, tick: number, delayMs?: number): Promise<void> {
    await this.queue.enqueue({
      queue: 'lifecycle',
      step: FLEET_TICK_STEP,
      tenantId: rolloutId,
      runId: rolloutId,
      ...(tick === 0 ? {} : { poll: tick }),
      ...(delayMs === undefined ? {} : { scheduleAt: new Date(this.clock.now().getTime() + delayMs) }),
    });
  }

  async tick(rolloutId: string, tick: number, context: StepContext = {}): Promise<string> {
    const cloud = this.cloud;
    const settings = this.settings;
    if (cloud === null || settings === null) return 'fleet_unconfigured';
    const current = await this.store.get(rolloutId);
    if (current === undefined) return 'unknown_rollout';
    if (tick < current.nextTick) {
      // Uma volta já feita: se a fila falhou ao receber a seguinte, esta repetição a põe.
      if (tick === current.nextTick - 1 && needsTick(current, await this.store.nodes(rolloutId))) {
        await this.enqueue(rolloutId, current.nextTick, FLEET_WAITS.tickMs);
      }
      return 'stale_tick';
    }
    if (tick > current.nextTick) return 'not_current';

    let leased: { rollout: RolloutRecord; nodes: RolloutNodeRecord[] } | undefined;
    try {
      leased = await this.store.change(rolloutId, (rollout, nodes, now) => {
        if (rollout.nextTick !== tick) return undefined;
        if (rollout.lease?.tick === tick && rollout.lease.until > now)
          throw new FleetConflictError('tick_running');
        return {
          rollout: { ...rollout, lease: { tick, until: new Date(now.getTime() + FLEET_WAITS.leaseMs) } },
          nodes: [],
        };
      });
    } catch (error) {
      if (error instanceof FleetConflictError) retryLater(error.code);
      throw error;
    }
    if (leased === undefined || leased.rollout.nextTick !== tick) return 'stale_tick';
    const rollout = leased.rollout;

    const failures: { node: RolloutNodeRecord; code: string }[] = [];
    const bundles = new Map<string, () => Promise<PanelBundle>>();
    for (const node of leased.nodes.filter((candidate) => IN_FLIGHT_STATES.has(candidate.state))) {
      const result = await this.advance(rollout, node, cloud, settings, bundles);
      if (result?.state === 'failed') failures.push({ node: result, code: result.errorCode ?? 'unknown' });
    }
    // Uma falha nesta volta para a rodada: só a volta forçada (pedida pelo responsável) começa. A mesma regra vale no
    // meio do lote: depois da primeira falha de um nó que começou agora, os outros do lote não começam.
    let stopping = failures.some((entry) => entry.node.operation?.kind !== 'revert');
    const refreshed = await this.store.nodes(rolloutId);
    const starting = nodesToStart(stopping ? { ...rollout, state: 'paused_on_failure' } : rollout, refreshed);
    for (const node of starting) {
      if (stopping && node.forced !== true) continue;
      const started = await this.start(rollout, node, cloud);
      if (started === undefined) continue;
      // O pedido vai aos metadados na mesma volta.
      const result = await this.advance(rollout, started, cloud, settings, bundles);
      if (result?.state === 'failed') {
        failures.push({ node: result, code: result.errorCode ?? 'unknown' });
        if (result.operation?.kind !== 'revert') stopping = true;
      }
    }

    const finished = await this.store.change(rolloutId, (latest, nodes, now) => {
      if (latest.nextTick !== tick) return undefined;
      let state = latest.state;
      let failure = latest.failure;
      const updateFailure = failures.find((entry) => entry.node.operation?.kind !== 'revert');
      if (state === 'running' && updateFailure !== undefined) {
        state = 'paused_on_failure';
        failure = { nodeKey: updateFailure.node.key, code: updateFailure.code, at: now };
      }
      const open = nodes.some((node) => !SETTLED_STATES.has(node.state));
      const completed = state === 'running' && !open;
      return {
        rollout: {
          ...latest,
          state: completed ? 'completed' : state,
          ...(failure === undefined ? {} : { failure }),
          ...(completed ? { finishedAt: now } : {}),
          nextTick: tick + 1,
          lease: undefined,
        },
        nodes: [],
        ...(state !== latest.state || completed
          ? {
              audit: {
                actor: 'system',
                action: completed ? 'rollout.completed' : 'rollout.paused_on_failure',
                details: {
                  rolloutId,
                  release: latest.release.release,
                  ...(failure === undefined || completed
                    ? {}
                    : { nodeKey: failure.nodeKey, code: failure.code }),
                },
                requestId: context.requestId,
              },
            }
          : {}),
      };
    });
    if (finished === undefined) return 'stale_tick';
    for (const { node, code } of failures) {
      // A linha que o alerta do responsável procura (envs/control-plane/monitoring.tf): a rodada, o nó e o código.
      this.logger.error(
        { event: 'rollout_failed', rolloutId, nodeKey: node.key, operation: node.operation?.kind, code },
        'atualização da frota parou num nó',
      );
    }
    if (finished.rollout.state === 'completed' && rollout.state !== 'completed') {
      this.logger.info(
        { event: 'rollout_completed', rolloutId, release: rollout.release.release },
        'frota atualizada',
      );
    }
    if (needsTick(finished.rollout, finished.nodes)) {
      await this.enqueue(rolloutId, tick + 1, FLEET_WAITS.tickMs);
      return 'continuing';
    }
    return finished.rollout.state;
  }

  /** Um nó da fila passa a mudar: a operação, a tentativa, o id do pedido e a versão de antes. */
  private async start(
    rollout: RolloutRecord,
    node: RolloutNodeRecord,
    cloud: FleetCloud,
  ): Promise<RolloutNodeRecord | undefined> {
    const operation: NodeOperation = node.operation ?? {
      kind: 'update',
      release: rollout.release,
      intent: rollout.intent,
    };
    let fromVersion = node.fromVersion;
    if (fromVersion === undefined) {
      fromVersion = versionOfAttributes(
        await cloud.guestAttributes(node.target).catch(() => new Map<string, string>()),
      );
    }
    const attempt = node.attempt + 1;
    const next: RolloutNodeRecord = {
      ...node,
      state: 'updating',
      operation,
      attempt,
      request: `${rollout.id}-${attempt}`,
      requestedAt: undefined,
      fromVersion,
      nodeState: undefined,
      healthPolls: 0,
      panelsDone: 0,
      errorCode: undefined,
      startedAt: this.clock.now(),
      finishedAt: undefined,
      forced: undefined,
    };
    // O começo é conferido contra a rodada relida na mesma transação: parada ou abortada enquanto a volta esperava a
    // nuvem, nenhum nó novo começa (só a volta forçada pelo responsável).
    const claimed = await this.store.saveNode(
      rollout.id,
      next,
      node.rev,
      (latest) => node.forced === true || latest.state === 'running',
    );
    if (!claimed) return undefined;
    return { ...next, rev: node.rev + 1 };
  }

  /** Um passo de um nó que está mudando; grava o resultado (se ninguém mexeu no nó) e o devolve. */
  private async advance(
    rollout: RolloutRecord,
    node: RolloutNodeRecord,
    cloud: FleetCloud,
    settings: FleetSettings,
    bundles: Map<string, () => Promise<PanelBundle>>,
  ): Promise<RolloutNodeRecord | undefined> {
    const now = this.clock.now();
    let next: RolloutNodeRecord;
    try {
      next = await this.step(rollout, node, cloud, settings, bundles, now);
    } catch (error) {
      const progress = error instanceof PublishProgressError ? error.node : node;
      const cause = error instanceof PublishProgressError ? error.failure : error;
      const code = fleetFailureCode(cause);
      if (code === undefined) {
        this.logger.warn(
          { event: 'rollout_node_retry', rolloutId: rollout.id, nodeKey: node.key, reason: reasonOf(cause) },
          'nó da frota vai tentar de novo na próxima volta',
        );
        next = progress;
        if (next === node) return node;
      } else {
        next = fail(progress, code, now);
      }
    }
    if (!(await this.store.saveNode(rollout.id, next, node.rev))) return undefined;
    return { ...next, rev: node.rev + 1 };
  }

  private async step(
    rollout: RolloutRecord,
    node: RolloutNodeRecord,
    cloud: FleetCloud,
    settings: FleetSettings,
    bundles: Map<string, () => Promise<PanelBundle>>,
    now: Date,
  ): Promise<RolloutNodeRecord> {
    const operation = node.operation;
    const request = node.request;
    if (operation === undefined || request === undefined) return fail(node, 'node_state_invalid', now);
    switch (node.state) {
      case 'updating': {
        if (node.requestedAt === undefined) {
          await cloud.requestRelease(node.target, {
            release: operation.release.release,
            packageSha256: operation.release.packageSha256,
            request,
            intent: operation.intent,
            // A janela vale para a rodada; a volta pedida pelo responsável não espera.
            ...(operation.kind === 'update' && rollout.window !== undefined
              ? { window: rollout.window }
              : {}),
          });
          return { ...node, requestedAt: now };
        }
        const attributes = await cloud.guestAttributes(node.target);
        let next: RolloutNodeRecord = node;
        if (attributes.get('update-request') === request) {
          const hostState = attributes.get('update-state') ?? 'unknown';
          next = { ...node, nodeState: /^[a-z_]{1,40}$/.test(hostState) ? hostState : 'unknown' };
          if (hostState === 'ok' && attributes.get('update-release') === operation.release.release) {
            return { ...next, state: 'checking', healthPolls: 0 };
          }
          if (HOST_FAILURE_STATES.has(hostState)) {
            const reason = attributes.get('update-error') ?? '';
            return fail(
              next,
              `node_${hostState}:${HOST_ERROR_PATTERN.test(reason) ? reason : 'unknown'}`,
              now,
            );
          }
        }
        const limit =
          rollout.nodeTimeoutMinutes * MINUTE_MS +
          (operation.kind === 'update' && rollout.window !== undefined ? FLEET_WAITS.windowExtraMs : 0);
        if (now.getTime() - node.requestedAt.getTime() >= limit) return fail(next, 'update_timeout', now);
        return next;
      }
      case 'checking': {
        if (await cloud.apiHealthy(node.apiOrigin)) return { ...node, state: 'publishing', panelsDone: 0 };
        const polls = node.healthPolls + 1;
        if (polls >= FLEET_WAITS.healthTries)
          return fail({ ...node, healthPolls: polls }, 'health_failed', now);
        return { ...node, healthPolls: polls };
      }
      case 'publishing': {
        const release = operation.release;
        let bundle = bundles.get(release.release);
        if (bundle === undefined) {
          bundle = cloud.panelBundle(release);
          bundles.set(release.release, bundle);
        }
        let done = node.panelsDone;
        const until = Math.min(node.panels.length, done + PANELS_PER_TICK);
        for (; done < until; done += 1) {
          const site = node.panels[done];
          if (site === undefined) break;
          try {
            const published = await cloud.publishPanel(
              site,
              apiOriginOf(site.slug, settings),
              release,
              bundle,
            );
            if (published) {
              this.logger.info(
                {
                  event: 'rollout_panel_published',
                  rolloutId: rollout.id,
                  nodeKey: node.key,
                  siteId: site.siteId,
                },
                'painel publicado na versão do nó',
              );
            }
          } catch (error) {
            throw new PublishProgressError({ ...node, panelsDone: done }, error);
          }
        }
        if (done < node.panels.length) return { ...node, panelsDone: done };
        return {
          ...node,
          panelsDone: done,
          state: operation.kind === 'revert' ? 'reverted' : 'done',
          finishedAt: now,
        };
      }
      default:
        return node;
    }
  }
}

/** A publicação parou num site: o progresso dos anteriores fica. */
class PublishProgressError extends Error {
  constructor(
    readonly node: RolloutNodeRecord,
    readonly failure: unknown,
  ) {
    super('publicação do painel interrompida');
    this.name = 'PublishProgressError';
  }
}

function fail(node: RolloutNodeRecord, code: string, now: Date): RolloutNodeRecord {
  return { ...node, state: 'failed', errorCode: code.slice(0, 64), finishedAt: now };
}

function reasonOf(error: unknown): string {
  if (error instanceof CloudApiError)
    return `${error.service}_${error.status === 0 ? 'unreachable' : String(error.status)}`;
  return error instanceof Error ? error.name.slice(0, 40) : 'unknown';
}

/** A volta do motor como passo da fila `lifecycle` (o corpo traz a rodada nos dois ids). */
@Injectable()
export class FleetTickStep implements StepHandler {
  readonly name = FLEET_TICK_STEP;

  constructor(private readonly engine: RolloutEngine) {}

  run(input: StepInput, context: StepContext): Promise<string> {
    if (input.tenantId !== input.runId) return Promise.resolve('invalid_tick');
    return this.engine.tick(input.runId, input.poll ?? 0, context);
  }
}
