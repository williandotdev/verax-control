import { Controller, Get, Param } from '@nestjs/common';
import type { CloudflareConnection, CloudflareZones } from '@verax/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { CloudflareAccountService } from './cloudflare-account.service.js';

const accountIdSchema = z.uuid();

/**
 * A conta do Cloudflare do cliente da sessão: por onde ela é lida (token colado ou OAuth) e a saúde das zonas e da
 * auditoria. Todos leem, em todo nó, com o OAuth ligado ou não; a lista de zonas monitoradas muda no `PATCH` da conta.
 */
@Controller('cloud-accounts')
export class CloudflareAccountController {
  constructor(private readonly accounts: CloudflareAccountService) {}

  @Get(':id/cloudflare-connection')
  @RequirePermission('cloud_accounts:read')
  connection(@Param('id', { schema: accountIdSchema }) id: string): Promise<CloudflareConnection> {
    return this.accounts.connection(id);
  }

  @Get(':id/cloudflare-zones')
  @RequirePermission('cloud_accounts:read')
  zones(@Param('id', { schema: accountIdSchema }) id: string): Promise<CloudflareZones> {
    return this.accounts.zones(id);
  }
}
