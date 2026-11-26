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
  type AlertExceptionCreated,
  alertExceptionCreateSchema,
  type AlertExceptionListQuery,
  alertExceptionListQuerySchema,
  type AlertExceptionOpenPreviewQuery,
  alertExceptionOpenPreviewQuerySchema,
  type AlertExceptionUpdate,
  alertExceptionUpdateSchema,
  type ExceptionCreateQuery,
  exceptionCreateQuerySchema,
  type ExceptionOpenPreview,
  type ExceptionOpenResolution,
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

  /**
   * A prévia da criação: os alertas em aberto que a exceção resolveria agora. Antes de `:id`, que só aceita UUID. Um nó de
   * antes responde 400 (a rota cai em `:id`), e o painel novo só não mostra a prévia.
   */
  @Get('open-alerts')
  @RequirePermission('alert_exceptions:write')
  previewOpen(
    @Query({ schema: alertExceptionOpenPreviewQuerySchema }) query: AlertExceptionOpenPreviewQuery,
  ): Promise<ExceptionOpenPreview> {
    return this.exceptions.previewOpen(query);
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
    @Query({ schema: exceptionCreateQuerySchema }) query: ExceptionCreateQuery,
  ): Promise<AlertException | AlertExceptionCreated> {
    return this.exceptions.create(request.auth as RequestAuth, body, query);
  }

  /** "Resolver os próximos": os alertas em aberto que a criação deixou por causa do teto da requisição. */
  @Post(':id/resolve-open')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('alert_exceptions:write')
  resolveOpen(
    @Req() request: Request,
    @Param('id', { schema: exceptionIdSchema }) id: string,
  ): Promise<ExceptionOpenResolution> {
    return this.exceptions.resolveOpenAgain(request.auth as RequestAuth, id);
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
