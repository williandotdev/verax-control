import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { type AgentInstall, type AgentList, type AgentListQuery, agentListQuerySchema } from '@verax/shared';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { AgentsService } from './agents.service.js';

/**
 * Agentes do Wazuh nas instâncias do cliente da sessão: a lista e as instruções de instalação. Só leitura; todos os
 * papéis leem, e só quem administra recebe a senha de registro (`agents:enroll`, conferido no service).
 */
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @RequirePermission('agents:read')
  list(
    @Req() request: Request,
    @Query({ schema: agentListQuerySchema }) query: AgentListQuery,
  ): Promise<AgentList> {
    return this.agents.list(request.auth as RequestAuth, query);
  }

  /** A resposta pode levar a senha de registro: nada de cache no navegador nem no Cloudflare. */
  @Get('install')
  @RequirePermission('agents:read')
  @Header('Cache-Control', 'no-store')
  install(@Req() request: Request): Promise<AgentInstall> {
    return this.agents.install(request);
  }
}
