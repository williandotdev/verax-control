import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { PROVISIONING_APIS, type ProvisioningApis } from '../provisioning/provisioning-settings.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { ownsSlug } from './node-power.js';
import { signedUrl } from './signed-url.js';

/** O link da exportação vale 24 h (plano §4d e §10, item 11); a conferência do objeto, 60 s. */
export const EXPORT_LINK_SECONDS = 24 * 60 * 60;
const CHECK_SECONDS = 60;
const CHECK_TIMEOUT_MS = 10_000;

/** O nome de um backup do nó (`infra/node/bin/backup.sh`): `postgres/verax-<AAAAMMDD>T<HHMMSS>Z.dump`. */
export const BACKUP_OBJECT_PATTERN = /^postgres\/verax-[0-9]{8}T[0-9]{6}Z\.dump$/;

export type ExportOutcome =
  | { kind: 'created'; url: string; expiresAt: Date; object: string }
  | {
      kind:
        | 'not_found'
        | 'not_canceled'
        | 'window_closed'
        | 'invalid_object'
        | 'unavailable'
        | 'no_backups'
        | 'object_not_found'
        | 'check_failed';
    };

/**
 * A exportação sob pedido (plano §4d e §10, item 11), operação do responsável: um link assinado de 24 h para um backup
 * do banco do cliente cancelado, dentro dos 30 dias da janela. Regras:
 * - **nunca lista o bucket**: o responsável diz qual backup (o nome segue o formato do `backup.sh`), e a conferência
 *   de que ele existe é um `HEAD` pelo próprio link assinado (60 s), não uma listagem;
 * - o bucket é o deste cliente (`<projeto-dos-nos>-vx-<slug>-backups`, o mesmo das saídas do Terraform) e o subdomínio
 *   é dele: o pedido nunca escolhe bucket;
 * - quem assina é a conta `EXPORT_SIGNER_SA_EMAIL`, pelo `signBlob` (nenhuma chave no plano de controle); sem ela, a
 *   exportação fica desligada (503) e o plano de controle não alcança backup nenhum;
 * - o link é a credencial: nunca vai a log, à auditoria nem ao Firestore (a auditoria guarda o objeto e o prazo).
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly audit: AuditService,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(ExportService.name) private readonly logger: PinoLogger,
  ) {}

  async createLink(
    tenantId: string,
    object: string,
    actor: string,
    requestId?: string,
  ): Promise<ExportOutcome> {
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) return { kind: 'not_found' };
    const now = this.clock.now();
    if (tenant.state !== 'canceled') return { kind: 'not_canceled' };
    const until = tenant.lifecycle?.exportUntil;
    if (until === undefined || until.getTime() < now.getTime()) return { kind: 'window_closed' };
    if (!BACKUP_OBJECT_PATTERN.test(object)) return { kind: 'invalid_object' };
    const signer = this.config.EXPORT_SIGNER_SA_EMAIL;
    if (signer === undefined) {
      this.logger.warn({ event: 'export_unconfigured', tenantId }, 'exportação sem a conta que assina');
      return { kind: 'unavailable' };
    }
    const project = tenant.resources?.nodesProject;
    const bucket = tenant.resources?.backupsBucket;
    if (
      project === undefined ||
      bucket === undefined ||
      bucket !== `${project}-vx-${tenant.slug}-backups` ||
      !(await ownsSlug(this.tenants, tenant))
    ) {
      return { kind: 'no_backups' };
    }
    const sign = (payload: Buffer): Promise<Buffer> => this.apis.iam.signBlob(signer, payload);
    const base = this.apis.signedStorage.base;
    const check = await signedUrl(
      { method: 'HEAD', base, bucket, object, signer, now, expiresSeconds: CHECK_SECONDS },
      sign,
    );
    let status: number;
    try {
      const response = await this.apis.signedStorage.fetchFn(check, {
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      status = response.status;
    } catch {
      status = 0;
    }
    if (status === 404) return { kind: 'object_not_found' };
    if (status !== 200) {
      this.logger.warn({ event: 'export_check_failed', tenantId, status }, 'o backup não pôde ser conferido');
      return { kind: 'check_failed' };
    }
    const url = await signedUrl(
      { method: 'GET', base, bucket, object, signer, now, expiresSeconds: EXPORT_LINK_SECONDS },
      sign,
    );
    const expiresAt = new Date(now.getTime() + EXPORT_LINK_SECONDS * 1000);
    await this.audit.write({
      actor,
      action: 'tenant.export_link_created',
      tenantId,
      details: { object, expiresAt: expiresAt.toISOString() },
      requestId,
    });
    this.logger.info({ event: 'export_link_created', tenantId }, 'link da exportação criado');
    return { kind: 'created', url, expiresAt, object };
  }
}
