import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { NODE_RELEASE_PATTERN } from '../common/config/env.schema.js';
import { ApiError } from '../common/http/api-error.js';
import { isUlid } from '../common/ulid.js';
import { FleetStore } from '../fleet/fleet-store.js';
import {
  MAX_CONCURRENCY,
  NODE_KEY_PATTERN,
  type RolloutNodeRecord,
  type RolloutRecord,
  UPDATE_WINDOW_PATTERN,
} from '../fleet/fleet.schema.js';
import { EXCLUSION_REASONS } from '../fleet/fleet-plan.js';
import type { OwnerContext } from '../pricing/pricing-store.js';
import { CONSOLE_FLEET_CLIENT, type WorkerFleetClient } from './worker-fleet-client.js';
import type { OwnerCallResult } from './worker-owner-client.js';

/** Uma rodada como o console a mostra. */
export interface RolloutView {
  id: string;
  release: string;
  commit: string;
  intent: 'upgrade' | 'rollback';
  state: RolloutRecord['state'];
  concurrency: number;
  window?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  failure?: { nodeKey: string; code: string; at: string };
  totals: RolloutRecord['totals'];
}

/** Um nó de uma rodada como o console o mostra (sem projeto nem zona: só o que o responsável decide). */
export interface RolloutNodeView {
  key: string;
  kind: 'cell' | 'dedicated';
  wave: number;
  label: string;
  instance: string;
  state: RolloutNodeRecord['state'];
  operation?: { kind: 'update' | 'revert'; release: string };
  attempt: number;
  fromVersion?: string;
  nodeState?: string;
  errorCode?: string;
  panels: string[];
  panelsDone: number;
  startedAt?: string;
  finishedAt?: string;
}

function rolloutView(rollout: RolloutRecord): RolloutView {
  return {
    id: rollout.id,
    release: rollout.release.release,
    commit: rollout.release.commit,
    intent: rollout.intent,
    state: rollout.state,
    concurrency: rollout.concurrency,
    ...(rollout.window === undefined ? {} : { window: rollout.window }),
    createdBy: rollout.createdBy.replace(/^owner:/, ''),
    createdAt: rollout.createdAt.toISOString(),
    updatedAt: rollout.updatedAt.toISOString(),
    ...(rollout.finishedAt === undefined ? {} : { finishedAt: rollout.finishedAt.toISOString() }),
    ...(rollout.failure === undefined
      ? {}
      : { failure: { ...rollout.failure, at: rollout.failure.at.toISOString() } }),
    totals: rollout.totals,
  };
}

function nodeView(node: RolloutNodeRecord): RolloutNodeView {
  return {
    key: node.key,
    kind: node.kind,
    wave: node.wave,
    label: node.label,
    instance: node.target.instance,
    state: node.state,
    ...(node.operation === undefined
      ? {}
      : { operation: { kind: node.operation.kind, release: node.operation.release.release } }),
    attempt: node.attempt,
    ...(node.fromVersion === undefined ? {} : { fromVersion: node.fromVersion }),
    ...(node.nodeState === undefined ? {} : { nodeState: node.nodeState }),
    ...(node.errorCode === undefined ? {} : { errorCode: node.errorCode }),
    panels: node.panels.map((panel) => panel.slug),
    panelsDone: node.panelsDone,
    ...(node.startedAt === undefined ? {} : { startedAt: node.startedAt.toISOString() }),
    ...(node.finishedAt === undefined ? {} : { finishedAt: node.finishedAt.toISOString() }),
  };
}

// --- O que o worker devolve, conferido antes de ir ao navegador --------------------------------------------------

const releaseName = z.string().regex(NODE_RELEASE_PATTERN);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const nodeKey = z.string().regex(NODE_KEY_PATTERN);
const label = z.string().max(64);
const slug = z.string().max(32);
const excludedSchema = z.object({
  key: nodeKey,
  label,
  kind: z.enum(['cell', 'dedicated']),
  reason: z.enum(EXCLUSION_REASONS),
});

