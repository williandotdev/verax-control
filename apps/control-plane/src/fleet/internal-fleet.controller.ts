import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { isUlid } from '../common/ulid.js';
import { ownerActorOf, WorkerCallerGuard, WorkerCallers } from '../internal/worker-caller.js';
import { CloudApiError } from '../provisioning/cloud-http.js';
import { FleetConflictError } from './fleet-store.js';
import type { RolloutNodeRecord, RolloutRecord } from './fleet.schema.js';
import {
  type FleetPlanView,
  FleetReleaseError,
  FleetService,
  FleetUnconfiguredError,
  type InventoryNode,
  NODE_ACTIONS,
  ROLLOUT_ACTIONS,
  type ReleaseView,
  rolloutRequestSchema,
} from './fleet.service.js';
import type { ExcludedNode } from './fleet-plan.js';

const actorField = z.email().max(254).optional();
const actorSchema = z.strictObject({ actor: actorField });
const planSchema = z.strictObject({ release: z.string().max(32), actor: actorField });
const createSchema = rolloutRequestSchema.extend({ actor: actorField });

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** O que cada recusa responde ao console (a mensagem em português; o código para a tela escolher o texto). */
const CONFLICTS: Readonly<Record<string, { status: HttpStatus; message: string }>> = {
  not_found: { status: HttpStatus.NOT_FOUND, message: 'Não encontrado' },
  confirmation_mismatch: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A versão digitada não confere: nada foi promovido',
  },
  rollout_active: { status: HttpStatus.CONFLICT, message: 'Já existe uma rodada da frota em andamento' },
  fleet_empty: { status: HttpStatus.CONFLICT, message: 'Nenhum nó da frota pode receber a versão agora' },
  fleet_too_large: { status: HttpStatus.CONFLICT, message: 'A frota passou do tamanho de uma rodada' },
  rollout_not_running: { status: HttpStatus.CONFLICT, message: 'A rodada não está andando' },
  rollout_not_paused: { status: HttpStatus.CONFLICT, message: 'A rodada não está parada' },
  rollout_finished: { status: HttpStatus.CONFLICT, message: 'A rodada já terminou' },
  node_in_flight: { status: HttpStatus.CONFLICT, message: 'O nó está mudando agora: espere o fim do passo' },
  node_not_skippable: {
    status: HttpStatus.CONFLICT,
    message: 'Só um nó na fila ou com falha pode ser pulado',
  },
  node_not_revertible: {
    status: HttpStatus.CONFLICT,
    message: 'Só um nó atualizado ou com falha pode voltar de versão',
  },
  rollback_unavailable: {
    status: HttpStatus.CONFLICT,
    message: 'A versão de antes deste nó não é uma versão publicada: a volta é pelo deploy.sh',
  },
};

/**
 * As operações do responsável sobre a frota (decisão de 16/11/2026), no cp-worker, atrás da mesma guarda das outras:
 * o console (`ADMIN_SA_EMAIL`, com quem agiu em `actor`) ou um responsável direto (`OWNER_PRINCIPALS`). Só `POST`,
 * como as outras chamadas do console ao worker:
 * - `fleet/releases` e `fleet/inventory`: as versões do bucket (conferidas) e a versão de cada nó e site agora;
 * - `fleet/plan` `{release}`: a revisão (as ondas, os nós, quem fica fora);
 * - `fleet/rollouts` `{release, confirmRelease, concurrency, window?, intent?}`: a rodada nova;
 * - `fleet/rollouts/:id/(pause|resume|abort)` e `fleet/rollouts/:id/nodes/:key/(skip|rollback)`.
 */
@Controller('internal/fleet')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner', 'console')
export class InternalFleetController {
  constructor(
    private readonly fleet: FleetService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private actor(req: Request, actor: string | undefined): string {
    const who = ownerActorOf(req, this.config, actor);
    if (who === undefined) throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'actor_not_owner');
    return who;
  }

  @Post('releases')
  @HttpCode(HttpStatus.OK)
  async releases(@Body() body: unknown, @Req() req: Request): Promise<{ releases: ReleaseView[] }> {
    this.actor(req, parse(actorSchema, body).actor);
    return guard(async () => ({ releases: await this.fleet.releases() }));
  }

  @Post('inventory')
  @HttpCode(HttpStatus.OK)
  async inventory(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ nodes: InventoryNode[]; excluded: ExcludedNode[] }> {
    this.actor(req, parse(actorSchema, body).actor);
    return guard(() => this.fleet.inventory());
  }

  @Post('plan')
  @HttpCode(HttpStatus.OK)
  async plan(@Body() body: unknown, @Req() req: Request): Promise<FleetPlanView> {
    const input = parse(planSchema, body);
    this.actor(req, input.actor);
    return guard(() => this.fleet.preview(input.release));
  }

  @Post('rollouts')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Req() req: Request): Promise<{ rollout: RolloutRecord }> {
    const { actor, ...request } = parse(createSchema, body);
    const who = this.actor(req, actor);
    return guard(async () => ({ rollout: await this.fleet.create(request, who, requestIdOf(req)) }));
  }

  @Post('rollouts/:id/:action')
  @HttpCode(HttpStatus.OK)
  async act(
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ rollout: RolloutRecord }> {
    if (!isUlid(id) || !(ROLLOUT_ACTIONS as readonly string[]).includes(action)) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    }
    const who = this.actor(req, parse(actorSchema, body).actor);
    return guard(async () => ({
      rollout: await this.fleet.act(id, action as (typeof ROLLOUT_ACTIONS)[number], who, requestIdOf(req)),
    }));
  }

  @Post('rollouts/:id/nodes/:key/:action')
  @HttpCode(HttpStatus.OK)
  async actOnNode(
    @Param('id') id: string,
    @Param('key') key: string,
    @Param('action') action: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ node: RolloutNodeRecord }> {
    if (!isUlid(id) || !(NODE_ACTIONS as readonly string[]).includes(action)) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    }
    const who = this.actor(req, parse(actorSchema, body).actor);
    return guard(async () => ({
      node: await this.fleet.actOnNode(
        id,
        key,
        action as (typeof NODE_ACTIONS)[number],
        who,
        requestIdOf(req),
      ),
    }));
  }
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
  return parsed.data;
}

/** As recusas do domínio viram respostas com código; o resto (rede, Firestore) segue para o filtro de erros. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof FleetUnconfiguredError) {
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'A frota não está configurada no cp-worker (RELEASE_BUCKET)',
        'fleet_unconfigured',
      );
    }
    if (error instanceof FleetReleaseError) {
      throw new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'A versão não pode ir para a frota', error.code);
    }
    if (error instanceof FleetConflictError) {
      const conflict = CONFLICTS[error.code] ?? { status: HttpStatus.CONFLICT, message: 'Operação recusada' };
      throw new ApiError(conflict.status, conflict.message, error.code);
    }
    if (error instanceof CloudApiError) {
      throw new ApiError(HttpStatus.BAD_GATEWAY, 'A nuvem não respondeu', `${error.service}_unavailable`);
    }
    throw error;
  }
}
