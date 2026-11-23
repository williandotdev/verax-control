import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { awsOnboardingSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncLegacyAwsSources } from '../src/aws/onboarding/legacy-sources.js';
import { WazuhConfig } from '../src/aws/wazuh-config.js';
import { WAZUH_PROGRESS_MAX_BYTES } from '../src/aws/wazuh-progress.js';
import type { StallQuestion, WazuhStallProbe } from '../src/aws/wazuh-source-health.js';
import {
  findWazuhSourceRows,
  serializeWazuhSources,
  toWazuhSources,
  wazuhSourcesGeneration,
} from '../src/aws/wazuh-sources.js';
import { wazuhSourcesLine } from '../src/cli/wazuh-sources.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const bucket = (prefix = 'trilha') => `${prefix}-${randomInt(1_000_000, 9_999_999)}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const ago = (ms: number) => new Date(Math.floor((Date.now() - ms) / 1000) * 1000);
/** O dia de hoje (UTC), o início da coleta de uma fonte autorizada agora. */
const today = () => new Date(new Date().toISOString().slice(0, 10));

interface Cloud {
  id: string;
  tenantId: string;
  accountId: string;
}

/** A chave de um objeto do CloudTrail gravado em `at` (ao minuto, como a AWS o nomeia). */
function trailKey(account: string, at: Date, region = 'sa-east-1'): string {
  const stamp = `${at.toISOString().slice(0, 16).replace(/[-:]/g, '')}Z`;
  const day = `${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp.slice(6, 8)}`;
  return `AWSLogs/${account}/CloudTrail/${region}/${day}/${account}_CloudTrail_${region}_${stamp}_a.json.gz`;
}

