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
} from '@nestjs/common';
import {
  type Paginated,
  type Tenant,
  type TenantCreate,
  type TenantCreated,
  tenantCreateSchema,
  type TenantListQuery,
  tenantListQuerySchema,
  type TenantSummary,
  type TenantUpdate,
  tenantUpdateSchema,
} from '@verax/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { TenantsService } from './tenants.service.js';

const tenantIdSchema = z.uuid();

/** Cadastro de clientes (T3.1): só `admin_verax` lê e altera. */
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @RequirePermission('tenants:read')
  list(@Query({ schema: tenantListQuerySchema }) query: TenantListQuery): Promise<Paginated<TenantSummary>> {
    return this.tenants.list(query);
  }

  @Get(':id')
  @RequirePermission('tenants:read')
  get(@Param('id', { schema: tenantIdSchema }) id: string): Promise<Tenant> {
    return this.tenants.get(id);
  }

  /** Cria o cliente e o primeiro administrador dele; a senha temporária só sai nesta resposta. */
  @Post()
  @RequirePermission('tenants:write')
  create(@Body({ schema: tenantCreateSchema }) body: TenantCreate): Promise<TenantCreated> {
    return this.tenants.create(body);
  }

  @Patch(':id')
  @RequirePermission('tenants:write')
  update(
    @Param('id', { schema: tenantIdSchema }) id: string,
    @Body({ schema: tenantUpdateSchema }) body: TenantUpdate,
  ): Promise<Tenant> {
    return this.tenants.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('tenants:write')
  deactivate(@Param('id', { schema: tenantIdSchema }) id: string): Promise<void> {
    return this.tenants.deactivate(id);
  }
}
