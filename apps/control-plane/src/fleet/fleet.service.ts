import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { CellStore } from '../cells/cell-store.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { NODE_RELEASE_PATTERN } from '../common/config/env.schema.js';
import { newUlid } from '../common/ulid.js';
import { CloudApiError } from '../provisioning/cloud-http.js';
import { ReleaseManifestError } from '../provisioning/release-manifest.js';
import { TenantStore } from '../tenants/tenant-store.js';
import type { TenantRecord } from '../tenants/tenant.schema.js';
import { type FleetCloud, ReleaseWithoutPanelError } from './fleet-cloud.js';
import {
  buildFleetPlan,
  type ExcludedNode,
  type FleetPlan,
  type PlannedNode,
  RUNNING_TENANT_STATES,
  STOPPED_TENANT_STATES,
} from './fleet-plan.js';
import { FLEET_CLOUD, FLEET_SETTINGS, type FleetSettings } from './fleet-settings.js';
import { FleetConflictError, FleetStore, totalsOf } from './fleet-store.js';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_NODE_TIMEOUT_MINUTES,
  IN_FLIGHT_STATES,
  MAX_CONCURRENCY,
  MAX_FLEET_NODES,
  NODE_KEY_PATTERN,
  ROLLOUT_INTENTS,
  type Rollout,
  type RolloutNodeRecord,
  type RolloutRecord,
  type RolloutRelease,
  UPDATE_WINDOW_PATTERN,
} from './fleet.schema.js';
import { RolloutEngine } from './rollout-engine.js';

/** A frota sem configuração (`RELEASE_BUCKET`): nada pode ser lido nem promovido. */
export class FleetUnconfiguredError extends Error {
  constructor() {
    super('frota sem configuração');
    this.name = 'FleetUnconfiguredError';
  }
}

/** A versão pedida não serve para a frota: fora do bucket, assinatura ou manifesto recusados, ou sem o painel. */
export class FleetReleaseError extends Error {
  constructor(readonly code: string) {
    super(`versão recusada: ${code}`);
    this.name = 'FleetReleaseError';
  }
}

/** O pedido de uma rodada nova (o console manda; o worker confere tudo de novo). */
export const rolloutRequestSchema = z.strictObject({
  release: z.string().regex(NODE_RELEASE_PATTERN),
  /** A versão digitada de novo: a confirmação, como o subdomínio nas operações sobre um cliente. */
  confirmRelease: z.string().max(32),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).default(DEFAULT_CONCURRENCY),
  window: z.string().regex(UPDATE_WINDOW_PATTERN).optional(),
  intent: z.enum(ROLLOUT_INTENTS).default('upgrade'),
});
export type RolloutRequest = z.infer<typeof rolloutRequestSchema>;

export const ROLLOUT_ACTIONS = ['pause', 'resume', 'abort'] as const;
export type RolloutAction = (typeof ROLLOUT_ACTIONS)[number];
export const NODE_ACTIONS = ['skip', 'rollback'] as const;
export type NodeAction = (typeof NODE_ACTIONS)[number];

/** Um nó como a revisão o mostra. */
export interface PlanView {
  key: string;
  kind: 'cell' | 'dedicated';
  wave: number;
  label: string;
  instance: string;
  panels: string[];
}

export interface FleetPlanView {
  release: Pick<RolloutRelease, 'release' | 'commit'>;
  nodes: PlanView[];
  excluded: ExcludedNode[];
  /** A rodada que ainda não terminou (uma por vez). */
  activeRolloutId?: string;
}

/** A versão de um nó e dos sites dele agora (o console, "Versões"). */
export interface InventoryNode {
  key: string;
  kind: 'cell' | 'dedicated';
  wave: number;
  label: string;
  version?: string;
  updateState?: string;
  error?: 'unreachable';
  panels: { slug: string; release?: string; error?: 'unreachable' }[];
}

export interface ReleaseView {
  release: string;
  commit?: string;
  /** `ok`: assinatura e manifesto conferidos, com o painel; senão, o motivo. */
  status: 'ok' | 'panel_missing' | 'invalid' | 'unavailable';
}

