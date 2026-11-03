import { Controller, Get, Req } from '@nestjs/common';
import type { TowerSummary } from '@verax/shared';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { TowerService } from './tower.service.js';

/** Resumo da Torre (T5.10) do cliente da sessão. */
@Controller('tower')
export class TowerController {
  constructor(private readonly tower: TowerService) {}

  @Get()
  @RequirePermission('tower:read')
  summary(@Req() request: Request): Promise<TowerSummary> {
    return this.tower.summary(request.auth as RequestAuth);
  }
}
