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
  type Author,
  type Incident,
  type IncidentAttach,
  incidentAttachSchema,
  type IncidentCreate,
  incidentCreateSchema,
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

/**
 * Incidentes do cliente da sessão (T5.7; decisão de 17/11/2026). Todos leem; quem opera (`incidents:write`) confirma
 * incidentes promovendo alertas, anexa e remove alertas, e muda o status e o responsável.
 */
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  /** Promove alertas a um incidente novo. */
  @Post()
  @RequirePermission('incidents:write')
  create(
    @Req() request: Request,
    @Body({ schema: incidentCreateSchema }) body: IncidentCreate,
  ): Promise<IncidentDetail> {
    return this.incidents.create(request.auth as RequestAuth, body);
  }

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

  /** Anexa alertas a um incidente que não está resolvido. */
  @Post(':id/findings')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('incidents:write')
  attach(
    @Param('id', { schema: incidentIdSchema }) id: string,
    @Body({ schema: incidentAttachSchema }) body: IncidentAttach,
  ): Promise<IncidentDetail> {
    return this.incidents.attach(id, body);
  }

  /** Tira um alerta do incidente; ele volta à fila de validação. O último alerta não sai. */
  @Delete(':id/findings/:findingId')
  @RequirePermission('incidents:write')
  detach(
    @Param('id', { schema: incidentIdSchema }) id: string,
    @Param('findingId', { schema: incidentIdSchema }) findingId: string,
  ): Promise<IncidentDetail> {
    return this.incidents.detach(id, findingId);
  }
}
