import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type AlertExceptionBatch,
  alertExceptionBatchSchema,
  type AlertExceptionBatchResult,
  type CaseExceptionDraft,
  type Paginated,
  type ScopedException,
  type ScopedExceptionCreateParsed,
  scopedExceptionCreateSchema,
  type ScopedExceptionListQuery,
  scopedExceptionListQuerySchema,
  type ScopedExceptionPreview,
  type ScopedExceptionPreviewQuery,
  scopedExceptionPreviewQuerySchema,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { CasesOperableGuard } from '../cases/cases.guard.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ScopedExceptionsService } from './scoped-exceptions.service.js';

const idSchema = z.uuid();

/**
 * Exceções amplas (casos, PR-9). Só existem com os casos ligados (`CASES_MODE=on`; fora disso, 404 para todos). Ler, quem
 * lê exceções; a prévia, criar e revogar, só os administradores (D8), conferido pelo papel no service: a permissão
 * `alert_exceptions:write` passa os analistas, e o papel os recusa com 403. Não há permissão nova no `/v1/me`, cuja lista
 * é um enum fechado no painel de antes.
 */
@Controller('scoped-exceptions')
@UseGuards(CasesOperableGuard)
export class ScopedExceptionsController {
  constructor(private readonly exceptions: ScopedExceptionsService) {}

  @Get()
  @RequirePermission('alert_exceptions:read')
  list(
    @Query({ schema: scopedExceptionListQuerySchema }) query: ScopedExceptionListQuery,
  ): Promise<Paginated<ScopedException>> {
    return this.exceptions.list(query);
  }

  @Get('preview')
  @RequirePermission('alert_exceptions:write')
  preview(
    @Req() request: Request,
    @Query({ schema: scopedExceptionPreviewQuerySchema }) query: ScopedExceptionPreviewQuery,
  ): Promise<ScopedExceptionPreview> {
    return this.exceptions.preview(request.auth as RequestAuth, query);
  }

  @Post()
  @RequirePermission('alert_exceptions:write')
  create(
    @Req() request: Request,
    @Body({ schema: scopedExceptionCreateSchema }) body: ScopedExceptionCreateParsed,
  ): Promise<ScopedException> {
    return this.exceptions.create(request.auth as RequestAuth, body);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('alert_exceptions:write')
  revoke(@Req() request: Request, @Param('id', { schema: idSchema }) id: string): Promise<ScopedException> {
    return this.exceptions.revoke(request.auth as RequestAuth, id);
  }
}

/**
 * A exceção a partir de um caso: o que é constante nele e as de usuário, IP ou recurso em lote (até 20). Quem opera
 * exceções (`alert_exceptions:write`), com os casos ligados.
 */
@Controller('cases/:id')
@UseGuards(CasesOperableGuard)
export class CaseExceptionsController {
  constructor(private readonly exceptions: ScopedExceptionsService) {}

  @Get('exception-draft')
  @RequirePermission('alert_exceptions:write')
  draft(@Param('id', { schema: idSchema }) id: string): Promise<CaseExceptionDraft> {
    return this.exceptions.draft(id);
  }

  @Post('alert-exceptions')
  @RequirePermission('alert_exceptions:write')
  createBatch(
    @Req() request: Request,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: alertExceptionBatchSchema }) body: AlertExceptionBatch,
  ): Promise<AlertExceptionBatchResult> {
    return this.exceptions.createBatch(request.auth as RequestAuth, id, body);
  }
}
