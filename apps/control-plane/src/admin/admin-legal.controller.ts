import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { LegalTextRecord, LegalVersionSummary } from '../legal/legal.schema.js';
import { AdminLegalService, type LegalAuditEntry, type LegalOverview } from './admin-legal.service.js';
import { type OwnerRequest, ownerOf } from './owner.guard.js';

/**
 * Os textos legais no console do responsável (`/v1/admin/legal/...`, só no `cp-admin`, atrás da `OwnerGuard`): a lista
 * dos três textos com as versões, o rascunho, a edição, a publicação e a trilha de auditoria de cada texto. O tipo é
 * `terms`, `privacy` ou `dpa`.
 */
@Controller('admin/legal')
export class AdminLegalController {
  constructor(private readonly service: AdminLegalService) {}

  @Get()
  overview(): Promise<LegalOverview> {
    return this.service.overview();
  }

  @Post(':kind/versions')
  create(
    @Param('kind') kind: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<LegalTextRecord> {
    return this.service.create(kind, body, ownerOf(req));
  }

  @Get(':kind/versions/:version')
  get(@Param('kind') kind: string, @Param('version') version: string): Promise<LegalTextRecord> {
    return this.service.get(kind, version);
  }

  @Put(':kind/versions/:version')
  update(
    @Param('kind') kind: string,
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<LegalTextRecord> {
    return this.service.update(kind, version, body, ownerOf(req));
  }

  @Post(':kind/versions/:version/publish')
  @HttpCode(200)
  publish(
    @Param('kind') kind: string,
    @Param('version') version: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<LegalVersionSummary> {
    return this.service.publish(kind, version, body, ownerOf(req));
  }

  @Get(':kind/audit')
  audit(@Param('kind') kind: string): Promise<LegalAuditEntry[]> {
    return this.service.auditTrail(kind);
  }
}
