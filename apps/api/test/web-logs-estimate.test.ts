import { randomBytes, randomInt } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { AwsConnectionError } from '../src/aws/web-identity.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { WebLogsEstimator, type WebEstimateOptions } from '../src/weblogs/collect/web-estimate-job.js';
import { loadCountries, webLogsTasks } from '../src/weblogs/collect/web-logs-tasks.js';
import { clockAt, FakeCredentials } from './inventory/fake-job.js';
import { times } from './support/alb-lines.js';
import { awsFault, deliver, FakeAlbS3, gzipLines, linesOf } from './support/fake-alb-s3.js';
import { HOUR, MINUTE, NOON, type Site, SLOT, START, webLogsHarness } from './support/web-logs-harness.js';

/** A tarefa `web-logs-estimate` (a estimativa pedida antes da autorização) e o portão das duas tarefas no worker. */
describe('estimativa de volume de um balanceador', () => {
  let prisma: PrismaService;
  let h: ReturnType<typeof webLogsHarness>;
  const YESTERDAY = NOON - 24 * HOUR;

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    h = webLogsHarness(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Um balanceador ainda não autorizado, como a descoberta o deixa. */
  const idle = (name: string, options: Parameters<typeof h.newSite>[1] = {}) =>
    h.newSite(name, {
      ...options,
      source: {
        authorizedAt: null,
        authorizedBy: null,
        collectFrom: null,
        state: 'available',
        stateCode: null,
        permission: 'granted',
        ...options.source,
      },
    });
  const ask = (site: Site, requestedAt = new Date(START.getTime() - MINUTE)) =>
    prisma.webSourceEstimate.upsert({
      where: { sourceId_tenantId: { sourceId: site.sourceId, tenantId: site.tenantId } },
      create: { sourceId: site.sourceId, tenantId: site.tenantId, requestedAt, lastRequestAt: requestedAt },
      update: { requestedAt, lastRequestAt: requestedAt },
    });
  const rowOf = (site: Site) =>
    prisma.webSourceEstimate.findFirstOrThrow({ where: { sourceId: site.sourceId } });
  function newTask(tenantIds: string[], options: WebEstimateOptions & { s3?: FakeAlbS3 } = {}) {
    const { s3 = new FakeAlbS3(), ...rest } = options;
    const credentials = new FakeCredentials();
    const clock = clockAt(START);
    const name = `estimativa-${randomInt(1e6, 9e6)}`;
    const task = new WebLogsEstimator(prisma, credentials, s3.factory, {
      name,
      now: clock.now,
      random: () => 0.5,
      sleep: () => Promise.resolve(),
      tenantIds,
      ...rest,
    });
    return { task, s3, credentials, clock, name };
  }
  const body = (count: number) =>
    gzipLines(
      linesOf(
        YESTERDAY,
        times(count, () => ({ client: '192.0.2.10', path: `/${randomBytes(10).toString('hex')}` })),
      ),
    );

  it('mede os arquivos de ontem pelos 4 últimos bytes de uma amostra, sem ler nenhum', async () => {
    const site = await idle('estimativa');
    await ask(site);
    const { task, s3 } = newTask([site.tenantId]);
    let compressed = 0;
    let bytes = 0;
    for (let i = 0; i < 50; i += 1) {
      const data = body(200 + i);
      compressed += data.length;
      bytes += gunzipSync(data).length;
      deliver(s3, site.balancer, YESTERDAY - 12 * HOUR + i * SLOT, data, { day: '2026-11-23' });
    }
    // De hoje, de outro balanceador e fora da gramática: não entram.
    deliver(s3, site.balancer, NOON, body(500));
    deliver(s3, { ...site.balancer, lb: 'app/outra/0000000000000002' }, YESTERDAY, body(500));
    const report = await task.runOnce();
    expect(report).toMatchObject({ status: 'done', pending: 1, ready: 1, failed: 0, lists: 1, tails: 20 });
    expect(s3.gets).toEqual([]);
    expect(s3.tails).toHaveLength(20);
    expect(s3.tails.every((call) => call.range === 'bytes=-4')).toBe(true);
    expect(s3.lists.every((call) => call.key.includes('/2026/11/23/'))).toBe(true);
    const row = await rowOf(site);
    expect(row).toMatchObject({
      status: 'ready',
      requestedAt: null,
      computedAt: START,
      day: new Date('2026-11-23T00:00:00.000Z'),
      objects: 50,
      sampledObjects: 20,
      truncated: false,
      errorCode: null,
    });
    const estimated = Number(row.bytesPerDay);
    expect(Math.abs(estimated - bytes) / bytes).toBeLessThan(0.03);
    expect(compressed).toBeLessThan(bytes);
    // A fonte não muda: ninguém foi autorizado.
    expect(await h.sourceRow(site)).toMatchObject({
      state: 'available',
      lastSyncAt: null,
      authorizedAt: null,
    });
    expect(await h.ledger(site)).toEqual([]);
    expect(await h.usage(site)).toEqual({ month: null, day: null });
    // Respondida, não é refeita.
    const calls = s3.calls.length;
    expect(await task.runOnce()).toMatchObject({ pending: 0 });
    expect(s3.calls).toHaveLength(calls);
  });

  it('o tamanho impossível no fim do arquivo vira a estimativa de sempre, e não o volume que o arquivo diz', async () => {
    const site = await idle('ISIZE impossível');
    await ask(site);
    const { task, s3 } = newTask([site.tenantId]);
    const data = Buffer.from(body(100));
    data.writeUInt32LE(0xffff_ffff, data.length - 4);
    deliver(s3, site.balancer, YESTERDAY, data);
    await task.runOnce();
    expect(Number((await rowOf(site)).bytesPerDay)).toBe(data.length * 10);
  });

  it('sem arquivo ontem: sem amostra; só arquivo vazio: volume zero', async () => {
    const none = await idle('sem amostra');
    const empty = await idle('vazios');
    await ask(none);
    await ask(empty);
    const { task, s3 } = newTask([none.tenantId, empty.tenantId]);
    deliver(s3, empty.balancer, YESTERDAY, Buffer.alloc(0));
    expect(await task.runOnce()).toMatchObject({ ready: 1, noSample: 1 });
    expect(await rowOf(none)).toMatchObject({
      status: 'no_sample',
      objects: 0,
      sampledObjects: 0,
      bytesPerDay: null,
      requestedAt: null,
    });
    expect(await rowOf(empty)).toMatchObject({
      status: 'ready',
      objects: 1,
      sampledObjects: 0,
      bytesPerDay: 0n,
    });
    expect(s3.tails).toEqual([]);
  });

  it('além do limite de páginas, o volume é um piso, e o número de chamadas tem teto', async () => {
    const site = await idle('cortada');
    await ask(site);
    const { task, s3 } = newTask([site.tenantId]);
    s3.pageSize = 3;
    for (let i = 0; i < 60; i += 1)
      deliver(s3, site.balancer, YESTERDAY - i * SLOT, body(3), { day: '2026-11-23' });
    expect(await task.runOnce()).toMatchObject({ ready: 1, lists: 10, tails: 20 });
    expect(await rowOf(site)).toMatchObject({ truncated: true, objects: 30, sampledObjects: 20 });
  });

  it('a amostra apagada ou arquivada no meio fica de fora; sem nenhuma, não há como dizer', async () => {
    const some = await idle('algumas');
    const gone = await idle('nenhuma');
    await ask(some);
    await ask(gone);
    const { task, s3 } = newTask([some.tenantId, gone.tenantId]);
    const lost = deliver(s3, some.balancer, YESTERDAY, body(10), { random: 'a' });
    deliver(s3, some.balancer, YESTERDAY, body(10), { random: 'b' });
    deliver(s3, gone.balancer, YESTERDAY, body(10));
    s3.onGet = (call) =>
      call.key === lost
        ? { error: awsFault('InvalidObjectState', 403) }
        : call.bucket === gone.balancer.bucket
          ? { error: awsFault('NoSuchKey', 404) }
          : undefined;
    await task.runOnce();
    expect(await rowOf(some)).toMatchObject({ status: 'ready', objects: 2, sampledObjects: 1 });
    expect(await rowOf(gone)).toMatchObject({ status: 'no_sample', objects: 1, bytesPerDay: null });
  });

  it.each([
    ['listagem negada', awsFault('AccessDenied', 403), 'bucket_denied'],
    ['bucket que não existe', awsFault('NoSuchBucket', 404), 'bucket_missing'],
    ['limite persistente', awsFault('SlowDown', 503), 'throttled'],
    ['sem resposta', awsFault('TimeoutError', 0), 'TimeoutError'],
  ])('%s: falhou, com o motivo, e o pedido sai de pendente', async (name, fault, code) => {
    const site = await idle(name);
    await ask(site);
    const { task, s3 } = newTask([site.tenantId]);
    s3.onList = () => fault;
    expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { [code]: 1 } });
    expect(await rowOf(site)).toMatchObject({
      status: 'failed',
      errorCode: code,
      requestedAt: null,
      computedAt: START,
      day: null,
      objects: null,
      bytesPerDay: null,
    });
  });

  it('leitura negada, papel recusado, conta desconectada, fonte indisponível e detalhe torto', async () => {
    const denied = await idle('leitura negada');
    const refused = await idle('papel recusado');
    const offline = await idle('desconectada');
    const missing = await idle('indisponível', { source: { availability: 'no_destination' } });
    const vanished = await idle('sumida', { source: { missingSince: new Date(NOON) } });
    const crooked = await idle('torta', { prefix: 'com espaço' });
    const sites = [denied, refused, offline, missing, vanished, crooked];
    for (const [i, site] of sites.entries()) await ask(site, new Date(START.getTime() - HOUR + i));
    await prisma.cloudAccount.update({
      where: { id: offline.accountRow },
      data: { connection: 'error', connectionError: 'trust_denied' },
    });
    const { task, s3, credentials } = newTask(sites.map((site) => site.tenantId));
    credentials.failures.set(refused.balancer.account, new AwsConnectionError('trust_denied', true));
    deliver(s3, denied.balancer, YESTERDAY, body(5));
    s3.onGet = () => ({ error: awsFault('AccessDenied', 403) });
    // Cinco por execução, os mais antigos primeiro.
    expect(await task.runOnce()).toMatchObject({ pending: 5, failed: 5 });
    expect((await rowOf(crooked)).status).toBeNull();
    expect(await task.runOnce()).toMatchObject({ pending: 1, failed: 1 });
    const codes = await Promise.all(sites.map(async (site) => (await rowOf(site)).errorCode));
    expect(codes).toEqual([
      's3:GetObject',
      'trust_denied',
      'account_not_connected',
      'source_not_available',
      'source_not_available',
      'web_prefix_unsupported',
    ]);
    expect(new Set(s3.calls.map((call) => call.bucket))).toEqual(new Set([denied.balancer.bucket]));
  });

  it('cliente suspenso, fonte de outro tipo: o pedido espera, e não trava a fila', async () => {
    const suspended = await idle('suspenso');
    await ask(suspended, new Date(START.getTime() - 2 * HOUR));
    await prisma.tenant.update({ where: { id: suspended.tenantId }, data: { status: 'suspended' } });
    const site = await idle('da vez');
    await ask(site);
    const { task, s3 } = newTask([suspended.tenantId, site.tenantId]);
    deliver(s3, site.balancer, YESTERDAY, body(5));
    expect(await task.runOnce()).toMatchObject({ pending: 1, ready: 1 });
    expect((await rowOf(suspended)).requestedAt).not.toBeNull();
    expect(new Set(s3.calls.map((call) => call.bucket))).toEqual(new Set([site.balancer.bucket]));
  });

  it('o pedido renovado no meio não é respondido com o número do anterior; a fonte apagada também não quebra', async () => {
    const renewed = await idle('renovado');
    const deleted = await idle('apagada');
    await ask(renewed, new Date(START.getTime() - 2 * HOUR));
    await ask(deleted, new Date(START.getTime() - HOUR));
    const { task, s3 } = newTask([renewed.tenantId, deleted.tenantId]);
    s3.onList = async (call) => {
      if (call.bucket === renewed.balancer.bucket) await ask(renewed, START);
      else await prisma.awsSource.delete({ where: { id: deleted.sourceId } });
      return undefined;
    };
    expect(await task.runOnce()).toMatchObject({ superseded: 2, ready: 0, noSample: 0 });
    expect(await rowOf(renewed)).toMatchObject({ requestedAt: START, status: null, computedAt: null });
  });

  it('a estimativa da fonte já autorizada também responde; o resultado anterior é trocado inteiro', async () => {
    const site = await h.newSite('autorizada');
    await prisma.webSourceEstimate.create({
      data: {
        sourceId: site.sourceId,
        tenantId: site.tenantId,
        requestedAt: START,
        lastRequestAt: START,
        status: 'ready',
        computedAt: new Date(NOON - HOUR),
        day: new Date('2026-11-20'),
        objects: 9,
        sampledObjects: 9,
        bytesPerDay: 1_000n,
        truncated: true,
      },
    });
    const { task } = newTask([site.tenantId]);
    await task.runOnce();
    expect(await rowOf(site)).toMatchObject({
      status: 'no_sample',
      objects: 0,
      bytesPerDay: null,
      truncated: false,
    });
  });

  it('duas réplicas: uma por vez; o sinal deixa o pedido como estava', async () => {
    const site = await idle('sinal');
    await ask(site);
    const { task, s3, name } = newTask([site.tenantId]);
    const other = newTask([site.tenantId], { name });
    const controller = new AbortController();
    s3.onList = async () => {
      expect(await other.task.runOnce()).toMatchObject({ status: 'locked' });
      controller.abort(new DOMException('parada', 'AbortError'));
      return awsFault('AbortError', 0);
    };
    await expect(task.runOnce(controller.signal)).rejects.toThrow();
    expect((await rowOf(site)).requestedAt).not.toBeNull();
    expect(other.s3.calls).toEqual([]);
    s3.onList = () => undefined;
    expect(await task.runOnce()).toMatchObject({ noSample: 1 });
  });

  it('o gzip comum tem o tamanho certo no fim', () => {
    const text = Buffer.from('x'.repeat(5_000));
    expect(gzipSync(text).readUInt32LE(gzipSync(text).length - 4)).toBe(5_000);
  });

  describe('o portão no worker', () => {
    const deps = () => {
      const warn = vi.fn();
      return { prisma, credentials: new FakeCredentials(), logger: { warn }, warn };
    };

    it('desligado, na célula ou sem identidade na AWS: nenhuma tarefa', async () => {
      const off = [
        { AWS_WEB_LOGS_ENABLED: false, NODE_MODE: 'dedicated' },
        { AWS_WEB_LOGS_ENABLED: true, NODE_MODE: 'cell' },
      ] as const;
      for (const config of off) {
        const { tasks, close } = await webLogsTasks(config, deps());
        expect(tasks).toEqual([]);
        await close();
      }
      const noIdentity = await webLogsTasks(
        { AWS_WEB_LOGS_ENABLED: true, NODE_MODE: 'dedicated' },
        { ...deps(), credentials: null },
      );
      expect(noIdentity.tasks).toEqual([]);
    });

    it('ligado: as duas tarefas, com os nomes da concessão e os orçamentos dentro do intervalo', async () => {
      const { tasks, close } = await webLogsTasks(
        { AWS_WEB_LOGS_ENABLED: true, NODE_MODE: 'dedicated' },
        deps(),
      );
      expect(tasks.map(({ name, intervalMs, budgetMs }) => ({ name, intervalMs, budgetMs }))).toEqual([
        { name: 'web-logs', intervalMs: 120_000, budgetMs: 480_000 },
        { name: 'web-logs-estimate', intervalMs: 30_000, budgetMs: 240_000 },
      ]);
      await close();
    });

    it('a tabela de países que não abre não impede nada: avisa, e segue sem o país', async () => {
      const { logger, warn } = deps();
      expect(await loadCountries(logger, () => Promise.reject(new Error('dados corrompidos')))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('corrompidos');
      expect((await loadCountries(logger))?.size).toBeGreaterThan(200);
    });
  });

  it('sem a tabela de países, a leitura segue e o tráfego sai como ZZ', async () => {
    const site = await h.newSite('sem países');
    const { task, s3 } = h.newTask([site.tenantId], { countries: null });
    deliver(
      s3,
      site.balancer,
      NOON,
      times(3, (i) => ({ client: `192.0.2.${i}` })),
    );
    expect(await task.runOnce()).toMatchObject({ objects: 1, lines: 3 });
    expect(await h.traffic(site)).toMatchObject([{ country: 'ZZ', cls: 'direct', requests: 3 }]);
  });
});
