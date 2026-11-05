import { Controller, HttpCode, HttpStatus, Inject, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { isNodeSmtpPassword } from '../common/config/env.schema.js';
import { ApiError } from '../common/http/api-error.js';
import { registerLiveSecret } from '../common/logger/sanitize.js';
import { WorkerCallerGuard, WorkerCallers, workerCallerOf } from '../internal/worker-caller.js';
import { TenantStore } from '../tenants/tenant-store.js';
import type { TenantState } from '../tenants/tenant.schema.js';
import { CloudApiError } from './cloud-http.js';
import type { SecretVersionsApi } from './google-apis.js';
import {
  NODE_MAIL_VAULT,
  PROVISIONING_APIS,
  type ProvisioningApis,
  resolveProvisioningSettings,
} from './provisioning-settings.js';

/**
 * O e-mail dos nós de clientes: uma caixa de envio comum a todos os nós gerenciados (qualquer provedor SMTP com TLS). O
 * servidor, a porta e o usuário são configuração do cp-worker (`SMTP_*_NODES`) e vão para os metadados da VM pelo
 * Terraform; a senha fica no cofre `cp-nodes-smtp-password` do projeto do plano de controle e o cp-worker a copia como
 * versão nova do cofre `vx-<slug>-smtp-password` de cada nó (passo `secrets.smtp_password` e a recópia da troca de
 * senha, abaixo), com o `secretVersionAdder` que o `envs/tenant` dá só nesse cofre: grava e não lê de volta. A senha
 * nunca vai para o Job, o Terraform, os metadados, o Firestore, o log nem um erro.
 */

/** O cofre da senha da caixa de envio de um nó (o mesmo nome do módulo, `infra/gcp/modules/node/secrets.tf`). */
export function nodeSmtpPasswordSecret(slug: string): string {
  return `vx-${slug}-smtp-password`;
}

export type NodeSmtpPasswordResult =
  { ok: true; password: string } | { ok: false; reason: 'smtp_password_missing' | 'smtp_password_invalid' };

/**
 * A senha da caixa de envio dos nós, lida da versão `latest` de `cp-nodes-smtp-password` e conferida
 * (`isNodeSmtpPassword`: o que o `start.sh` do nó aceita). Uma quebra de linha no fim (o `echo` de quem gravou) sai, como
 * o `start.sh` faz ao ler o cofre do nó. Sem versão habilitada, `smtp_password_missing`; fora do formato,
 * `smtp_password_invalid`. Com `ok`, o valor entra na máscara do logger e fica nela enquanto o processo viver: é uma
 * credencial de longa duração, que só muda na troca (o conjunto não cresce), e esquecer no fim de um passo tiraria a
 * máscara de outro passo ou da recópia que a estivesse usando ao mesmo tempo.
 */
export async function readNodeSmtpPassword(
  secrets: Pick<SecretVersionsApi, 'accessLatest'>,
  project: string,
): Promise<NodeSmtpPasswordResult> {
  const raw = await secrets.accessLatest(project, NODE_MAIL_VAULT);
  if (raw === undefined) return { ok: false, reason: 'smtp_password_missing' };
  const password = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (password.length === 0) return { ok: false, reason: 'smtp_password_missing' };
  if (!isNodeSmtpPassword(password)) return { ok: false, reason: 'smtp_password_invalid' };
  registerLiveSecret(password);
  return { ok: true, password };
}

/**
 * Estados em que o cofre do nó existe (criado pelo `apply` do provisionamento e só apagado na exclusão): a recópia vale
 * para eles. `pending` não tem nó, e `deleted` não tem mais.
 */
const STATES_WITH_NODE: ReadonlySet<TenantState> = new Set([
  'provisioning',
  'provisioning_failed',
  'waiting_customer_connection',
  'active',
  'past_due',
  'suspended',
  'canceled',
]);

export interface NodeMailSyncResult {
  /** Nós cujo cofre recebeu a senha nova. */
  updated: number;
  /** Os ids (ULID) dos clientes cujo cofre recusou a gravação: o log diz o motivo de cada um. */
  failed: string[];
  /** Clientes com a senha copiada antes, mas sem nó agora (`deleted`). */
  skipped: number;
}

/**
 * A recópia da senha na troca (rotação): o responsável grava a senha nova em `cp-nodes-smtp-password` e chama esta
 * operação, que grava a versão `latest` no cofre de cada nó que já recebeu a senha (`resources.nodeMailPasswordAt`). O
 * nó lê o cofre na partida (`start.sh`): a senha nova vale no próximo reinício da VM ou do `verax-node`, e a antiga
 * precisa continuar válida no provedor até lá (docs/runbooks/provisionamento.md, "Trocar a senha do e-mail dos nós").
 * Só a senha: um servidor ou um usuário novo não chega aos nós que já existem (o `node.conf` é escrito na instalação).
 */
@Injectable()
export class NodeMailSyncService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    private readonly tenants: TenantStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(NodeMailSyncService.name) private readonly logger: PinoLogger,
  ) {}

  async sync(actor: string, requestId?: string): Promise<NodeMailSyncResult> {
    const resolved = resolveProvisioningSettings(this.config);
    if (!resolved.ready) {
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Provisionamento desligado',
        'provisioning_disabled',
      );
    }
    const settings = resolved.settings;
    if (settings.nodeMail === undefined) {
      throw new ApiError(HttpStatus.CONFLICT, 'O e-mail dos nós está desligado', 'node_mail_disabled');
    }
    const read = await readNodeSmtpPassword(this.apis.secrets, settings.controlPlaneProject);
    if (!read.ok) {
      throw new ApiError(HttpStatus.CONFLICT, 'A senha do e-mail dos nós não está no cofre', read.reason);
    }
    const result: NodeMailSyncResult = { updated: 0, failed: [], skipped: 0 };
    for (const tenant of await this.tenants.listWithNodeMail()) {
      if (!STATES_WITH_NODE.has(tenant.state)) {
        result.skipped += 1;
        continue;
      }
      try {
        await this.apis.secrets.addVersion(
          settings.nodesProject,
          nodeSmtpPasswordSecret(tenant.slug),
          read.password,
        );
      } catch (error) {
        if (!(error instanceof CloudApiError)) throw error;
        result.failed.push(tenant.id);
        this.logger.warn(
          {
            event: 'node_smtp_password_sync_failed',
            tenantId: tenant.id,
            reason: `${error.service}_${error.status === 0 ? 'unreachable' : String(error.status)}`,
          },
          'senha do e-mail não chegou ao cofre do nó',
        );
        continue;
      }
      // Na trilha do cliente, com quem pediu: quando o cofre do nó recebeu a senha nova.
      const now = this.clock.now();
      await this.tenants.change(tenant.id, (current) =>
        STATES_WITH_NODE.has(current.state)
          ? {
              reason: 'node_smtp_password_synced',
              audit: { actor, requestId },
              mutate: (t) => ({ ...t, resources: { ...t.resources, nodeMailPasswordAt: now } }),
            }
          : undefined,
      );
      result.updated += 1;
    }
    this.logger.info(
      {
        event: 'node_smtp_password_synced',
        updated: result.updated,
        failed: result.failed.length,
        skipped: result.skipped,
      },
      'senha do e-mail dos nós copiada de novo',
    );
    return result;
  }
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * `POST /internal/nodes/smtp-password/sync`: só o responsável (`OWNER_PRINCIPALS`), como o `resume`. Responde com as
 * contagens e os ids dos clientes cujo cofre recusou a gravação; a senha nunca sai.
 */
@Controller('internal/nodes')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner')
export class NodeMailSyncController {
  constructor(private readonly sync: NodeMailSyncService) {}

  @Post('smtp-password/sync')
  @HttpCode(HttpStatus.OK)
  async syncPassword(@Req() req: Request): Promise<NodeMailSyncResult> {
    return this.sync.sync(`owner:${workerCallerOf(req) ?? 'desconhecido'}`, requestIdOf(req));
  }
}
