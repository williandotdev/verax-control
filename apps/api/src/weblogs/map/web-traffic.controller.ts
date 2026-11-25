import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { type WebTraffic, type WebTrafficQuery, webTrafficQuerySchema } from '@verax/shared';
import { RequirePermission } from '../../auth/decorators.js';
import { WebLogsEnabledGuard } from '../settings/web-logs-enabled.guard.js';
import { WebTrafficService } from './web-traffic.service.js';

/**
 * O mapa de origens das requisições, do cliente da sessão, para a tela Detecções: a permissão é a do resumo do topo dela
 * (`tower:read`, todos os papéis), e quem vê um vê o outro. Como o resto de `/v1/web-logs`, só com `AWS_WEB_LOGS_ENABLED`
 * ligado no nó.
 */
@Controller('web-logs/traffic')
@UseGuards(WebLogsEnabledGuard)
export class WebTrafficController {
  constructor(private readonly webTraffic: WebTrafficService) {}

  @Get()
  @RequirePermission('tower:read')
  traffic(@Query({ schema: webTrafficQuerySchema }) query: WebTrafficQuery): Promise<WebTraffic> {
    return this.webTraffic.traffic(query);
  }
}
