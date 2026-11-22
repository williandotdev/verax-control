import { Body, Controller, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { forgetLiveSecret } from '../common/logger/sanitize.js';
import type { NodeUserCreated } from './admin-node-users.schema.js';
import { AdminNodeUsersService } from './admin-node-users.service.js';
import { type OwnerRequest, ownerOf } from './owner.guard.js';

/**
 * Os usuários do cliente que a Verax cria pelo console do responsável (só no `cp-admin`, atrás da `OwnerGuard`): o
 * pedido ao nó do cliente, com a senha temporária gerada aqui e devolvida uma única vez. A lista dos pedidos, com o
 * relato do nó, vem no `GET .../node-sync` (`AdminLogSourcesController`). Na v1 não há alteração nem remoção.
 */
@Controller('admin/tenants')
export class AdminNodeUsersController {
  constructor(private readonly service: AdminNodeUsersService) {}

  /**
   * A resposta sai com `Cache-Control: private, no-store`, como toda do console; a senha sai da máscara do logger quando
   * a resposta termina.
   */
  @Post(':tenantId/users')
  async create(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NodeUserCreated> {
    const created = await this.service.create(tenantId, body, ownerOf(req));
    res.on('close', () => forgetLiveSecret(created.temporaryPassword));
    return created;
  }
}
