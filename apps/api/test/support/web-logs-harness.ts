import { randomInt } from 'node:crypto';
import type { PrismaService } from '../../src/common/prisma/prisma.service.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { usageDay, usageMonth } from '../../src/usage/usage-meter.js';
import { webLogsStream } from '../../src/weblogs/collect/source-config.js';
import { WebLogsCollector, type WebLogsOptions } from '../../src/weblogs/collect/web-logs-job.js';
import type { CountryLookup } from '../../src/weblogs/traffic.js';
import { clockAt, FakeCredentials } from '../inventory/fake-job.js';
import { LB, REGION, TEST_RANGES } from './alb-lines.js';
import { type Balancer, FakeAlbS3 } from './fake-alb-s3.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const SLOT = 5 * MINUTE;
/** O relógio do começo dos testes: meio-dia e um, com o intervalo das 11:55 ao meio-dia acabado de fechar. */
export const NOON = Date.UTC(2026, 10, 24, 12, 0, 0);
export const START = new Date(NOON + MINUTE);
export const AUTHORIZED = new Date(NOON - 6 * HOUR);
const DAY = 24 * HOUR;

/** Países fictícios pelo primeiro octeto: 192 é BR, 198 é US, 203 é FR; o IPv6 é DE. */
export const COUNTRIES: CountryLookup = {
  size: 5,
  countryOfV4: (word) => ({ 192: 1, 198: 2, 203: 3 })[word >>> 24] ?? 0,
  countryOfWords: () => 4,
  code: (index) => [null, 'BR', 'US', 'FR', 'DE'][index] ?? null,
};

export interface Site {
  tenantId: string;
  accountRow: string;
  sourceId: string;
  name: string;
  balancer: Balancer;
}