const RELEASES_SCHEMA = z.object({
  releases: z
    .array(
      z.object({
        release: releaseName,
        commit: commit.optional(),
        status: z.enum(['ok', 'panel_missing', 'invalid', 'unavailable']),
      }),
    )
    .max(50),
});
const INVENTORY_SCHEMA = z.object({
  nodes: z
    .array(
      z.object({
        key: nodeKey,
        kind: z.enum(['cell', 'dedicated']),
        wave: z.number().int().min(0).max(2),
        label,
        version: z.string().max(64).optional(),
        updateState: z.string().max(40).optional(),
        error: z.literal('unreachable').optional(),
        panels: z
          .array(
            z.object({ slug, release: releaseName.optional(), error: z.literal('unreachable').optional() }),
          )
          .max(300),
      }),
    )
    .max(1000),
  excluded: z.array(excludedSchema).max(1000),
});
const PLAN_SCHEMA = z.object({
  release: z.object({ release: releaseName, commit }),
  nodes: z
    .array(
      z.object({
        key: nodeKey,
        kind: z.enum(['cell', 'dedicated']),
        wave: z.number().int().min(0).max(2),
        label,
        instance: z.string().max(64),
        panels: z.array(slug).max(300),
      }),
    )
    .max(1000),
  excluded: z.array(excludedSchema).max(1000),
  activeRolloutId: z.string().optional(),
});
const ROLLOUT_ID_SCHEMA = z.object({ rollout: z.object({ id: z.string() }) });

/** O pedido de uma rodada nova pelo console. */
const createSchema = z.strictObject({
  release: releaseName,
  confirmRelease: z.string().max(32),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY),
  window: z.string().regex(UPDATE_WINDOW_PATTERN).optional(),
});
const planRequestSchema = z.strictObject({ release: releaseName });

/** As mensagens do console para cada recusa da frota (o código vem do worker). */
const FLEET_ERRORS: Readonly<Record<string, { status: HttpStatus; message: string }>> = {
  not_found: { status: HttpStatus.NOT_FOUND, message: 'Rodada ou nó não encontrado.' },
  invalid_request: { status: HttpStatus.BAD_REQUEST, message: 'Pedido inválido.' },
  confirmation_mismatch: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A versão digitada não confere com a escolhida: nada foi promovido.',
  },
  rollout_active: {
    status: HttpStatus.CONFLICT,
    message: 'Já existe uma rodada da frota em andamento: termine, aborte ou espere ela acabar.',
  },
  fleet_empty: { status: HttpStatus.CONFLICT, message: 'Nenhum nó da frota pode receber a versão agora.' },
  fleet_too_large: { status: HttpStatus.CONFLICT, message: 'A frota passou do tamanho de uma rodada.' },
  rollout_not_running: { status: HttpStatus.CONFLICT, message: 'A rodada não está andando.' },
  rollout_not_paused: { status: HttpStatus.CONFLICT, message: 'A rodada não está parada.' },
  rollout_finished: { status: HttpStatus.CONFLICT, message: 'A rodada já terminou.' },
  node_in_flight: { status: HttpStatus.CONFLICT, message: 'O nó está mudando agora: espere o fim do passo.' },
  node_not_skippable: {
    status: HttpStatus.CONFLICT,
    message: 'Só um nó na fila ou com falha pode ser pulado.',
  },
  node_not_revertible: {
    status: HttpStatus.CONFLICT,
    message: 'Só um nó atualizado ou com falha pode voltar de versão.',
  },
  rollback_unavailable: {
    status: HttpStatus.CONFLICT,
    message: 'A versão de antes deste nó não é uma versão publicada: a volta é pelo deploy.sh.',
  },
  panel_bundle_missing: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Esta versão não tem o bundle do painel: promova uma versão nova (docs/runbooks/versao-no.md).',
  },
  release_manifest_missing: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'A versão não está no bucket de releases.',
  },
  release_manifest_invalid: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'O manifesto da versão foi recusado (assinatura ou formato).',
  },
  release_unavailable: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'O bucket de releases não respondeu.',
  },
  fleet_unconfigured: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'O cp-worker está sem o bucket de releases (RELEASE_BUCKET): a frota não está configurada.',
  },
  worker_refused: { status: HttpStatus.BAD_GATEWAY, message: 'O cp-worker recusou o console.' },
  worker_unconfigured: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Console sem o cp-worker.' },
  worker_unavailable: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'O cp-worker não respondeu.' },
};

function fleetError(code: string): ApiError {
  const entry = FLEET_ERRORS[code] ?? FLEET_ERRORS['worker_unavailable'];
  return new ApiError(
    entry?.status ?? HttpStatus.SERVICE_UNAVAILABLE,
    entry?.message ?? 'O cp-worker não respondeu.',
    code in FLEET_ERRORS ? code : 'worker_unavailable',
  );
}

