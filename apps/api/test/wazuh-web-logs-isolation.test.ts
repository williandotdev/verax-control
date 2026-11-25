import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AWS_SOURCE_ACTIVE_STATES } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WazuhConfig } from '../src/aws/wazuh-config.js';
import type { WazuhStallProbe } from '../src/aws/wazuh-source-health.js';
import {
  findWazuhSourceRows,
  serializeWazuhSources,
  toWazuhSources,
  wazuhSourcesGeneration,
} from '../src/aws/wazuh-sources.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 60 * 60 * 1000;
const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const today = () => new Date(new Date().toISOString().slice(0, 10));

/**
 * Com banco de verdade: balanceadores autorizados, em várias contas, regiões e estados, não mudam a lista do manager, e a
 * tarefa `wazuh-config` (a saúde, a conferência de fonte parada e o aviso das contas) nunca toca nas linhas deles.
 */
describe('balanceadores autorizados e o Wazuh do nó', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const dirs: string[] = [];

  const account = (tenantId: string, data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {}) =>
    prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: ['sa-east-1', 'us-east-1'],
        connection: 'connected',
        ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: new Date(),
        ...data,
      },
      select: { id: true, tenantId: true, accountId: true },
    });
  type Cloud = Awaited<ReturnType<typeof account>>;
  function source(cloud: Cloud, data: Partial<Prisma.AwsSourceUncheckedCreateInput>) {
    const now = new Date();
    return prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind: 'cloudtrail',
        region: 'sa-east-1',
        resourceId: `recurso-${randomInt(1e6, 9e6)}`,
        name: 'fonte',
        details: {},
        method: 's3',
        availability: 'available',
        permission: 'granted',
        authorizedAt: now,
        authorizedBy: 'usuario-de-teste',
        collectFrom: today(),
        state: 'authorized',
        stateCode: 'awaiting_collector',
        stateSince: now,
        ...data,
      },
    });
  }
  /** O que o coletor do worker (PR-4) terá gravado. */
  const balancer = (cloud: Cloud, bucket: string, data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {}) =>
    source(cloud, {
      kind: 'elb_logs',
      details: {
        arn: `arn:aws:elasticloadbalancing:sa-east-1:${cloud.accountId}:loadbalancer/app/loja/0123456789abcdef`,
        destinationType: 's3',
        bucket,
        prefix: `AWSLogs/${cloud.accountId}/elasticloadbalancing/sa-east-1/`,
        internetFacing: true,
      },
      notes: ['high_volume'],
      lastSyncAt: new Date(Date.now() - 5 * HOUR),
      lastEventAt: new Date(Date.now() - 5 * HOUR),
      lastIngestedAt: new Date(Date.now() - 5 * HOUR),
      lagSeconds: 420,
      ...data,
    });
  const lineOf = async (tenantIds: string[]) =>
    serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(prisma, tenantIds)));

  beforeAll(async () => {
    app = await createApp({ awsWebLogs: true });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    await app.close();
  });

  it('a lista e a geração não mudam, a conta que só tem balanceador não entra, e nenhuma linha deles é escrita', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (Wazuh e ALB)');
    const tenantB = await createTenant(app, 'Cliente Demo B (Wazuh e ALB)');
    const tenants = [tenantA, tenantB];
    const bucket = `trilha-${randomInt(1e6, 9e6)}`;
    const first = await account(tenantA);
    const second = await account(tenantB);
    const only = await account(tenantA);
    const trail = await source(first, { details: { bucket }, name: 'trilha' });
    await source(first, {
      kind: 'vpc_flow_logs',
      resourceId: 'fl-0123456789abcdef0',
      region: 'us-east-1',
      details: { bucket: 'fluxo-da-conta', flowLogId: 'fl-0123456789abcdef0' },
    });
    await source(second, {
      kind: 'waf',
      region: 'us-east-1',
      details: { bucket: 'aws-waf-logs-painel', webAclName: 'painel', webAclScope: 'REGIONAL' },
    });
    const before = await lineOf(tenants);
    expect(before).toContain(bucket);

    const ids: string[] = [];
    for (const cloud of [first, second, only]) {
      for (const [i, state] of [...AWS_SOURCE_ACTIVE_STATES, 'source_missing' as const].entries()) {
        const row = await balancer(cloud, bucket, {
          state,
          stateCode: state === 'ingestion_error' ? 'web_gap' : null,
          region: i % 2 === 0 ? 'sa-east-1' : 'us-east-1',
          resourceId: `alb-${i}`,
        });
        ids.push(row.id);
      }
    }
    expect(await lineOf(tenants)).toBe(before);
    const rows = await findWazuhSourceRows(prisma, tenants);
    expect(rows.map((row) => row.id)).not.toContain(only.id);
    expect(rows.flatMap((row) => row.awsSources).map((row) => row.kind)).not.toContain('elb_logs');

    const snapshot = () => prisma.awsSource.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
    const untouched = await snapshot();
    const dir = await mkdtemp(join(tmpdir(), 'verax-wazuh-alb-'));
    dirs.push(dir);
    const asked: string[] = [];
    const stallProbe: WazuhStallProbe = {
      hasUnreadObjects: (question) => {
        asked.push(question.cloudAccountId);
        return Promise.resolve(true);
      },
    };
    const task = new WazuhConfig(prisma, dir, {
      tenantIds: tenants,
      stallProbe,
      cloudWatchOwnershipKey: `teste-alb-${randomInt(1e6, 9e6)}`,
    });
    const token = (at: Date) =>
      writeFile(join(dir, 'aws-token'), `${JSON.stringify({ tokenAt: iso(at) })}\n`);
    const applied = (status: 'ok' | 'error') =>
      writeFile(
        join(dir, 'applied'),
        `${JSON.stringify({ generation: wazuhSourcesGeneration(before), status, at: iso(new Date()) })}\n`,
      );
    const progress = () =>
      writeFile(
        join(dir, 'progress'),
        `${JSON.stringify({
          version: 1,
          at: iso(new Date()),
          s3: {
            status: 'ok',
            truncated: false,
            entries: [
              {
                table: 'cloudtrail',
                bucketPath: `${bucket}/`,
                accountId: first.accountId,
                region: 'sa-east-1',
                flowLogId: null,
                lastKey: `AWSLogs/${first.accountId}/CloudTrail/sa-east-1/2026/11/24/a.json.gz`,
                createdDate: 20261124,
                keys: 1,
                processedAt: iso(new Date()),
              },
            ],
          },
          cloudwatch: { status: 'ok', truncated: false, entries: [] },
        })}\n`,
      );

    // Todos os caminhos da tarefa: lista ainda não aplicada, aplicação com erro, aplicada com progresso, token parado.
    await token(new Date());
    const reports = [await task.runOnce()];
    await applied('error');
    reports.push(await task.runOnce());
    await applied('ok');
    await progress();
    reports.push(await task.runOnce(), await task.runOnce());
    await token(new Date(Date.now() - 2 * HOUR));
    reports.push(await task.runOnce());
    expect(reports.map((report) => report.state)).toEqual([
      'pending',
      'wazuh_apply_failed',
      'ok',
      'ok',
      'aws_token_stale',
    ]);
    // Só as três fontes do Wazuh existem para ela, e só as duas contas que o manager lê.
    expect(reports.map((report) => [report.accounts, report.sources?.sources])).toEqual(
      reports.map(() => [2, 3]),
    );
    expect((await readFile(join(dir, 'generation'), 'utf8')).trim()).toBe(wazuhSourcesGeneration(before));
    // A fonte do Wazuh andou; as dos balanceadores são, coluna a coluna, as de antes (o `updatedAt` também).
    expect((await prisma.awsSource.findUniqueOrThrow({ where: { id: trail.id } })).stateCode).toBe(
      'aws_token_stale',
    );
    expect(await snapshot()).toEqual(untouched);
    expect(asked).not.toContain(only.id);
    // O aviso do nó é das contas que o manager lê: a que só tem balanceador não ganha um.
    expect(
      (await prisma.cloudAccount.findUniqueOrThrow({ where: { id: only.id } })).collectionError,
    ).toBeNull();
    const audited = await prisma.auditLog.findMany({
      where: { tenantId: { in: tenants }, action: 'cloud_account.aws_source_collection' },
      select: { after: true },
    });
    expect(audited.length).toBeGreaterThan(0);
    for (const { after } of audited) expect(after).not.toMatchObject({ kind: 'elb_logs' });
  });
});
