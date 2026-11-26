import { randomUUID } from 'node:crypto';
import type { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { GetRoleCommand, type IAMClient } from '@aws-sdk/client-iam';
import {
  ALB_ACCESS_LOG_PREFIX,
  AWS_READER_ROLE_NAME,
  isAwsRegion,
  parseAlbLogsBucketTag,
  type WebAlbLoggingAction,
  type WebAlbLoggingFailure,
  type WebAlbLoggingStatus,
} from '@verax/shared';
import { SyncLease } from '../../alerts/finding-store.js';
import type { DiscoveryClientFactory } from '../../aws/discovery/clients.js';
import { requestAwsDiscovery } from '../../aws/discovery/discovery-runs.js';
import { readOnly } from '../../aws/discovery/read-only.js';
import {
  abortableSleep,
  DEFAULT_THROTTLE_RETRY,
  isThrottling,
  type Sleep,
  withThrottleRetry,
} from '../../aws/findings/throttle.js';
import { entersRole } from '../../aws/onboarding/account-access.js';
import { sourceDetails } from '../../aws/onboarding/onboarding-view.js';
import { AwsConnectionError, awsErrorName, STS_FALLBACK_REGION } from '../../aws/web-identity.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { errorKind } from '../../common/logger/error-kind.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { COLLECTING_TENANT } from '../../tenants/tenant-status.js';
import type { WebLogsCredentials } from '../collect/web-logs-job.js';
import {
  type AccessLogState,
  albLoggingClient,
  albLoggingFailureOf,
  AlbLoggingViolation,
  changeAccessLog,
  readAccessLog,
} from './alb-access-logs.js';

/**
 * Tarefa `web-logs-alb-logging` do worker: liga ou desliga o log de acesso de um ALB, a pedido no painel
 * (`POST /v1/web-logs/sources/:id/access-logs/enable` e `/disable`). Só existe com `AWS_WEB_LOGS_ENABLED`, fora da célula e
 * com identidade na AWS, como as outras tarefas dos ataques web.
 *
 * **Ligar.** O destino vem da etiqueta do papel (`verax-control:alb-logs-bucket`, só na pilha com `EnableAlbAccessLogs`),
 * lida na hora. Os atributos do balanceador são lidos de novo: com o log já ligado, em qualquer bucket, nada muda
 * (`already_enabled`). Desligado, a mudança leva só as três chaves do log (`alb-access-logs.ts`), e a Verax guarda o que
 * mudou, quem pediu e o estado de antes.
 *
 * **Desligar** só o que a Verax ligou: o mesmo ALB (o ARN), com o log ainda no bucket e no prefixo em que ela o deixou.
 * Mudado fora do painel, nada é tocado e ele deixa de ser da Verax (`released`).
 *
 * Cada resultado entra na trilha do cliente (ator sistema), com o antes e o depois, e o que mudou pede uma descoberta da
 * conta, que mostra a fonte com o log ligado (ou desligado). Nada além do nome do erro vai para o log.
 */
export const WEB_ALB_LOGGING_SYNC = 'web-logs-alb-logging';
export const WEB_ALB_LOGGING_TICK_MS = 15_000;
export const WEB_ALB_LOGGING_BUDGET_MS = 2 * 60_000;
export const WEB_ALB_LOGGING_RUN_MS = 60_000;
export const WEB_ALB_LOGGING_LEASE_MS = 3 * 60_000;
/** Pedidos respondidos por execução. */
export const WEB_ALB_LOGGING_PER_RUN = 5;
const AUDIT_ACTION = 'web_logs.alb_logging_result';

export interface WebAlbLoggingReport {
  status: 'done' | 'locked';
  pending: number;
  enabled: number;
  alreadyEnabled: number;
  disabled: number;
  released: number;
  failed: number;
  /** Pedido trocado (ou fonte apagada) no meio: nada foi gravado. */
  superseded: number;
  /** Mudanças mandadas à AWS (o `ModifyLoadBalancerAttributes`). */
  changes: number;
  failures?: Record<string, number>;
}

export interface WebAlbLoggingOptions {
  name?: string;
  owner?: string;
  leaseMs?: number;
  now?: () => Date;
  elapsed?: () => number;
  random?: () => number;
  sleep?: Sleep;
  throttle?: { attempts: number; baseMs: number; maxMs: number };
  audit?: AuditService;
  /** Só os testes, que dividem o banco. */
  tenantIds?: readonly string[];
}

const PENDING_SELECT = {
  sourceId: true,
  tenantId: true,
  pending: true,
  requestedAt: true,
  requestedBy: true,
  enabledByVerax: true,
  loadBalancerArn: true,
  bucket: true,
  prefix: true,
  source: {
    select: {
      region: true,
      details: true,
      missingSince: true,
      cloudAccount: {
        select: {
          id: true,
          accountId: true,
          regions: true,
          status: true,
          connection: true,
          connectionError: true,
          ingestFrom: true,
        },
      },
    },
  },
} as const satisfies Prisma.WebAlbLoggingSelect;
type Pending = Prisma.WebAlbLoggingGetPayload<{ select: typeof PENDING_SELECT }>;

type Outcome =
  | {
      status: 'enabled';
      arn: string;
      bucket: string;
      previous: AccessLogState;
    }
  | { status: 'already_enabled'; current: AccessLogState }
  | { status: 'disabled'; sent: boolean }
  | { status: 'released' }
  | { status: 'failed'; code: WebAlbLoggingFailure };

/**
 * O ARN do ALB da fonte, conferido por partes: `arn:<partição>:elasticloadbalancing:<região da fonte>:<conta>:loadbalancer/
 * app/<nome>/<id>`. Null fora disso (um NLB, outra conta ou região, ou o ARN que a descoberta não guardou).
 */
export function albArnOf(details: unknown, region: string, accountId: string): string | null {
  const { arn } = sourceDetails(details);
  if (typeof arn !== 'string' || arn.length > 256) return null;
  const parts = arn.split(':');
  if (parts.length !== 6) return null;
  const [prefix, partition = '', service, arnRegion, account, resource = ''] = parts;
  if (prefix !== 'arn' || !['aws', 'aws-cn', 'aws-us-gov'].includes(partition)) return null;
  if (service !== 'elasticloadbalancing' || arnRegion !== region || account !== accountId) return null;
  const [kind, type, name = '', id = '', ...rest] = resource.split('/');
  if (kind !== 'loadbalancer' || type !== 'app' || rest.length > 0) return null;
  if (name.length === 0 || name.length > 32 || id.length !== 16) return null;
  return arn;
}

export class WebAlbLoggingTask {
  private readonly lease: SyncLease;
  private readonly name: string;
  private readonly now: () => Date;
  private readonly elapsed: () => number;
  private readonly random: () => number;
  private readonly sleep: Sleep;
  private readonly throttle: { attempts: number; baseMs: number; maxMs: number };
  private readonly audit: AuditService;
  private readonly tenantIds: readonly string[] | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: WebLogsCredentials,
    private readonly clients: DiscoveryClientFactory,
    {
      name = WEB_ALB_LOGGING_SYNC,
      owner = `worker-${randomUUID()}`,
      leaseMs = WEB_ALB_LOGGING_LEASE_MS,
      now = () => new Date(),
      elapsed = () => performance.now(),
      random = Math.random,
      sleep = abortableSleep,
      throttle = DEFAULT_THROTTLE_RETRY,
      audit = new AuditService(),
      tenantIds,
    }: WebAlbLoggingOptions = {},
  ) {
    this.lease = new SyncLease(prisma, name, owner, leaseMs);
    this.name = name;
    this.now = now;
    this.elapsed = elapsed;
    this.random = random;
    this.sleep = sleep;
    this.throttle = throttle;
    this.audit = audit;
    this.tenantIds = tenantIds;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<WebAlbLoggingReport> {
    const report: WebAlbLoggingReport = {
      status: 'done',
      pending: 0,
      enabled: 0,
      alreadyEnabled: 0,
      disabled: 0,
      released: 0,
      failed: 0,
      superseded: 0,
      changes: 0,
    };
    const startedAt = this.now();
    if (!(await this.lease.acquire(startedAt))) return { ...report, status: 'locked' };
    const started = this.elapsed();
    let firstError: string | null = null;
    try {
      const pending = await this.prisma.webAlbLogging.findMany({
        where: {
          pending: { not: null },
          source: { kind: 'elb_logs', cloudAccount: { provider: 'aws', ...COLLECTING_TENANT } },
          ...(this.tenantIds !== undefined && { tenantId: { in: [...this.tenantIds] } }),
        },
        select: PENDING_SELECT,
        orderBy: [{ requestedAt: 'asc' }, { sourceId: 'asc' }],
        take: WEB_ALB_LOGGING_PER_RUN,
      });
      report.pending = pending.length;
      for (const row of pending) {
        signal.throwIfAborted();
        if (this.elapsed() - started >= WEB_ALB_LOGGING_RUN_MS) break;
        const action = row.pending as WebAlbLoggingAction;
        const outcome = await this.process(row, action, report, signal);
        if (!(await this.save(row, action, outcome))) {
          report.superseded += 1;
          continue;
        }
        if (outcome.status === 'enabled') report.enabled += 1;
        else if (outcome.status === 'already_enabled') report.alreadyEnabled += 1;
        else if (outcome.status === 'disabled') report.disabled += 1;
        else if (outcome.status === 'released') report.released += 1;
        else {
          report.failed += 1;
          report.failures = {
            ...report.failures,
            [outcome.code]: (report.failures?.[outcome.code] ?? 0) + 1,
          };
        }
      }
      return report;
    } catch (error) {
      firstError = errorKind(error);
      throw error;
    } finally {
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastRunAt: startedAt,
          lastError: firstError,
          ...(firstError === null && { lastSuccessAt: this.now() }),
        },
      });
      await this.lease.release();
    }
  }

  private call<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return withThrottleRetry(send, { ...this.throttle, random: this.random, sleep: this.sleep, signal });
  }

  private async process(
    row: Pending,
    action: WebAlbLoggingAction,
    report: WebAlbLoggingReport,
    signal: AbortSignal,
  ): Promise<Outcome> {
    const failed = (code: WebAlbLoggingFailure): Outcome => ({ status: 'failed', code });
    const { source } = row;
    const { cloudAccount: account } = source;
    if (account.status !== 'active' || !entersRole(account)) return failed('account_not_connected');
    const arn =
      source.missingSince === null ? albArnOf(source.details, source.region, account.accountId) : null;
    if (action === 'disable') {
      // Outro balanceador com o mesmo nome (recriado), ou o que sumiu: o log que a Verax ligou não está mais ali.
      if (!row.enabledByVerax || arn === null || arn !== row.loadBalancerArn) return { status: 'released' };
    } else if (arn === null) {
      return failed('balancer_missing');
    }
    const home = account.regions.find(isAwsRegion) ?? STS_FALLBACK_REGION;
    let destroy: (() => void)[] = [];
    try {
      const session = await this.credentials.session(account.accountId, home, signal);
      // A chave de um usuário de leitura (a VM própria do cliente) nunca muda nada na conta.
      if (session.principal === 'iam_user') return failed('stack_update_required');
      const factory = this.clients(this.credentials.credentialsFor(account.accountId, home), home);
      const elbClient = factory.elbv2(source.region);
      destroy = [() => elbClient.destroy?.()];
      if (action === 'disable') {
        const elb = albLoggingClient<ElasticLoadBalancingV2Client>(elbClient, arn, null);
        const current = await this.call(() => readAccessLog(elb, arn, signal), signal);
        if (!current.enabled) return { status: 'disabled', sent: false };
        if (current.bucket !== row.bucket || (current.prefix ?? '') !== (row.prefix ?? ''))
          return { status: 'released' };
        await this.call(() => changeAccessLog(elb, arn, { kind: 'disable' }, signal), signal);
        report.changes += 1;
        return { status: 'disabled', sent: true };
      }
      const iamClient = factory.iam();
      destroy.push(() => iamClient.destroy?.());
      const target = await this.stackBucket(readOnly<IAMClient>(iamClient), signal);
      if (typeof target === 'string') return failed(target);
      if (target.region !== source.region) return failed('other_region');
      const elb = albLoggingClient<ElasticLoadBalancingV2Client>(elbClient, arn, target.bucket);
      const current = await this.call(() => readAccessLog(elb, arn, signal), signal);
      // Já ligado, em qualquer bucket: nada muda, e nenhum log é desviado.
      if (current.enabled) return { status: 'already_enabled', current };
      await this.call(
        () => changeAccessLog(elb, arn, { kind: 'enable', bucket: target.bucket }, signal),
        signal,
      );
      report.changes += 1;
      return { status: 'enabled', arn: arn, bucket: target.bucket, previous: current };
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof AwsConnectionError) return failed('account_not_connected');
      if (error instanceof AlbLoggingViolation) return failed('failed');
      return failed(albLoggingFailureOf(error));
    } finally {
      for (const close of destroy) close();
    }
  }

  /** O bucket da pilha, pela etiqueta do papel, lida agora (o cliente pode ter acabado de atualizar a pilha). */
  private async stackBucket(
    iam: Pick<IAMClient, 'send'>,
    signal: AbortSignal,
  ): Promise<{ region: string; bucket: string } | WebAlbLoggingFailure> {
    let tags: unknown;
    try {
      const response = await this.call(
        () => iam.send(new GetRoleCommand({ RoleName: AWS_READER_ROLE_NAME }), { abortSignal: signal }),
        signal,
      );
      tags = response.Role?.Tags;
    } catch (error) {
      if (signal.aborted || error instanceof AwsConnectionError) throw error;
      if (isThrottling(error)) return 'throttled';
      // O papel do modelo 1 não lê as próprias etiquetas: é uma pilha a atualizar.
      return awsErrorName(error).startsWith('AccessDenied') ? 'stack_update_required' : 'failed';
    }
    const list = Array.isArray(tags) ? (tags as { Key?: string; Value?: string }[]).slice(0, 50) : [];
    return parseAlbLogsBucketTag(list) ?? 'stack_update_required';
  }

  /** Grava o resultado (só se o pedido ainda é o mesmo), a trilha e, se algo mudou, a descoberta da conta. */
  private async save(row: Pending, action: WebAlbLoggingAction, outcome: Outcome): Promise<boolean> {
    const now = this.now();
    const status: WebAlbLoggingStatus = outcome.status;
    const base = {
      pending: null,
      requestedAt: null,
      lastAction: action,
      status,
      errorCode: outcome.status === 'failed' ? outcome.code : null,
      completedAt: now,
    };
    let data: Prisma.WebAlbLoggingUpdateManyMutationInput;
    switch (outcome.status) {
      case 'enabled':
        data = {
          ...base,
          enabledByVerax: true,
          loadBalancerArn: outcome.arn,
          bucket: outcome.bucket,
          prefix: ALB_ACCESS_LOG_PREFIX,
          enabledAt: now,
          enabledBy: row.requestedBy,
          previousEnabled: outcome.previous.enabled,
          previousBucket: outcome.previous.bucket,
          previousPrefix: outcome.previous.prefix,
          disabledAt: null,
          disabledBy: null,
        };
        break;
      case 'already_enabled':
        data = {
          ...base,
          enabledByVerax: false,
          loadBalancerArn: null,
          bucket: outcome.current.bucket,
          prefix: outcome.current.prefix,
        };
        break;
      case 'disabled':
        data = { ...base, enabledByVerax: false, disabledAt: now, disabledBy: row.requestedBy };
        break;
      case 'released':
        data = { ...base, enabledByVerax: false };
        break;
      default:
        data = base;
    }
    const changed = outcome.status === 'enabled' || (outcome.status === 'disabled' && outcome.sent);
    const { cloudAccount: account } = row.source;
    return this.prisma.$transaction(async (tx) => {
      const db = scopeToTenant(tx, row.tenantId);
      const { count } = await db.webAlbLogging.updateMany({
        where: { sourceId: row.sourceId, pending: row.pending, requestedAt: row.requestedAt },
        data,
      });
      if (count !== 1) return false;
      if (changed) {
        await requestAwsDiscovery(tx, {
          tenantId: row.tenantId,
          cloudAccountId: account.id,
          trigger: 'scheduled',
          now,
        });
      }
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId: row.tenantId },
        action: AUDIT_ACTION,
        outcome: outcome.status === 'failed' ? 'failure' : 'success',
        resourceType: 'cloud_account',
        resourceId: account.id,
        before: {
          sourceId: row.sourceId,
          action,
          requestedBy: row.requestedBy,
          ...(outcome.status === 'enabled' && { accessLog: outcome.previous }),
          ...(action === 'disable' && {
            accessLog: { enabled: true, bucket: row.bucket, prefix: row.prefix },
          }),
        },
        after: {
          sourceId: row.sourceId,
          status,
          ...(outcome.status === 'failed' && { errorCode: outcome.code }),
          ...(outcome.status === 'enabled' && {
            accessLog: { enabled: true, bucket: outcome.bucket, prefix: ALB_ACCESS_LOG_PREFIX },
          }),
          ...(outcome.status === 'disabled' && { accessLog: { enabled: false }, sent: outcome.sent }),
        },
      });
      return true;
    });
  }
}
