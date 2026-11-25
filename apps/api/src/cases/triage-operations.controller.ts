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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  type CaseSplit,
  type CaseSplitResult,
  caseSplitSchema,
  type Paginated,
  type TriageAuthors,
  type TriageFilter,
  triageFilterSchema,
  type TriageOperationCreate,
  triageOperationCreateSchema,
  type TriageOperationDetail,
  type TriageOperationListQuery,
  triageOperationListQuerySchema,
  type TriagePreview,
  type TriageUndo,
  triageUndoSchema,
} from '@verax/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { PlanService } from '../plan/plan.service.js';
import { CaseSplitService } from './case-split.service.js';
import { CasesOperableGuard, CasesVisibleGuard } from './cases.guard.js';
import { TriageOperationsService } from './triage-operations.service.js';

const idSchema = z.uuid();

/**
 * Triagem em massa. Ler, todos os papéis que leem alertas; pedir, desfazer, cancelar e continuar, quem faz triagem (e, nas
 * operações de incidente, quem opera incidentes). As leituras seguem o modo dos casos (na medição, só a equipe da Verax); as
 * escritas só existem com os casos ligados.
 */
@Controller('triage-operations')
@UseGuards(CasesVisibleGuard)
export class TriageOperationsController {
  constructor(
    private readonly operations: TriageOperationsService,
    private readonly plan: PlanService,
  ) {}

  @Get()
  @RequirePermission('findings:read')
  list(
    @Req() request: Request,
    @Query({ schema: triageOperationListQuerySchema }) query: TriageOperationListQuery,
  ): Promise<Paginated<TriageOperationDetail>> {
    return this.operations.list(request.auth as RequestAuth, query);
  }

  // Antes de `:id`, para "authors" e "preview" não serem lidos como id.
  @Get('authors')
  @RequirePermission('findings:read')
  authors(): Promise<TriageAuthors> {
    return this.operations.authors();
  }

  @Get('preview')
  @RequirePermission('findings:triage')
  async preview(@Query({ schema: triageFilterSchema }) filter: TriageFilter): Promise<TriagePreview> {
    await this.plan.assertPeriodWithinHistory(filter.period);
    await this.plan.assertRangeWithinHistory(filter.from);
    return this.operations.preview(filter);
  }

  @Get(':id')
  @RequirePermission('findings:read')
  get(
    @Req() request: Request,
    @Param('id', { schema: idSchema }) id: string,
  ): Promise<TriageOperationDetail> {
    return this.operations.get(request.auth as RequestAuth, id);
  }

  /** 201: feita na requisição. 202: na fila do worker. 200: o pedido repetido, com a operação que ele já criou. */
  @Post()
  @UseGuards(CasesOperableGuard)
  @RequirePermission('findings:triage')
  async create(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body({ schema: triageOperationCreateSchema }) body: TriageOperationCreate,
  ): Promise<TriageOperationDetail> {
    const answer = await this.operations.create(request.auth as RequestAuth, body);
    response.status(answer.status);
    return answer.operation;
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CasesOperableGuard)
  @RequirePermission('findings:triage')
  cancel(
    @Req() request: Request,
    @Param('id', { schema: idSchema }) id: string,
  ): Promise<TriageOperationDetail> {
    return this.operations.cancel(request.auth as RequestAuth, id);
  }

  @Post(':id/continue')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CasesOperableGuard)
  @RequirePermission('findings:triage')
  continue(
    @Req() request: Request,
    @Param('id', { schema: idSchema }) id: string,
  ): Promise<TriageOperationDetail> {
    return this.operations.continue(request.auth as RequestAuth, id);
  }

  /** A resposta é a operação que desfaz. 201, 202 e 200 como no pedido. */
  @Post(':id/undo')
  @UseGuards(CasesOperableGuard)
  @RequirePermission('findings:triage')
  async undo(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: triageUndoSchema }) body: TriageUndo,
  ): Promise<TriageOperationDetail> {
    const answer = await this.operations.undo(request.auth as RequestAuth, id, body);
    response.status(answer.status);
    return answer.operation;
  }
}

/** Dividir um caso que juntou coisas demais. */
@Controller('cases')
@UseGuards(CasesOperableGuard)
export class CaseSplitController {
  constructor(private readonly splits: CaseSplitService) {}

  @Post(':id/split')
  @RequirePermission('findings:triage')
  split(
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: caseSplitSchema }) body: CaseSplit,
  ): Promise<CaseSplitResult> {
    return this.splits.split(id, body);
  }
}
