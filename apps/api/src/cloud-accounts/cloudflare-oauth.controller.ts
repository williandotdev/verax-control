import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import {
  type CloudflareConnectOptions,
  type CloudflareOauthAttempt,
  type CloudflareOauthChoose,
  cloudflareOauthChooseSchema,
  type CloudflareOauthComplete,
  cloudflareOauthCompleteSchema,
  type CloudflareOauthCompleted,
  type CloudflareOauthStart,
  cloudflareOauthStartSchema,
  type CloudflareOauthStarted,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { CloudflareConnectService } from '../cloudflare/oauth/cloudflare-connect.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';

const attemptIdSchema = z.uuid();

/**
 * "Conectar com Cloudflare" (OAuth). Só administradores começam, concluem e escolhem as contas, com a mesma permissão do
 * token colado (`cloud_credentials:write`). No nó em que o Cloudflare não é conectado por OAuth, tudo responde 404.
 */
@Controller('cloudflare-oauth')
export class CloudflareOauthController {
  constructor(private readonly connect: CloudflareConnectService) {}

  /** Como o Cloudflare é conectado neste nó. */
  @Get('options')
  @RequirePermission('cloud_accounts:read')
  options(): Promise<CloudflareConnectOptions> {
    return this.connect.options();
  }

  /** Começa uma tentativa: a URL de autorização, para o painel navegar. */
  @Post('start')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cloud_credentials:write')
  start(
    @Req() request: Request,
    @Body({ schema: cloudflareOauthStartSchema }) body: CloudflareOauthStart,
  ): Promise<CloudflareOauthStarted> {
    return this.connect.start(request.auth as RequestAuth, body);
  }

  /** O retorno do Cloudflare, lido do fragmento pelo painel: só vale na sessão que começou. */
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cloud_credentials:write')
  complete(
    @Req() request: Request,
    @Body({ schema: cloudflareOauthCompleteSchema }) body: CloudflareOauthComplete,
  ): Promise<CloudflareOauthCompleted> {
    return this.connect.complete(request.auth as RequestAuth, body);
  }

  @Get('attempts/:id')
  @RequirePermission('cloud_credentials:write')
  attempt(
    @Req() request: Request,
    @Param('id', { schema: attemptIdSchema }) id: string,
  ): Promise<CloudflareOauthAttempt> {
    return this.connect.attempt(request.auth as RequestAuth, id);
  }

  /** As contas que o cliente quer monitorar (202): o worker prova e liga. */
  @Post('attempts/:id/accounts')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('cloud_credentials:write')
  choose(
    @Req() request: Request,
    @Param('id', { schema: attemptIdSchema }) id: string,
    @Body({ schema: cloudflareOauthChooseSchema }) body: CloudflareOauthChoose,
  ): Promise<CloudflareOauthAttempt> {
    return this.connect.choose(request.auth as RequestAuth, id, body);
  }
}
