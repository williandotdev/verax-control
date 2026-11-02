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
  type Paginated,
  type ProtectedResource,
  type ProtectedResourceCreate,
  protectedResourceCreateSchema,
  type ProtectedResourceListQuery,
  protectedResourceListQuerySchema,
  type ProtectedResourceUpdate,
  protectedResourceUpdateSchema,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ProtectedResourcesService } from './protected-resources.service.js';

const itemIdSchema = z.uuid();

/** Lista de proteção do cliente da sessão (T3.4). Todos leem; administradores alteram. */
@Controller('protected-resources')
export class ProtectedResourcesController {
  constructor(private readonly items: ProtectedResourcesService) {}

  @Get()
  @RequirePermission('protected_resources:read')
  list(
    @Query({ schema: protectedResourceListQuerySchema }) query: ProtectedResourceListQuery,
  ): Promise<Paginated<ProtectedResource>> {
    return this.items.list(query);
  }

  @Get(':id')
  @RequirePermission('protected_resources:read')
  get(@Param('id', { schema: itemIdSchema }) id: string): Promise<ProtectedResource> {
    return this.items.get(id);
  }

  @Post()
  @RequirePermission('protected_resources:write')
  create(
    @Req() request: Request,
    @Body({ schema: protectedResourceCreateSchema }) body: ProtectedResourceCreate,
  ): Promise<ProtectedResource> {
    return this.items.create(request.auth as RequestAuth, body);
  }

  @Patch(':id')
  @RequirePermission('protected_resources:write')
  update(
    @Param('id', { schema: itemIdSchema }) id: string,
    @Body({ schema: protectedResourceUpdateSchema }) body: ProtectedResourceUpdate,
  ): Promise<ProtectedResource> {
    return this.items.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('protected_resources:write')
  remove(@Param('id', { schema: itemIdSchema }) id: string): Promise<void> {
    return this.items.remove(id);
  }
}
