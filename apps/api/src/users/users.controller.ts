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
  type TemporaryPassword,
  type User,
  type UserCreate,
  type UserCreated,
  userCreateSchema,
  type UserListQuery,
  userListQuerySchema,
  type UserUpdate,
  userUpdateSchema,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { UsersService } from './users.service.js';

const userIdSchema = z.string().min(1).max(64);

/** Usuários do cliente da sessão (T3.2): `admin_cliente` e `admin_verax` (no cliente selecionado). */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users:read')
  list(@Query({ schema: userListQuerySchema }) query: UserListQuery): Promise<Paginated<User>> {
    return this.users.list(query);
  }

  @Get(':id')
  @RequirePermission('users:read')
  get(@Param('id', { schema: userIdSchema }) id: string): Promise<User> {
    return this.users.get(id);
  }

  @Post()
  @RequirePermission('users:write')
  create(
    @Req() request: Request,
    @Body({ schema: userCreateSchema }) body: UserCreate,
  ): Promise<UserCreated> {
    return this.users.create(request.auth as RequestAuth, body);
  }

  @Patch(':id')
  @RequirePermission('users:write')
  update(
    @Req() request: Request,
    @Param('id', { schema: userIdSchema }) id: string,
    @Body({ schema: userUpdateSchema }) body: UserUpdate,
  ): Promise<User> {
    return this.users.update(request.auth as RequestAuth, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('users:write')
  deactivate(@Req() request: Request, @Param('id', { schema: userIdSchema }) id: string): Promise<void> {
    return this.users.deactivate(request.auth as RequestAuth, id);
  }

  @Post(':id/temporary-password')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('users:write')
  temporaryPassword(
    @Req() request: Request,
    @Param('id', { schema: userIdSchema }) id: string,
  ): Promise<TemporaryPassword> {
    return this.users.temporaryPassword(request.auth as RequestAuth, id);
  }

  @Post(':id/mfa-reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('users:write')
  resetMfa(@Req() request: Request, @Param('id', { schema: userIdSchema }) id: string): Promise<void> {
    return this.users.resetMfa(request.auth as RequestAuth, id);
  }
}