export function webLogsHarness(prisma: PrismaService) {
  const newTenant = async (name: string): Promise<string> =>
    (await prisma.tenant.create({ data: { name: `Cliente Demo (${name})` }, select: { id: true } })).id;

  const newAccount = (tenantId: string, data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {}) =>
    prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: [REGION],
        connection: 'connected',
        ingestFrom: new Date(NOON - 10 * DAY),
        ...data,
      },
      select: { id: true, tenantId: true, accountId: true },
    });

  /** Um balanceador descoberto, autorizado há 6 h e aguardando o coletor, com a configuração que a autorização cria. */
  async function newSite(
    name: string,
    options: {
      tenantId?: string;
      account?: { id: string; tenantId: string; accountId: string };
      lb?: string;
      prefix?: string;
      mode?: 'observe' | 'alert';
      authorizedAt?: Date;
      multiplier?: number;
      source?: Partial<Prisma.AwsSourceUncheckedCreateInput>;
    } = {},
  ): Promise<Site> {
    const account = options.account ?? (await newAccount(options.tenantId ?? (await newTenant(name))));
    const lb = options.lb ?? LB;
    const authorizedAt = options.authorizedAt ?? AUTHORIZED;
    const bucket = `logs-${randomInt(1e8, 9e8)}`;
    const root = `${options.prefix === undefined ? '' : `${options.prefix}/`}AWSLogs/${account.accountId}/elasticloadbalancing/${REGION}/`;
    const resourceId = lb.split('/')[1] ?? 'loja';
    const row = await prisma.awsSource.create({
      data: {
        tenantId: account.tenantId,
        cloudAccountId: account.id,
        kind: 'elb_logs',
        region: REGION,
        resourceId,
        name: resourceId,
        details: {
          arn: `arn:aws:elasticloadbalancing:${REGION}:${account.accountId}:loadbalancer/${lb}`,
          destinationType: 's3',
          bucket,
          prefix: root,
          internetFacing: true,
          ...(options.prefix !== undefined && { customPrefix: options.prefix }),
        },
        method: 's3',
        availability: 'available',
        loggingState: 'logging',
        permission: 'unknown',
        origin: 'discovered',
        authorizedAt,
        authorizedBy: 'usuario-de-teste',
        collectFrom: new Date(authorizedAt.toISOString().slice(0, 10)),
        state: 'authorized',
        stateCode: 'awaiting_collector',
        ...options.source,
      },
      select: { id: true },
    });
    await prisma.webSourceSettings.create({
      data: {
        sourceId: row.id,
        tenantId: account.tenantId,
        mode: options.mode ?? 'alert',
        observeUntil: new Date(authorizedAt.getTime() + 72 * HOUR),
        thresholdMultiplier: options.multiplier ?? 1,
      },
    });
    return {
      tenantId: account.tenantId,
      accountRow: account.id,
      sourceId: row.id,
      name: resourceId,
      balancer: {
        bucket,
        account: account.accountId,
        region: REGION,
        lb,
        ...(options.prefix !== undefined && { prefix: options.prefix }),
      },
    };
  }

  /** A tarefa de um processo: o S3 falso, o relógio e a concessão própria de cada teste. */
  function newTask(
    tenantIds: string[],
    options: WebLogsOptions & { s3?: FakeAlbS3; clock?: ReturnType<typeof clockAt>; lease?: string } = {},
  ) {
    const {
      s3 = new FakeAlbS3(),
      clock = clockAt(START),
      lease = `web-${randomInt(1e8, 9e8)}`,
      ...rest
    } = options;
    const credentials = new FakeCredentials();
    const task = new WebLogsCollector(prisma, credentials, s3.factory, {
      name: lease,
      now: clock.now,
      random: () => 0.5,
      sleep: () => Promise.resolve(),
      countries: COUNTRIES,
      ranges: TEST_RANGES,
      tenantIds,
      ...rest,
    });
    return { task, s3, clock, credentials, lease };
  }

  const sourceRow = (site: Site) => prisma.awsSource.findUniqueOrThrow({ where: { id: site.sourceId } });
  const ledger = (site: Site) =>
    prisma.webLogObject.findMany({
      where: { sourceId: site.sourceId },
      orderBy: [{ slotStart: 'asc' }, { objectHash: 'asc' }],
    });
  const findings = (site: Site) =>
    prisma.finding.findMany({
      where: { tenantId: site.tenantId },
      orderBy: [{ ruleId: 'asc' }, { ruleLevel: 'asc' }, { sourceEventId: 'asc' }],
    });
  const usage = async (site: Site, at = START) => {
    const [month, day] = await Promise.all([
      prisma.ingestUsage.findUnique({
        where: {
          tenantId_month_source: { tenantId: site.tenantId, month: usageMonth(at), source: 'aws' },
        },
      }),
      prisma.ingestUsageDay.findUnique({
        where: { tenantId_day_source: { tenantId: site.tenantId, day: usageDay(at), source: 'aws' } },
      }),
    ]);
    const numbers = (row: { bytes: bigint; events: bigint } | null) =>
      row === null ? null : { bytes: Number(row.bytes), events: Number(row.events) };
    return { month: numbers(month), day: numbers(day) };
  };
  const traffic = async (site: Site) =>
    (
      await prisma.webTrafficSlot.findMany({
        where: { sourceId: site.sourceId },
        orderBy: [{ slotStart: 'asc' }, { country: 'asc' }, { clientClass: 'asc' }],
      })
    ).map((row) => ({
      slot: (row.slotStart.getTime() - NOON) / SLOT,
      country: row.country,
      cls: row.clientClass,
      requests: Number(row.requests),
      blocked: Number(row.blocked),
      clientErrors: Number(row.clientErrors),
      serverErrors: Number(row.serverErrors),
      flagged: Number(row.flagged),
    }));
  const requests = async (site: Site): Promise<number> =>
    (await traffic(site)).reduce((sum, row) => sum + row.requests, 0);
  const cursor = (site: Site) =>
    prisma.collectorCursor.findUniqueOrThrow({
      where: {
        cloudAccountId_stream_region: {
          cloudAccountId: site.accountRow,
          stream: webLogsStream(site.name),
          region: REGION,
        },
      },
    });
  /** Até onde o balanceador já foi lido (um slot atrás do meio-dia é -1). */
  const setCursor = (site: Site, at: Date) =>
    prisma.collectorCursor.create({
      data: {
        cloudAccountId: site.accountRow,
        stream: webLogsStream(site.name),
        region: REGION,
        cursorAt: at,
        nextRunAt: new Date(0),
      },
    });
  const state = (site: Site) =>
    prisma.webEngineState.findFirst({ where: { sourceId: site.sourceId } }) as Promise<{
      loadBalancer: string;
      version: number;
      state: {
        digest: { settledThrough: number | null; days: unknown[]; tracks: unknown[] } | null;
        observation: {
          since: string;
          rules: { ruleId: string; level: number; findings: number }[];
          truncated: boolean;
          keys: string[];
        };
        suppressed: { trustedId: string; ruleId: string; clients: number }[];
        notes: string[];
      };
    } | null>;
  const audit = (site: Site, action = 'cloud_account.aws_source_collection') =>
    prisma.auditLog.findMany({
      where: { action, resourceId: site.accountRow, tenantId: site.tenantId },
      orderBy: { occurredAt: 'asc' },
    });

  return {
    newTenant,
    newAccount,
    newSite,
    newTask,
    sourceRow,
    ledger,
    findings,
    usage,
    traffic,
    requests,
    cursor,
    setCursor,
    state,
    audit,
  };
}