const ACTIVE_STATES = new Set<Rollout['state']>(['running', 'paused', 'paused_on_failure']);
/** Leituras paralelas na tela de versões (uma VM e os sites dela por vez, alguns ao mesmo tempo). */
const INVENTORY_PARALLELISM = 4;
const MAX_LISTED_RELEASES = 20;

function viewOf(node: PlannedNode): PlanView {
  return {
    key: node.key,
    kind: node.kind,
    wave: node.wave,
    label: node.label,
    instance: node.target.instance,
    panels: node.panels.map((panel) => panel.slug),
  };
}

/** Ordem das versões: a mais nova primeiro. */
export function compareReleasesDesc(a: string, b: string): number {
  const parts = (value: string): number[] => value.slice('node-v'.length).split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    const diff = (y[index] ?? 0) - (x[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function inPool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * As operações do responsável sobre a frota (no cp-worker; o console as pede pela rota interna): as versões no bucket,
 * a frota e a versão de cada nó e site, a revisão de uma rodada, a rodada nova, e parar, retomar, abortar, pular um nó
 * e voltar um nó. Tudo auditado como `owner:<e-mail>` (`rollout.*`).
 */
@Injectable()
export class FleetService {
  constructor(
    private readonly store: FleetStore,
    private readonly engine: RolloutEngine,
    private readonly tenants: TenantStore,
    private readonly cells: CellStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FLEET_CLOUD) private readonly cloud: FleetCloud | null,
    @Inject(FLEET_SETTINGS) private readonly settings: FleetSettings | null,
    @InjectPinoLogger(FleetService.name) private readonly logger: PinoLogger,
  ) {}

  private configured(): { cloud: FleetCloud; settings: FleetSettings } {
    if (this.cloud === null || this.settings === null) throw new FleetUnconfiguredError();
    return { cloud: this.cloud, settings: this.settings };
  }

  /** O plano de agora: as células e os clientes com nó no ar, nas ondas. */
  async plan(): Promise<FleetPlan> {
    const { settings } = this.configured();
    const states = [...RUNNING_TENANT_STATES, ...STOPPED_TENANT_STATES];
    const lists = await Promise.all(states.map((state) => this.tenants.listInState(state, { limit: 500 })));
    const tenants: TenantRecord[] = lists.flat();
    return buildFleetPlan(await this.cells.list(), tenants, settings);
  }

  /** As versões do bucket de releases, a mais nova primeiro, cada uma conferida. */
  async releases(): Promise<ReleaseView[]> {
    const { cloud } = this.configured();
    const names = (await cloud.listReleases())
      .filter((name) => NODE_RELEASE_PATTERN.test(name))
      .sort(compareReleasesDesc)
      .slice(0, MAX_LISTED_RELEASES);
    return inPool(names, INVENTORY_PARALLELISM, async (release): Promise<ReleaseView> => {
      try {
        const info = await cloud.readRelease(release);
        return { release, commit: info.commit, status: 'ok' };
      } catch (error) {
        if (error instanceof ReleaseWithoutPanelError) return { release, status: 'panel_missing' };
        if (error instanceof ReleaseManifestError) return { release, status: 'invalid' };
        return { release, status: 'unavailable' };
      }
    });
  }

  /** A versão de cada nó e de cada site do painel, agora (os guest attributes e os rótulos do Firebase). */
  async inventory(): Promise<{ nodes: InventoryNode[]; excluded: ExcludedNode[] }> {
    const { cloud } = this.configured();
    const plan = await this.plan();
    const nodes = await inPool(plan.nodes, INVENTORY_PARALLELISM, async (node): Promise<InventoryNode> => {
      const base = { key: node.key, kind: node.kind, wave: node.wave, label: node.label };
      let attributes: Map<string, string> | undefined;
      try {
        attributes = await cloud.guestAttributes(node.target);
      } catch {
        attributes = undefined;
      }
      const panels = await Promise.all(
        node.panels.map(async (site) => {
          try {
            const release = await cloud.siteRelease(site);
            return { slug: site.slug, ...(release === undefined ? {} : { release }) };
          } catch {
            return { slug: site.slug, error: 'unreachable' as const };
          }
        }),
      );
      if (attributes === undefined) return { ...base, error: 'unreachable', panels };
      const version =
        attributes.get('update-release') ?? attributes.get('ready') ?? attributes.get('version');
      const updateState = attributes.get('update-state');
      return {
        ...base,
        ...(version === undefined ? {} : { version: version.slice(0, 64) }),
        ...(updateState === undefined ? {} : { updateState: updateState.slice(0, 40) }),
        panels,
      };
    });
    return { nodes, excluded: plan.excluded };
  }

  /** A revisão de uma rodada com esta versão: a versão conferida, as ondas e quem fica fora. */
  async preview(release: string): Promise<FleetPlanView> {
    const info = await this.readRelease(release);
    const plan = await this.plan();
    const active = await this.activeRollout();
    return {
      release: { release: info.release, commit: info.commit },
      nodes: plan.nodes.map(viewOf),
      excluded: plan.excluded,
      ...(active === undefined ? {} : { activeRolloutId: active.id }),
    };
  }

  /** Cria a rodada e põe a primeira volta na fila. */
  async create(request: RolloutRequest, actor: string, requestId?: string): Promise<RolloutRecord> {
    if (request.confirmRelease !== request.release) throw new FleetConflictError('confirmation_mismatch');
    const release = await this.readRelease(request.release);
    if ((await this.activeRollout()) !== undefined) throw new FleetConflictError('rollout_active');
    const plan = await this.plan();
    if (plan.nodes.length === 0) throw new FleetConflictError('fleet_empty');
    if (plan.nodes.length > MAX_FLEET_NODES) throw new FleetConflictError('fleet_too_large');
    const now = this.clock.now();
    const id = newUlid(now.getTime());
    const nodes: RolloutNodeRecord[] = plan.nodes.map((node) => ({
      ...node,
      state: 'pending',
      attempt: 0,
      healthPolls: 0,
      panelsDone: 0,
      updatedAt: now,
      rev: 0,
    }));
    const rollout: Rollout = {
      release,
      intent: request.intent,
      state: 'running',
      concurrency: request.concurrency,
      ...(request.window === undefined ? {} : { window: request.window }),
      nodeTimeoutMinutes: DEFAULT_NODE_TIMEOUT_MINUTES,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
      nextTick: 0,
      totals: totalsOf(nodes),
    };
    await this.store.create(id, rollout, nodes, {
      actor,
      action: 'rollout.created',
      details: {
        rolloutId: id,
        release: release.release,
        intent: request.intent,
        concurrency: request.concurrency,
        window: request.window ?? null,
        nodes: nodes.length,
        excluded: plan.excluded.length,
      },
      requestId,
    });
    this.logger.info(
      { event: 'rollout_created', rolloutId: id, release: release.release, nodes: nodes.length },
      'rodada da frota criada',
    );
    await this.engine.enqueue(id, 0);
    return { id, ...rollout };
  }

  /** Parar, retomar (o nó que falhou tenta de novo, com um pedido novo) ou abortar a rodada. */
  async act(id: string, action: RolloutAction, actor: string, requestId?: string): Promise<RolloutRecord> {
    const result = await this.store.change(id, (rollout, nodes, now) => {
      const audit = {
        actor,
        action: `rollout.${action === 'abort' ? 'aborted' : action === 'pause' ? 'paused' : 'resumed'}`,
        details: { rolloutId: id, release: rollout.release.release },
        requestId,
      };
      switch (action) {
        case 'pause':
          if (rollout.state !== 'running') throw new FleetConflictError('rollout_not_running');
          return { rollout: { ...rollout, state: 'paused' }, nodes: [], audit };
        case 'resume': {
          if (rollout.state !== 'paused' && rollout.state !== 'paused_on_failure') {
            throw new FleetConflictError('rollout_not_paused');
          }
          const retried = nodes
            .filter((node) => node.state === 'failed' && node.operation?.kind !== 'revert')
            .map((node) => ({
              ...node,
              state: 'pending' as const,
              errorCode: undefined,
              finishedAt: undefined,
            }));
          return {
            rollout: { ...rollout, state: 'running', failure: undefined },
            nodes: retried,
            audit: { ...audit, details: { ...audit.details, retried: retried.map((node) => node.key) } },
          };
        }
        case 'abort':
          if (!ACTIVE_STATES.has(rollout.state)) throw new FleetConflictError('rollout_finished');
          return { rollout: { ...rollout, state: 'aborted', finishedAt: now }, nodes: [], audit };
      }
    });
    if (result === undefined) throw new FleetConflictError('not_found');
    await this.engine.enqueue(id, result.rollout.nextTick);
    this.logger.info({ event: `rollout_${action}`, rolloutId: id }, 'operação na rodada da frota');
    return result.rollout;
  }

  /** Pular um nó (na fila ou que falhou), ou voltar um nó para a versão que ele tinha antes da rodada. */
  async actOnNode(
    id: string,
    key: string,
    action: NodeAction,
    actor: string,
    requestId?: string,
  ): Promise<RolloutNodeRecord> {
    if (!NODE_KEY_PATTERN.test(key)) throw new FleetConflictError('not_found');
    let previous: RolloutRelease | undefined;
    if (action === 'rollback') {
      const node = (await this.store.nodes(id)).find((candidate) => candidate.key === key);
      if (node === undefined) throw new FleetConflictError('not_found');
      const from = node.fromVersion;
      if (from === undefined || !NODE_RELEASE_PATTERN.test(from))
        throw new FleetConflictError('rollback_unavailable');
      if (from === node.operation?.release.release) throw new FleetConflictError('rollback_unavailable');
      previous = await this.readRelease(from);
    }
    const result = await this.store.change(id, (rollout, nodes) => {
      const node = nodes.find((candidate) => candidate.key === key);
      if (node === undefined) throw new FleetConflictError('not_found');
      if (IN_FLIGHT_STATES.has(node.state)) throw new FleetConflictError('node_in_flight');
      const details = { rolloutId: id, nodeKey: key, release: rollout.release.release };
      if (action === 'skip') {
        if (node.state !== 'pending' && node.state !== 'failed')
          throw new FleetConflictError('node_not_skippable');
        return {
          rollout,
          nodes: [{ ...node, state: 'skipped', forced: undefined }],
          audit: { actor, action: 'rollout.node_skipped', details, requestId },
        };
      }
      if (node.state !== 'done' && node.state !== 'failed')
        throw new FleetConflictError('node_not_revertible');
      if (previous === undefined || node.fromVersion !== previous.release) {
        throw new FleetConflictError('rollback_unavailable');
      }
      return {
        rollout,
        nodes: [
          {
            ...node,
            state: 'pending',
            forced: true,
            operation: { kind: 'revert', release: previous, intent: 'rollback' },
            errorCode: undefined,
            finishedAt: undefined,
          },
        ],
        audit: {
          actor,
          action: 'rollout.node_rollback',
          details: { ...details, to: previous.release },
          requestId,
        },
      };
    });
    const node = result?.nodes.find((candidate) => candidate.key === key);
    if (result === undefined || node === undefined) throw new FleetConflictError('not_found');
    await this.engine.enqueue(id, result.rollout.nextTick);
    this.logger.info(
      { event: `rollout_node_${action}`, rolloutId: id, nodeKey: key },
      'operação num nó da frota',
    );
    return node;
  }

  /** A rodada que ainda não terminou, se houver (uma por vez). */
  async activeRollout(): Promise<RolloutRecord | undefined> {
    const recent = await this.store.list(20);
    return recent.find((rollout) => ACTIVE_STATES.has(rollout.state));
  }

  private async readRelease(release: string): Promise<RolloutRelease> {
    const { cloud } = this.configured();
    if (!NODE_RELEASE_PATTERN.test(release)) throw new FleetReleaseError('release_invalid');
    try {
      return await cloud.readRelease(release);
    } catch (error) {
      if (error instanceof ReleaseWithoutPanelError) throw new FleetReleaseError('panel_bundle_missing');
      if (error instanceof ReleaseManifestError) throw new FleetReleaseError(error.code);
      if (error instanceof CloudApiError && !error.retryable)
        throw new FleetReleaseError('release_unavailable');
      throw error;
    }
  }
}
