import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { NODE_RELEASE_PATTERN } from '../common/config/env.schema.js';
import { ApiError } from '../common/http/api-error.js';
import { isUlid } from '../common/ulid.js';
import { ownerActorOf, WorkerCallerGuard, WorkerCallers } from '../internal/worker-caller.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { hostingOf } from '../tenants/tenant.schema.js';
import { PROVISIONING_APIS, type ProvisioningApis } from './provisioning-settings.js';
import { ReleaseManifestError, type ReleaseDetails, readReleaseDetails } from './release-manifest.js';

export type InstallationRefusal =
  | 'not_found'
  | 'not_customer_hosted'
  | 'not_allowed'
  | 'release_unconfigured'
  | 'release_manifest_missing'
  | 'release_manifest_invalid'
  | 'release_unavailable';

export type InstallationOutcome =
  { ok: true; details: ReleaseDetails } | { ok: false; reason: InstallationRefusal };

/**
 * O que o responsável manda a um cliente de contrato direto que instala o ambiente na infraestrutura dele (`hosting =
 * customer`): a versão do nó que o provisionamento usaria agora (`NODE_RELEASE`), lida do bucket de releases com a
 * assinatura conferida (`readReleaseDetails`, o mesmo manifesto do release do GitHub). Só leitura: nada é criado,
 * gravado nem pedido em nenhuma outra infraestrutura. Precisa só de `RELEASE_BUCKET` e `NODE_RELEASE` (não do
 * provisionamento ligado: o contrato no cliente não usa o projeto dos nós).
 */
@Injectable()
export class InstallationService {
  constructor(
    private readonly tenants: TenantStore,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(InstallationService.name) private readonly logger: PinoLogger,
  ) {}

  async details(tenantId: string): Promise<InstallationOutcome> {
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) return { ok: false, reason: 'not_found' };
    if (hostingOf(tenant) !== 'customer') return { ok: false, reason: 'not_customer_hosted' };
    if (tenant.state === 'deleted') return { ok: false, reason: 'not_allowed' };
    const bucket = this.config.RELEASE_BUCKET;
    const release = this.config.NODE_RELEASE;
    if (bucket === undefined || release === undefined || !NODE_RELEASE_PATTERN.test(release)) {
      this.logger.warn(
        { event: 'installation_release_unconfigured', tenantId },
        'sem RELEASE_BUCKET ou NODE_RELEASE (node-vX.Y.Z): a versão para o cliente instalar não pode ser lida',
      );
      return { ok: false, reason: 'release_unconfigured' };
    }
    try {
      const details = await readReleaseDetails(this.apis.storage, bucket, release, this.apis.releaseKeys);
      this.logger.info(
        { event: 'installation_release_read', tenantId, release },
        'versão para o cliente instalar lida e conferida',
      );
      return { ok: true, details };
    } catch (error) {
      if (error instanceof ReleaseManifestError) {
        this.logger.warn(
          { event: 'installation_release_refused', tenantId, release, code: error.code },
          error.message,
        );
        return { ok: false, reason: error.code };
      }
      this.logger.error(
        {
          event: 'installation_release_unavailable',
          tenantId,
          release,
          reason: error instanceof Error ? error.name.slice(0, 40) : 'unknown',
        },
        'o bucket de releases não respondeu',
      );
      return { ok: false, reason: 'release_unavailable' };
    }
  }
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

const installationBodySchema = z.strictObject({ actor: z.email().max(254).optional() });

const REFUSALS: Readonly<Record<InstallationRefusal, { status: HttpStatus; message: string }>> = {
  not_found: { status: HttpStatus.NOT_FOUND, message: 'Não encontrado' },
  not_customer_hosted: {
    status: HttpStatus.CONFLICT,
    message: 'O ambiente deste cliente roda na infraestrutura da Verax: não há instalação para enviar',
  },
  not_allowed: { status: HttpStatus.CONFLICT, message: 'O cliente não está num estado que permita isso' },
  release_unconfigured: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Versão do nó não configurada' },
  release_manifest_missing: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Manifesto da versão ausente',
  },
  release_manifest_invalid: { status: HttpStatus.BAD_GATEWAY, message: 'Manifesto da versão recusado' },
  release_unavailable: { status: HttpStatus.SERVICE_UNAVAILABLE, message: 'Bucket de releases indisponível' },
};

/**
 * `POST /internal/tenants/:tenantId/installation` `{actor?}`: a versão e os endereços que o responsável manda ao
 * cliente que instala o ambiente na infraestrutura dele. Quem chama: o console (`cp-admin`, com quem agiu em `actor`)
 * ou um responsável direto, como as outras operações do responsável; nunca a cp-invoker nem o cp-public. Só leitura.
 */
@Controller('internal/tenants')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner', 'console')
export class InstallationController {
  constructor(
    private readonly installations: InstallationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(InstallationController.name) private readonly logger: PinoLogger,
  ) {}

  @Post(':tenantId/installation')
  @HttpCode(HttpStatus.OK)
  async installation(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ReleaseDetails> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const parsed = installationBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
    const actor = ownerActorOf(req, this.config, parsed.data.actor);
    if (actor === undefined) throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'actor_not_owner');
    const outcome = await this.installations.details(tenantId);
    if (outcome.ok) return outcome.details;
    if (outcome.reason !== 'not_found') {
      this.logger.info(
        { event: 'installation_refused', tenantId, code: outcome.reason, requestId: requestIdOf(req) },
        'pedido da instalação no cliente recusado',
      );
    }
    const refusal = REFUSALS[outcome.reason];
    throw new ApiError(refusal.status, refusal.message, outcome.reason);
  }
}
