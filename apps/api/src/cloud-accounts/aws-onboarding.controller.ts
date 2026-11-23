import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import {
  type AwsConnect,
  awsConnectSchema,
  type AwsOnboarding,
  awsSourceIdSchema,
  type AwsSourcesAuthorize,
  awsSourcesAuthorizeSchema,
} from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { AwsOnboardingService } from './aws-onboarding.service.js';

const accountIdSchema = z.uuid();

/**
 * Onboarding self-service da conta AWS do cliente da sessão (`docs/ARQUITETURA.md`, "Onboarding AWS self-service"):
 * todos leem o estado; administradores conectam, pedem a descoberta e autorizam (ou desautorizam) as fontes. Toda
 * escrita responde com o estado da conta já atualizado, o mesmo da leitura.
 */
@Controller('cloud-accounts')
export class AwsOnboardingController {
  constructor(private readonly onboarding: AwsOnboardingService) {}

  /** O estado da conexão, as conferências, a descoberta mais recente, o retrato da infraestrutura e as fontes. */
  @Get(':id/aws/onboarding')
  @RequirePermission('cloud_accounts:read')
  get(@Param('id', { schema: accountIdSchema }) id: string): Promise<AwsOnboarding> {
    return this.onboarding.get(id);
  }

  /**
   * "Conectar com AWS": o nó passa a tentar a entrada no papel por até 60 min, enquanto o cliente cria a pilha.
   * Responde na hora (202); o painel acompanha pelo estado da conta. O corpo é opcional: com ele, as autorizações que o
   * cliente marcou no painel ficam gravadas (só a escolha, para a tela devolvê-la; não é permissão).
   */
  @Post(':id/aws/connect')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('cloud_accounts:write')
  connect(
    @Param('id', { schema: accountIdSchema }) id: string,
    @Body({ schema: awsConnectSchema.optional() }) body: AwsConnect | undefined,
  ): Promise<AwsOnboarding> {
    return this.onboarding.connect(id, body);
  }

  /** Pede uma descoberta das fontes da conta (202): no máximo uma por vez, e uma manual a cada 5 min. */
  @Post(':id/aws/discovery')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('cloud_accounts:write')
  discover(
    @Req() request: Request,
    @Param('id', { schema: accountIdSchema }) id: string,
  ): Promise<AwsOnboarding> {
    return this.onboarding.requestDiscovery(request.auth as RequestAuth, id);
  }

  /** Autoriza a coleta das fontes citadas, a partir de hoje. As sensíveis só entram confirmadas uma a uma. */
  @Post(':id/aws/sources/authorize')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cloud_accounts:write')
  authorize(
    @Req() request: Request,
    @Param('id', { schema: accountIdSchema }) id: string,
    @Body({ schema: awsSourcesAuthorizeSchema }) body: AwsSourcesAuthorize,
  ): Promise<AwsOnboarding> {
    return this.onboarding.authorize(request.auth as RequestAuth, id, body);
  }

  /** Tira a autorização de uma fonte: ela sai da coleta, e a linha fica. */
  @Post(':id/aws/sources/:sourceId/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cloud_accounts:write')
  revoke(
    @Param('id', { schema: accountIdSchema }) id: string,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
  ): Promise<AwsOnboarding> {
    return this.onboarding.revoke(id, sourceId);
  }

  /** "Tentar de novo": pede ao worker que confira de novo a permissão da fonte (202); um a cada 30 s por fonte (429). */
  @Post(':id/aws/sources/:sourceId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('cloud_accounts:write')
  retry(
    @Param('id', { schema: accountIdSchema }) id: string,
    @Param('sourceId', { schema: awsSourceIdSchema }) sourceId: string,
  ): Promise<AwsOnboarding> {
    return this.onboarding.retry(id, sourceId);
  }
}
