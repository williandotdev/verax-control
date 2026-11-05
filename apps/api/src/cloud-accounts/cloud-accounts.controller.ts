import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  type CloudAccount,
  type CloudAccountCreate,
  cloudAccountCreateSchema,
  type CloudAccountListQuery,
  cloudAccountListQuerySchema,
  type CloudAccountUpdate,
  cloudAccountUpdateSchema,
  type Paginated,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { CloudAccountsService } from './cloud-accounts.service.js';

const accountIdSchema = z.uuid();

/**
 * Contas cloud do cliente da sessão (T3.3). Todos leem; administradores cadastram, alteram e pedem a verificação da
 * conta AWS.
 */
@Controller('cloud-accounts')
export class CloudAccountsController {
  constructor(private readonly accounts: CloudAccountsService) {}

  @Get()
  @RequirePermission('cloud_accounts:read')
  list(
    @Query({ schema: cloudAccountListQuerySchema }) query: CloudAccountListQuery,
  ): Promise<Paginated<CloudAccount>> {
    return this.accounts.list(query);
  }

  @Get(':id')
  @RequirePermission('cloud_accounts:read')
  get(@Param('id', { schema: accountIdSchema }) id: string): Promise<CloudAccount> {
    return this.accounts.get(id);
  }

  @Post()
  @RequirePermission('cloud_accounts:write')
  create(
    @Req() request: Request,
    @Body({ schema: cloudAccountCreateSchema }) body: CloudAccountCreate,
  ): Promise<CloudAccount> {
    return this.accounts.create(request.auth as RequestAuth, body);
  }

  @Patch(':id')
  @RequirePermission('cloud_accounts:write')
  update(
    @Req() request: Request,
    @Param('id', { schema: accountIdSchema }) id: string,
    @Body({ schema: cloudAccountUpdateSchema }) body: CloudAccountUpdate,
  ): Promise<CloudAccount> {
    return this.accounts.update(request.auth as RequestAuth, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('cloud_accounts:write')
  deactivate(@Param('id', { schema: accountIdSchema }) id: string): Promise<void> {
    return this.accounts.deactivate(id);
  }

  /**
   * "Verificar" a conta AWS (fase 2, PR-V3'): pede ao worker que confira a entrada no papel de leitura sem chave e a
   * leitura dos buckets. Responde na hora (202) com a conta, a conexão em "aguardando" e o pedido pendente
   * (`checkRequestedAt`); o painel acompanha pela conta até o worker gravar "conectada" ou o código do erro.
   */
  @Post(':id/aws/verify')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('cloud_accounts:write')
  verifyAws(@Param('id', { schema: accountIdSchema }) id: string): Promise<CloudAccount> {
    return this.accounts.requestAwsCheck(id);
  }
}
