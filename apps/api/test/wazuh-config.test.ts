import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type AwsConnectionWarningCode, cloudAccountSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AwsCheck } from '../src/aws/aws-check.js';
import type {
  AwsCheckOutcome,
  AwsCheckTarget,
  AwsConnectionChecker,
} from '../src/aws/aws-connection-check.js';
import { AWS_TOKEN_STALE_AFTER_MS, WazuhConfig } from '../src/aws/wazuh-config.js';
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

/** A conferência falsa do PR-V5': conectada, com os avisos diários que o caso pede. */
class WarningChecker implements AwsConnectionChecker {
  daily: AwsConnectionWarningCode[] = [];

  check(target: AwsCheckTarget): Promise<AwsCheckOutcome> {
    return Promise.resolve({ ok: true, ...(target.daily && { daily: { warnings: [...this.daily] } }) });
  }
}

describe("Wazuh do nó: a lista das contas AWS e a tarefa wazuh-config (fase 2, PR-V4')", () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const dirs: string[] = [];

  /** Uma conta AWS como o worker a deixa depois da primeira verificação: conectada, com o início da coleta. */
  async function awsAccount(tenantId: string, data: Partial<Prisma.CloudAccountUncheckedCreateInput> = {}) {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: accountId(),
        regions: ['sa-east-1', 'us-east-1'],
        ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
        cloudtrailBucket: bucket(),
        connection: 'connected',
        ...data,
      },
      select: { id: true, accountId: true },
    });
  }

  const rowOf = (id: string) =>
    prisma.cloudAccount.findUniqueOrThrow({
      where: { id },
      select: { connection: true, connectionError: true, collectionError: true },
    });

  /** A pasta de sinais de um caso (no nó, /run/verax/wazuh-signal montada no worker). */
  async function signalDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'verax-wazuh-signal-'));
    dirs.push(dir);
    return dir;
  }

  /** A geração das contas destes clientes, como o worker e o wazuh-apply.sh a calculam. */
  async function generationOf(tenantIds: string[]): Promise<string> {
    return wazuhSourcesGeneration(
      serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(prisma, tenantIds))),
    );
  }

  /** Os sinais do host (wazuh-apply.sh e aws-token.sh), no formato deles. */
  const applied = (dir: string, generation: string | null, status: 'ok' | 'error') =>
    writeFile(
      join(dir, 'applied'),
      `${JSON.stringify({ generation, status, at: '2026-11-04T12:00:00Z' })}\n`,
    );
  const tokenAt = (dir: string, at: Date) =>
    writeFile(
      join(dir, 'aws-token'),
      `${JSON.stringify({ tokenAt: at.toISOString().replace(/\.\d{3}Z$/, 'Z') })}\n`,
    );

  const auditOf = (id: string, action = 'cloud_account.aws_collection') =>
    prisma.auditLog.findMany({
      where: { resourceId: id, action },
      orderBy: { occurredAt: 'asc' },
      select: { tenantId: true, actorType: true, before: true, after: true },
    });

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

  it('a lista: só as contas AWS ativas, já verificadas e com bucket; o CLI a imprime sem nada do cliente', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (lista do Wazuh)');
    const first = await awsAccount(tenant, { guarddutyBucket: bucket('guardduty') });
    const second = await awsAccount(tenant, {
      connection: 'error',
      connectionError: 'bucket_denied',
      wafBucket: `aws-waf-logs-${bucket()}`,
    });
    const excluded = await Promise.all([
      awsAccount(tenant, { status: 'inactive' }),
      awsAccount(tenant, { ingestFrom: null, connection: 'waiting' }),
      awsAccount(tenant, { cloudtrailBucket: null }),
    ]);
    await prisma.cloudAccount.create({
      data: { tenantId: tenant, provider: 'gcp', accountId: `projeto-${randomInt(100_000, 999_999)}` },
    });

    const sources = toWazuhSources(await findWazuhSourceRows(prisma, [tenant]));
    // Um erro da conta não a tira do manager: só a desativação ou a falta de verificação e de bucket.
    expect(sources.map((source) => source.accountId)).toEqual([first.accountId, second.accountId].sort());
    const source = sources.find((item) => item.accountId === first.accountId);
    expect(source).toMatchObject({ region: 'sa-east-1', onlyLogsAfter: '2026-NOV-01' });
    expect(Object.keys(source ?? {})).toEqual([
      'accountId',
      'region',
      'onlyLogsAfter',
      'cloudtrailBucket',
      'guarddutyBucket',
    ]);
    expect(source?.cloudtrailBucket).toMatch(/^trilha-/);
    expect(source?.guarddutyBucket).toMatch(/^guardduty-/);

    // O CLI lê todos os clientes do nó: as contas deste aparecem, as outras não.
    const line = await wazuhSourcesLine(prisma);
    expect(line).not.toContain('\n');
    const printed = (JSON.parse(line) as { accountId: string }[]).map((item) => item.accountId);
    expect(printed).toEqual(expect.arrayContaining([first.accountId, second.accountId]));
    for (const account of excluded) expect(printed).not.toContain(account.accountId);
    expect(line).not.toMatch(/tenant|externalId|secret|connection|collection/i);
  });

  it('a geração: gravada só quando a lista muda, de uma vez, com o hash da lista que o CLI imprime', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (geração)');
    const account = await awsAccount(tenant);
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });

    expect(await task.runOnce()).toMatchObject({ accounts: 1, generation: 'written', state: 'pending' });
    const first = await readFile(join(dir, 'generation'), 'utf8');
    expect(first).toBe(`${await generationOf([tenant])}\n`);
    expect(await task.runOnce()).toMatchObject({ generation: 'unchanged' });
    // Troca atômica: nenhum arquivo temporário fica na pasta.
    expect(await readdir(dir)).toEqual(['generation']);

    // Um bucket novo muda a geração (o host refaz a configuração); a conexão de agora, não.
    await prisma.cloudAccount.update({
      where: { id: account.id },
      data: { wafBucket: `aws-waf-logs-${bucket()}` },
    });
    expect(await task.runOnce()).toMatchObject({ generation: 'written' });
    const second = await readFile(join(dir, 'generation'), 'utf8');
    expect(second).not.toBe(first);
    await prisma.cloudAccount.update({ where: { id: account.id }, data: { connection: 'waiting' } });
    expect(await task.runOnce()).toMatchObject({ generation: 'unchanged' });

    // Desativada, a conta sai da lista: a geração da lista vazia.
    await prisma.cloudAccount.update({ where: { id: account.id }, data: { status: 'inactive' } });
    expect(await task.runOnce()).toMatchObject({ accounts: 0, generation: 'written' });
    expect(await readFile(join(dir, 'generation'), 'utf8')).toBe(`${wazuhSourcesGeneration('[]')}\n`);
  });

  it('erro ao aplicar a lista de agora: o aviso vai para o campo da coleta de cada conta, na trilha de cada cliente (A/B), sem tocar na conexão', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (aplicação)');
    const tenantB = await createTenant(app, 'Cliente Demo B (aplicação)');
    const connectedA = await awsAccount(tenantA);
    const waitingA = await awsAccount(tenantA, { connection: 'waiting' });
    const connectedB = await awsAccount(tenantB, {
      connectionError: 'trail_not_logging',
    });
    const deniedB = await awsAccount(tenantB, { connection: 'error', connectionError: 'bucket_denied' });
    const all = [connectedA, waitingA, connectedB, deniedB];
    const connectionBefore = await Promise.all(all.map((account) => rowOf(account.id)));
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenantA, tenantB] });
    await tokenAt(dir, new Date());
    const generation = await generationOf([tenantA, tenantB]);

    await applied(dir, generation, 'error');
    expect(await task.runOnce()).toMatchObject({
      accounts: 4,
      state: 'wazuh_apply_failed',
      marked: 4,
      cleared: 0,
    });
    // O aviso é do nó: vale para toda conta que o manager lê, e a conexão (e o aviso dela) fica como estava.
    for (const [index, account] of all.entries()) {
      expect(await rowOf(account.id)).toEqual({
        connection: connectionBefore[index]?.connection,
        connectionError: connectionBefore[index]?.connectionError,
        collectionError: 'wazuh_apply_failed',
      });
    }
    // Auditoria: ator sistema, na trilha do cliente de cada conta, e nada das contas de B na trilha de A.
    expect(await auditOf(connectedA.id)).toEqual([
      {
        tenantId: tenantA,
        actorType: 'system',
        before: { collectionError: null },
        after: { collectionError: 'wazuh_apply_failed' },
      },
    ]);
    for (const account of [connectedB, deniedB]) {
      expect((await auditOf(account.id)).map((entry) => entry.tenantId)).toEqual([tenantB]);
    }
    expect(
      await prisma.auditLog.count({
        where: { tenantId: tenantA, resourceId: { in: [connectedB.id, deniedB.id] } },
      }),
    ).toBe(0);

    // A mesma execução de novo não grava nem audita de novo.
    expect(await task.runOnce()).toMatchObject({ marked: 0, cleared: 0 });
    expect(await auditOf(connectedA.id)).toHaveLength(1);

    // O resultado é de uma lista antiga (a de agora ainda não foi aplicada): o aviso de antes fica.
    await applied(dir, 'a'.repeat(64), 'ok');
    expect(await task.runOnce()).toMatchObject({ state: 'pending', marked: 0, cleared: 0 });
    expect((await rowOf(connectedA.id)).collectionError).toBe('wazuh_apply_failed');

    // A lista de agora aplicada: o aviso sai das quatro, e a conexão segue como estava.
    await applied(dir, generation, 'ok');
    expect(await task.runOnce()).toMatchObject({ state: 'ok', marked: 0, cleared: 4 });
    for (const [index, account] of all.entries()) {
      expect(await rowOf(account.id)).toEqual({ ...connectionBefore[index], collectionError: null });
    }
    expect((await auditOf(connectedA.id)).at(-1)?.after).toEqual({ collectionError: null });
  });

  it('o host nem leu a lista (erro sem geração): o aviso vai para as contas elegíveis (A/B); o erro de uma lista antiga, não; a próxima aplicação certa o tira', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (lista não lida)');
    const tenantB = await createTenant(app, 'Cliente Demo B (lista não lida)');
    const accountA = await awsAccount(tenantA);
    const accountB = await awsAccount(tenantB, { connection: 'waiting' });
    // Fora da coleta (sem a primeira verificação): não ganha o aviso do nó.
    const notCollected = await awsAccount(tenantA, { ingestFrom: null, connection: 'waiting' });
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenantA, tenantB] });
    await tokenAt(dir, new Date());

    // O erro de uma lista antiga não diz nada da de agora: aguardando, sem aviso.
    await applied(dir, 'b'.repeat(64), 'error');
    expect(await task.runOnce()).toMatchObject({ accounts: 2, state: 'pending', marked: 0 });
    expect((await rowOf(accountA.id)).collectionError).toBeNull();

    // O CLI falhou no host: nenhuma lista chega ao manager, nem a de agora.
    await applied(dir, null, 'error');
    expect(await task.runOnce()).toMatchObject({ state: 'wazuh_apply_failed', marked: 2, cleared: 0 });
    for (const account of [accountA, accountB]) {
      expect((await rowOf(account.id)).collectionError).toBe('wazuh_apply_failed');
    }
    expect((await rowOf(notCollected.id)).collectionError).toBeNull();
    // A conexão fica como estava, e cada conta tem a entrada na trilha do próprio cliente.
    expect(await rowOf(accountB.id)).toMatchObject({ connection: 'waiting', connectionError: null });
    expect((await auditOf(accountA.id)).map((entry) => entry.tenantId)).toEqual([tenantA]);
    expect((await auditOf(accountB.id)).map((entry) => entry.tenantId)).toEqual([tenantB]);
    expect(await task.runOnce()).toMatchObject({ marked: 0, cleared: 0 });
    expect(await auditOf(accountA.id)).toHaveLength(1);

    // A lista muda enquanto isso (um bucket novo): o erro sem geração segue valendo para a lista nova.
    await prisma.cloudAccount.update({
      where: { id: accountA.id },
      data: { wafBucket: `aws-waf-logs-${bucket()}` },
    });
    expect(await task.runOnce()).toMatchObject({
      generation: 'written',
      state: 'wazuh_apply_failed',
      marked: 0,
    });
    // O host aplica uma lista antiga: o aviso fica até o resultado da de agora.
    await applied(dir, 'b'.repeat(64), 'ok');
    expect(await task.runOnce()).toMatchObject({ state: 'pending', marked: 0, cleared: 0 });
    expect((await rowOf(accountA.id)).collectionError).toBe('wazuh_apply_failed');

    // A lista de agora aplicada: o aviso sai das duas, com auditoria.
    await applied(dir, await generationOf([tenantA, tenantB]), 'ok');
    expect(await task.runOnce()).toMatchObject({ state: 'ok', marked: 0, cleared: 2 });
    for (const account of [accountA, accountB]) {
      expect((await rowOf(account.id)).collectionError).toBeNull();
    }
    expect((await auditOf(accountA.id)).at(-1)?.after).toEqual({ collectionError: null });
  });

  it("as duas tarefas não se desfazem: o aviso da conferência (PR-V5') e o da coleta convivem, e tirar um mantém o outro", async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (duas tarefas)');
    const account = await awsAccount(tenant);
    const dir = await signalDir();
    const checker = new WarningChecker();
    const awsCheck = new AwsCheck(prisma, checker, {
      tenantIds: [tenant],
      recheckIntervalMs: 0,
      dailyIntervalMs: 0,
    });
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });
    await tokenAt(dir, new Date());
    const generation = await generationOf([tenant]);
    const audits = async () => ({
      check: (await auditOf(account.id, 'cloud_account.aws_check')).length,
      collection: (await auditOf(account.id)).length,
    });

    // A conferência diária acha a trilha parada: aviso na conexão, que segue conectada.
    checker.daily = ['trail_not_logging'];
    await awsCheck.recheck();
    expect(await rowOf(account.id)).toEqual({
      connection: 'connected',
      connectionError: 'trail_not_logging',
      collectionError: null,
    });

    // A aplicação no host dá erro: o aviso da coleta entra ao lado, sem mexer no da conexão.
    await applied(dir, generation, 'error');
    await task.runOnce();
    expect(await rowOf(account.id)).toEqual({
      connection: 'connected',
      connectionError: 'trail_not_logging',
      collectionError: 'wazuh_apply_failed',
    });

    // Cada tarefa roda de novo, sem mudança: nenhuma desfaz a outra, e nada é gravado nem auditado.
    const before = await audits();
    await awsCheck.recheck();
    await task.runOnce();
    await awsCheck.recheck();
    expect(await rowOf(account.id)).toEqual({
      connection: 'connected',
      connectionError: 'trail_not_logging',
      collectionError: 'wazuh_apply_failed',
    });
    expect(await audits()).toEqual(before);

    // A coleta se resolve: o aviso dela sai, e o da trilha fica (não espera a próxima conferência diária).
    await applied(dir, generation, 'ok');
    await task.runOnce();
    expect(await rowOf(account.id)).toEqual({
      connection: 'connected',
      connectionError: 'trail_not_logging',
      collectionError: null,
    });

    // O contrário: a coleta volta a falhar e a trilha é religada; a conferência tira o aviso dela, e o da coleta fica.
    await applied(dir, generation, 'error');
    await task.runOnce();
    checker.daily = [];
    await awsCheck.recheck();
    expect(await rowOf(account.id)).toEqual({
      connection: 'connected',
      connectionError: null,
      collectionError: 'wazuh_apply_failed',
    });
    // Cada mudança, uma entrada, de cada tarefa, na trilha do cliente.
    expect(await audits()).toEqual({ check: before.check + 1, collection: before.collection + 2 });
  });

  it('token do Google parado há mais de 40 min: aws_token_stale, que vale mais que o erro de aplicação; renovado, sai', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (token)');
    const account = await awsAccount(tenant);
    const dir = await signalDir();
    const now = new Date('2026-11-04T12:00:00.000Z');
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant], now: () => now, startedAt: now });
    const generation = await generationOf([tenant]);

    await applied(dir, generation, 'error');
    await tokenAt(dir, new Date(now.getTime() - AWS_TOKEN_STALE_AFTER_MS - MINUTE));
    expect(await task.runOnce()).toMatchObject({ state: 'aws_token_stale', marked: 1 });
    expect((await rowOf(account.id)).collectionError).toBe('aws_token_stale');

    // Renovado, com a aplicação ainda em erro: troca para o aviso de aplicação.
    await tokenAt(dir, new Date(now.getTime() - 5 * MINUTE));
    expect(await task.runOnce()).toMatchObject({ state: 'wazuh_apply_failed', marked: 1 });
    expect((await rowOf(account.id)).collectionError).toBe('wazuh_apply_failed');

    await applied(dir, generation, 'ok');
    expect(await task.runOnce()).toMatchObject({ state: 'ok', cleared: 1 });
    expect(await rowOf(account.id)).toEqual({
      connection: 'connected',
      connectionError: null,
      collectionError: null,
    });
  });

  it('sem nenhum sinal do token: só conta como parado 40 min depois da partida do worker', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (sem token)');
    const account = await awsAccount(tenant);
    const dir = await signalDir();
    const now = new Date('2026-11-04T12:00:00.000Z');
    const recent = new WazuhConfig(prisma, dir, { tenantIds: [tenant], now: () => now, startedAt: now });
    expect(await recent.runOnce()).toMatchObject({ state: 'pending', marked: 0 });
    expect((await rowOf(account.id)).collectionError).toBeNull();

    const old = new WazuhConfig(prisma, dir, {
      tenantIds: [tenant],
      now: () => now,
      startedAt: new Date(now.getTime() - AWS_TOKEN_STALE_AFTER_MS - MINUTE),
    });
    expect(await old.runOnce()).toMatchObject({ state: 'aws_token_stale', marked: 1 });
  });

  it('a conta que sai da coleta perde o aviso, e a API só o devolve na conta AWS ativa', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (saída da coleta)');
    const account = await awsAccount(tenant);
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });
    await tokenAt(dir, new Date());
    await applied(dir, await generationOf([tenant]), 'error');
    await task.runOnce();

    // A API devolve o aviso a quem vê a conta, pelo schema compartilhado.
    const user = await createSignedInUser(app, { role: 'leitura', tenantId: tenant });
    const response = await request(app.getHttpServer())
      .get(`/v1/cloud-accounts/${account.id}`)
      .set('Cookie', user.cookie)
      .expect(200);
    expect(cloudAccountSchema.parse(response.body).collectionError).toBe('wazuh_apply_failed');

    // Desativada, a conta sai da lista do manager e a próxima execução tira o aviso, com auditoria.
    await prisma.cloudAccount.update({ where: { id: account.id }, data: { status: 'inactive' } });
    expect(await task.runOnce()).toMatchObject({ accounts: 0, cleared: 1 });
    expect((await rowOf(account.id)).collectionError).toBeNull();
    expect((await auditOf(account.id)).at(-1)?.after).toEqual({ collectionError: null });
  });

  it('o banco só aceita o aviso da coleta na conta AWS, e só com os códigos dela', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (CHECK da coleta)');
    const account = await awsAccount(tenant);
    const gcp = await prisma.cloudAccount.create({
      data: { tenantId: tenant, provider: 'gcp', accountId: `projeto-${randomInt(100_000, 999_999)}` },
      select: { id: true },
    });
    await expect(
      prisma.cloudAccount.update({ where: { id: gcp.id }, data: { collectionError: 'wazuh_apply_failed' } }),
    ).rejects.toThrow(/CloudAccount_aws_collection_error_check/);
    await expect(
      prisma.cloudAccount.update({ where: { id: account.id }, data: { collectionError: 'trust_denied' } }),
    ).rejects.toThrow(/CloudAccount_aws_collection_error_check/);
    await prisma.cloudAccount.update({
      where: { id: account.id },
      data: { collectionError: 'aws_token_stale' },
    });
    expect((await rowOf(account.id)).collectionError).toBe('aws_token_stale');
  });

  it('sinais do host fora do formato são ignorados (contados), sem mexer nas contas', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (sinais)');
    const account = await awsAccount(tenant);
    const dir = await signalDir();
    const task = new WazuhConfig(prisma, dir, { tenantIds: [tenant] });
    const generation = await generationOf([tenant]);

    await writeFile(join(dir, 'applied'), 'não é json');
    await tokenAt(dir, new Date());
    expect(await task.runOnce()).toMatchObject({ state: 'pending', invalidSignals: 1, marked: 0 });

    // Campo a mais, status desconhecido, ok sem geração (o host só manda null com erro) ou um arquivo grande demais:
    // fora do formato.
    for (const content of [
      JSON.stringify({ generation, status: 'error', at: '2026-11-04T12:00:00Z', extra: 1 }),
      JSON.stringify({ generation, status: 'talvez', at: '2026-11-04T12:00:00Z' }),
      JSON.stringify({ generation: null, status: 'ok', at: '2026-11-04T12:00:00Z' }),
      JSON.stringify({ generation, status: 'error', at: '2026-11-04T12:00:00Z', pad: 'x'.repeat(5000) }),
    ]) {
      await writeFile(join(dir, 'applied'), content);
      expect(await task.runOnce()).toMatchObject({ state: 'pending', invalidSignals: 1, marked: 0 });
    }
    expect(await rowOf(account.id)).toEqual({
      connection: 'connected',
      connectionError: null,
      collectionError: null,
    });
  });
});
