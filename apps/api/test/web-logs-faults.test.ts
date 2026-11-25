import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { AWS_SOURCE_STATES } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AwsConnectionError } from '../src/aws/web-identity.js';
import { abortableSleep } from '../src/aws/findings/throttle.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { READ_LIMITS } from '../src/weblogs/collect/object-reader.js';
import {
  WEB_LOGS_BACKOFF,
  WEB_LOGS_REFUSAL_BACKOFF,
  WEB_LOGS_RUN_AMOUNTS,
} from '../src/weblogs/collect/web-logs-job.js';
import { times } from './support/alb-lines.js';
import { awsFault, deliver, gzipLines, linesOf } from './support/fake-alb-s3.js';
import { HOUR, MINUTE, NOON, type Site, SLOT, START, webLogsHarness } from './support/web-logs-harness.js';

/** O S3 que falha, os arquivos hostis e os limites da tarefa `web-logs`: tudo contado e à vista, nada pulado em silêncio. */
describe('tarefa web-logs: falhas do S3, arquivos hostis e limites', () => {
  let prisma: PrismaService;
  let h: ReturnType<typeof webLogsHarness>;

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    h = webLogsHarness(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const visits = (endMs: number, count: number, client = '192.0.2.10') =>
    times(count, () => ({ client, path: '/', time: endMs - MINUTE }));
  const failures = (endMs: number, count: number) =>
    times(count, (i) => ({
      client: '198.51.100.7',
      method: 'POST',
      path: '/login',
      status: 401,
      time: endMs - 4 * MINUTE + i * 1_000,
    }));
  /** Linhas que não se repetem (as de verdade têm identificadores aleatórios): a compactação é a de um log comum. */
  const noise = (count: number) =>
    gzipLines(
      linesOf(
        NOON,
        times(count, () => ({ client: '192.0.2.10', path: `/${randomBytes(12).toString('hex')}` })),
      ),
    );
  const billed = async (site: Site) => (await h.usage(site)).day?.events ?? 0;
  const at = (clock: { now: () => Date; advance: (ms: number) => void }, ms: number) =>
    clock.advance(ms - clock.now().getTime());

  describe('a AWS recusa, limita ou não responde', () => {
    const cases: [string, 'list' | 'get', Error, string, string][] = [
      ['listagem negada', 'list', awsFault('AccessDenied', 403), 'permission_error', 'bucket_denied'],
      ['bucket que não existe', 'list', awsFault('NoSuchBucket', 404), 'permission_error', 'bucket_missing'],
      ['leitura negada', 'get', awsFault('AccessDenied', 403), 'permission_error', 's3:GetObject'],
      ['chave KMS negada', 'get', awsFault('KMS.DisabledException'), 'permission_error', 'kms_denied'],
    ];
    it.each(cases)(
      '%s: o motivo na fonte, recuo longo, e a volta sozinha',
      async (name, where, fault, state, code) => {
        const site = await h.newSite(name);
        const { task, s3, clock } = h.newTask([site.tenantId]);
        deliver(s3, site.balancer, NOON, visits(NOON, 3));
        if (where === 'list') s3.onList = () => fault;
        else s3.onGet = () => ({ error: fault });
        const report = await task.runOnce();
        expect(report).toMatchObject({ failed: 1, synced: 0, objects: 0, failures: { [code]: 1 } });
        expect(JSON.stringify(report)).not.toContain('mensagem da AWS');
        const row = await h.sourceRow(site);
        expect(row).toMatchObject({ state, stateCode: code, permission: 'missing', permissionDetail: code });
        expect((await h.cursor(site)).nextRunAt).toEqual(
          new Date(START.getTime() + WEB_LOGS_REFUSAL_BACKOFF.baseMs),
        );
        expect((await h.audit(site)).at(-1)?.after).toMatchObject({ state, stateCode: code });
        // Nada se perde: a volta lê o que ficou.
        s3.onList = () => undefined;
        s3.onGet = () => undefined;
        at(clock, NOON + 20 * MINUTE);
        expect(await task.runOnce()).toMatchObject({ synced: 1, objects: 1 });
        expect(await h.sourceRow(site)).toMatchObject({
          state: 'collecting',
          permission: 'granted',
          permissionDetail: null,
        });
        expect(await billed(site)).toBe(3);
      },
    );

    it('a permissão que faltava na leitura só volta com uma leitura', async () => {
      const site = await h.newSite('sem prova', {
        source: {
          permission: 'missing',
          permissionDetail: 's3:GetObject',
          state: 'permission_error',
          stateCode: 's3:GetObject',
        },
      });
      const { task, s3, clock } = h.newTask([site.tenantId]);
      await task.runOnce();
      expect(await h.sourceRow(site)).toMatchObject({ state: 'permission_error', permission: 'missing' });
      deliver(s3, site.balancer, NOON + SLOT, visits(NOON, 1));
      at(clock, NOON + 7 * MINUTE);
      await task.runOnce();
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting', permission: 'granted' });
    });

    it('limite de requisições: tenta de novo na hora e, se persiste, só na terceira passagem vira erro', async () => {
      const site = await h.newSite('limite');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, visits(NOON, 2));
      let left = 2;
      s3.onList = () => (left-- > 0 ? awsFault('SlowDown', 503) : undefined);
      expect(await task.runOnce()).toMatchObject({ synced: 1, objects: 1, throttled: 2, failed: 0 });
      s3.onList = () => awsFault('SlowDown', 503);
      const states: (string | null)[] = [];
      let nowMs = NOON + 7 * MINUTE;
      for (let i = 0; i < 3; i += 1) {
        at(clock, nowMs);
        expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { throttled: 1 } });
        const row = await h.sourceRow(site);
        states.push(row.state, row.stateCode);
        nowMs = (await h.cursor(site)).nextRunAt.getTime();
      }
      expect(states).toEqual(['collecting', null, 'collecting', null, 'ingestion_error', 'throttled']);
      expect((await h.cursor(site)).failures).toBe(3);
      s3.onList = () => undefined;
      at(clock, nowMs);
      await task.runOnce();
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting', stateCode: null });
    });

    it('listagem que não responde: o tempo por chamada', async () => {
      const site = await h.newSite('tempo da listagem');
      const { task, s3 } = h.newTask([site.tenantId]);
      s3.onList = () => awsFault('TimeoutError', 0);
      expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { TimeoutError: 1 } });
      expect((await h.cursor(site)).nextRunAt).toEqual(new Date(START.getTime() + WEB_LOGS_BACKOFF.baseMs));
    });

    it('corpo que para de vir: o tempo sem pedaço novo, e o tempo do objeto inteiro', async () => {
      for (const options of [{ readLimits: { ...READ_LIMITS, idleMs: 150 } }, { objectTimeoutMs: 150 }]) {
        const site = await h.newSite('corpo parado');
        const { task, s3 } = h.newTask([site.tenantId], options);
        deliver(s3, site.balancer, NOON, noise(5_000));
        s3.onGet = () => ({ stallAt: 20 });
        const started = performance.now();
        expect(await task.runOnce()).toMatchObject({ failed: 1, objectFailures: 1, objects: 0 });
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(s3.open).toBe(0);
        expect(await h.ledger(site)).toEqual([]);
      }
    });

    it('a entrada no papel recusada: a fonte fica como está, e nenhuma chamada sai', async () => {
      const site = await h.newSite('papel recusado');
      const { task, s3, clock, credentials } = h.newTask([site.tenantId]);
      credentials.failures.set(site.balancer.account, new AwsConnectionError('trust_denied', true));
      expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { trust_denied: 1 } });
      expect(s3.calls).toEqual([]);
      expect(await h.sourceRow(site)).toMatchObject({ state: 'authorized' });
      // De novo só no intervalo de sempre (a autorização recente é lida já: o estado é outro aqui).
      await prisma.awsSource.update({ where: { id: site.sourceId }, data: { state: 'collecting' } });
      at(clock, NOON + 3 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ notDue: 1, failed: 0 });
      expect(credentials.sessions).toHaveLength(1);
    });

    it('o objeto apagado no meio não é falha; o arquivado é posto de lado', async () => {
      const site = await h.newSite('apagado');
      const { task, s3 } = h.newTask([site.tenantId]);
      const gone = deliver(s3, site.balancer, NOON, visits(NOON, 1));
      const archived = deliver(s3, site.balancer, NOON - SLOT, visits(NOON, 1));
      s3.onGet = (call) =>
        call.key === gone
          ? { error: awsFault('NoSuchKey', 404) }
          : call.key === archived
            ? { error: awsFault('InvalidObjectState', 403) }
            : undefined;
      expect(await task.runOnce()).toMatchObject({ gone: 1, quarantined: 1, failed: 0, synced: 1 });
      expect(await h.ledger(site)).toMatchObject([{ status: 'quarantined' }]);
    });
  });

  describe('leitura interrompida', () => {
    it.each([
      ['com erro de rede', { cutAt: 4_000 }],
      ['sem erro nenhum', { cutAt: 4_000, quiet: true }],
    ])(
      'cortada %s: a volta não conta nenhuma linha duas vezes no motor, no plano nem no mapa',
      async (_, fault) => {
        const site = await h.newSite('cortada');
        const { task, s3, clock } = h.newTask([site.tenantId]);
        // 15 falhas: com as linhas contadas duas vezes, passariam de 20.
        const body = gzipLines([
          ...linesOf(NOON, failures(NOON, 15)),
          ...times(
            400,
            () =>
              linesOf(NOON, [{ client: '192.0.2.10', path: `/${randomBytes(24).toString('hex')}` }])[0] ?? '',
          ),
        ]);
        const key = deliver(s3, site.balancer, NOON, body);
        const other = deliver(s3, site.balancer, NOON, visits(NOON, 2), { node: '10.0.9.9' });
        expect(body.length).toBeGreaterThan(5_000);
        s3.onGet = (call) => (call.key === key ? fault : undefined);
        expect(await task.runOnce()).toMatchObject({ objectFailures: 1, objects: 1, synced: 1 });
        expect(s3.gets.map((call) => call.key)).toContain(other);
        expect(await h.requests(site)).toBe(2);
        s3.onGet = () => undefined;
        at(clock, NOON + 7 * MINUTE);
        expect(await task.runOnce()).toMatchObject({ objects: 1, lines: 415, objectFailures: 0 });
        expect(await h.findings(site)).toEqual([]);
        expect(await billed(site)).toBe(417);
        expect(await h.requests(site)).toBe(417);
        expect((await h.traffic(site)).find((row) => row.country === 'US')).toMatchObject({
          requests: 15,
          flagged: 15,
        });
      },
    );

    it('sem nenhum objeto lido, é a fonte que falhou; com algum, o que insiste em falhar é posto de lado', async () => {
      const site = await h.newSite('insistente');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      const bad = deliver(s3, site.balancer, NOON, visits(NOON, 3));
      s3.onGet = (call) => (call.key === bad ? { cutAt: 10 } : undefined);
      expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { NetworkError: 1 } });
      let quarantined = 0;
      for (let i = 1; i <= 8; i += 1) {
        const endMs = NOON + i * SLOT;
        deliver(s3, site.balancer, endMs, visits(endMs, 1));
        at(clock, endMs + MINUTE);
        quarantined += (await task.runOnce()).quarantined;
      }
      expect(quarantined).toBe(1);
      expect((await h.ledger(site)).filter((row) => row.status === 'quarantined')).toHaveLength(1);
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting', stateCode: 'web_quarantined' });
      expect(await billed(site)).toBe(8);
    });

    it('falhas demais numa passagem: a leitura para, e o resto fica para a próxima', async () => {
      const site = await h.newSite('falhas demais');
      const { task, s3 } = h.newTask([site.tenantId]);
      const ok = deliver(s3, site.balancer, NOON - 10 * SLOT, visits(NOON, 1));
      for (let i = 0; i < 30; i += 1) deliver(s3, site.balancer, NOON, visits(NOON, 1), { random: `f${i}` });
      s3.onGet = (call) => (call.key === ok ? undefined : { cutAt: 1 });
      expect(await task.runOnce()).toMatchObject({ objectFailures: 10, objects: 1, capped: 1 });
      const none = await h.newSite('nenhum lido');
      const second = h.newTask([none.tenantId]);
      for (let i = 0; i < 30; i += 1)
        deliver(second.s3, none.balancer, NOON, visits(NOON, 1), { random: `f${i}` });
      second.s3.onGet = () => ({ cutAt: 1 });
      expect(await second.task.runOnce()).toMatchObject({ objectFailures: 3, failed: 1 });
    });
  });

  describe('arquivos hostis', () => {
    const line = (spec = {}) => linesOf(NOON, [{ client: '192.0.2.10', ...spec }])[0] ?? '';

    it('gzip quebrado, cortado na origem, bomba, texto puro e grande demais: postos de lado, sem cobrança nem análise', async () => {
      const site = await h.newSite('hostis');
      const limits = {
        ...READ_LIMITS,
        compressed: 200_000,
        decompressed: 4_000_000,
        ratioFloor: 100_000,
        lines: 20_000,
      };
      const { task, s3, clock } = h.newTask([site.tenantId], { readLimits: limits });
      const random = (count: number) =>
        times(count, () => line({ path: `/${randomBytes(40).toString('hex')}` }));
      const good = gzipLines(random(50));
      const broken = Buffer.from(good);
      broken.fill(0x55, Math.floor(good.length / 2), Math.floor(good.length / 2) + 40);
      const bodies: [string, Buffer][] = [
        ['quebrado', broken],
        ['cortado', good.subarray(0, good.length - 30)],
        ['texto', Buffer.from(random(2).join('\n'))],
        ['bomba', gzipSync(Buffer.alloc(3_000_000, 'a'))],
        ['linhas', gzipSync(Buffer.from('a\n'.repeat(1) + times(21_000, (i) => `${i}`).join('\n')))],
        ['inflado', gzipSync(Buffer.from(random(10_000).join('\n').slice(0, 5_000_000)), { level: 9 })],
      ];
      for (const [name, body] of bodies) deliver(s3, site.balancer, NOON, body, { random: name });
      // Maior que o teto compactado: nem é aberto.
      const huge = deliver(s3, site.balancer, NOON, good, { random: 'imenso', size: 200_001 });
      const own = deliver(s3, site.balancer, NOON, visits(NOON, 4), { random: 'bom' });
      const report = await task.runOnce();
      expect(report).toMatchObject({ objects: 1, quarantined: 7, lines: 4, failed: 0, synced: 1 });
      expect(s3.gets.map((call) => call.key)).not.toContain(huge);
      expect(s3.gets.map((call) => call.key)).toContain(own);
      const rows = await h.ledger(site);
      expect(rows.filter((row) => row.status === 'quarantined')).toHaveLength(7);
      expect(rows.filter((row) => row.status === 'quarantined').every((row) => row.bytes === 0n)).toBe(true);
      expect(await billed(site)).toBe(4);
      expect(await h.requests(site)).toBe(4);
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting', stateCode: 'web_quarantined' });
      // Registrados: não são abertos de novo.
      const before = s3.gets.length;
      at(clock, NOON + 7 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ quarantined: 0, objects: 0 });
      expect(s3.gets).toHaveLength(before);
    });

    it('a bomba para cedo: pouco é lido e nada fica aberto', async () => {
      const site = await h.newSite('bomba');
      const { task, s3 } = h.newTask([site.tenantId]);
      // 300 MB de um byte só: 1.000 vezes o compactado.
      deliver(s3, site.balancer, NOON, gzipSync(Buffer.alloc(300_000_000, 0x41)));
      const started = performance.now();
      expect(await task.runOnce()).toMatchObject({ quarantined: 1, oversize: 0 });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(s3.open).toBe(0);
    });

    it('arquivo vazio conta como lido, sem ser aberto', async () => {
      const site = await h.newSite('vazio');
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, Buffer.alloc(0));
      deliver(s3, site.balancer, NOON, gzipLines([]), { random: 'semlinha' });
      expect(await task.runOnce()).toMatchObject({ objects: 2, lines: 0, quarantined: 0 });
      expect(s3.gets).toHaveLength(1);
      expect(await h.usage(site)).toEqual({ month: null, day: null });
    });

    it('gzip de vários membros é lido inteiro', async () => {
      const site = await h.newSite('membros');
      const { task, s3 } = h.newTask([site.tenantId]);
      const part = gzipLines(linesOf(NOON, visits(NOON, 5)));
      deliver(s3, site.balancer, NOON, Buffer.concat([part, part, part]));
      expect(await task.runOnce()).toMatchObject({ objects: 1, lines: 15 });
    });

    it('o que a descoberta guardou e não serve: nenhuma chamada, e o motivo já na primeira vez', async () => {
      const broken: [string, Record<string, unknown>, string][] = [
        ['sem bucket', { bucket: undefined }, 'invalid_details'],
        ['bucket inválido', { bucket: 'Bucket Errado' }, 'invalid_details'],
        [
          'ARN de NLB',
          { arn: 'arn:aws:elasticloadbalancing:sa-east-1:111111111111:loadbalancer/net/x/0123456789abcdef' },
          'invalid_details',
        ],
        [
          'prefixo de outra conta',
          { prefix: 'AWSLogs/222222222222/elasticloadbalancing/sa-east-1/' },
          'invalid_details',
        ],
      ];
      for (const [name, change, code] of broken) {
        const site = await h.newSite(name);
        const row = await h.sourceRow(site);
        await prisma.awsSource.update({
          where: { id: site.sourceId },
          data: { details: { ...(row.details as Record<string, unknown>), ...change } as never },
        });
        const { task, s3, credentials } = h.newTask([site.tenantId]);
        expect(await task.runOnce()).toMatchObject({ failed: 1, failures: { [code]: 1 } });
        expect([name, s3.calls.length, credentials.sessions.length]).toEqual([name, 0, 0]);
        expect(await h.sourceRow(site)).toMatchObject({ state: 'ingestion_error', stateCode: code });
      }
      const spaced = await h.newSite('prefixo com espaço', { prefix: 'meus logs' });
      const { task, s3 } = h.newTask([spaced.tenantId]);
      expect(await task.runOnce()).toMatchObject({ failures: { web_prefix_unsupported: 1 } });
      expect(s3.calls).toEqual([]);
    });
  });

  describe('orçamento', () => {
    it.each([
      ['objetos', { ...WEB_LOGS_RUN_AMOUNTS, objects: 3 }],
      ['linhas', { ...WEB_LOGS_RUN_AMOUNTS, lines: 25 }],
      ['bytes', { ...WEB_LOGS_RUN_AMOUNTS, bytes: 18_000 }],
    ])('de %s: para, segue na execução seguinte e conta tudo uma vez', async (_, amounts) => {
      const site = await h.newSite('orçamento');
      const { task, s3, clock } = h.newTask([site.tenantId], { amounts });
      for (let i = 0; i < 10; i += 1) {
        const endMs = NOON - i * SLOT;
        deliver(s3, site.balancer, endMs, visits(endMs, 10));
      }
      const first = await task.runOnce();
      expect(first.capped).toBe(1);
      expect(first.objects).toBeGreaterThan(0);
      expect(first.objects).toBeLessThan(10);
      // A posição não passa do que ficou por ler.
      const waiting = NOON - (10 - first.objects) * SLOT + SLOT;
      expect((await h.cursor(site)).cursorAt?.getTime()).toBeLessThan(waiting);
      let objects = first.objects;
      for (let i = 1; i <= 8 && objects < 10; i += 1) {
        // O que ficou para trás não espera os 5 minutos.
        clock.advance(2 * MINUTE);
        objects += (await task.runOnce()).objects;
      }
      expect(objects).toBe(10);
      expect(await billed(site)).toBe(100);
      expect((await h.ledger(site)).map((row) => row.status)).toEqual(times(10, () => 'read'));
    });

    it('o slot por ler não fecha: a janela é avaliada inteira quando o resto chega', async () => {
      const site = await h.newSite('janela adiada');
      const { task, s3, clock } = h.newTask([site.tenantId], {
        amounts: { ...WEB_LOGS_RUN_AMOUNTS, objects: 1 },
      });
      // Dois arquivos de um slot que, pelo relógio de agora, já teria fechado.
      const endMs = NOON - 4 * SLOT;
      deliver(s3, site.balancer, endMs, failures(endMs, 12), { random: 'um' });
      deliver(s3, site.balancer, endMs, failures(endMs, 12), { random: 'dois' });
      expect(await task.runOnce()).toMatchObject({ objects: 1, capped: 1, findings: 0 });
      clock.advance(2 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, late: 0, findings: 1 });
    });

    it('o tempo da execução acaba: o que não começou fica para a próxima, sem perder a vez', async () => {
      const tenantId = await h.newTenant('tempo');
      const sites = [];
      for (let i = 0; i < 3; i += 1)
        sites.push(await h.newSite(`tempo ${i}`, { tenantId, lb: `app/t${i}/000000000000000${i}` }));
      let elapsed = 0;
      const { task, s3 } = h.newTask([tenantId], { elapsed: () => elapsed, concurrency: 1 });
      for (const site of sites) {
        await h.setCursor(site, new Date(NOON - 10 * MINUTE));
        deliver(s3, site.balancer, NOON, visits(NOON, 1));
      }
      s3.onGet = () => {
        elapsed += 5 * MINUTE;
        return undefined;
      };
      expect(await task.runOnce()).toMatchObject({ deferred: 2, objects: 1 });
      elapsed = 0;
      s3.onGet = () => undefined;
      expect(await task.runOnce()).toMatchObject({ deferred: 0, notDue: 1, objects: 2 });
    });

    it('um balanceador cheio não come a vez dos outros', async () => {
      const tenantId = await h.newTenant('vez');
      const heavy = await h.newSite('cheio', { tenantId, lb: 'app/cheio/0000000000000001' });
      const light = await h.newSite('leve', { tenantId, lb: 'app/leve/0000000000000002' });
      const { task, s3 } = h.newTask([tenantId], {
        amounts: { ...WEB_LOGS_RUN_AMOUNTS, objects: 6 },
        concurrency: 1,
      });
      for (let i = 0; i < 12; i += 1)
        deliver(s3, heavy.balancer, NOON - i * SLOT, visits(NOON - i * SLOT, 1));
      deliver(s3, light.balancer, NOON, visits(NOON, 1));
      await task.runOnce();
      expect(await billed(light)).toBeGreaterThan(0);
      expect(await h.requests(light)).toBe(1);
      expect(await h.requests(heavy)).toBe(5);
    });
  });

  describe('parada e estado', () => {
    it('o sinal do agendador para a leitura onde está, fecha o corpo e devolve a concessão', async () => {
      const site = await h.newSite('parada');
      const { task, s3, clock, lease } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, noise(5_000));
      const controller = new AbortController();
      s3.onGet = () => {
        setTimeout(() => controller.abort(new DOMException('o worker está parando', 'AbortError')), 50);
        return { stallAt: 20 };
      };
      await expect(task.runOnce(controller.signal)).rejects.toThrow();
      expect(s3.open).toBe(0);
      expect(await h.ledger(site)).toEqual([]);
      expect(await prisma.syncState.findUniqueOrThrow({ where: { name: lease } })).toMatchObject({
        leaseOwner: null,
      });
      s3.onGet = () => undefined;
      const again = h.newTask([site.tenantId], { s3, clock, lease });
      expect(await again.task.runOnce()).toMatchObject({ status: 'done', objects: 1 });
      expect(await billed(site)).toBe(5_000);
    });

    it('a espera de uma nova tentativa também para com o sinal', async () => {
      const site = await h.newSite('parada na espera');
      const { task, s3 } = h.newTask([site.tenantId], {
        sleep: abortableSleep,
        throttle: { attempts: 3, baseMs: 60_000, maxMs: 60_000 },
      });
      const controller = new AbortController();
      s3.onList = () => {
        setTimeout(() => controller.abort(new DOMException('o worker está parando', 'AbortError')), 30);
        return awsFault('SlowDown', 503);
      };
      const started = performance.now();
      await expect(task.runOnce(controller.signal)).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(5_000);
    });

    it('parada (`stalled`) só com arquivo mais novo à espera e nada lido há 2 h', async () => {
      const site = await h.newSite('parada com arquivo');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, visits(NOON, 1));
      await task.runOnce();
      // Um site quieto não para: 5 h sem arquivo nenhum.
      for (let i = 1; i <= 10; i += 1) {
        at(clock, NOON + i * 30 * MINUTE);
        await task.runOnce();
      }
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting' });
      // Agora há arquivo, e todos falham menos um vazio (a leitura não é da fonte inteira).
      const endMs = NOON + 5 * HOUR;
      for (let i = 0; i < 12; i += 1)
        deliver(s3, site.balancer, endMs, visits(endMs, 1), { random: `p${i}` });
      const stuck = h.newTask([site.tenantId], {
        s3,
        clock,
        lease: 'outra' + String(Math.random()),
        amounts: { ...WEB_LOGS_RUN_AMOUNTS, objects: 0 },
      });
      at(clock, endMs + 6 * MINUTE);
      await stuck.task.runOnce();
      expect(await h.sourceRow(site)).toMatchObject({ state: 'stalled', stateCode: 'web_unread' });
      at(clock, endMs + 12 * MINUTE);
      const back = h.newTask([site.tenantId], { s3, clock, lease: 'volta' + String(Math.random()) });
      expect(await back.task.runOnce()).toMatchObject({ objects: 12 });
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting', stateCode: null });
    });

    it('todo estado gravado é do catálogo', async () => {
      const rows = await prisma.awsSource.findMany({
        where: { kind: 'elb_logs' },
        select: { state: true, stateCode: true },
      });
      expect(rows.length).toBeGreaterThan(20);
      for (const row of rows) {
        expect(AWS_SOURCE_STATES as readonly string[]).toContain(row.state);
        expect(row.stateCode ?? 'x').toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
      }
    });
  });
});
