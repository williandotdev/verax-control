import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  type Finding,
  type FindingComment,
  type FindingChangeContext,
  type FindingCommentCreate,
  findingCommentCreateSchema,
  type FindingDetail,
  type FindingEvidence,
  type FindingListQuery,
  findingListQuerySchema,
  type FindingStatusUpdate,
  findingStatusUpdateSchema,
  type Paginated,
  type RelatedFindings,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { PlanService } from '../plan/plan.service.js';
import { FindingsService } from './findings.service.js';

const findingIdSchema = z.uuid();

/**
 * Alertas (achados) do cliente da sessão (T5.4 e T5.5). Todos leem; quem faz triagem muda o status e comenta. Os
 * relacionados são a sugestão do painel ao promover um alerta a incidente.
 */
@Controller('findings')
export class FindingsController {
  constructor(
    private readonly findings: FindingsService,
    private readonly plan: PlanService,
  ) {}

  @Get()
  @RequirePermission('findings:read')
  async list(
    @Query({ schema: findingListQuerySchema }) query: FindingListQuery,
  ): Promise<Paginated<Finding>> {
    await this.plan.assertPeriodWithinHistory(query.period);
    await this.plan.assertRangeWithinHistory(query.from);
    return this.findings.list(query);
  }

  @Get(':id')
  @RequirePermission('findings:read')
  get(@Param('id', { schema: findingIdSchema }) id: string): Promise<FindingDetail> {
    return this.findings.get(id);
  }

  @Get(':id/related')
  @RequirePermission('findings:read')
  related(@Param('id', { schema: findingIdSchema }) id: string): Promise<RelatedFindings> {
    return this.findings.related(id);
  }

  @Get(':id/evidence')
  @RequirePermission('findings:read')
  evidence(@Param('id', { schema: findingIdSchema }) id: string): Promise<FindingEvidence> {
    return this.findings.evidence(id);
  }

  @Get(':id/change')
  @RequirePermission('findings:read')
  change(@Param('id', { schema: findingIdSchema }) id: string): Promise<FindingChangeContext> {
    return this.findings.change(id);
  }

  @Patch(':id/status')
  @RequirePermission('findings:triage')
  updateStatus(
    @Req() request: Request,
    @Param('id', { schema: findingIdSchema }) id: string,
    @Body({ schema: findingStatusUpdateSchema }) body: FindingStatusUpdate,
  ): Promise<FindingDetail> {
    return this.findings.updateStatus(request.auth as RequestAuth, id, body);
  }

  @Post(':id/comments')
  @RequirePermission('findings:triage')
  comment(
    @Req() request: Request,
    @Param('id', { schema: findingIdSchema }) id: string,
    @Body({ schema: findingCommentCreateSchema }) body: FindingCommentCreate,
  ): Promise<FindingComment> {
    return this.findings.comment(request.auth as RequestAuth, id, body);
  }
}
