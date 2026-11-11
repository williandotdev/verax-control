import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { RequirePermission } from './decorators.js';

const switchTenantSchema = z.strictObject({ tenantId: z.uuid() });

/**
 * Troca de cliente do `admin_verax` (T2.5). O cliente escolhido fica na sessão, no servidor; as rotas de
 * dados nunca aceitam `tenantId` do corpo, da query ou da URL. Toda troca vai para a auditoria.
 *
 * Na célula (CE-01), só no endereço da equipe da Verax: é o único onde o `admin_verax` tem sessão (`resolveSession`), e
 * a rota confere de novo.
 */
@Controller('session/tenant')
@RequirePermission('session:switch_tenant')
export class SessionTenantController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async select(
    @Req() request: Request,
    @Body({ schema: switchTenantSchema }) body: z.infer<typeof switchTenantSchema>,
  ): Promise<{ activeTenantId: string }> {
    const auth = request.auth as RequestAuth;
    if (this.config.cell !== null && request.hostTenant?.staff !== true) throw new NotFoundException();
    const tenant = await this.prisma.db().tenant.findUnique({
      where: { id: body.tenantId },
      select: { id: true, status: true },
    });
    if (!tenant || tenant.status !== 'active') {
      throw new ApiError(HttpStatus.NOT_FOUND, 'Cliente não encontrado ou inativo');
    }
    await this.prisma.db().session.update({
      where: { id: auth.sessionId },
      data: { activeTenantId: tenant.id },
    });
    // Na trilha do cliente escolhido (ele vê que a Verax entrou), sem citar o cliente anterior.
    this.audit.describe({
      action: 'session.switch_tenant',
      resourceType: 'tenant',
      resourceId: tenant.id,
      tenantId: tenant.id,
      after: { activeTenantId: tenant.id },
    });
    return { activeTenantId: tenant.id };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async clear(@Req() request: Request): Promise<void> {
    const auth = request.auth as RequestAuth;
    await this.prisma.db().session.update({ where: { id: auth.sessionId }, data: { activeTenantId: null } });
    // Na trilha do cliente que a Verax deixou.
    this.audit.describe({
      action: 'session.clear_tenant',
      resourceType: 'tenant',
      resourceId: auth.activeTenantId ?? undefined,
      tenantId: auth.activeTenantId,
      before: { activeTenantId: auth.activeTenantId },
      after: { activeTenantId: null },
    });
  }
}
