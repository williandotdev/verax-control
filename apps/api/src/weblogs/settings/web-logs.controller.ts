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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  awsSourceIdSchema,
  type WebLogSource,
  type WebLogSourceList,
  type WebRoute,
  type WebRouteCreate,
  webRouteCreateSchema,
  type WebRouteList,
  type WebRouteUpdate,
  webRouteUpdateSchema,
  type WebSourceSettingsUpdate,
  webSourceSettingsUpdateSchema,
  type WebTrustedSource,
  type WebTrustedSourceCreate,
  webTrustedSourceCreateSchema,
  type WebTrustedSourceList,
  type WebTrustedSourceUpdate,
  webTrustedSourceUpdateSchema,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../../auth/decorators.js';
import type { RequestAuth } from '../../common/auth/request-auth.js';
import { WebLogsEnabledGuard } from './web-logs-enabled.guard.js';
import { WebLogsService } from './web-logs.service.js';

const idSchema = z.uuid();

/**
 * A configuração dos ataques web pelos logs do ALB, do cliente da sessão: todos leem, administradores mudam, com as
 * permissões das contas cloud (os balanceadores são fontes delas). Só com `AWS_WEB_LOGS_ENABLED` ligado no nó.
 */
@Controller('web-logs')
@UseGuards(WebLogsEnabledGuard)
export class WebLogsController {
  constructor(private readonly webLogs: WebLogsService) {}

  @Get('sources')
  @RequirePermission('cloud_accounts:read')
  sources(@Req() request: Request): Promise<WebLogSourceList> {
    return this.webLogs.sources(request.auth as RequestAuth);
  }

  @Get('sources/:sourceId')
  @RequirePermission('cloud_accounts:read')
  source(
    @Req() request: Request,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
  ): Promise<WebLogSource> {
    return this.webLogs.source(request.auth as RequestAuth, sourceId);
  }

  /** O modo (observar ou alertar) e o multiplicador dos limites. */
  @Patch('sources/:sourceId/settings')
  @RequirePermission('cloud_accounts:write')
  updateSettings(
    @Req() request: Request,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
    @Body({ schema: webSourceSettingsUpdateSchema }) body: WebSourceSettingsUpdate,
  ): Promise<WebLogSource> {
    return this.webLogs.updateSettings(request.auth as RequestAuth, sourceId, body);
  }

  /** Pede a estimativa de volume ao worker (202); o painel acompanha pela leitura. */
  @Post('sources/:sourceId/estimate')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('cloud_accounts:write')
  requestEstimate(
    @Req() request: Request,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
  ): Promise<WebLogSource> {
    return this.webLogs.requestEstimate(request.auth as RequestAuth, sourceId);
  }

  @Get('sources/:sourceId/routes')
  @RequirePermission('cloud_accounts:read')
  routes(@Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string): Promise<WebRouteList> {
    return this.webLogs.routes(sourceId);
  }

  @Post('sources/:sourceId/routes')
  @RequirePermission('cloud_accounts:write')
  createRoute(
    @Req() request: Request,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
    @Body({ schema: webRouteCreateSchema }) body: WebRouteCreate,
  ): Promise<WebRoute> {
    return this.webLogs.createRoute(request.auth as RequestAuth, sourceId, body);
  }

  @Patch('sources/:sourceId/routes/:id')
  @RequirePermission('cloud_accounts:write')
  updateRoute(
    @Req() request: Request,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: webRouteUpdateSchema }) body: WebRouteUpdate,
  ): Promise<WebRoute> {
    return this.webLogs.updateRoute(request.auth as RequestAuth, sourceId, id, body);
  }

  @Delete('sources/:sourceId/routes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('cloud_accounts:write')
  removeRoute(
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
    @Param('id', { schema: idSchema }) id: string,
  ): Promise<void> {
    return this.webLogs.removeRoute(sourceId, id);
  }

  /** As de todos os balanceadores e as de cada um. */
  @Get('trusted-sources')
  @RequirePermission('cloud_accounts:read')
  trustedSources(): Promise<WebTrustedSourceList> {
    return this.webLogs.trustedSources();
  }

  @Post('trusted-sources')
  @RequirePermission('cloud_accounts:write')
  createTrusted(
    @Req() request: Request,
    @Body({ schema: webTrustedSourceCreateSchema }) body: WebTrustedSourceCreate,
  ): Promise<WebTrustedSource> {
    return this.webLogs.createTrusted(request.auth as RequestAuth, body);
  }

  @Patch('trusted-sources/:id')
  @RequirePermission('cloud_accounts:write')
  updateTrusted(
    @Req() request: Request,
    @Param('id', { schema: idSchema }) id: string,
    @Body({ schema: webTrustedSourceUpdateSchema }) body: WebTrustedSourceUpdate,
  ): Promise<WebTrustedSource> {
    return this.webLogs.updateTrusted(request.auth as RequestAuth, id, body);
  }

  @Delete('trusted-sources/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('cloud_accounts:write')
  removeTrusted(@Param('id', { schema: idSchema }) id: string): Promise<void> {
    return this.webLogs.removeTrusted(id);
  }
}
