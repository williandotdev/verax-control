import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ASSET_KINDS,
  type AssetKind,
  type AssetListQuery,
  assetListQuerySchema,
  type InventorySummary,
  type Paginated,
} from '@verax/shared';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import { AssetsService } from './assets.service.js';

/** Ativos e identidades do cliente da sessão (T5.9): visão geral e a lista de cada tipo, com o risco. */
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermission('assets:read')
  summary(): Promise<InventorySummary> {
    return this.assets.summary();
  }

  @Get(':kind')
  @RequirePermission('assets:read')
  list(
    @Param('kind', { schema: z.enum(ASSET_KINDS) }) kind: AssetKind,
    @Query({ schema: assetListQuerySchema }) query: AssetListQuery,
  ): Promise<Paginated<unknown>> {
    return this.assets.list(kind, query);
  }
}
