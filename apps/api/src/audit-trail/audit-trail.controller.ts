import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  type AuditEntry,
  type AuditEntryDetail,
  type AuditListQuery,
  auditListQuerySchema,
  type Paginated,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { AuditTrailService } from './audit-trail.service.js';

/** Trilha de auditoria (tela Auditoria): os administradores leem; ninguém altera nem apaga. */
@Controller('audit')
export class AuditTrailController {
  constructor(private readonly trail: AuditTrailService) {}

  @Get()
  @RequirePermission('audit:read')
  list(
    @Req() request: Request,
    @Query({ schema: auditListQuerySchema }) query: AuditListQuery,
  ): Promise<Paginated<AuditEntry>> {
    return this.trail.list(request.auth as RequestAuth, query);
  }

  @Get(':id')
  @RequirePermission('audit:read')
  get(@Req() request: Request, @Param('id', { schema: z.uuid() }) id: string): Promise<AuditEntryDetail> {
    return this.trail.get(request.auth as RequestAuth, id);
  }
}
