import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { forgetLiveSecret } from '../common/logger/sanitize.js';
import type {
  DirectTenantCreated,
  DirectTenantPreview,
  EnrollmentCodeIssued,
  TenantActionResult,
  TenantDetail,
  TenantInstallation,
  TenantList,
} from './admin-tenants.schema.js';
import { AdminTenantsService } from './admin-tenants.service.js';
import { type OwnerRequest, ownerOf } from './owner.guard.js';

/**
 * Os clientes no console do responsável (`/v1/admin/tenants...`, só no `cp-admin`, todas atrás da `OwnerGuard`, que
 * exige a sessão do login próprio, JSON e a mesma origem nas escritas): a lista, o detalhe com a linha do tempo, a
 * cotação de referência, o cadastro de um cliente de contrato direto e as operações do responsável, cada uma com o
 * subdomínio digitado como confirmação: `start`, `resume`, `cancel`, `suspend`, `reactivate`, `delete-now` e
 * `export`. Para o contrato direto com o ambiente na VM do cliente, a leitura do que mandar a ele (`installation`) e o
 * código de instalação de uso único (`enrollment-code`).
 */
@Controller('admin/tenants')
export class AdminTenantsController {
  constructor(private readonly service: AdminTenantsService) {}

  @Get()
  list(): Promise<TenantList> {
    return this.service.list();
  }

  @Post('preview')
  @HttpCode(200)
  preview(@Body() body: unknown): Promise<DirectTenantPreview> {
    return this.service.preview(body);
  }

  @Post()
  create(@Body() body: unknown, @Req() req: OwnerRequest): Promise<DirectTenantCreated> {
    return this.service.create(body, ownerOf(req));
  }

  @Get(':tenantId')
  detail(@Param('tenantId') tenantId: string): Promise<TenantDetail> {
    return this.service.detail(tenantId);
  }

  /** A versão do nó e o guia para o cliente instalar o ambiente na infraestrutura dele (só leitura). */
  @Get(':tenantId/installation')
  installation(@Param('tenantId') tenantId: string, @Req() req: OwnerRequest): Promise<TenantInstallation> {
    return this.service.installation(tenantId, ownerOf(req));
  }

  /** O código de instalação da VM do cliente, uma vez (a resposta sai com `Cache-Control: private, no-store`). */
  @Post(':tenantId/enrollment-code')
  @HttpCode(200)
  async enrollmentCode(
    @Param('tenantId') id: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EnrollmentCodeIssued> {
    const issued = await this.service.enrollmentCode(id, body, ownerOf(req));
    res.on('close', () => forgetLiveSecret(issued.code));
    return issued;
  }

  @Post(':tenantId/start')
  @HttpCode(200)
  start(
    @Param('tenantId') id: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<TenantActionResult> {
    return this.service.act('start', id, body, ownerOf(req));
  }

  @Post(':tenantId/resume')
  @HttpCode(200)
  resume(
    @Param('tenantId') id: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<TenantActionResult> {
    return this.service.act('resume', id, body, ownerOf(req));
  }

  @Post(':tenantId/cancel')
  @HttpCode(200)
  cancel(
    @Param('tenantId') id: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<TenantActionResult> {
    return this.service.act('cancel', id, body, ownerOf(req));
  }

  @Post(':tenantId/suspend')
  @HttpCode(200)
  suspend(
    @Param('tenantId') id: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<TenantActionResult> {
    return this.service.act('suspend', id, body, ownerOf(req));
  }

  @Post(':tenantId/reactivate')
  @HttpCode(200)
  reactivate(
    @Param('tenantId') id: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<TenantActionResult> {
    return this.service.act('reactivate', id, body, ownerOf(req));
  }

  @Post(':tenantId/delete-now')
  @HttpCode(200)
  deleteNow(
    @Param('tenantId') id: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<TenantActionResult> {
    return this.service.act('delete-now', id, body, ownerOf(req));
  }

  /** O link assinado de um backup: a resposta, como toda do console, sai com `Cache-Control: private, no-store`. */
  @Post(':tenantId/export')
  @HttpCode(200)
  export(
    @Param('tenantId') id: string,
    @Body() body: unknown,
    @Req() req: OwnerRequest,
  ): Promise<TenantActionResult> {
    return this.service.act('export', id, body, ownerOf(req));
  }
}
