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
  type AlertException,
  type AlertExceptionCreate,
  alertExceptionCreateSchema,
  type AlertExceptionListQuery,
  alertExceptionListQuerySchema,
  type AlertExceptionUpdate,
  alertExceptionUpdateSchema,
  type Paginated,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { AlertExceptionsService } from './alert-exceptions.service.js';

const exceptionIdSchema = z.uuid();

/** Exceções de alerta do cliente da sessão (T3.5). Todos leem; operadores (admins e analistas) alteram. */
@Controller('alert-exceptions')
export class AlertExceptionsController {
  constructor(private readonly exceptions: AlertExceptionsService) {}

  @Get()
  @RequirePermission('alert_exceptions:read')
  list(
    @Query({ schema: alertExceptionListQuerySchema }) query: AlertExceptionListQuery,
  ): Promise<Paginated<AlertException>> {
    return this.exceptions.list(query);
  }

  @Get(':id')
  @RequirePermission('alert_exceptions:read')
  get(@Param('id', { schema: exceptionIdSchema }) id: string): Promise<AlertException> {
    return this.exceptions.get(id);
  }

  @Post()
  @RequirePermission('alert_exceptions:write')
  create(
    @Req() request: Request,
    @Body({ schema: alertExceptionCreateSchema }) body: AlertExceptionCreate,
  ): Promise<AlertException> {
    return this.exceptions.create(request.auth as RequestAuth, body);
  }

  @Patch(':id')
  @RequirePermission('alert_exceptions:write')
  update(
    @Param('id', { schema: exceptionIdSchema }) id: string,
    @Body({ schema: alertExceptionUpdateSchema }) body: AlertExceptionUpdate,
  ): Promise<AlertException> {
    return this.exceptions.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('alert_exceptions:write')
  remove(@Param('id', { schema: exceptionIdSchema }) id: string): Promise<void> {
    return this.exceptions.remove(id);
  }
}
