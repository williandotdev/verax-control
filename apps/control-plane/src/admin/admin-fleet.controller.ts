import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { AdminFleetService, type RolloutNodeView, type RolloutView } from './admin-fleet.service.js';
import { type OwnerRequest, ownerOf } from './owner.guard.js';

/**
 * A frota no console do responsável (`/v1/admin/fleet...`, só no `cp-admin`, atrás da `OwnerGuard`: a sessão do login
 * próprio, JSON e a mesma origem nas escritas): as versões do bucket, a versão de cada nó e site, as rodadas (lista e
 * detalhe), a revisão de uma rodada nova, a rodada nova (com a versão digitada de novo) e as operações: parar, retomar,
 * abortar, pular um nó e voltar um nó.
 */
@Controller('admin/fleet')
export class AdminFleetController {
  constructor(private readonly service: AdminFleetService) {}

  @Get('releases')
  releases(@Req() req: OwnerRequest): Promise<unknown> {
    return this.service.releases(ownerOf(req));
  }

  @Get('inventory')
  inventory(@Req() req: OwnerRequest): Promise<unknown> {
    return this.service.inventory(ownerOf(req));
  }

  @Get('rollouts')
  rollouts(): Promise<{ rollouts: RolloutView[] }> {
    return this.service.rollouts();
  }

  @Get('rollouts/:id')
  rollout(@Param('id') id: string): Promise<{ rollout: RolloutView; nodes: RolloutNodeView[] }> {
    return this.service.rollout(id);
  }

  @Post('plan')
  @HttpCode(200)
  plan(@Body() body: unknown, @Req() req: OwnerRequest): Promise<unknown> {
    return this.service.plan(body, ownerOf(req));
  }

  @Post('rollouts')
  create(@Body() body: unknown, @Req() req: OwnerRequest): Promise<{ rollout: RolloutView }> {
    return this.service.create(body, ownerOf(req));
  }

  @Post('rollouts/:id/nodes/:key/:action')
  @HttpCode(200)
  actOnNode(
    @Param('id') id: string,
    @Param('key') key: string,
    @Param('action') action: string,
    @Req() req: OwnerRequest,
  ): Promise<{ rollout: RolloutView; nodes: RolloutNodeView[] }> {
    return this.service.actOnNode(id, key, action, ownerOf(req));
  }

  @Post('rollouts/:id/:action')
  @HttpCode(200)
  act(
    @Param('id') id: string,
    @Param('action') action: string,
    @Req() req: OwnerRequest,
  ): Promise<{ rollout: RolloutView }> {
    return this.service.act(id, action, ownerOf(req));
  }
}
