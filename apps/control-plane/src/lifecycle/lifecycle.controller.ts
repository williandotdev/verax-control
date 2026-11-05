import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { isUlid } from '../common/ulid.js';
import { ownerActorOf, WorkerCallerGuard, WorkerCallers } from '../internal/worker-caller.js';
import { type ContractOutcome, ContractService } from './contract.service.js';
import { DeletionService } from './deletion.service.js';
import { ExportService } from './export.service.js';
import { TickService, type TickSummary } from './tick.service.js';

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * `POST /internal/tick` (Cloud Scheduler, a cada hora): as tasks e o Scheduler (a cp-invoker) e o responsável. Sempre
 * 200 com o resumo; uma parte que falhou fica em `failed` e na linha `event=tick_section_failed`.
 */
@Controller('internal')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('tasks')
export class TickController {
  constructor(private readonly tick: TickService) {}

  @Post('tick')
  @HttpCode(HttpStatus.OK)
  run(): Promise<TickSummary> {
    return this.tick.run();
  }
}

/** Quem agiu, quando quem chama é o console (`ADMIN_SA_EMAIL`): o e-mail que o IAP deu a ele. */
const actorField = z.email().max(254).optional();
const deleteNowSchema = z.strictObject({ confirmSlug: z.string().min(1).max(64), actor: actorField });
const exportSchema = z.strictObject({ object: z.string().min(1).max(200), actor: actorField });
const contractSchema = z.strictObject({ confirmSlug: z.string().min(1).max(64), actor: actorField });
const contractCancelSchema = z.strictObject({
  confirmSlug: z.string().min(1).max(64),
  actor: actorField,
  /** A data do cancelamento (o fim do contrato), ISO 8601 com fuso; sem ela, agora. */
  at: z.iso.datetime({ offset: true }).optional(),
});

/** Quem agiu, para a auditoria; sem um responsável identificado, 403 (o console precisa dizer quem). */
export function ownerActorOrForbid(req: Request, config: AppConfig, actor: string | undefined): string {
  const who = ownerActorOf(req, config, actor);
  if (who === undefined) throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'actor_not_owner');
  return who;
}

/**
 * As operações do responsável sobre um cliente (CP-11), auditadas como `owner:<e-mail>`. Quem chama: o console do
 * responsável (`cp-admin`, com o token da conta dele e quem agiu em `actor`) ou um responsável direto
 * (`OWNER_PRINCIPALS`); nunca a cp-invoker nem o cp-public. Todas pedem o subdomínio do cliente de novo
 * (`confirmSlug`), menos a exportação:
 * - `POST /internal/tenants/:id/delete-now` `{confirmSlug}`: a Exclusão 1 agora, de um cliente cancelado;
 * - `POST /internal/tenants/:id/export` `{object}`: o link assinado (24 h) de um backup, na janela da exportação;
 * - `POST /internal/tenants/:id/cancel` `{confirmSlug, at?}`, `.../suspend` e `.../reactivate` `{confirmSlug}`: um
 *   cliente de contrato direto (sem a Stripe).
 */
