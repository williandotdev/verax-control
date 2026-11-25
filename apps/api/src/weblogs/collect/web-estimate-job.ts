import { randomUUID } from 'node:crypto';
import { isAwsRegion } from '@verax/shared';
import { SyncLease } from '../../alerts/finding-store.js';
import { type DiscoveryClientFactory, DiscoveryRunClients } from '../../aws/discovery/clients.js';
import {
  abortableSleep,
  DEFAULT_THROTTLE_RETRY,
  type Sleep,
  withThrottleRetry,
} from '../../aws/findings/throttle.js';
import { entersRole } from '../../aws/onboarding/account-access.js';
import { sourceDetails } from '../../aws/onboarding/onboarding-view.js';
import { AwsConnectionError, STS_FALLBACK_REGION } from '../../aws/web-identity.js';
import { errorKind } from '../../common/logger/error-kind.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { concurrencyLimit } from '../../inventory/inventory.js';
import { COLLECTING_TENANT } from '../../tenants/tenant-status.js';
import { decompressedSize } from '../../usage/aws-volume.js';
import { AlbBucket, type AlbPage } from './alb-bucket.js';
import { type AlbObject, albTargetOf, utcDay } from './alb-target.js';
import { type AlbAction, AlbCallError, albFailureOf, isArchived, isFatal, isGone } from './s3-errors.js';
import type { WebLogsCredentials } from './web-logs-job.js';

/**
 * Tarefa `web-logs-estimate` do worker: a estimativa de volume de um balanceador, que o cliente pede no painel antes de
 * autorizá-lo (`POST /v1/web-logs/sources/:id/estimate`). Só existe com `AWS_WEB_LOGS_ENABLED`, fora da célula, e à parte da
 * leitura: a leitura pode levar minutos, e quem pediu está esperando.
 *
 * **O que é lido de uma fonte ainda não autorizada:** o que a sondagem da descoberta já lê dela (a listagem da pasta e o fim
 * de um objeto), só a pedido, e nenhum conteúdo: os nomes e os tamanhos dos arquivos de ontem e os 4 últimos bytes (o
 * tamanho descompactado, que o gzip guarda) de até 20 deles. O volume do dia é o tamanho compactado de todos vezes a razão
 * da amostra.
 *
 * **O resultado:** `ready` com o volume, `no_sample` (nenhum arquivo ontem) ou `failed` com o motivo, e o pedido sai de
 * pendente. Com mais de 10 páginas, o volume é um piso (`truncated`). O pedido renovado no meio não é respondido com o número
 * do anterior. A mesma coisa duas vezes (duas réplicas) daria o mesmo resultado; a concessão só evita as chamadas dobradas.
 */
export const WEB_ESTIMATE_SYNC = 'web-logs-estimate';
export const WEB_ESTIMATE_TICK_MS = 30_000;
/** O orçamento do agendador, e o tempo em que uma execução ainda começa uma estimativa. */
export const WEB_ESTIMATE_BUDGET_MS = 4 * 60_000;
export const WEB_ESTIMATE_RUN_MS = 60_000;
export const WEB_ESTIMATE_LEASE_MS = 5 * 60_000;
/** Pedidos respondidos por execução. */
export const WEB_ESTIMATES_PER_RUN = 5;
export const WEB_ESTIMATE_PAGES = 10;
export const WEB_ESTIMATE_SAMPLES = 20;
const SAMPLE_CONCURRENCY = 4;
const DAY_MS = 24 * 60 * 60_000;

/** Contagens de uma execução. */
export interface WebEstimateReport {
  status: 'done' | 'locked';
  pending: number;
  ready: number;
  noSample: number;
  failed: number;
  /** Pedido renovado, ou fonte apagada, no meio: nada foi gravado. */
  superseded: number;
  lists: number;
  tails: number;
  failures?: Record<string, number>;
}

export interface WebEstimateOptions {
  name?: string;
  owner?: string;
  leaseMs?: number;
  now?: () => Date;
  elapsed?: () => number;
  random?: () => number;
  sleep?: Sleep;
  throttle?: { attempts: number; baseMs: number; maxMs: number };
  maxPages?: number;
  samples?: number;
  /** Só os testes, que dividem o banco. */
  tenantIds?: readonly string[];
}

