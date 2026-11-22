import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { LogSourceWriteResult, NodeSyncOverview } from './admin-log-sources.schema.js';
import { AdminLogSourcesService } from './admin-log-sources.service.js';
import { type OwnerRequest, ownerOf } from './owner.guard.js';

/**
 * As fontes de log de um cliente no console do responsável (só no `cp-admin`, atrás da `OwnerGuard`, que exige a
 * sessão do login próprio, JSON e a mesma origem nas escritas): o que o nó disse de si e de cada fonte (`node-sync`),
 * o cadastro, a alteração, a credencial cifrada para o nó e a remoção (a lápide, com o subdomínio digitado). O nó
 * recebe o estado desejado na próxima sincronização (`/v1/node-sync`, no cp-public e no cp-worker). As respostas saem
 * com `Cache-Control: private, no-store`, como toda a API do console, e nenhuma leva segredo.
 */
@Controller('admin/tenants')
export class AdminLogSourcesController {
  constructor(private readonly service: AdminLogSourcesService) {}

  @Get(':tenantId/node-sync')
  overview(@Param('tenantId') tenantId: string): Promise<NodeSyncOverview> {
    return this.service.overview(tenantId);
  }

  @Post(':tenantId/log-sources')
  create(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<LogSourceWriteResult> {
    return this.service.create(tenantId, body, ownerOf(req));
  }

  @Patch(':tenantId/log-sources/:sourceId')
  update(
    @Param('tenantId') tenantId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<LogSourceWriteResult> {
    return this.service.update(tenantId, sourceId, body, ownerOf(req));
  }

  @Put(':tenantId/log-sources/:sourceId/credential')
  credential(
    @Param('tenantId') tenantId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<LogSourceWriteResult> {
    return this.service.credential(tenantId, sourceId, body, ownerOf(req));
  }

  @Post(':tenantId/log-sources/:sourceId/remove')
  @HttpCode(200)
  remove(
    @Param('tenantId') tenantId: string,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<LogSourceWriteResult> {
    return this.service.remove(tenantId, sourceId, body, ownerOf(req));
  }
}
