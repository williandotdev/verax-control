import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  type Finding,
  type FindingComment,
  type FindingCommentCreate,
  findingCommentCreateSchema,
  type FindingDetail,
  type FindingListQuery,
  findingListQuerySchema,
  type FindingStatusUpdate,
  findingStatusUpdateSchema,
  type Paginated,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { FindingsService } from './findings.service.js';

const findingIdSchema = z.uuid();

/** Achados do cliente da sessão (T5.4 e T5.5). Todos leem; quem faz triagem muda o status e comenta. */
@Controller('findings')
export class FindingsController {
  constructor(private readonly findings: FindingsService) {}

  @Get()
  @RequirePermission('findings:read')
  list(@Query({ schema: findingListQuerySchema }) query: FindingListQuery): Promise<Paginated<Finding>> {
    return this.findings.list(query);
  }

  @Get(':id')
  @RequirePermission('findings:read')
  get(@Param('id', { schema: findingIdSchema }) id: string): Promise<FindingDetail> {
    return this.findings.get(id);
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