const ESTIMATE_SELECT = {
  sourceId: true,
  tenantId: true,
  requestedAt: true,
  source: {
    select: {
      region: true,
      details: true,
      availability: true,
      missingSince: true,
      cloudAccount: {
        select: {
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
} as const satisfies Prisma.WebSourceEstimateSelect;
type Pending = Prisma.WebSourceEstimateGetPayload<{ select: typeof ESTIMATE_SELECT }>;

type Result =
  | {
      status: 'ready';
      day: string;
      objects: number;
      sampled: number;
      bytesPerDay: number;
      truncated: boolean;
    }
  | { status: 'no_sample'; day: string; objects: number; truncated: boolean }
  | { status: 'failed'; code: string };

/** Até `count` itens, espalhados pela lista. */
export function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)] as T);
}

export class WebLogsEstimator {
  private readonly lease: SyncLease;
  private readonly name: string;
  private readonly now: () => Date;
  private readonly elapsed: () => number;
  private readonly random: () => number;
  private readonly sleep: Sleep;
  private readonly throttle: { attempts: number; baseMs: number; maxMs: number };
  private readonly maxPages: number;
  private readonly samples: number;
  private readonly tenantIds: readonly string[] | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: WebLogsCredentials,
    private readonly clients: DiscoveryClientFactory,
    {
      name = WEB_ESTIMATE_SYNC,
      owner = `worker-${randomUUID()}`,
      leaseMs = WEB_ESTIMATE_LEASE_MS,
      now = () => new Date(),
      elapsed = () => performance.now(),
      random = Math.random,
      sleep = abortableSleep,
      throttle = DEFAULT_THROTTLE_RETRY,
      maxPages = WEB_ESTIMATE_PAGES,
      samples = WEB_ESTIMATE_SAMPLES,
      tenantIds,
    }: WebEstimateOptions = {},
  ) {
    this.lease = new SyncLease(prisma, name, owner, leaseMs);
    this.name = name;
    this.now = now;
    this.elapsed = elapsed;
    this.random = random;
    this.sleep = sleep;
    this.throttle = throttle;
    this.maxPages = maxPages;
    this.samples = samples;
    this.tenantIds = tenantIds;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<WebEstimateReport> {
    const report: WebEstimateReport = {
      status: 'done',
      pending: 0,
      ready: 0,
      noSample: 0,
      failed: 0,
      superseded: 0,
      lists: 0,
      tails: 0,
    };
    const startedAt = this.now();
    if (!(await this.lease.acquire(startedAt))) return { ...report, status: 'locked' };
    const started = this.elapsed();
    let firstError: string | null = null;
    try {
      const pending = await this.prisma.webSourceEstimate.findMany({
        where: {
          requestedAt: { not: null },
          source: { kind: 'elb_logs', cloudAccount: { provider: 'aws', ...COLLECTING_TENANT } },
          ...(this.tenantIds !== undefined && { tenantId: { in: [...this.tenantIds] } }),
        },
        select: ESTIMATE_SELECT,
        orderBy: [{ requestedAt: 'asc' }, { sourceId: 'asc' }],
        take: WEB_ESTIMATES_PER_RUN,
      });
      report.pending = pending.length;
      for (const row of pending) {
        signal.throwIfAborted();
        if (this.elapsed() - started >= WEB_ESTIMATE_RUN_MS) break;
        const result = await this.estimate(row, report, signal);
        if (!(await this.save(row, result))) {
          report.superseded += 1;
          continue;
        }
        if (result.status === 'ready') report.ready += 1;
        else if (result.status === 'no_sample') report.noSample += 1;
        else {
          report.failed += 1;
          report.failures = { ...report.failures, [result.code]: (report.failures?.[result.code] ?? 0) + 1 };
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

  private async estimate(row: Pending, report: WebEstimateReport, signal: AbortSignal): Promise<Result> {
    const { source } = row;
    const { cloudAccount: account } = source;
    const failed = (code: string): Result => ({ status: 'failed', code });
    if (account.status !== 'active' || !entersRole(account)) return failed('account_not_connected');
    if (source.availability !== 'available' || source.missingSince !== null)
      return failed('source_not_available');
    const target = isAwsRegion(source.region)
      ? albTargetOf(account.accountId, source.region, sourceDetails(source.details))
      : 'invalid_details';
    if (typeof target === 'string') return failed(target);
    const home = account.regions.find(isAwsRegion) ?? STS_FALLBACK_REGION;
    let clients: DiscoveryRunClients | null = null;
    try {
      await this.credentials.session(account.accountId, home, signal);
      clients = new DiscoveryRunClients(
        this.clients(this.credentials.credentialsFor(account.accountId, home), home),
        home,
        signal,
      );
      const s3 = clients.s3(target.region);
      return await this.measure(new AlbBucket(s3, s3, target), report, signal);
    } catch (error) {
      if (error instanceof AwsConnectionError) return failed(error.code);
      if (isFatal(error, signal) || !(error instanceof AlbCallError)) throw error;
      const failure = albFailureOf(error);
      return failed(failure.type === 'permission' ? failure.detail : failure.code);
    } finally {
      clients?.destroy();
    }
  }

  private async call<T>(action: AlbAction, send: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await withThrottleRetry(send, {
        ...this.throttle,
        random: this.random,
        sleep: this.sleep,
        signal,
      });
    } catch (error) {
      if (isFatal(error, signal)) throw error;
      throw new AlbCallError(action, error);
    }
  }

  /** Os arquivos de ontem (a pasta do dia da entrega) e a razão de uma amostra deles. */
  private async measure(bucket: AlbBucket, report: WebEstimateReport, signal: AbortSignal): Promise<Result> {
    const day = utcDay(this.now().getTime() - DAY_MS);
    const objects: AlbObject[] = [];
    let after: string | null = null;
    let truncated = true;
    for (let pages = 0; pages < this.maxPages; pages += 1) {
      const from: string | null = after;
      const page: AlbPage = await this.call('s3:ListBucket', () => bucket.list(day, from), signal);
      report.lists += 1;
      objects.push(...page.objects);
      after = page.next;
      if (after === null) {
        truncated = false;
        break;
      }
    }
    if (objects.length === 0) return { status: 'no_sample', day, objects: 0, truncated };
    const limit = concurrencyLimit(SAMPLE_CONCURRENCY);
    const sampled = await Promise.all(
      spread(
        objects.filter(({ size }) => size > 0),
        this.samples,
      ).map((object) => limit(() => this.sample(bucket, object, report, signal))),
    );
    const known = sampled.filter((item) => item !== null);
    const compressed = known.reduce((sum, item) => sum + item.compressed, 0);
    const bytes = known.reduce((sum, item) => sum + item.bytes, 0);
    const total = objects.reduce((sum, object) => sum + object.size, 0);
    // Só arquivos vazios: o volume é zero. Arquivos com conteúdo e nenhum para medir: não dá para dizer.
    if (compressed === 0 && total > 0)
      return { status: 'no_sample', day, objects: objects.length, truncated };
    const bytesPerDay = compressed === 0 ? 0 : Math.round((total / compressed) * bytes);
    return {
      status: 'ready',
      day,
      objects: objects.length,
      sampled: known.length,
      bytesPerDay: Math.min(Number.MAX_SAFE_INTEGER, bytesPerDay),
      truncated,
    };
  }

  /** O tamanho descompactado de um arquivo; null se ele saiu do bucket (ou foi arquivado) no meio. */
  private async sample(
    bucket: AlbBucket,
    object: AlbObject,
    report: WebEstimateReport,
    signal: AbortSignal,
  ): Promise<{ compressed: number; bytes: number } | null> {
    try {
      const tail = await this.call('s3:GetObject', () => bucket.tail(object), signal);
      report.tails += 1;
      return { compressed: object.size, bytes: decompressedSize(object.key, object.size, tail).bytes };
    } catch (error) {
      if (isGone(error) || isArchived(error)) return null;
      throw error;
    }
  }

  /** Grava o resultado, só se o pedido ainda é o mesmo. */
  private async save(row: Pending, result: Result): Promise<boolean> {
    const computed =
      result.status === 'failed'
        ? {
            day: null,
            objects: null,
            sampledObjects: null,
            bytesPerDay: null,
            truncated: false,
            errorCode: result.code,
          }
        : {
            day: new Date(`${result.day}T00:00:00.000Z`),
            objects: result.objects,
            sampledObjects: result.status === 'ready' ? result.sampled : 0,
            bytesPerDay: result.status === 'ready' ? BigInt(result.bytesPerDay) : null,
            truncated: result.truncated,
            errorCode: null,
          };
    const { count } = await this.prisma.forTenant(row.tenantId).webSourceEstimate.updateMany({
      where: { sourceId: row.sourceId, requestedAt: row.requestedAt },
      data: { ...computed, status: result.status, computedAt: this.now(), requestedAt: null },
    });
    return count === 1;
  }
}