describe('saúde das fontes da AWS lidas pelo Wazuh: a tarefa wazuh-config com o sinal progress', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const dirs: string[] = [];

  /** Uma conta AWS já verificada e conectada. */
  function account(
    tenantId: string,
    data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {},
  ): Promise<Cloud> {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountId(),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
        awsTemplateVersion: 2,
        awsCapabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
        awsCapabilitiesCheckedAt: new Date(),
        ...data,
      },
      select: { id: true, tenantId: true, accountId: true },
    });
  }

  /** Uma fonte descoberta que o cliente acabou de autorizar (o que a rota de autorização grava). */
  function source(cloud: Cloud, data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {}) {
    const now = new Date();
    return prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind: 'cloudtrail',
        region: 'sa-east-1',
        resourceId: `recurso-${randomInt(1e6, 9e6)}`,
        name: 'trilha',
        details: { bucket: bucket() },
        method: 's3',
        availability: 'available',
        permission: 'granted',
        permissionCheckedAt: now,
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
  const logGroup = (cloud: Cloud, name: string, data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {}) =>
    source(cloud, {
      kind: 'cloudwatch_log_group',
      method: 'cloudwatch',
      resourceId: name,
      name,
      details: { logGroup: name, tagged: true },
      sensitive: true,
      ...data,
    });

  const row = (id: string) =>
    prisma.awsSource.findUniqueOrThrow({
      where: { id },
      select: {
        state: true,
        stateCode: true,
        lastSyncAt: true,
        lastEventAt: true,
        lastIngestedAt: true,
        lagSeconds: true,
        revokedAt: true,
      },
    });
  const stateOf = async (id: string) => {
    const { state, stateCode } = await row(id);
    return [state, stateCode];
  };
  const auditOf = (cloudAccountId: string) =>
    prisma.auditLog.findMany({
      where: { resourceId: cloudAccountId, action: 'cloud_account.aws_source_collection' },
      orderBy: { occurredAt: 'asc' },
      select: { tenantId: true, actorType: true, before: true, after: true },
    });
  const transitions = async (cloudAccountId: string) =>
    (await auditOf(cloudAccountId)).map((entry) => {
      const before = entry.before as { state: string; stateCode: string | null };
      const after = entry.after as { state: string; stateCode: string | null };
      return `${before.state} > ${after.state}${after.stateCode === null ? '' : `/${after.stateCode}`}`;
    });

  /** A pasta de sinais de um caso (no nó, /run/verax/wazuh-signal montada no worker). */
  async function signalDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'verax-wazuh-health-'));
    dirs.push(dir);
    return dir;
  }
  const generationOf = async (tenantIds: string[]) =>
    wazuhSourcesGeneration(
      serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(prisma, tenantIds))),
    );
  /** O host aplicou a lista de agora (ou falhou ao aplicar). */
  const applied = async (dir: string, tenantIds: string[], status: 'ok' | 'error' = 'ok') =>
    writeFile(
      join(dir, 'applied'),
      `${JSON.stringify({ generation: await generationOf(tenantIds), status, at: iso(new Date()) })}\n`,
    );
  const tokenAt = (dir: string, at: Date) =>
    writeFile(join(dir, 'aws-token'), `${JSON.stringify({ tokenAt: iso(at) })}\n`);

  interface Marker {
    table?: string;
    bucketPath: string;
    accountId: string;
    region?: string | null;
    flowLogId?: string | null;
    lastKey: string;
    processedAt: Date;
  }
  /** O sinal `progress` como o host o grava (o que o exportador tirou dos bancos do módulo). */
  const progress = (
    dir: string,
    markers: Marker[] = [],
    groups: { logGroup: string; endTime: Date | null; region?: string }[] = [],
    at: Date = new Date(),
  ) =>
    writeFile(
      join(dir, 'progress'),
      `${JSON.stringify({
        version: 1,
        at: iso(at),
        s3: {
          status: 'ok',
          truncated: false,
          entries: markers.map((marker) => ({
            table: 'cloudtrail',
            region: 'sa-east-1',
            flowLogId: null,
            createdDate: Number(marker.processedAt.toISOString().slice(0, 10).replace(/-/g, '')),
            keys: 1,
            ...marker,
            processedAt: iso(marker.processedAt),
          })),
        },
        cloudwatch: {
          status: 'ok',
          truncated: false,
          entries: groups.map((group) => ({
            region: group.region ?? 'sa-east-1',
            logGroup: group.logGroup,
            endTime: group.endTime?.getTime() ?? null,
            streams: 1,
          })),
        },
      })}\n`,
    );

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await app.close();
  });

  it('da autorização à coleta: configurando, aguardando eventos e coletando, com a trilha só no que importa', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (saúde das fontes)');
    const cloud = await account(tenant);
    const trailBucket = bucket();
    const trail = await source(cloud, { details: { bucket: trailBucket } });
    const group = await logGroup(cloud, '/aws/lambda/cobranca');
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });
    await tokenAt(dir, new Date());

    // A lista de agora ainda não foi aplicada pelo host.
    expect(await task.runOnce()).toMatchObject({
      accounts: 1,
      generation: 'written',
      state: 'pending',
      sources: { sources: 2, transitions: 2, refreshed: 0 },
    });
    expect(await stateOf(trail.id)).toEqual(['configuring', 'awaiting_apply']);
    expect(await stateOf(group.id)).toEqual(['configuring', 'awaiting_apply']);

    // Aplicada, e o módulo ainda não leu nada.
    await applied(dir, [tenant]);
    await progress(dir);
    expect(await task.runOnce()).toMatchObject({ state: 'ok', sources: { transitions: 2 } });
    expect(await row(trail.id)).toMatchObject({
      state: 'waiting_events',
      stateCode: null,
      lastIngestedAt: null,
    });
    expect((await row(trail.id)).lastSyncAt).not.toBeNull();
    // A espera não vai para a trilha de auditoria.
    expect(await auditOf(cloud.id)).toEqual([]);

    // O módulo leu um objeto da trilha e um evento do grupo.
    const readAt = ago(2 * MINUTE);
    const eventAt = ago(7 * MINUTE);
    const key = trailKey(cloud.accountId, eventAt);
    const groupEvent = ago(3 * MINUTE);
    const exportedAt = ago(MINUTE);
    await progress(
      dir,
      [{ bucketPath: `${trailBucket}/`, accountId: cloud.accountId, lastKey: key, processedAt: readAt }],
      [{ logGroup: '/aws/lambda/cobranca', endTime: groupEvent }],
      exportedAt,
    );
    expect(await task.runOnce()).toMatchObject({ sources: { transitions: 2 } });
    const minute = new Date(Math.floor(eventAt.getTime() / MINUTE) * MINUTE);
    expect(await row(trail.id)).toEqual({
      state: 'collecting',
      stateCode: null,
      lastSyncAt: exportedAt,
      lastIngestedAt: readAt,
      // O horário do nome do objeto, ao minuto.
      lastEventAt: minute,
      lagSeconds: Math.round((readAt.getTime() - minute.getTime()) / 1000),
      revokedAt: null,
    });
    expect(await row(group.id)).toEqual({
      state: 'collecting',
      stateCode: null,
      lastSyncAt: exportedAt,
      lastEventAt: groupEvent,
      // O módulo não guarda quando leu o grupo: vale a hora em que o nó viu o marcador.
      lastIngestedAt: exportedAt,
      lagSeconds: Math.round((exportedAt.getTime() - groupEvent.getTime()) / 1000),
      revokedAt: null,
    });
    // A primeira coleta de cada fonte, na trilha do cliente, pelo sistema.
    expect(await auditOf(cloud.id)).toEqual(
      [trail, group].map((item) => ({
        tenantId: tenant,
        actorType: 'system',
        before: {
          sourceId: item.id,
          kind: item.kind,
          region: 'sa-east-1',
          state: 'waiting_events',
          stateCode: null,
        },
        after: {
          sourceId: item.id,
          kind: item.kind,
          region: 'sa-east-1',
          state: 'collecting',
          stateCode: null,
        },
      })),
    );

    // A mesma execução de novo: nada gravado, nada auditado.
    expect(await task.runOnce()).toMatchObject({ sources: { transitions: 0, refreshed: 0 } });
    // Outro retrato do host com o mesmo marcador: só a última confirmação anda, numa gravação só, sem auditoria.
    const later = new Date();
    await progress(
      dir,
      [{ bucketPath: `${trailBucket}/`, accountId: cloud.accountId, lastKey: key, processedAt: readAt }],
      [{ logGroup: '/aws/lambda/cobranca', endTime: groupEvent }],
      later,
    );
    expect(await task.runOnce()).toMatchObject({ sources: { transitions: 0, refreshed: 2 } });
    expect(await row(trail.id)).toMatchObject({ lastSyncAt: new Date(iso(later)), lastIngestedAt: readAt });
    expect(await row(group.id)).toMatchObject({
      lastSyncAt: new Date(iso(later)),
      lastIngestedAt: exportedAt,
    });
    expect(await auditOf(cloud.id)).toHaveLength(2);
  });

  it('as fontes de achados lidas por API não entram na lista nem são tocadas: a saúde delas é da tarefa aws-findings', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (fontes de API)');
    const cloud = await account(tenant);
    const trailBucket = bucket();
    const trail = await source(cloud, { details: { bucket: trailBucket } });
    // Fontes de achados da mesma conta, nos estados que a tarefa `aws-findings` grava (os motivos são dela).
    const synced = ago(3 * MINUTE);
    const findings = await Promise.all(
      [
        { kind: 'guardduty', state: 'collecting', stateCode: 'no_findings_yet', lastSyncAt: synced },
        { kind: 'security_hub', state: 'authorized', stateCode: 'awaiting_collector' },
        { kind: 'inspector', state: 'ingestion_error', stateCode: 'throttled', lastSyncAt: synced },
        { kind: 'access_analyzer', state: 'permission_error', stateCode: 'access-analyzer:ListFindingsV2' },
      ].map((data) => source(cloud, { method: 'api', details: {}, name: data.kind, ...data })),
    );
    const snapshot = () =>
      prisma.awsSource.findMany({
        where: { id: { in: findings.map((item) => item.id) } },
        orderBy: { id: 'asc' },
      });
    const before = await snapshot();
    expect(before).toHaveLength(4);

    // A lista do manager só tem a trilha.
    const list = toWazuhSources(await findWazuhSourceRows(prisma, [tenant]));
    expect(list.accounts).toMatchObject([
      { accountId: cloud.accountId, s3: [{ type: 'cloudtrail', bucket: trailBucket }], logGroups: [] },
    ]);

    const dir = await signalDir();
    let now = new Date();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant], now: () => now });
    const marker = {
      bucketPath: `${trailBucket}/`,
      accountId: cloud.accountId,
      lastKey: trailKey(cloud.accountId, ago(8 * MINUTE)),
      processedAt: ago(4 * MINUTE),
    };
    await tokenAt(dir, now);
    await applied(dir, [tenant]);
    await progress(dir, [marker]);
    expect(await task.runOnce()).toMatchObject({ state: 'ok', sources: { sources: 1, transitions: 1 } });
    expect(await stateOf(trail.id)).toEqual(['collecting', null]);
    // O token do nó parado derruba só o que o Wazuh lê.
    now = new Date(Date.now() + 41 * MINUTE);
    await progress(dir, [marker], [], now);
    expect(await task.runOnce()).toMatchObject({ state: 'aws_token_stale', sources: { sources: 1 } });
    expect(await stateOf(trail.id)).toEqual(['ingestion_error', 'aws_token_stale']);

    // As de API ficam como estavam, campo a campo (o `updatedAt` inclusive), e nada delas entra na trilha do cliente.
    expect(await snapshot()).toEqual(before);
    const audited = (await auditOf(cloud.id)).map((entry) => (entry.after as { sourceId: string }).sourceId);
    expect([...new Set(audited)]).toEqual([trail.id]);
  });

  it('os buckets do cadastro anterior: a mesma lista de sempre, e a saúde pelo marcador que já existia', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (cadastro anterior)');
    const buckets = {
      cloudtrailBucket: bucket(),
      guarddutyBucket: bucket('achados'),
      wafBucket: `aws-waf-logs-${bucket()}`,
    };
    const cloud = await account(tenant, { ...buckets, regions: ['sa-east-1', 'us-east-1'] });
    await syncLegacyAwsSources(prisma.forTenant(tenant), cloud.id);

    // A lista é a do cadastro, sem nada do cliente: só o tipo, o bucket, a data e a marca.
    const line = serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(prisma, [tenant])));
    const entry = (type: string, name: string) => ({
      type,
      bucket: name,
      onlyLogsAfter: '2026-NOV-01',
      legacy: true,
    });
    expect(JSON.parse(line)).toEqual({
      version: 2,
      accounts: [
        {
          accountId: cloud.accountId,
          region: 'sa-east-1',
          s3: [
            entry('cloudtrail', buckets.cloudtrailBucket),
            entry('guardduty', buckets.guarddutyBucket),
            entry('waf', buckets.wafBucket),
          ],
          logGroups: [],
        },
      ],
    });
    expect(await wazuhSourcesLine(prisma)).toContain(line.slice('{"version":2,"accounts":['.length, -2));

    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });
    await tokenAt(dir, new Date());
    await applied(dir, [tenant]);
    // O módulo já lia a trilha (em outra região) e o GuardDuty (a pasta de outra conta, no bucket lido inteiro).
    const readAt = ago(5 * MINUTE);
    await progress(dir, [
      {
        bucketPath: `${buckets.cloudtrailBucket}/`,
        accountId: cloud.accountId,
        region: 'us-east-1',
        lastKey: trailKey(cloud.accountId, ago(9 * MINUTE), 'us-east-1'),
        processedAt: readAt,
      },
      {
        table: 'guardduty',
        bucketPath: `${buckets.guarddutyBucket}/`,
        accountId: '999999999999',
        region: null,
        lastKey: `AWSLogs/999999999999/GuardDuty/sa-east-1/${new Date().toISOString().slice(0, 10).replace(/-/g, '/')}/achado.jsonl.gz`,
        processedAt: readAt,
      },
    ]);
    await task.runOnce();
    const sources = await prisma.awsSource.findMany({
      where: { cloudAccountId: cloud.id },
      select: { kind: true, state: true, lastIngestedAt: true },
      orderBy: { kind: 'asc' },
    });
    expect(sources).toEqual([
      { kind: 'cloudtrail', state: 'collecting', lastIngestedAt: readAt },
      { kind: 'guardduty_export', state: 'collecting', lastIngestedAt: readAt },
      // O WAF sem requisição bloqueada: aplicado, aguardando eventos.
      { kind: 'waf', state: 'waiting_events', lastIngestedAt: null },
    ]);
  });

  it('os avisos do nó: o token parado derruba todas; a lista que não subiu, só a fonte que ainda não tinha entrado', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (avisos do nó)');
    const cloud = await account(tenant);
    const trailBucket = bucket();
    const trail = await source(cloud, { details: { bucket: trailBucket } });
    const dir = await signalDir();
    let now = new Date();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant], now: () => now });
    const marker = () => ({
      bucketPath: `${trailBucket}/`,
      accountId: cloud.accountId,
      lastKey: trailKey(cloud.accountId, ago(8 * MINUTE)),
      processedAt: ago(4 * MINUTE),
    });
    await tokenAt(dir, now);
    await applied(dir, [tenant]);
    await progress(dir, [marker()]);
    await task.runOnce();
    expect(await stateOf(trail.id)).toEqual(['collecting', null]);

    // Uma fonte nova muda a lista, e o host não consegue aplicá-la: o manager segue com a anterior, que tem a trilha.
    const flow = await source(cloud, {
      kind: 'vpc_flow_logs',
      resourceId: 'fl-0123456789abcdef0',
      details: { bucket: bucket('fluxo'), flowLogId: 'fl-0123456789abcdef0' },
    });
    await applied(dir, [tenant], 'error');
    expect(await task.runOnce()).toMatchObject({ state: 'wazuh_apply_failed' });
    expect(await stateOf(trail.id)).toEqual(['collecting', null]);
    expect(await stateOf(flow.id)).toEqual(['ingestion_error', 'wazuh_apply_failed']);

    // O token do Google do host para: nada é lido, de fonte nenhuma.
    now = new Date(Date.now() + 41 * MINUTE);
    await progress(dir, [marker()], [], now);
    expect(await task.runOnce()).toMatchObject({ state: 'aws_token_stale' });
    expect(await stateOf(trail.id)).toEqual(['ingestion_error', 'aws_token_stale']);
    expect(await stateOf(flow.id)).toEqual(['ingestion_error', 'aws_token_stale']);

    // O token volta e a lista é aplicada: a trilha volta a coletar, e os flow logs esperam os eventos.
    await tokenAt(dir, now);
    await applied(dir, [tenant]);
    expect(await task.runOnce()).toMatchObject({ state: 'ok' });
    expect(await stateOf(trail.id)).toEqual(['collecting', null]);
    expect(await stateOf(flow.id)).toEqual(['waiting_events', null]);
    // Na trilha: a primeira coleta, cada entrada num erro e cada saída dele.
    expect(await transitions(cloud.id)).toEqual([
      'authorized > collecting',
      'authorized > ingestion_error/wazuh_apply_failed',
      'collecting > ingestion_error/aws_token_stale',
      'ingestion_error > ingestion_error/aws_token_stale',
      'ingestion_error > collecting',
      'ingestion_error > waiting_events',
    ]);
  });

  it('isolamento A/B: cada fonte na trilha do próprio cliente, e o grupo repetido de outro cliente fica de fora da lista', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (isolamento da saúde)');
    const tenantB = await createTenant(app, 'Cliente Demo B (isolamento da saúde)');
    const cloudA = await account(tenantA);
    const cloudB = await account(tenantB);
    const name = `/aws/lambda/cobranca-${randomInt(1e6, 9e6)}`;
    const first = await logGroup(cloudA, name, { authorizedAt: ago(2 * HOUR) });
    // O mesmo nome, na mesma região, autorizado depois: o marcador do módulo não separa as contas.
    const second = await logGroup(cloudB, name);
    const odd = await logGroup(cloudB, `/aws/lambda/fila#${randomInt(1e6, 9e6)}`);
    const trailB = await source(cloudB);
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenantA, tenantB] });
    await tokenAt(dir, new Date());
    await applied(dir, [tenantA, tenantB]);
    await progress(dir, [], [{ logGroup: name, endTime: ago(2 * MINUTE) }]);
    await task.runOnce();

    expect(await stateOf(first.id)).toEqual(['collecting', null]);
    expect(await stateOf(second.id)).toEqual(['ingestion_error', 'log_group_name_conflict']);
    expect(await stateOf(odd.id)).toEqual(['ingestion_error', 'unsupported_name']);
    expect(await stateOf(trailB.id)).toEqual(['waiting_events', null]);
    // A lista: o grupo só na conta de A; nem o repetido nem o de nome recusado chegam ao gerador.
    const list = toWazuhSources(await findWazuhSourceRows(prisma, [tenantA, tenantB]));
    const groups = (id: string) =>
      list.accounts.find((item) => item.accountId === id)?.logGroups.flatMap((item) => item.names);
    expect(groups(cloudA.accountId)).toEqual([name]);
    expect(groups(cloudB.accountId)).toEqual([]);
    expect(serializeWazuhSources(list)).not.toContain('#');

    // Cada mudança na trilha do cliente da fonte, e nada de B na trilha de A (nem o contrário).
    expect((await auditOf(cloudA.id)).map((entry) => entry.tenantId)).toEqual([tenantA]);
    expect((await auditOf(cloudB.id)).map((entry) => entry.tenantId)).toEqual([tenantB, tenantB]);
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA, resourceId: cloudB.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { tenantId: tenantB, resourceId: cloudA.id } })).toBe(0);

    // A execução restrita a A não toca nas fontes de B.
    const before = await prisma.awsSource.findMany({ where: { tenantId: tenantB }, orderBy: { id: 'asc' } });
    const onlyA = new WazuhConfig(prisma, await signalDir(), { tenantIds: [tenantA] });
    await onlyA.runOnce();
    expect(await prisma.awsSource.findMany({ where: { tenantId: tenantB }, orderBy: { id: 'asc' } })).toEqual(
      before,
    );
  });

  it('revogada, a fonte sai da lista e a coleta não mexe mais nela; a que a descoberta tirou também', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (revogação)');
    const cloud = await account(tenant);
    const kept = await source(cloud, { details: { bucket: bucket('fica') } });
    const revoked = await source(cloud, { details: { bucket: bucket('sai') } });
    const denied = await logGroup(cloud, '/aws/lambda/sem-tag');
    const gone = await logGroup(cloud, '/aws/lambda/apagado');
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });
    await tokenAt(dir, new Date());
    await applied(dir, [tenant]);
    await progress(dir);
    await task.runOnce();
    const before = await generationOf([tenant]);
    const listed = async () =>
      serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(prisma, [tenant])));
    expect(await listed()).toMatch(/sai-\d+/);
    expect(await listed()).toContain('/aws/lambda/sem-tag');

    // O cliente tira a autorização (o que a rota grava), e a descoberta acha um grupo sem a tag e outro apagado.
    const at = new Date();
    await prisma.awsSource.update({
      where: { id: revoked.id },
      data: { revokedAt: at, state: 'revoked', stateCode: null, stateSince: at },
    });
    await prisma.awsSource.update({
      where: { id: denied.id },
      data: { permission: 'missing', state: 'permission_error', stateCode: 'tag_missing' },
    });
    await prisma.awsSource.update({
      where: { id: gone.id },
      data: { state: 'source_missing', stateCode: 'not_found', missingSince: at },
    });
    const snapshot = await prisma.awsSource.findMany({
      where: { id: { in: [revoked.id, denied.id, gone.id] } },
      orderBy: { id: 'asc' },
    });

    expect(await task.runOnce()).toMatchObject({ generation: 'written', sources: { sources: 1 } });
    // A lista nova só tem a fonte que ficou: o gerador não recebe mais nada das outras três.
    expect(await generationOf([tenant])).not.toBe(before);
    const line = await listed();
    expect(line).toMatch(/fica-\d+/);
    expect(line).not.toMatch(/sai-\d+|sem-tag|apagado/);
    // Nada é apagado: as linhas ficam, com o estado que a revogação e a descoberta gravaram, e sem auditoria da coleta.
    expect(
      await prisma.awsSource.findMany({
        where: { id: { in: [revoked.id, denied.id, gone.id] } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(snapshot);
    // A que ficou já estava no manager: segue aguardando os eventos enquanto o host aplica a lista nova.
    expect(await stateOf(kept.id)).toEqual(['waiting_events', null]);
    expect(await auditOf(cloud.id)).toEqual([]);

    // A permissão volta (a descoberta devolve a fonte a "autorizada"): ela entra de novo na lista.
    await prisma.awsSource.update({
      where: { id: denied.id },
      data: { permission: 'granted', state: 'authorized', stateCode: 'awaiting_collector' },
    });
    await task.runOnce();
    expect(await listed()).toContain('/aws/lambda/sem-tag');
    expect(await stateOf(denied.id)).toEqual(['configuring', 'awaiting_apply']);
  });

  it('fonte parada: só com objeto novo na origem que o Wazuh não leu; a conta quieta segue coletando', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (fonte parada)');
    const cloud = await account(tenant);
    const trailBucket = bucket();
    const wafBucket = `aws-waf-logs-${bucket()}`;
    const trail = await source(cloud, { details: { bucket: trailBucket }, collectFrom: ago(48 * HOUR) });
    const waf = await source(cloud, {
      kind: 'waf',
      resourceId: 'acl-1',
      details: { bucket: wafBucket, webAclName: 'painel', webAclScope: 'REGIONAL' },
      collectFrom: ago(48 * HOUR),
    });
    const questions: StallQuestion[] = [];
    let unread: boolean | null = false;
    const stallProbe: WazuhStallProbe = {
      hasUnreadObjects: (question) => {
        questions.push(question);
        return Promise.resolve(unread);
      },
    };
    const dir = await signalDir();
    let now = new Date();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant], stallProbe, now: () => now });
    // As duas fontes sem leitura há 3 horas.
    const readAt = ago(3 * HOUR);
    const key = trailKey(cloud.accountId, ago(3 * HOUR + 5 * MINUTE));
    const markers = (at = new Date()) =>
      progress(
        dir,
        [
          { bucketPath: `${trailBucket}/`, accountId: cloud.accountId, lastKey: key, processedAt: readAt },
          {
            table: 'waf',
            bucketPath: `${wafBucket}/AWSLogs/${cloud.accountId}/WAFLogs/sa-east-1/painel/`,
            accountId: cloud.accountId,
            region: null,
            lastKey: `AWSLogs/${cloud.accountId}/WAFLogs/sa-east-1/painel/log.gz`,
            processedAt: readAt,
          },
        ],
        [],
        at,
      );
    await tokenAt(dir, now);
    await applied(dir, [tenant]);
    await markers();

    // A origem não tem objeto novo: a conta só está quieta.
    expect(await task.runOnce()).toMatchObject({ sources: { stallChecks: 1 } });
    expect(await stateOf(trail.id)).toEqual(['collecting', null]);
    expect(await stateOf(waf.id)).toEqual(['collecting', null]);
    // Só a trilha é conferida (o WAF sem requisição bloqueada não é problema), com a sessão de leitura da conta dela.
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      tenantId: tenant,
      cloudAccountId: cloud.id,
      accountId: cloud.accountId,
      homeRegion: 'sa-east-1',
      bucket: trailBucket,
      afterKey: key,
    });
    // A pasta do dia de hoje da conta e da região, com o começo do nome dos objetos da trilha.
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    expect(questions[0]?.prefixes.at(-1)).toBe(
      `AWSLogs/${cloud.accountId}/CloudTrail/sa-east-1/${day}/${cloud.accountId}_CloudTrail_sa-east-1_`,
    );
    // A mesma fonte não é conferida de novo antes de 30 min.
    await task.runOnce();
    expect(questions).toHaveLength(1);

    // Meia hora depois, a origem tem objeto que o Wazuh não leu: parada.
    unread = true;
    now = new Date(Date.now() + 31 * MINUTE);
    await tokenAt(dir, now);
    await markers(now);
    expect(await task.runOnce()).toMatchObject({ sources: { stallChecks: 1, transitions: 1 } });
    expect(await stateOf(trail.id)).toEqual(['stalled', 'no_progress']);
    expect(await stateOf(waf.id)).toEqual(['collecting', null]);

    // O módulo volta a ler: a fonte sai da parada sem perguntar de novo à origem.
    const fresh = new Date(Math.floor((now.getTime() - 2 * MINUTE) / 1000) * 1000);
    await progress(
      dir,
      [
        {
          bucketPath: `${trailBucket}/`,
          accountId: cloud.accountId,
          lastKey: trailKey(cloud.accountId, new Date(now.getTime() - 6 * MINUTE)),
          processedAt: fresh,
        },
      ],
      [],
      now,
    );
    expect(await task.runOnce()).toMatchObject({ sources: { stallChecks: 0 } });
    expect(await row(trail.id)).toMatchObject({
      state: 'collecting',
      stateCode: null,
      lastIngestedAt: fresh,
    });
    expect(questions).toHaveLength(2);
    expect(await transitions(cloud.id)).toEqual([
      'authorized > collecting',
      'authorized > collecting',
      'collecting > stalled/no_progress',
      'stalled > collecting',
    ]);
  });

  it('a conferência da origem que falha, ou que não existe, nunca marca a fonte como parada', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (conferência indisponível)');
    const cloud = await account(tenant);
    const trailBucket = bucket();
    const trail = await source(cloud, { details: { bucket: trailBucket }, collectFrom: ago(48 * HOUR) });
    const dir = await signalDir();
    await tokenAt(dir, new Date());
    await applied(dir, [tenant]);
    await progress(dir, [
      {
        bucketPath: `${trailBucket}/`,
        accountId: cloud.accountId,
        lastKey: trailKey(cloud.accountId, ago(5 * HOUR)),
        processedAt: ago(5 * HOUR),
      },
    ]);
    let calls = 0;
    const failing: WazuhStallProbe = {
      hasUnreadObjects: () => {
        calls += 1;
        return Promise.reject(new Error('AccessDenied (simulado)'));
      },
    };
    await new WazuhConfig(prisma, dir, { tenantIds: [tenant], stallProbe: failing }).runOnce();
    expect(calls).toBe(1);
    expect(await stateOf(trail.id)).toEqual(['collecting', null]);
    // Sem a sessão de leitura no worker (o padrão): nem pergunta.
    expect(await new WazuhConfig(prisma, dir, { tenantIds: [tenant] }).runOnce()).toMatchObject({
      sources: { stallChecks: 0 },
    });
    expect(await stateOf(trail.id)).toEqual(['collecting', null]);
  });

  it('o sinal progress fora do formato, grande demais ou velho não muda o estado de fonte nenhuma', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (sinal progress)');
    const cloud = await account(tenant);
    const trailBucket = bucket();
    const trail = await source(cloud, { details: { bucket: trailBucket } });
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });
    const marker = {
      bucketPath: `${trailBucket}/`,
      accountId: cloud.accountId,
      lastKey: trailKey(cloud.accountId, ago(6 * MINUTE)),
      processedAt: ago(3 * MINUTE),
    };
    await tokenAt(dir, new Date());
    await applied(dir, [tenant]);
    await progress(dir, [marker]);
    await task.runOnce();
    const collecting = await row(trail.id);
    expect(collecting.state).toBe('collecting');

    const cases: [string, string][] = [
      ['não é JSON', '{'],
      ['outra versão', JSON.stringify({ version: 2, at: iso(new Date()) })],
      ['sem as partes', JSON.stringify({ version: 1, at: iso(new Date()) })],
      ['grande demais', `{"version":1,"lixo":"${'a'.repeat(WAZUH_PROGRESS_MAX_BYTES)}"}`],
    ];
    for (const [label, content] of cases) {
      await writeFile(join(dir, 'progress'), content);
      const report = await task.runOnce();
      expect(report.invalidSignals, label).toBe(1);
      expect(report.sources, label).toMatchObject({ transitions: 0, refreshed: 0 });
      expect(await row(trail.id), label).toEqual(collecting);
    }
    // Um retrato de mais de 20 min (o timer do host parou) e sem o marcador: a fonte fica como estava.
    await progress(dir, [], [], ago(25 * MINUTE));
    expect(await task.runOnce()).toMatchObject({
      invalidSignals: 0,
      sources: { transitions: 0, refreshed: 0 },
    });
    expect(await row(trail.id)).toEqual(collecting);
    // De volta, com uma linha fora do formato no meio: ela fica de fora, e a outra vale.
    await writeFile(
      join(dir, 'progress'),
      JSON.stringify({
        version: 1,
        at: iso(new Date()),
        s3: {
          status: 'ok',
          truncated: false,
          entries: [
            { table: 'cloudtrail', conteudo: 'linha de log' },
            {
              table: 'cloudtrail',
              bucketPath: marker.bucketPath,
              accountId: marker.accountId,
              region: 'sa-east-1',
              flowLogId: null,
              lastKey: marker.lastKey,
              processedAt: iso(new Date()),
              createdDate: null,
              keys: 3,
            },
          ],
        },
        cloudwatch: { status: 'missing', truncated: false, entries: [] },
      }),
    );
    expect(await task.runOnce()).toMatchObject({ invalidSignals: 0, sources: { refreshed: 1 } });
    expect((await row(trail.id)).lastIngestedAt?.getTime()).toBeGreaterThan(
      collecting.lastIngestedAt?.getTime() ?? 0,
    );
  });

  it('na célula a tarefa não grava a saúde das fontes: a geração e os avisos das contas seguem como antes', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (célula)');
    const cloud = await account(tenant, { cloudtrailBucket: bucket() });
    await syncLegacyAwsSources(prisma.forTenant(tenant), cloud.id);
    const before = await prisma.awsSource.findMany({ where: { cloudAccountId: cloud.id } });
    const dir = await signalDir();
    await tokenAt(dir, new Date());
    await progress(dir);
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant], sourceHealth: false });
    const report = await task.runOnce();
    expect(report).toMatchObject({ accounts: 1, generation: 'written', state: 'pending' });
    expect(report.sources).toBeUndefined();
    expect(await prisma.awsSource.findMany({ where: { cloudAccountId: cloud.id } })).toEqual(before);
  });

  it('a tela da conexão mostra o que a coleta gravou: as conferências do coletor, dos eventos, da leitura e do atraso', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (conferências da coleta)');
    const admin = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenant });
    const cloud = await account(tenant);
    await prisma.awsDiscoveryRun.create({
      data: {
        tenantId: tenant,
        cloudAccountId: cloud.id,
        trigger: 'connect',
        status: 'succeeded',
        requestedAt: ago(HOUR),
        startedAt: ago(HOUR),
        finishedAt: ago(HOUR),
        regions: ['sa-east-1'],
      },
    });
    const trailBucket = bucket();
    const trail = await source(cloud, { details: { bucket: trailBucket } });
    const group = await logGroup(cloud, '/aws/lambda/cobranca');
    const onboarding = async () => {
      const response = await request(app.getHttpServer())
        .get(`/v1/cloud-accounts/${cloud.id}/aws/onboarding`)
        .set('Cookie', admin.cookie)
        .expect(200);
      const parsed = awsOnboardingSchema.parse(response.body);
      const checks = Object.fromEntries(parsed.checks.map((item) => [item.id, [item.status, item.code]]));
      return { state: parsed.state, checks, sources: parsed.sources };
    };
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });
    await tokenAt(dir, new Date());

    // Autorizadas, com a lista ainda por aplicar: nada de "tudo certo".
    await task.runOnce();
    expect(await onboarding()).toMatchObject({
      state: 'configuring',
      checks: {
        collector_config: ['pending', 'awaiting_collector'],
        events: ['pending', 'awaiting_collector'],
        last_sync: ['pending', 'no_data'],
        lag: ['pending', 'no_data'],
      },
    });

    // Aplicada; só a trilha já foi lida.
    await applied(dir, [tenant]);
    const marker = {
      bucketPath: `${trailBucket}/`,
      accountId: cloud.accountId,
      lastKey: trailKey(cloud.accountId, ago(6 * MINUTE)),
      processedAt: ago(2 * MINUTE),
    };
    await progress(dir, [marker]);
    await task.runOnce();
    const partial = await onboarding();
    expect(partial).toMatchObject({
      state: 'partial',
      checks: {
        collector_config: ['ok', null],
        events: ['pending', 'waiting_events'],
        last_sync: ['ok', null],
        lag: ['pending', 'no_data'],
      },
    });
    expect(partial.sources.find((item) => item.id === trail.id)).toMatchObject({
      state: 'collecting',
      health: { lagSeconds: expect.any(Number) as number },
    });
    expect(partial.sources.find((item) => item.id === group.id)).toMatchObject({ state: 'waiting_events' });

    // As duas lidas: coletando, com todas as conferências da coleta no verde.
    await progress(dir, [marker], [{ logGroup: '/aws/lambda/cobranca', endTime: ago(MINUTE) }]);
    await task.runOnce();
    expect(await onboarding()).toMatchObject({
      state: 'collecting',
      checks: {
        collector_config: ['ok', null],
        events: ['ok', null],
        last_sync: ['ok', null],
        lag: ['ok', null],
      },
    });

    // O token do nó para: falha de ingestão, com o motivo.
    const late = new WazuhConfig(prisma, dir, {
      tenantIds: [tenant],
      now: () => new Date(Date.now() + 41 * MINUTE),
    });
    await late.runOnce();
    expect(await onboarding()).toMatchObject({
      state: 'ingestion_failure',
      checks: { collector_config: ['failed', 'aws_token_stale'], events: ['failed', 'aws_token_stale'] },
    });
  });
});
