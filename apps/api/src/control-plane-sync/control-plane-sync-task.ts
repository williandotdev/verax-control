import { AWS_READER_AUDIENCE } from '@verax/shared';
import { AwsAccessKeyCheck } from '../aws/aws-key-check.js';
import { CloudflareTokenCheck } from '../cloudflare/cloudflare-token-check.js';
import type { WorkerEnv } from '../common/config/env.schema.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { GcpServiceAccountKeyCheck } from '../gcp/gcp-key-check.js';
import type { TenantPlans } from '../plan/tenant-plan.js';
import type { ScheduledTask } from '../worker/scheduler.js';
import type { SyncLogger } from './apply-source.js';
import {
  CONTROL_PLANE_SYNC_BUDGET_MS,
  CONTROL_PLANE_SYNC_TASK,
  CONTROL_PLANE_SYNC_TICK_MS,
  ControlPlaneSync,
  type ControlPlaneSyncOptions,
} from './control-plane-sync.js';
import { panelCredentialChecks, type SourceCredentialChecks } from './credential-checks.js';

/** O que o worker passa além da configuração (os testes trocam a conferência e o token). */
export interface ControlPlaneSyncTaskDeps {
  prisma: PrismaService;
  plans: TenantPlans;
  logger: SyncLogger;
  checks?: SourceCredentialChecks;
  idToken?: ControlPlaneSyncOptions['idToken'];
  fetch?: typeof fetch;
}

type ControlPlaneSyncEnv = Pick<
  WorkerEnv,
  | 'controlPlaneSync'
  | 'NODE_PLATFORM'
  | 'credentialsKeyring'
  | 'NODE_EGRESS_IPS'
  | 'NODE_SA_UNIQUE_ID'
  | 'AWS_WEB_IDENTITY_AUDIENCE'
>;

/**
 * A tarefa `control-plane-sync` do worker, ou null com a sincronização desligada (`CONTROL_PLANE_SYNC`, que a
 * configuração recusa na célula). No nó da GCP, o token do Google vem do metadata (`fetchNodeSyncToken`; o módulo, com
 * o SDK do STS, só é carregado aqui); na VM própria, a chave do nó já lida pela configuração. As credenciais do console
 * são conferidas na origem com as mesmas conferências do painel.
 */
export async function controlPlaneSyncTask(
  config: ControlPlaneSyncEnv,
  deps: ControlPlaneSyncTaskDeps,
): Promise<ScheduledTask | null> {
  const sync = config.controlPlaneSync;
  if (sync === null) return null;
  let idToken = deps.idToken;
  if (idToken === undefined && sync.credential.kind === 'gcp_identity') {
    const { fetchNodeSyncToken } = await import('../aws/web-identity.js');
    idToken = (audience, signal) => fetchNodeSyncToken(audience, signal);
  }
  const task = new ControlPlaneSync(deps.prisma, {
    config: sync,
    platform: config.NODE_PLATFORM,
    keyring: config.credentialsKeyring,
    node: {
      egressIps: config.NODE_EGRESS_IPS ?? [],
      serviceAccountId: config.NODE_SA_UNIQUE_ID ?? null,
      audience: config.AWS_WEB_IDENTITY_AUDIENCE ?? AWS_READER_AUDIENCE,
    },
    plans: deps.plans,
    checks:
      deps.checks ??
      panelCredentialChecks(
        new CloudflareTokenCheck(),
        new AwsAccessKeyCheck(),
        new GcpServiceAccountKeyCheck(),
      ),
    logger: deps.logger,
    ...(idToken !== undefined && { idToken }),
    ...(deps.fetch !== undefined && { fetch: deps.fetch }),
  });
  return {
    name: CONTROL_PLANE_SYNC_TASK,
    intervalMs: CONTROL_PLANE_SYNC_TICK_MS,
    budgetMs: CONTROL_PLANE_SYNC_BUDGET_MS,
    run: (signal) => task.runOnce(signal),
  };
}