/** O código que o console mostra para uma resposta do worker que não deu certo. */
function failureOf(result: { status: number; code: string }): string {
  if (result.code === 'worker_unconfigured') return 'worker_unconfigured';
  if (result.status === 0 || result.code === 'worker_unreachable' || result.code === 'worker_error') {
    return 'worker_unavailable';
  }
  if (result.status === 401 || result.status === 403) return 'worker_refused';
  return Object.hasOwn(FLEET_ERRORS, result.code) ? result.code : 'worker_unavailable';
}

/**
 * A frota no console do responsável (`/v1/admin/fleet/...`): as rodadas e os nós de cada uma saem do Firestore (o
 * console lê); as versões do bucket, a versão de cada nó e site, a revisão e as operações vão ao cp-worker, que tem o
 * bucket, as VMs e o Firebase, com quem agiu (`actor`) para a auditoria.
 */
@Injectable()
export class AdminFleetService {
  constructor(
    private readonly store: FleetStore,
    @Inject(CONSOLE_FLEET_CLIENT) private readonly worker: WorkerFleetClient | null,
    @InjectPinoLogger(AdminFleetService.name) private readonly logger: PinoLogger,
  ) {}

  async rollouts(): Promise<{ rollouts: RolloutView[] }> {
    return { rollouts: (await this.store.list(30)).map(rolloutView) };
  }

  async rollout(id: string): Promise<{ rollout: RolloutView; nodes: RolloutNodeView[] }> {
    const rollout = isUlid(id) ? await this.store.get(id) : undefined;
    if (rollout === undefined) throw fleetError('not_found');
    return { rollout: rolloutView(rollout), nodes: (await this.store.nodes(id)).map(nodeView) };
  }

  releases(owner: OwnerContext): Promise<z.infer<typeof RELEASES_SCHEMA>> {
    return this.call('releases', {}, owner, RELEASES_SCHEMA);
  }

  inventory(owner: OwnerContext): Promise<z.infer<typeof INVENTORY_SCHEMA>> {
    return this.call('inventory', {}, owner, INVENTORY_SCHEMA);
  }

  plan(body: unknown, owner: OwnerContext): Promise<z.infer<typeof PLAN_SCHEMA>> {
    const parsed = planRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw fleetError('invalid_request');
    return this.call('plan', parsed.data, owner, PLAN_SCHEMA);
  }

  async create(body: unknown, owner: OwnerContext): Promise<{ rollout: RolloutView }> {
    const parsed = createSchema.safeParse(body ?? {});
    if (!parsed.success) throw fleetError('invalid_request');
    const created = await this.call('rollouts', parsed.data, owner, ROLLOUT_ID_SCHEMA);
    return { rollout: (await this.rollout(created.rollout.id)).rollout };
  }

  async act(id: string, action: string, owner: OwnerContext): Promise<{ rollout: RolloutView }> {
    if (!isUlid(id) || !['pause', 'resume', 'abort'].includes(action)) throw fleetError('not_found');
    await this.call(`rollouts/${id}/${action}`, {}, owner, ROLLOUT_ID_SCHEMA);
    return { rollout: (await this.rollout(id)).rollout };
  }

  async actOnNode(
    id: string,
    key: string,
    action: string,
    owner: OwnerContext,
  ): Promise<{ rollout: RolloutView; nodes: RolloutNodeView[] }> {
    if (!isUlid(id) || !NODE_KEY_PATTERN.test(key) || !['skip', 'rollback'].includes(action)) {
      throw fleetError('not_found');
    }
    await this.call(`rollouts/${id}/nodes/${key}/${action}`, {}, owner, z.object({ node: z.object({}) }));
    return this.rollout(id);
  }

  private async call<T extends z.ZodType>(
    path: string,
    body: Record<string, unknown>,
    owner: OwnerContext,
    schema: T,
  ): Promise<z.infer<T>> {
    let result: OwnerCallResult;
    if (this.worker === null) {
      result = { ok: false, status: 503, code: 'worker_unconfigured' };
    } else {
      try {
        result = await this.worker.post(path, body, owner.email);
      } catch {
        result = { ok: false, status: 0, code: 'worker_unreachable' };
      }
    }
    const checked = result.ok ? schema.safeParse(result.body) : undefined;
    if (!result.ok || checked === undefined || !checked.success) {
      const failure = failureOf(result.ok ? { status: 502, code: 'worker_error' } : result);
      this.logger.warn(
        { event: 'admin_fleet_failed', operation: path.split('/')[0], failure, status: result.status },
        'operação da frota sem resposta do cp-worker',
      );
      throw fleetError(failure);
    }
    return checked.data;
  }
}
