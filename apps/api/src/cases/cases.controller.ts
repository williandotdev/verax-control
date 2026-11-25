import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  type CaseDetail,
  type CaseFindingPage,
  type CaseFindingsQuery,
  caseFindingsQuerySchema,
  type CaseGroup,
  type CaseGroupsQuery,
  caseGroupsQuerySchema,
  type CaseListQuery,
  caseListQuerySchema,
  type CaseStatus,
  type CaseSummary,
  type CaseTimeline,
  type FindingTriage,
  type Paginated,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { PlanService } from '../plan/plan.service.js';
import { CasesVisibleGuard } from './cases.guard.js';
import { CasesService } from './cases.service.js';

const idSchema = z.uuid();

/** A situação dos casos: a única rota deles que responde com os casos desligados. */
@Controller('cases/status')
export class CaseStatusController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  @RequirePermission('findings:read')
  status(@Req() request: Request): Promise<CaseStatus> {
    return this.cases.status(request.auth as RequestAuth);
  }
}

/** Casos do cliente da sessão, só leitura: todos os papéis que leem alertas. O período não passa do histórico do plano. */
@Controller('cases')
@UseGuards(CasesVisibleGuard)
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly plan: PlanService,
  ) {}

  @Get()
  @RequirePermission('findings:read')
  async list(@Query({ schema: caseListQuerySchema }) query: CaseListQuery): Promise<Paginated<CaseSummary>> {
    await this.plan.assertPeriodWithinHistory(query.period);
    await this.plan.assertRangeWithinHistory(query.from);
    return this.cases.list(query);
  }

  // Antes de `:id`, para "groups" não ser lido como id.
  @Get('groups')
  @RequirePermission('findings:read')
  groups(@Query({ schema: caseGroupsQuerySchema }) query: CaseGroupsQuery): Promise<Paginated<CaseGroup>> {
    return this.cases.groups(query);
  }

  @Get(':id')
  @RequirePermission('findings:read')
  get(@Req() request: Request, @Param('id', { schema: idSchema }) id: string): Promise<CaseDetail> {
    return this.cases.get(request.auth as RequestAuth, id);
  }

  @Get(':id/findings')
  @RequirePermission('findings:read')
  findings(
    @Param('id', { schema: idSchema }) id: string,
    @Query({ schema: caseFindingsQuerySchema }) query: CaseFindingsQuery,
  ): Promise<CaseFindingPage> {
    return this.cases.findings(id, query);
  }

  @Get(':id/timeline')
  @RequirePermission('findings:read')
  timeline(@Param('id', { schema: idSchema }) id: string): Promise<CaseTimeline> {
    return this.cases.timeline(id);
  }
}

/** A trilha da triagem em massa de um alerta. Existe com os casos: a operação é deles. */
@Controller('findings')
@UseGuards(CasesVisibleGuard)
export class FindingTriageController {
  constructor(private readonly cases: CasesService) {}

  @Get(':id/triage')
  @RequirePermission('findings:read')
  triage(@Param('id', { schema: idSchema }) id: string): Promise<FindingTriage> {
    return this.cases.findingTriage(id);
  }
}