@Controller('internal/tenants')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner', 'console')
export class LifecycleOwnerController {
  constructor(
    private readonly deletions: DeletionService,
    private readonly exports: ExportService,
    private readonly contracts: ContractService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post(':tenantId/delete-now')
  @HttpCode(HttpStatus.OK)
  async deleteNow(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const parsed = deleteNowSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'Informe o subdomínio do cliente para confirmar',
        'invalid_request',
      );
    }
    const outcome = await this.deletions.deleteNow(
      tenantId,
      parsed.data.confirmSlug,
      ownerActorOrForbid(req, this.config, parsed.data.actor),
      requestIdOf(req),
    );
    switch (outcome.kind) {
      case 'not_found':
        throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
      case 'confirmation_mismatch':
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'O subdomínio não confere com o do cliente: nada foi excluído',
          'confirmation_mismatch',
        );
      case 'not_canceled':
        throw new ApiError(
          HttpStatus.CONFLICT,
          'Só um cliente cancelado pode ser excluído: cancele a assinatura antes',
          'not_canceled',
        );
      case 'started':
      case 'restarted':
        return { deletion: outcome.kind, phase: outcome.phase, runId: outcome.runId };
      case 'in_progress':
        return { deletion: 'in_progress', phase: outcome.phase };
      case 'deleted':
        return {
          deletion: 'deleted',
          ...(outcome.cryptoDestroyAfter === undefined
            ? {}
            : { cryptoDestroyAfter: outcome.cryptoDestroyAfter.toISOString() }),
        };
      case 'purged':
        return { deletion: 'purged' };
    }
  }

  @Post(':tenantId/export')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  async export(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<{ url: string; expiresAt: string; object: string }> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const parsed = exportSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Informe o backup', 'invalid_request');
    const outcome = await this.exports.createLink(
      tenantId,
      parsed.data.object,
      ownerActorOrForbid(req, this.config, parsed.data.actor),
      requestIdOf(req),
    );
    switch (outcome.kind) {
      case 'created':
        return { url: outcome.url, expiresAt: outcome.expiresAt.toISOString(), object: outcome.object };
      case 'not_found':
        throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
      case 'not_canceled':
        throw new ApiError(HttpStatus.CONFLICT, 'Só um cliente cancelado tem exportação', 'not_canceled');
      case 'window_closed':
        throw new ApiError(
          HttpStatus.CONFLICT,
          'A janela de 30 dias da exportação acabou',
          'export_window_closed',
        );
      case 'invalid_object':
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'O backup deve ser postgres/verax-<AAAAMMDD>T<HHMMSS>Z.dump',
          'invalid_object',
        );
      case 'unavailable':
        throw new ApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'Exportação não configurada',
          'export_unavailable',
        );
      case 'no_backups':
        throw new ApiError(HttpStatus.NOT_FOUND, 'O cliente não tem bucket de backups', 'no_backups');
      case 'object_not_found':
        throw new ApiError(HttpStatus.NOT_FOUND, 'Backup não encontrado', 'object_not_found');
      case 'check_failed':
        throw new ApiError(HttpStatus.BAD_GATEWAY, 'O backup não pôde ser conferido', 'export_check_failed');
    }
  }

  @Post(':tenantId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const parsed = contractCancelSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
    const { confirmSlug, actor, at } = parsed.data;
    return contractResponse(
      await this.contracts.cancel(
        tenantId,
        confirmSlug,
        at === undefined ? undefined : new Date(at),
        ownerActorOrForbid(req, this.config, actor),
        requestIdOf(req),
      ),
    );
  }

  @Post(':tenantId/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    const { confirmSlug, actor } = this.contractBody(tenantId, body);
    return contractResponse(
      await this.contracts.suspend(
        tenantId,
        confirmSlug,
        ownerActorOrForbid(req, this.config, actor),
        requestIdOf(req),
      ),
    );
  }

  @Post(':tenantId/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    const { confirmSlug, actor } = this.contractBody(tenantId, body);
    return contractResponse(
      await this.contracts.reactivate(
        tenantId,
        confirmSlug,
        ownerActorOrForbid(req, this.config, actor),
        requestIdOf(req),
      ),
    );
  }

  private contractBody(tenantId: string, body: unknown): z.infer<typeof contractSchema> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const parsed = contractSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
    return parsed.data;
  }
}

function contractResponse(outcome: ContractOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case 'canceled':
      return {
        result: 'canceled',
        deleteAfter: outcome.deleteAfter?.toISOString(),
        cryptoDestroyAfter: outcome.cryptoDestroyAfter?.toISOString(),
      };
    case 'scheduled':
      return { result: 'scheduled', cancelAt: outcome.cancelAt.toISOString() };
    case 'suspended':
    case 'reactivated':
      return { result: outcome.kind, state: outcome.state };
    case 'not_found':
      throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    case 'confirmation_mismatch':
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'O subdomínio não confere com o do cliente: nada mudou',
        'confirmation_mismatch',
      );
    case 'not_contract':
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Cliente da Stripe: cancele ou suspenda pela assinatura',
        'stripe_managed',
      );
    case 'invalid_date':
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'A data do cancelamento tem de ser agora ou futura (até 2 anos)',
        'invalid_date',
      );
    case 'not_allowed':
      throw new ApiError(
        HttpStatus.CONFLICT,
        'O cliente não está num estado que permita isso',
        'not_allowed',
      );
  }
}
