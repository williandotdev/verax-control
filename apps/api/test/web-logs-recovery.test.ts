import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { FindingStore } from '../src/alerts/finding-store.js';
import { lockAwsOnboarding } from '../src/aws/discovery/discovery-runs.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { AlertNotices } from '../src/notifications/finding-notices.js';
import { WEB_LOGS_RUN_AMOUNTS } from '../src/weblogs/collect/web-logs-job.js';
import { times } from './support/alb-lines.js';
import { deliver } from './support/fake-alb-s3.js';
import { HOUR, MINUTE, NOON, type Site, SLOT, START, webLogsHarness } from './support/web-logs-harness.js';

/** A gravação de verdade, para os testes que põem algo antes ou depois dela. */
const realPersist = Object.getOwnPropertyDescriptor(FindingStore.prototype, 'persist')?.value as (
  this: FindingStore,
  ...args: Parameters<FindingStore['persist']>
) => ReturnType<FindingStore['persist']>;

/**
 * A tarefa `web-logs` quando algo dá errado ou chega fora de hora: atrasados, repetidos, reinícios, quedas em cada ponto,
 * duas réplicas, atraso, lacuna, retirada e balanceador trocado. O que se confere sempre: nenhuma linha contada duas vezes
 * no plano nem no mapa, nenhum achado duplicado e nenhum perdido.
 */
