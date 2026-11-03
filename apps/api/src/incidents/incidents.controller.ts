import { Body, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import {
  type Author,
  type Incident,
  type IncidentDetail,
  type IncidentListQuery,
  incidentListQuerySchema,
  type IncidentUpdate,
  incidentUpdateSchema,
  type Paginated,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { IncidentsService } from './incidents.service.js';

const incidentIdSchema = z.uuid();

/** Incidentes do cliente da sessão (T5.7). Todos leem; quem opera muda o status e o responsável. */
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @RequirePermission('incidents:read')
  list(@Query({ schema: incidentListQuerySchema }) query: IncidentListQuery): Promise<Paginated<Incident>> {
    return this.incidents.list(query);
  }

  // Antes de `:id`, para "assignees" não ser lido como id.
  @Get('assignees')
  @RequirePermission('incidents:read')
  assignees(@Req() request: Request): Promise<{ items: Author[] }> {
    return this.incidents.assignees(request.auth as RequestAuth);
  }

  @Get(':id')
  @RequirePermission('incidents:read')
  get(@Param('id', { schema: incidentIdSchema }) id: string): Promise<IncidentDetail> {
    return this.incidents.get(id);
  }

  @Patch(':id')
  @RequirePermission('incidents:write')
  update(
    @Req() request: Request,
    @Param('id', { schema: incidentIdSchema }) id: string,
    @Body({ schema: incidentUpdateSchema }) body: IncidentUpdate,
  ): Promise<IncidentDetail> {
    return this.incidents.update(request.auth as RequestAuth, id, body);
  }
}
