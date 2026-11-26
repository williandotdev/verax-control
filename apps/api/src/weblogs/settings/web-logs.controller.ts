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
  UseGuards,
} from '@nestjs/common';
import {
  awsSourceIdSchema,
  type WebAlbLogging,
  type WebAlbLoggingRequest,
  webAlbLoggingRequestSchema,
  type WebLogSource,
  type WebLogSourceList,
  type WebLogSourceListQuery,
  webLogSourceListQuerySchema,
  type WebRoute,
  type WebRouteCreate,
  webRouteCreateSchema,
  type WebRouteList,
  type WebRouteUpdate,
  webRouteUpdateSchema,
  type WebSourceSettingsUpdate,
  type WebSourceHealth,
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
import { WebAlbLoggingService } from './web-alb-logging.service.js';
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
  constructor(
    private readonly webLogs: WebLogsService,
    private readonly albLogging: WebAlbLoggingService,
  ) {}

  @Get('sources')
  @RequirePermission('cloud_accounts:read')
  sources(
    @Req() request: Request,
    @Query({ schema: webLogSourceListQuerySchema }) query: WebLogSourceListQuery,
  ): Promise<WebLogSourceList> {
    return this.webLogs.sources(request.auth as RequestAuth, query);
  }

  @Get('sources/:sourceId')
  @RequirePermission('cloud_accounts:read')
  source(
    @Req() request: Request,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
  ): Promise<WebLogSource> {
    return this.webLogs.source(request.auth as RequestAuth, sourceId);
  }

  /** A leitura das últimas 24 h e o resumo da observação: só contagens e códigos. */
  @Get('sources/:sourceId/health')
  @RequirePermission('cloud_accounts:read')
  health(@Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string): Promise<WebSourceHealth> {
    return this.webLogs.health(sourceId);
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

  /** O log de acesso ligado pelo painel: o pedido pendente, o último resultado e o que a Verax ligou. */
  @Get('sources/:sourceId/access-logs')
  @RequirePermission('cloud_accounts:read')
  accessLogs(@Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string): Promise<WebAlbLogging> {
    return this.albLogging.state(sourceId);
  }

  /** Pede ao worker que ligue o log de acesso do ALB no bucket da pilha (202); o painel acompanha pela leitura. */
  @Post('sources/:sourceId/access-logs/enable')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('cloud_accounts:write')
  enableAccessLogs(
    @Req() request: Request,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
    @Body({ schema: webAlbLoggingRequestSchema }) _body: WebAlbLoggingRequest,
  ): Promise<WebAlbLogging> {
    return this.albLogging.requestEnable(request.auth as RequestAuth, sourceId);
  }

  /** Pede ao worker que desligue o log que a Verax ligou (202). */
  @Post('sources/:sourceId/access-logs/disable')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('cloud_accounts:write')
  disableAccessLogs(
    @Req() request: Request,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
    @Body({ schema: webAlbLoggingRequestSchema }) _body: WebAlbLoggingRequest,
  ): Promise<WebAlbLogging> {
    return this.albLogging.requestDisable(request.auth as RequestAuth, sourceId);
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