describe('tarefa web-logs: fora do caminho comum', () => {
  let prisma: PrismaService;
  let h: ReturnType<typeof webLogsHarness>;

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    h = webLogsHarness(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Falhas de login de um endereço, espalhadas nos 4 minutos antes do fim do intervalo. */
  const failures = (endMs: number, count: number, client = '198.51.100.7', path = '/login') =>
    times(count, (i) => ({
      client,
      method: 'POST',
      path,
      status: 401,
      time: endMs - 4 * MINUTE + Math.floor((i * 3 * MINUTE) / count),
    }));
  const visits = (endMs: number, count: number, client = '192.0.2.10') =>
    times(count, () => ({ client, path: '/', time: endMs - MINUTE }));
  const keysOf = async (site: Site) => (await h.findings(site)).map((row) => row.sourceEventId);
  const billed = async (site: Site) => (await h.usage(site)).day?.events ?? 0;
  const statuses = async (site: Site) => (await h.ledger(site)).map((row) => row.status);
  const at = (clock: { now: () => Date; advance: (ms: number) => void }, ms: number) =>
    clock.advance(ms - clock.now().getTime());

  describe('entrega', () => {
    it('objetos fora de ordem e de vários nós somam na mesma janela', async () => {
      const site = await h.newSite('fora de ordem');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      // 8 falhas em cada um de três arquivos: só a janela de 15 minutos passa de 20. O mais novo chega primeiro.
      deliver(s3, site.balancer, NOON + SLOT, failures(NOON + SLOT, 8));
      at(clock, NOON + SLOT + MINUTE);
      await task.runOnce();
      expect(await h.findings(site)).toEqual([]);
      deliver(s3, site.balancer, NOON, failures(NOON, 8), { node: '10.0.9.9' });
      deliver(s3, site.balancer, NOON + SLOT, failures(NOON + SLOT, 8), { node: '10.0.9.9' });
      at(clock, NOON + 12 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 2, findings: 1 });
      expect(await billed(site)).toBe(24);
    });

    it('o atrasado é avaliado sozinho, como piso, e marcado; o de ontem na pasta de hoje é achado pela conferência', async () => {
      const site = await h.newSite('atrasado');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, visits(NOON, 3));
      await task.runOnce();
      at(clock, NOON + 30 * MINUTE);
      // Dentro dos 70 minutos, com o intervalo já fechado.
      deliver(s3, site.balancer, NOON - 10 * MINUTE, failures(NOON - 10 * MINUTE, 30), { random: 'tarde1' });
      expect(await task.runOnce()).toMatchObject({ objects: 1, late: 1, findings: 1 });
      const [finding] = await h.findings(site);
      const evidence = await prisma.findingEvidence.findFirstOrThrow({
        where: { findingId: finding?.id ?? '' },
      });
      expect((evidence.data as { notes: string[] }).notes).toEqual(
        expect.arrayContaining(['late_object', 'counts_are_floor']),
      );
      // Muito depois, fora da listagem ao vivo: só a conferência de hora em hora o acha.
      deliver(s3, site.balancer, NOON - 3 * HOUR, failures(NOON - 3 * HOUR, 40, '198.51.100.60'), {
        random: 'tarde2',
      });
      at(clock, NOON + 40 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 0 });
      at(clock, NOON + 75 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, late: 1 });
      expect(await statuses(site)).toEqual(['late', 'late', 'read']);
      expect(await billed(site)).toBe(73);
      // Nada é lido de novo.
      at(clock, NOON + 140 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 0, replayed: 0 });
      expect(await billed(site)).toBe(73);
    });

    it('muitos atrasados de uma vez: mais intervalos do que o motor guarda, todos lidos', async () => {
      const site = await h.newSite('muitos atrasados', { authorizedAt: new Date(NOON - 12 * HOUR) });
      await h.setCursor(site, new Date(NOON - 10 * MINUTE));
      const { task, s3 } = h.newTask([site.tenantId]);
      for (let i = 0; i < 20; i += 1) {
        const endMs = NOON - 3 * HOUR + i * SLOT;
        deliver(s3, site.balancer, endMs, failures(endMs, 25, `198.51.100.${i + 1}`));
      }
      expect(await task.runOnce()).toMatchObject({ objects: 20, late: 20, capped: 0 });
      // Duas avaliações: 12 intervalos (10 achados e o resumo dos outros 2, o teto por regra) e os 8 que sobraram.
      expect((await h.findings(site)).filter((row) => row.ruleId === '990405')).toHaveLength(19);
      expect(await billed(site)).toBe(500);
    });

    it('perto da meia-noite, o arquivo de ontem entregue na pasta de hoje é lido', async () => {
      const midnight = Date.UTC(2026, 10, 25);
      const site = await h.newSite('meia-noite', { authorizedAt: new Date(midnight - 3 * HOUR) });
      const { task, s3, clock } = h.newTask([site.tenantId]);
      at(clock, midnight + 2 * MINUTE);
      deliver(s3, site.balancer, midnight - 10 * MINUTE, visits(midnight - 10 * MINUTE, 2));
      deliver(s3, site.balancer, midnight - 5 * MINUTE, visits(midnight - 5 * MINUTE, 3), {
        day: '2026-11-25',
      });
      deliver(s3, site.balancer, midnight, visits(midnight, 4));
      expect(await task.runOnce()).toMatchObject({ objects: 3, lines: 9, late: 0 });
      // Dias de Brasília do tráfego: 23:50 a 24:00 UTC são 21 h do mesmo dia 24.
      expect((await h.usage(site, new Date(midnight - HOUR))).day?.events).toBe(9);
    });

    it('com muitas páginas, nada se perde', async () => {
      const site = await h.newSite('páginas');
      const { task, s3 } = h.newTask([site.tenantId]);
      s3.pageSize = 7;
      for (let i = 0; i < 40; i += 1) {
        deliver(s3, site.balancer, NOON - (i % 10) * SLOT, visits(NOON - (i % 10) * SLOT, 1), {
          random: `n${i}`,
        });
      }
      expect(await task.runOnce()).toMatchObject({ objects: 40, lines: 40, capped: 0 });
      expect(await billed(site)).toBe(40);
    });

    it('o fim no futuro espera; a data absurda é posta de lado, à vista', async () => {
      const site = await h.newSite('futuro');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON + 40 * MINUTE, visits(NOON, 1), { day: '2026-11-24' });
      deliver(s3, site.balancer, NOON + 100 * 24 * HOUR, visits(NOON, 1), {
        day: '2026-11-24',
        random: 'longe',
      });
      expect(await task.runOnce()).toMatchObject({ objects: 0, future: 1, quarantined: 1 });
      expect(await h.ledger(site)).toMatchObject([
        { status: 'quarantined', slotStart: null, lines: 0, bytes: 0n },
      ]);
      expect(await h.sourceRow(site)).toMatchObject({ state: 'waiting_events' });
      at(clock, NOON + 41 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, future: 0, quarantined: 0 });
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting', stateCode: 'web_quarantined' });
    });
  });

  describe('reinício', () => {
    it('um processo novo refaz as janelas do S3, sem cobrar, somar nem duplicar nada', async () => {
      const site = await h.newSite('reinício');
      const { task, s3, clock, lease } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON - SLOT, failures(NOON - SLOT, 12));
      await task.runOnce();
      expect(await h.findings(site)).toEqual([]);
      await task.close();
      // A janela continua de onde estava: 12 de antes do reinício e 12 de depois.
      const again = h.newTask([site.tenantId], { s3, clock, lease });
      deliver(s3, site.balancer, NOON, failures(NOON, 12));
      at(clock, NOON + 7 * MINUTE);
      expect(await again.task.runOnce()).toMatchObject({ replayed: 1, objects: 1, findings: 1 });
      expect(await billed(site)).toBe(24);
      expect(await h.requests(site)).toBe(24);
      const keys = await keysOf(site);
      await again.task.close();
      const third = h.newTask([site.tenantId], { s3, clock, lease });
      at(clock, NOON + 13 * MINUTE);
      expect(await third.task.runOnce()).toMatchObject({ replayed: 2, objects: 0, findings: 0 });
      expect(await keysOf(site)).toEqual(keys);
      expect(await billed(site)).toBe(24);
      expect(await h.requests(site)).toBe(24);
    });

    it('o resumo do dia não encolhe com o reinício', async () => {
      const site = await h.newSite('resumo do dia');
      const { task, s3, clock, lease } = h.newTask([site.tenantId]);
      const probes = (endMs: number) =>
        times(12, (i) => ({
          client: '198.51.100.20',
          path: `/a${i}/.env`,
          status: 404,
          time: endMs - MINUTE,
        }));
      deliver(s3, site.balancer, NOON, probes(NOON));
      await task.runOnce();
      // Duas horas depois, o slot já saiu da memória e está no estado guardado.
      for (let ms = NOON + 10 * MINUTE; ms <= NOON + 2 * HOUR; ms += 10 * MINUTE) {
        at(clock, ms);
        await task.runOnce();
      }
      expect((await h.state(site))?.state.digest?.settledThrough).toBeGreaterThan(NOON / SLOT - 1);
      await task.close();
      const again = h.newTask([site.tenantId], { s3, clock, lease });
      deliver(s3, site.balancer, NOON + 2 * HOUR, [
        ...probes(NOON + 2 * HOUR).map((spec) => ({ ...spec, client: '198.51.100.21' })),
      ]);
      at(clock, NOON + 2 * HOUR + 6 * MINUTE);
      await again.task.runOnce();
      const [digest] = (await h.findings(site)).filter((row) => row.ruleId === '990400');
      expect(digest?.eventName).toContain('2 endereços no dia: 24 sondas');
    });

    it('o estado guardado que não serve é deixado de lado', async () => {
      const site = await h.newSite('estado estragado');
      await prisma.webEngineState.create({
        data: {
          sourceId: site.sourceId,
          tenantId: site.tenantId,
          loadBalancer: site.balancer.lb,
          version: 1,
          state: { digest: { version: 99 }, observation: [], suppressed: 'x' },
        },
      });
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, failures(NOON, 30));
      expect(await task.runOnce()).toMatchObject({ findings: 1, broken: 0 });
      expect((await h.state(site))?.state).toMatchObject({ suppressed: [] });
    });
  });

  describe('queda em cada ponto', () => {
    /** Uma falha do banco (ou do processo) num ponto, uma vez. */
    const boom = () => new Error('queda simulada');

    it('ao gravar o achado: nada entra no registro; a volta grava tudo uma vez', async () => {
      const site = await h.newSite('queda no achado');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, failures(NOON, 30));
      const spy = vi.spyOn(FindingStore.prototype, 'persist').mockRejectedValueOnce(boom());
      expect(await task.runOnce()).toMatchObject({ broken: 1, objects: 0 });
      spy.mockRestore();
      expect(await h.findings(site)).toEqual([]);
      expect(await h.ledger(site)).toEqual([]);
      expect(await billed(site)).toBe(0);
      at(clock, NOON + 7 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, findings: 1 });
      expect(await billed(site)).toBe(30);
      expect(await h.requests(site)).toBe(30);
    });

    it('depois do achado e antes do registro: o achado não duplica, e o volume entra uma vez', async () => {
      const site = await h.newSite('queda antes do registro');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, failures(NOON, 30));
      const reader = await import('../src/weblogs/collect/source-reader.js');
      const spy = vi
        .spyOn(reader.SourceReader.prototype as unknown as { settle: () => Promise<void> }, 'settle')
        .mockRejectedValueOnce(boom());
      expect(await task.runOnce()).toMatchObject({ broken: 1, findings: 1, objects: 0 });
      spy.mockRestore();
      const keys = await keysOf(site);
      expect(keys).toHaveLength(1);
      expect(await h.ledger(site)).toEqual([]);
      at(clock, NOON + 7 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, findings: 0 });
      expect(await keysOf(site)).toEqual(keys);
      expect(await billed(site)).toBe(30);
      expect(await h.requests(site)).toBe(30);
    });

    it('entre o registro e o commit: a transação inteira some, e a volta conta uma vez', async () => {
      const site = await h.newSite('queda no commit');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, visits(NOON, 9));
      const { UsageMeter } = await import('../src/usage/usage-meter.js');
      // O registro e o tráfego já foram escritos na transação; o medidor falha.
      const spy = vi.spyOn(UsageMeter.prototype, 'flushIn').mockRejectedValueOnce(boom());
      expect(await task.runOnce()).toMatchObject({ broken: 1, objects: 0 });
      spy.mockRestore();
      expect(await h.ledger(site)).toEqual([]);
      expect(await h.requests(site)).toBe(0);
      at(clock, NOON + 7 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1 });
      expect(await billed(site)).toBe(9);
      expect(await h.requests(site)).toBe(9);
    });

    it('no meio de um lote: o que já estava registrado fica, o resto é lido de novo, e tudo conta uma vez', async () => {
      const site = await h.newSite('queda no lote');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      for (let i = 0; i < 40; i += 1) deliver(s3, site.balancer, NOON, visits(NOON, 2), { random: `l${i}` });
      const { UsageMeter } = await import('../src/usage/usage-meter.js');
      const real = Object.getOwnPropertyDescriptor(UsageMeter.prototype, 'flushIn')?.value as (
        this: InstanceType<typeof UsageMeter>,
        ...args: Parameters<InstanceType<typeof UsageMeter>['flushIn']>
      ) => Promise<void>;
      let calls = 0;
      const spy = vi.spyOn(UsageMeter.prototype, 'flushIn').mockImplementation(async function (
        this: InstanceType<typeof UsageMeter>,
        ...args
      ) {
        calls += 1;
        if (calls === 31) throw boom();
        return real.apply(this, args);
      });
      expect(await task.runOnce()).toMatchObject({ broken: 1, objects: 30 });
      spy.mockRestore();
      expect(await h.ledger(site)).toHaveLength(30);
      expect(await billed(site)).toBe(60);
      at(clock, NOON + 7 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 10, replayed: 30 });
      expect(await billed(site)).toBe(80);
      expect(await h.requests(site)).toBe(80);
    });

    it('com o registro gravado e o processo morto antes da janela seguinte, a volta completa a janela', async () => {
      const site = await h.newSite('morte depois do registro');
      const { task, s3, clock, lease } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, failures(NOON, 12));
      await task.runOnce();
      expect(await statuses(site)).toEqual(['read']);
      // Sem `close`: a concessão do processo morto vence sozinha.
      await prisma.syncState.update({ where: { name: lease }, data: { leaseUntil: new Date(0) } });
      const other = h.newTask([site.tenantId], { s3, clock, lease });
      deliver(s3, site.balancer, NOON + SLOT, failures(NOON + SLOT, 12));
      at(clock, NOON + 7 * MINUTE);
      expect(await other.task.runOnce()).toMatchObject({ replayed: 1, objects: 1, findings: 1 });
      expect(await billed(site)).toBe(24);
    });

    it('o aviso que falha desfaz o achado inteiro', async () => {
      const site = await h.newSite('aviso que falha');
      const failing = new AlertNotices();
      vi.spyOn(failing, 'enqueue').mockRejectedValueOnce(boom());
      const { task, s3, clock } = h.newTask([site.tenantId], { notices: failing });
      deliver(s3, site.balancer, NOON, failures(NOON, 150));
      expect(await task.runOnce()).toMatchObject({ broken: 1 });
      expect(await h.findings(site)).toEqual([]);
      at(clock, NOON + 7 * MINUTE);
      await task.runOnce();
      expect(await h.findings(site)).toMatchObject([{ severity: 'high' }]);
      expect(await prisma.notification.count({ where: { tenantId: site.tenantId } })).toBe(1);
    });

    it('a falha de um balanceador não atrapalha o outro', async () => {
      const tenantId = await h.newTenant('um falha');
      const bad = await h.newSite('ruim', { tenantId });
      const good = await h.newSite('bom', { tenantId });
      const { task, s3 } = h.newTask([tenantId]);
      deliver(s3, bad.balancer, NOON, visits(NOON, 1));
      deliver(s3, good.balancer, NOON, visits(NOON, 2));
      s3.onList = (call) => {
        if (call.bucket === bad.balancer.bucket) throw new Error('falha sem nome');
        return undefined;
      };
      expect(await task.runOnce()).toMatchObject({ synced: 1, failed: 1, objects: 1 });
      expect(await h.requests(good)).toBe(2);
    });
  });

  describe('duas réplicas', () => {
    it('só uma lê; a outra espera a concessão, que continua entre as execuções', async () => {
      const site = await h.newSite('réplicas');
      const first = h.newTask([site.tenantId]);
      const { s3, clock, lease } = first;
      const second = h.newTask([site.tenantId], { s3, clock, lease });
      deliver(s3, site.balancer, NOON, failures(NOON, 12));
      expect((await first.task.runOnce()).status).toBe('done');
      at(clock, NOON + 3 * MINUTE);
      const calls = s3.calls.length;
      expect((await second.task.runOnce()).status).toBe('locked');
      expect(s3.calls).toHaveLength(calls);
      // A primeira devolve na parada; a segunda assume e refaz as janelas.
      await first.task.close();
      deliver(s3, site.balancer, NOON + SLOT, failures(NOON + SLOT, 12));
      at(clock, NOON + 7 * MINUTE);
      expect(await second.task.runOnce()).toMatchObject({ replayed: 1, objects: 1, findings: 1 });
      // A que volta não usa o que tinha na memória: a outra leu no meio.
      await second.task.close();
      at(clock, NOON + 13 * MINUTE);
      expect(await first.task.runOnce()).toMatchObject({ replayed: 2, objects: 0, findings: 0 });
      expect(await billed(site)).toBe(24);
    });

    it('a que teve a concessão tomada no meio não grava o estado nem cobra de novo', async () => {
      const site = await h.newSite('concessão tomada');
      const first = h.newTask([site.tenantId]);
      const { s3, clock, lease } = first;
      const second = h.newTask([site.tenantId], { s3, clock, lease });
      deliver(s3, site.balancer, NOON, visits(NOON, 5));
      let taken = false;
      s3.onGet = async () => {
        if (taken) return undefined;
        taken = true;
        // O processo parou aqui por mais que a concessão: a outra réplica assume, lê e termina.
        await prisma.syncState.update({ where: { name: lease }, data: { leaseUntil: new Date(0) } });
        expect(await second.task.runOnce()).toMatchObject({ status: 'done', objects: 1 });
        return undefined;
      };
      const report = await first.task.runOnce();
      expect(report.status).toBe('lease_lost');
      expect(await statuses(site)).toEqual(['read']);
      expect(await billed(site)).toBe(5);
      expect(await h.requests(site)).toBe(5);
    });
  });

  describe('atraso e lacuna', () => {
    it('depois de horas parado: primeiro o ao vivo, depois o atraso em ordem, com as janelas de quando aconteceu', async () => {
      const site = await h.newSite('atraso', { authorizedAt: new Date(NOON - 12 * HOUR) });
      const { task, s3, clock } = h.newTask([site.tenantId]);
      at(clock, NOON - 8 * HOUR + MINUTE);
      deliver(s3, site.balancer, NOON - 8 * HOUR, failures(NOON - 8 * HOUR, 12, '198.51.100.60'));
      await task.runOnce();
      await task.close();
      // Parado: 12 falhas logo depois da parada (somam com as 12 já registradas), um ataque no meio e um agora.
      deliver(
        s3,
        site.balancer,
        NOON - 8 * HOUR + SLOT,
        failures(NOON - 8 * HOUR + SLOT, 12, '198.51.100.60'),
      );
      deliver(s3, site.balancer, NOON - 5 * HOUR, failures(NOON - 5 * HOUR, 30, '198.51.100.40'));
      deliver(s3, site.balancer, NOON, failures(NOON, 30, '198.51.100.50'));
      at(clock, START.getTime());
      const again = h.newTask([site.tenantId], { s3, clock, lease: 'nova' + String(Math.random()) });
      const report = await again.task.runOnce();
      expect(report).toMatchObject({ objects: 3, backlog: 1, late: 0, gaps: 0, replayed: 1 });
      // O ao vivo antes do atraso.
      const order = s3.gets.map((call) => call.key);
      const firstLive = order.findIndex((key) => key.includes('T1200Z'));
      expect(firstLive).toBeLessThan(order.findIndex((key) => key.includes('T0405Z')));
      expect(firstLive).toBeLessThan(order.findIndex((key) => key.includes('T0700Z')));
      const ips = (await h.findings(site))
        .filter((row) => row.ruleId === '990405')
        .map((row) => row.sourceIp);
      expect(ips.sort()).toEqual(['198.51.100.40', '198.51.100.50', '198.51.100.60']);
      expect(await statuses(site)).toEqual(['read', 'read', 'read', 'read']);
      expect(await billed(site)).toBe(84);
      // Em dia de novo, no mesmo lugar em que estaria sem a parada.
      expect((await h.cursor(site)).cursorAt).toEqual(new Date(NOON - 10 * MINUTE));
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting', stateCode: null });
    });

    it('a janela dividida entre o atraso e o ao vivo é vista inteira', async () => {
      const site = await h.newSite('janela dividida', { authorizedAt: new Date(NOON - 12 * HOUR) });
      await h.setCursor(site, new Date(NOON - 8 * HOUR));
      const { task, s3 } = h.newTask([site.tenantId]);
      // O motor ao vivo começa 65 minutos antes de agora: 12 falhas de cada lado da divisa.
      const border = Math.ceil(START.getTime() / SLOT) * SLOT - 14 * SLOT;
      deliver(s3, site.balancer, border, failures(border, 12));
      deliver(s3, site.balancer, border + SLOT, failures(border + SLOT, 12));
      expect(await task.runOnce()).toMatchObject({ objects: 2, backlog: 1, replayed: 1 });
      expect(await h.findings(site)).toMatchObject([{ ruleId: '990405', sourceIp: '198.51.100.7' }]);
      expect(await billed(site)).toBe(24);
    });

    it('a conferência das pastas que não cabe numa passagem continua na seguinte', async () => {
      const site = await h.newSite('conferência em partes');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      for (let i = 0; i < 110; i += 1) {
        const endMs = NOON - Math.floor(i / 2) * SLOT;
        deliver(s3, site.balancer, endMs, visits(endMs, 1), { random: `n${i}` });
      }
      await task.runOnce();
      expect(await billed(site)).toBe(110);
      s3.pageSize = 2;
      deliver(s3, site.balancer, NOON - 2 * SLOT, visits(NOON - 2 * SLOT, 1), { random: 'zzz' });
      at(clock, NOON + 90 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 0 });
      at(clock, NOON + 96 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, late: 1 });
      const lists = s3.lists.length;
      at(clock, NOON + 102 * MINUTE);
      await task.runOnce();
      // Conferida: só a listagem ao vivo até a próxima hora.
      expect(s3.lists.length - lists).toBe(1);
      expect(await billed(site)).toBe(111);
    });

    it('sem arquivo nenhum no atraso, a posição anda sem motor e sem releitura', async () => {
      const site = await h.newSite('atraso vazio');
      await h.setCursor(site, new Date(NOON - 5 * HOUR));
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, visits(NOON, 1));
      expect(await task.runOnce()).toMatchObject({ objects: 1, capped: 0 });
      expect((await h.cursor(site)).cursorAt).toEqual(new Date(NOON - 10 * MINUTE));
      expect(s3.gets).toHaveLength(1);
    });

    it('o atraso maior que o orçamento continua de onde parou, e a leitura ao vivo não espera por ele', async () => {
      const site = await h.newSite('atraso em partes', { authorizedAt: new Date(NOON - 12 * HOUR) });
      await h.setCursor(site, new Date(NOON - 10 * HOUR));
      const { task, s3, clock } = h.newTask([site.tenantId], {
        amounts: { ...WEB_LOGS_RUN_AMOUNTS, objects: 10 },
      });
      for (let i = 0; i < 30; i += 1) {
        const endMs = NOON - 8 * HOUR + i * SLOT;
        deliver(s3, site.balancer, endMs, visits(endMs, 2));
      }
      deliver(s3, site.balancer, NOON, visits(NOON, 1));
      const first = await task.runOnce();
      expect(first).toMatchObject({ objects: 10, capped: 1 });
      expect(s3.gets[0]?.key).toContain('T1200Z');
      const positions = [(await h.cursor(site)).cursorAt?.getTime() ?? 0];
      for (let i = 1; i <= 6; i += 1) {
        at(clock, START.getTime() + i * 6 * MINUTE);
        if (i === 2) deliver(s3, site.balancer, NOON + 10 * MINUTE, visits(NOON + 10 * MINUTE, 1));
        await task.runOnce();
        positions.push((await h.cursor(site)).cursorAt?.getTime() ?? 0);
      }
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(await billed(site)).toBe(62);
      expect(await h.requests(site)).toBe(62);
      expect(new Set(await statuses(site))).toEqual(new Set(['read']));
      expect(positions.at(-1)).toBe(
        START.getTime() + 36 * MINUTE - ((START.getTime() + 36 * MINUTE) % SLOT) - 10 * MINUTE,
      );
    });

    it('um arquivo que falha no meio do atraso não o segura: volta como atrasado', async () => {
      const site = await h.newSite('atraso com falha', { authorizedAt: new Date(NOON - 12 * HOUR) });
      await h.setCursor(site, new Date(NOON - 5 * HOUR));
      const { task, s3, clock } = h.newTask([site.tenantId]);
      const bad = deliver(s3, site.balancer, NOON - 4 * HOUR, visits(NOON - 4 * HOUR, 3));
      deliver(s3, site.balancer, NOON - 3 * HOUR, visits(NOON - 3 * HOUR, 4));
      deliver(s3, site.balancer, NOON, visits(NOON, 1));
      s3.onGet = (call) => (call.key === bad ? { cutAt: 10 } : undefined);
      expect(await task.runOnce()).toMatchObject({ objects: 2, objectFailures: 1, failed: 0 });
      s3.onGet = () => undefined;
      at(clock, NOON + 65 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, late: 1 });
      expect(await billed(site)).toBe(8);
    });

    it('mais de 24 h: lacuna registrada por arquivo, contada, na trilha e no estado, sem leitura nem cobrança', async () => {
      const site = await h.newSite('lacuna', { authorizedAt: new Date(NOON - 5 * 24 * HOUR) });
      await h.setCursor(site, new Date(NOON - 3 * 24 * HOUR));
      const { task, s3, clock } = h.newTask([site.tenantId]);
      const old = [70, 60, 50, 30].map((hours) =>
        deliver(s3, site.balancer, NOON - hours * HOUR, failures(NOON - hours * HOUR, 40)),
      );
      // De ontem, com mais de 24 h: também é lacuna, e também aparece na conferência das pastas.
      old.push(deliver(s3, site.balancer, NOON - 24.5 * HOUR, visits(NOON - 24.5 * HOUR, 1)));
      // Já tratado antes da parada: não é lacuna.
      deliver(s3, site.balancer, NOON - 3.1 * 24 * HOUR, visits(NOON - 3.1 * 24 * HOUR, 1));
      const recent = deliver(s3, site.balancer, NOON - 10 * HOUR, visits(NOON - 10 * HOUR, 2));
      deliver(s3, site.balancer, NOON, visits(NOON, 3));
      expect(await task.runOnce()).toMatchObject({ gaps: 5, objects: 2, synced: 1 });
      expect(s3.gets.map((call) => call.key)).toContain(recent);
      for (const key of old) expect(s3.gets.map((call) => call.key)).not.toContain(key);
      const rows = await h.ledger(site);
      expect(rows.map((row) => row.status)).toEqual(['gap', 'gap', 'gap', 'gap', 'gap', 'read', 'read']);
      expect(
        rows.filter((row) => row.status === 'gap').every((row) => row.lines === 0 && row.bytes === 0n),
      ).toBe(true);
      expect(await h.findings(site)).toEqual([]);
      expect(await h.sourceRow(site)).toMatchObject({ state: 'ingestion_error', stateCode: 'web_gap' });
      const gaps = (await h.audit(site))
        .map((entry) => entry.after as { code?: string; objects?: number; from?: string; to?: string })
        .filter((after) => after.code === 'web_gap');
      expect(gaps.reduce((sum, gap) => sum + (gap.objects ?? 0), 0)).toBe(5);
      expect(gaps[0]).toMatchObject({ from: new Date(NOON - 70 * HOUR - SLOT).toISOString() });
      // A lacuna fica à vista por 24 h; a leitura segue.
      at(clock, NOON + 25 * HOUR);
      deliver(s3, site.balancer, NOON + 25 * HOUR, visits(NOON + 25 * HOUR, 1));
      const later = await task.runOnce();
      expect(later).toMatchObject({ gaps: 0 });
      expect(await h.sourceRow(site)).toMatchObject({ state: 'collecting', stateCode: null });
    });

    it('a parada de mais de nove dias salta para o que ainda dá para contar, com o registro na trilha', async () => {
      const site = await h.newSite('lacuna longa', { authorizedAt: new Date(NOON - 40 * 24 * HOUR) });
      await h.setCursor(site, new Date(NOON - 30 * 24 * HOUR));
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON - 20 * 24 * HOUR, visits(NOON, 1));
      deliver(s3, site.balancer, NOON - 8 * 24 * HOUR, visits(NOON, 1));
      expect(await task.runOnce()).toMatchObject({ gaps: 1, synced: 1 });
      const gaps = (await h.audit(site))
        .map((entry) => entry.after as { code?: string; objects?: number | null })
        .filter((after) => after.code === 'web_gap');
      expect(gaps.map((gap) => gap.objects)).toEqual([null, 1]);
      expect(s3.lists.length).toBeLessThan(120);
    });
  });

  describe('autorização', () => {
    it('retirada no meio da leitura: nenhum objeto novo é aberto, e nada é gravado', async () => {
      const site = await h.newSite('retirada');
      const { task, s3 } = h.newTask([site.tenantId]);
      for (let i = 0; i < 4; i += 1) {
        deliver(s3, site.balancer, NOON - i * SLOT, failures(NOON - i * SLOT, 30), { random: `r${i}` });
      }
      s3.onGet = async () => {
        await prisma.awsSource.update({
          where: { id: site.sourceId },
          data: { state: 'revoked', revokedAt: new Date(), stateCode: null },
        });
        return undefined;
      };
      expect(await task.runOnce()).toMatchObject({ withdrawn: 1, objects: 0, findings: 0, synced: 0 });
      expect(s3.gets).toHaveLength(1);
      expect(await h.ledger(site)).toEqual([]);
      expect(await h.findings(site)).toEqual([]);
      expect(await billed(site)).toBe(0);
      expect(await h.sourceRow(site)).toMatchObject({ state: 'revoked', stateCode: null });
      expect(await h.state(site)).toBeNull();
    });

    it('retirada entre a leitura e a gravação: o lock da conta a faz valer antes do registro', async () => {
      const site = await h.newSite('retirada na gravação');
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, failures(NOON, 30));
      const spy = vi.spyOn(FindingStore.prototype, 'persist').mockImplementationOnce(async function (
        this: FindingStore,
        ...args: Parameters<FindingStore['persist']>
      ) {
        const outcome = await realPersist.apply(this, args);
        await prisma.$transaction(async (tx) => {
          await lockAwsOnboarding(tx, site.accountRow);
          await tx.awsSource.update({
            where: { id: site.sourceId },
            data: { state: 'revoked', revokedAt: new Date(), stateCode: null },
          });
        });
        return outcome;
      });
      expect(await task.runOnce()).toMatchObject({ withdrawn: 1, objects: 0 });
      spy.mockRestore();
      expect(await h.ledger(site)).toEqual([]);
      expect(await billed(site)).toBe(0);
      expect(await h.requests(site)).toBe(0);
    });

    it('com a autorização já retirada, o `persist` do achado não grava', async () => {
      const site = await h.newSite('retirada no achado');
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, failures(NOON, 30));
      const spy = vi.spyOn(FindingStore.prototype, 'persist').mockImplementationOnce(async function (
        this: FindingStore,
        ...args: Parameters<FindingStore['persist']>
      ) {
        await prisma.awsSource.update({
          where: { id: site.sourceId },
          data: { state: 'revoked', revokedAt: new Date(), stateCode: null },
        });
        return realPersist.apply(this, args);
      });
      expect(await task.runOnce()).toMatchObject({ withdrawn: 1 });
      spy.mockRestore();
      expect(await h.findings(site)).toEqual([]);
    });

    it('conta desativada ou cliente suspenso no meio: para onde está', async () => {
      const changes: ((site: Site) => Promise<unknown>)[] = [
        (site) =>
          prisma.cloudAccount.update({ where: { id: site.accountRow }, data: { status: 'inactive' } }),
        (site) => prisma.tenant.update({ where: { id: site.tenantId }, data: { status: 'suspended' } }),
      ];
      for (const [i, change] of changes.entries()) {
        const site = await h.newSite(`meio ${i}`);
        const { task, s3 } = h.newTask([site.tenantId]);
        deliver(s3, site.balancer, NOON, visits(NOON, 1));
        deliver(s3, site.balancer, NOON - SLOT, visits(NOON - SLOT, 1));
        s3.onGet = async () => {
          await change(site);
          return undefined;
        };
        expect(await task.runOnce()).toMatchObject({ withdrawn: 1, objects: 0 });
        expect(s3.gets).toHaveLength(1);
        expect(await h.ledger(site)).toEqual([]);
      }
    });

    it('retirada e refeita: o intervalo sem autorização não é lido nem vira lacuna', async () => {
      const site = await h.newSite('refeita');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, visits(NOON, 1));
      await task.runOnce();
      const authorizedAt = new Date(NOON + 30 * MINUTE);
      await prisma.awsSource.update({
        where: { id: site.sourceId },
        data: { authorizedAt, state: 'authorized', stateCode: 'awaiting_collector' },
      });
      const between = deliver(s3, site.balancer, NOON + 20 * MINUTE, visits(NOON + 20 * MINUTE, 1));
      const after = deliver(s3, site.balancer, NOON + 40 * MINUTE, visits(NOON + 40 * MINUTE, 1));
      at(clock, NOON + 41 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, gaps: 0, replayed: 0 });
      const opened = s3.gets.map((call) => call.key);
      expect(opened).toContain(after);
      expect(opened).not.toContain(between);
    });
  });

  it('balanceador recriado com o mesmo nome: estado novo, observação recomeçada e troca na trilha', async () => {
    const site = await h.newSite('recriado');
    const { task, s3, clock } = h.newTask([site.tenantId]);
    deliver(
      s3,
      site.balancer,
      NOON,
      times(12, (i) => ({ client: '198.51.100.20', path: `/a${i}/.env`, status: 404 })),
    );
    await task.runOnce();
    const before = await h.state(site);
    expect(before?.loadBalancer).toBe('app/loja/0123456789abcdef');
    expect(JSON.stringify(before?.state.digest)).toContain('198.51.100.20');
    // A descoberta viu o novo, com o mesmo nome e outro id.
    const lb = 'app/loja/fedcba9876543210';
    const row = await h.sourceRow(site);
    const details = row.details as Record<string, unknown>;
    await prisma.awsSource.update({
      where: { id: site.sourceId },
      data: { details: { ...details, arn: String(details['arn']).split(site.balancer.lb).join(lb) } },
    });
    const now = NOON + 7 * MINUTE;
    at(clock, now);
    const replacement = { ...site.balancer, lb };
    deliver(s3, replacement, NOON + SLOT, failures(NOON + SLOT, 40));
    const orphan = deliver(s3, site.balancer, NOON + SLOT, failures(NOON + SLOT, 40));
    expect(await task.runOnce()).toMatchObject({ replaced: 1, objects: 1, findings: 0, observed: 1 });
    expect(s3.gets.map((call) => call.key)).not.toContain(orphan);
    const after = await h.state(site);
    expect(after?.loadBalancer).toBe(lb);
    expect(JSON.stringify(after?.state.digest)).not.toContain('198.51.100.20');
    expect(
      await prisma.webSourceSettings.findFirstOrThrow({ where: { sourceId: site.sourceId } }),
    ).toMatchObject({
      mode: 'observe',
      observeUntil: new Date(now + 72 * HOUR),
      updatedBy: null,
    });
    expect(await h.audit(site, 'web_logs.settings_update')).toMatchObject([
      {
        actorType: 'system',
        before: { loadBalancer: site.balancer.lb, mode: 'alert' },
        after: { loadBalancer: lb, mode: 'observe', observeUntil: new Date(now + 72 * HOUR).toISOString() },
      },
    ]);
    // Uma vez só.
    at(clock, now + 6 * MINUTE);
    expect(await task.runOnce()).toMatchObject({ replaced: 0 });
    expect(await h.audit(site, 'web_logs.settings_update')).toHaveLength(1);
  });

  it('a passagem de hora em hora do tráfego roda na tarefa, e não mais que isso', async () => {
    const site = await h.newSite('passagem');
    const { task, clock } = h.newTask([site.tenantId]);
    const old = new Date(NOON - 50 * HOUR);
    const row = {
      tenantId: site.tenantId,
      sourceId: site.sourceId,
      country: 'BR',
      clientClass: 'direct',
      requests: 7n,
      blocked: 0n,
      clientErrors: 0n,
      serverErrors: 0n,
      flagged: 0n,
    };
    await prisma.webTrafficSlot.create({ data: { ...row, slotStart: old } });
    expect(await task.runOnce()).toMatchObject({ rolledUp: 1 });
    expect(await prisma.webTrafficHour.findMany({ where: { sourceId: site.sourceId } })).toMatchObject([
      { requests: 7n },
    ]);
    await prisma.webTrafficSlot.create({ data: { ...row, slotStart: old } });
    at(clock, NOON + 30 * MINUTE);
    expect(await task.runOnce()).toMatchObject({ rolledUp: 0 });
    at(clock, NOON + 65 * MINUTE);
    expect(await task.runOnce()).toMatchObject({ rolledUp: 1 });
    expect(await prisma.webTrafficHour.findMany({ where: { sourceId: site.sourceId } })).toMatchObject([
      { requests: 14n },
    ]);
  });
});
