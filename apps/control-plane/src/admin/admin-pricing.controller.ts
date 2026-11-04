import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { VersionedRecord, VersionSummary } from '../pricing/pricing-store.js';
import type { CostModel, PriceTable } from '../pricing/pricing.schema.js';
import type { GuardReport } from '../pricing/publish-guard.js';
import { AdminPricingService, type PublishResult, type SimulationResult } from './admin-pricing.service.js';
import { type OwnerRequest, ownerOf } from './owner.guard.js';

/**
 * Rotas do console do responsável (`/v1/admin/...`, só no `cp-admin`, todas atrás da `OwnerGuard`): tabelas de preços
 * e modelos de custo (listar, ler, criar rascunho, editar rascunho, publicar), a checagem de publicação sem publicar
 * e o simulador de DRE. Custos e margens só saem por aqui.
 */
@Controller('admin')
export class AdminPricingController {
  constructor(private readonly service: AdminPricingService) {}

  @Get('pricing-tables')
  listTables(): Promise<VersionSummary[]> {
    return this.service.listTables();
  }

  @Get('pricing-tables/:version')
  getTable(@Param('version') version: string): Promise<VersionedRecord<PriceTable>> {
    return this.service.getTable(version);
  }

  @Post('pricing-tables')
  createTable(@Body() body: unknown, @Req() req: OwnerRequest): Promise<VersionedRecord<PriceTable>> {
    return this.service.createTable(body, ownerOf(req));
  }

  @Put('pricing-tables/:version')
  updateTable(
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<VersionedRecord<PriceTable>> {
    return this.service.updateTable(version, body, ownerOf(req));
  }

  @Post('pricing-tables/:version/check')
  @HttpCode(200)
  checkTable(
    @Param('version') version: string,
    @Body() body: unknown,
  ): Promise<{ costModelVersion: string; report: GuardReport }> {
    return this.service.checkTable(version, body);
  }

  @Post('pricing-tables/:version/publish')
  @HttpCode(200)
  publishTable(
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<PublishResult> {
    return this.service.publishTable(version, body, ownerOf(req));
  }

  @Get('cost-models')
  listCostModels(): Promise<VersionSummary[]> {
    return this.service.listCostModels();
  }

  @Get('cost-models/:version')
  getCostModel(@Param('version') version: string): Promise<VersionedRecord<CostModel>> {
    return this.service.getCostModel(version);
  }

  @Post('cost-models')
  createCostModel(@Body() body: unknown, @Req() req: OwnerRequest): Promise<VersionedRecord<CostModel>> {
    return this.service.createCostModel(body, ownerOf(req));
  }

  @Put('cost-models/:version')
  updateCostModel(
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<VersionedRecord<CostModel>> {
    return this.service.updateCostModel(version, body, ownerOf(req));
  }

  @Post('cost-models/:version/publish')
  @HttpCode(200)
  publishCostModel(
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<PublishResult> {
    return this.service.publishCostModel(version, body, ownerOf(req));
  }

  @Post('dre/simulate')
  @HttpCode(200)
  simulate(@Body() body: unknown): Promise<SimulationResult> {
    return this.service.simulate(body);
  }
}
