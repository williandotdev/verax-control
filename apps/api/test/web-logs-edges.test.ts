import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { usageDay, usageMonth } from '../src/usage/usage-meter.js';
import { WEB_LOGS_RUN_AMOUNTS } from '../src/weblogs/collect/web-logs-job.js';
import { times } from './support/alb-lines.js';
import { awsFault, deliver } from './support/fake-alb-s3.js';
import { HOUR, MINUTE, NOON, type Site, SLOT, START, webLogsHarness } from './support/web-logs-harness.js';

/** As bordas da tarefa `web-logs`: as divisas de horário, de autorização, de posição e de vez. */
describe('tarefa web-logs: bordas', () => {
  let prisma: PrismaService;
  let h: ReturnType<typeof webLogsHarness>;

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    h = webLogsHarness(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const failures = (endMs: number, count: number, client = '198.51.100.7') =>
    times(count, (i) => ({
      client,
      method: 'POST',
      path: '/login',
      status: 401,
      time: endMs - 4 * MINUTE + i * 1_000,
    }));
  const visits = (endMs: number, count: number) =>
    times(count, () => ({ client: '192.0.2.10', path: '/', time: endMs - MINUTE }));
  const billed = async (site: Site) => (await h.usage(site)).day?.events ?? 0;
  const at = (clock: { now: () => Date; advance: (ms: number) => void }, ms: number) =>
    clock.advance(ms - clock.now().getTime());

  it('na virada do mês em Brasília, o dia é o do tráfego e o mês, o da leitura', async () => {
    const midnight = Date.UTC(2026, 11, 1, 3);
    const site = await h.newSite('virada do mês', { authorizedAt: new Date(midnight - 3 * HOUR) });
    const { task, s3, clock } = h.newTask([site.tenantId]);
    at(clock, midnight + 2 * MINUTE);
    deliver(s3, site.balancer, midnight, visits(midnight, 5));
    expect(await task.runOnce()).toMatchObject({ objects: 1 });
    const days = await prisma.ingestUsageDay.findMany({ where: { tenantId: site.tenantId, source: 'aws' } });
    expect(days.map((row) => [row.day, row.events])).toEqual([[new Date('2026-11-30'), 5n]]);
    const months = await prisma.ingestUsage.findMany({ where: { tenantId: site.tenantId, source: 'aws' } });
    expect(months.map((row) => [row.month, row.events])).toEqual([[new Date('2026-12-01'), 5n]]);
    expect(usageDay(new Date(midnight - MINUTE))).toEqual(new Date('2026-11-30'));
    expect(usageMonth(new Date(midnight + MINUTE))).toEqual(new Date('2026-12-01'));
  });

  describe('autorização refeita', () => {
    const reauthorize = (site: Site, authorizedAt: Date) =>
      prisma.awsSource.update({
        where: { id: site.sourceId },
        data: { authorizedAt, state: 'authorized', stateCode: 'awaiting_collector', revokedAt: null },
      });

    it('no meio da leitura: o que era da autorização anterior não é gravado', async () => {
      const site = await h.newSite('refeita no meio');
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, failures(NOON, 30));
      s3.onGet = async () => {
        await reauthorize(site, START);
        return undefined;
      };
      expect(await task.runOnce()).toMatchObject({ withdrawn: 1, objects: 0 });
      expect(await h.ledger(site)).toEqual([]);
      expect(await h.findings(site)).toEqual([]);
      expect(await h.sourceRow(site)).toMatchObject({ state: 'authorized', stateCode: 'awaiting_collector' });
    });

    it('depois da leitura e antes do fechamento: o estado da nova não é mexido pela anterior', async () => {
      const site = await h.newSite('refeita no fim');
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, visits(NOON, 1));
      s3.onList = async (call) => {
        // A listagem da conferência de hora em hora: não tem horário de partida.
        if (call.startAfter === null) await reauthorize(site, START);
        return undefined;
      };
      expect(await task.runOnce()).toMatchObject({ objects: 1, transitions: 0 });
      expect(await h.sourceRow(site)).toMatchObject({
        state: 'authorized',
        stateCode: 'awaiting_collector',
        lastSyncAt: null,
      });
    });

    it('o que o motor viu na autorização anterior não soma com a nova', async () => {
      const site = await h.newSite('refeita na janela');
      const { task, s3, clock } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, failures(NOON, 12));
      await task.runOnce();
      await reauthorize(site, new Date(NOON + 3 * MINUTE));
      deliver(s3, site.balancer, NOON + 2 * SLOT, failures(NOON + 2 * SLOT, 12));
      at(clock, NOON + 2 * SLOT + MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 1, replayed: 0, findings: 0 });
    });

    it('depois de dias, a posição antiga não vira lacuna nem atraso', async () => {
      const site = await h.newSite('refeita dias depois', { authorizedAt: new Date(NOON - HOUR) });
      await h.setCursor(site, new Date(NOON - 4 * 24 * HOUR));
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON - 2 * 24 * HOUR, visits(NOON, 1));
      deliver(s3, site.balancer, NOON - 5 * HOUR, visits(NOON, 1));
      deliver(s3, site.balancer, NOON, visits(NOON, 1));
      expect(await task.runOnce()).toMatchObject({ objects: 1, gaps: 0, backlog: 0 });
      expect(await h.audit(site)).toHaveLength(1);
      expect(s3.lists.every((call) => /\/2026\/11\/(23|24)\//.test(call.key))).toBe(true);
    });

    it('o intervalo que começa antes da autorização não é lacuna nem é lido, nem quando ela tem dias', async () => {
      const authorizedAt = new Date(NOON - 3 * 24 * HOUR + 2 * MINUTE);
      const site = await h.newSite('divisa da autorização', { authorizedAt });
      const { task, s3 } = h.newTask([site.tenantId]);
      // Os dois intervalos que tocam a autorização, e o primeiro inteiro depois dela.
      for (const i of [0, 1, 2]) {
        deliver(s3, site.balancer, NOON - 3 * 24 * HOUR + i * SLOT, visits(NOON, 1));
      }
      expect(await task.runOnce()).toMatchObject({ gaps: 1, objects: 0 });
      expect((await h.ledger(site)).map((row) => row.slotStart)).toEqual([
        new Date(NOON - 3 * 24 * HOUR + SLOT),
      ]);
    });
  });

  it('retirada durante a listagem: nem o registro do que não é lido (a lacuna, a data absurda) é gravado', async () => {
    const revoke = (site: Site) =>
      prisma.awsSource.update({
        where: { id: site.sourceId },
        data: { state: 'revoked', revokedAt: new Date(), stateCode: null },
      });
    const absurd = await h.newSite('absurda');
    const gap = await h.newSite('lacuna retirada', { authorizedAt: new Date(NOON - 5 * 24 * HOUR) });
    await h.setCursor(gap, new Date(NOON - 3 * 24 * HOUR));
    const late = await h.newSite('atrasada retirada', { authorizedAt: new Date(NOON - 5 * 24 * HOUR) });
    await h.setCursor(late, new Date(NOON - 10 * MINUTE));
    for (const [site, isLast] of [
      [absurd, (call: { startAfter: string | null }) => call.startAfter !== null],
      [gap, (call: { startAfter: string | null }) => call.startAfter?.includes('20261121T') === true],
      [late, (call: { startAfter: string | null }) => call.startAfter === null],
    ] as const) {
      const { task, s3 } = h.newTask([site.tenantId]);
      if (site === absurd) {
        deliver(s3, site.balancer, NOON + 90 * 24 * HOUR, visits(NOON, 1), { day: '2026-11-24' });
      } else deliver(s3, site.balancer, NOON - 60 * HOUR, visits(NOON, 1));
      if (site === late) deliver(s3, site.balancer, NOON - 30 * HOUR, visits(NOON, 1), { day: '2026-11-23' });
      let revoked = false;
      s3.onList = async (call) => {
        if (isLast(call) && !revoked) {
          revoked = true;
          await revoke(site);
        }
        return undefined;
      };
      expect(await task.runOnce()).toMatchObject({ withdrawn: 1, gaps: 0, quarantined: 0 });
      expect(revoked).toBe(true);
      expect(await h.ledger(site)).toEqual([]);
      expect((await h.audit(site)).map((entry) => entry.after)).toEqual([]);
    }
  });

  it('a permissão negada para na primeira leitura', async () => {
    const site = await h.newSite('negada uma vez');
    const { task, s3 } = h.newTask([site.tenantId]);
    for (let i = 0; i < 8; i += 1) deliver(s3, site.balancer, NOON, visits(NOON, 1), { random: `n${i}` });
    s3.onGet = () => ({ error: awsFault('AccessDenied', 403) });
    expect(await task.runOnce()).toMatchObject({ failed: 1, objectFailures: 1 });
    expect(s3.gets).toHaveLength(1);
  });

  it('a atividade nova de um achado em aberto atualiza a evidência e a última vez, sem outro achado', async () => {
    const site = await h.newSite('atividade nova');
    const { task, s3, clock } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, NOON, failures(NOON, 30));
    await task.runOnce();
    const read = async () => {
      const [finding] = await h.findings(site);
      const evidence = await prisma.findingEvidence.findFirstOrThrow({
        where: { findingId: finding?.id ?? '' },
      });
      return { lastSeenAt: finding?.lastSeenAt, evidence: evidence.lastSeenAt };
    };
    const before = await read();
    const later = NOON + 65 * MINUTE;
    for (let ms = NOON + 10 * MINUTE; ms <= later; ms += 10 * MINUTE) {
      at(clock, ms);
      await task.runOnce();
    }
    deliver(s3, site.balancer, later, failures(later, 40));
    at(clock, later + MINUTE);
    expect(await task.runOnce()).toMatchObject({ findings: 0 });
    const after = await read();
    expect(await h.findings(site)).toHaveLength(1);
    expect(after.lastSeenAt).toEqual(new Date(NOON + HOUR));
    expect(after.evidence > before.evidence).toBe(true);
    // Triado, a atividade seguinte é uma reincidência.
    await prisma.finding.updateMany({ where: { tenantId: site.tenantId }, data: { status: 'resolved' } });
    const again = later + 70 * MINUTE;
    for (let ms = later + 10 * MINUTE; ms < again; ms += 10 * MINUTE) {
      at(clock, ms);
      await task.runOnce();
    }
    deliver(s3, site.balancer, again, failures(again, 30));
    at(clock, again + MINUTE);
    await task.runOnce();
    expect(await h.findings(site)).toHaveLength(2);
  });

  it('a réplica que perdeu a concessão sem devolvê-la joga fora o que tinha na memória', async () => {
    const site = await h.newSite('concessão vencida');
    const first = h.newTask([site.tenantId]);
    const { s3, clock, lease } = first;
    const second = h.newTask([site.tenantId], { s3, clock, lease });
    deliver(s3, site.balancer, NOON, visits(NOON, 1));
    await first.task.runOnce();
    await prisma.syncState.update({ where: { name: lease }, data: { leaseUntil: new Date(0) } });
    deliver(s3, site.balancer, NOON + SLOT, visits(NOON + SLOT, 1));
    at(clock, NOON + 7 * MINUTE);
    expect(await second.task.runOnce()).toMatchObject({ replayed: 1, objects: 1 });
    await prisma.syncState.update({ where: { name: lease }, data: { leaseUntil: new Date(0) } });
    at(clock, NOON + 13 * MINUTE);
    expect(await first.task.runOnce()).toMatchObject({ replayed: 2, objects: 0 });
  });

  it('o recém-autorizado é lido já, sem esperar o recuo de antes', async () => {
    const site = await h.newSite('recuo de antes');
    await h.setCursor(site, new Date(NOON - 10 * MINUTE));
    await prisma.collectorCursor.updateMany({
      where: { cloudAccountId: site.accountRow },
      data: { nextRunAt: new Date(NOON + 5 * HOUR), failures: 6 },
    });
    const { task, s3 } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, NOON, visits(NOON, 1));
    expect(await task.runOnce()).toMatchObject({ notDue: 0, objects: 1 });
    expect(await h.cursor(site)).toMatchObject({ failures: 0, nextRunAt: new Date(START.getTime() + SLOT) });
    // Já coletando, o recuo vale.
    await prisma.collectorCursor.updateMany({
      where: { cloudAccountId: site.accountRow },
      data: { nextRunAt: new Date(NOON + 5 * HOUR) },
    });
    expect(await task.runOnce()).toMatchObject({ notDue: 1 });
  });

  it('o mais atrasado primeiro', async () => {
    const tenantId = await h.newTenant('vez de cada um');
    const sites: Site[] = [];
    for (const [i, hours] of [1, 3, 2].entries()) {
      const site = await h.newSite(`vez ${i}`, { tenantId, lb: `app/v${i}/000000000000000${i}` });
      await h.setCursor(site, new Date(NOON - 10 * MINUTE));
      await prisma.collectorCursor.updateMany({
        where: { cloudAccountId: site.accountRow },
        data: { nextRunAt: new Date(NOON - hours * HOUR) },
      });
      sites.push(site);
    }
    const { task, s3 } = h.newTask([tenantId], { concurrency: 1 });
    await task.runOnce();
    const order = s3.lists
      .filter((call) => call.startAfter !== null)
      .map((call) => sites.findIndex((site) => site.balancer.bucket === call.bucket));
    expect(order).toEqual([1, 2, 0]);
  });

  describe('o que chega muito atrasado', () => {
    it('com mais de 24 h: lacuna, sem ser aberto; de ontem, com menos: lido', async () => {
      const site = await h.newSite('muito atrasado', { authorizedAt: new Date(NOON - 5 * 24 * HOUR) });
      await h.setCursor(site, new Date(NOON - 10 * MINUTE));
      const { task, s3 } = h.newTask([site.tenantId]);
      const old = deliver(s3, site.balancer, NOON - 30 * HOUR, visits(NOON, 1), { day: '2026-11-23' });
      const older = deliver(s3, site.balancer, NOON - 50 * HOUR, visits(NOON, 1), { day: '2026-11-24' });
      const recent = deliver(s3, site.balancer, NOON - 20 * HOUR, visits(NOON, 3));
      expect(recent).toContain('/2026/11/23/');
      expect(await task.runOnce()).toMatchObject({ gaps: 2, objects: 1, late: 1, duplicates: 0 });
      expect(s3.gets.map((call) => call.key)).toEqual([recent]);
      expect([old, older].every((key) => !s3.gets.some((call) => call.key === key))).toBe(true);
      expect(await billed(site)).toBe(0);
      expect((await h.usage(site, new Date(NOON - 20 * HOUR))).day?.events).toBe(3);
      expect(await h.sourceRow(site)).toMatchObject({ state: 'ingestion_error', stateCode: 'web_gap' });
    });
  });

  describe('lacuna e atraso juntos', () => {
    it('a lacuna para exatamente nas 24 h: o resto é lido como atraso', async () => {
      const site = await h.newSite('divisa das 24 h', { authorizedAt: new Date(NOON - 5 * 24 * HOUR) });
      await h.setCursor(site, new Date(NOON - 36 * HOUR));
      const { task, s3 } = h.newTask([site.tenantId]);
      const gone = deliver(s3, site.balancer, NOON - 25 * HOUR, visits(NOON - 25 * HOUR, 1));
      const kept = deliver(s3, site.balancer, NOON - 23 * HOUR, visits(NOON - 23 * HOUR, 1));
      expect(await task.runOnce()).toMatchObject({ gaps: 1, objects: 1, late: 0, backlog: 1 });
      expect(s3.gets.map((call) => call.key)).toEqual([kept]);
      expect((await h.ledger(site)).map((row) => row.status)).toEqual(['gap', 'read']);
      expect(gone).not.toBe(kept);
    });

    it('a lacuna de vários dias é contada inteira, um dia de cada vez', async () => {
      const site = await h.newSite('lacuna de dias', { authorizedAt: new Date(NOON - 8 * 24 * HOUR) });
      await h.setCursor(site, new Date(NOON - 5 * 24 * HOUR));
      const { task, s3 } = h.newTask([site.tenantId]);
      for (const hours of [110, 90, 70, 50]) deliver(s3, site.balancer, NOON - hours * HOUR, visits(NOON, 1));
      expect(await task.runOnce()).toMatchObject({ gaps: 4, objects: 0 });
    });

    it('o atraso que acaba o orçamento na releitura final termina na passagem seguinte, e devolve a vez', async () => {
      const site = await h.newSite('fim do atraso', { authorizedAt: new Date(NOON - 12 * HOUR) });
      await h.setCursor(site, new Date(NOON - 8 * HOUR));
      const { task, s3, clock } = h.newTask([site.tenantId], {
        amounts: { ...WEB_LOGS_RUN_AMOUNTS, objects: 14 },
      });
      const border = Math.ceil(START.getTime() / SLOT) * SLOT - 14 * SLOT;
      for (let i = 0; i <= 10; i += 1)
        deliver(s3, site.balancer, border + i * SLOT, visits(border + i * SLOT, 1));
      expect(await task.runOnce()).toMatchObject({ objects: 11, replayed: 3, backlog: 1, capped: 1 });
      clock.advance(2 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ objects: 0, backlog: 1, capped: 0 });
      clock.advance(6 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ backlog: 0, capped: 0 });
      expect((await h.usage(site)).day?.events).toBe(11);
    });

    it('no máximo dois motores de atraso ao mesmo tempo; o terceiro espera a vez', async () => {
      const tenantId = await h.newTenant('três atrasos');
      const sites: Site[] = [];
      for (let i = 0; i < 3; i += 1) {
        const site = await h.newSite(`atraso ${i}`, {
          tenantId,
          lb: `app/a${i}/000000000000000${i}`,
          authorizedAt: new Date(NOON - 12 * HOUR),
        });
        await h.setCursor(site, new Date(NOON - 8 * HOUR));
        sites.push(site);
      }
      const { task, s3, clock } = h.newTask([tenantId], { concurrency: 3 });
      for (const site of sites) deliver(s3, site.balancer, NOON - 5 * HOUR, visits(NOON - 5 * HOUR, 1));
      expect(await task.runOnce()).toMatchObject({ backlog: 2, capped: 1, objects: 2 });
      clock.advance(2 * MINUTE);
      expect(await task.runOnce()).toMatchObject({ backlog: 1, capped: 0, objects: 1 });
    });

    it('o resumo de ontem não encolhe com o atraso: o que já estava guardado continua contado', async () => {
      const yesterday = Date.UTC(2026, 10, 23);
      const site = await h.newSite('resumo de ontem', { authorizedAt: new Date(yesterday + 12 * HOUR) });
      const first = h.newTask([site.tenantId]);
      const { s3, clock, lease } = first;
      const probes = (endMs: number, client: string) =>
        times(12, (i) => ({ client, path: `/a${i}/.env`, status: 404, time: endMs - MINUTE }));
      deliver(s3, site.balancer, yesterday + 20 * HOUR, probes(yesterday + 20 * HOUR, '198.51.100.20'));
      for (let ms = yesterday + 20 * HOUR + MINUTE; ms < yesterday + 22 * HOUR; ms += 10 * MINUTE) {
        at(clock, ms);
        await first.task.runOnce();
      }
      await first.task.close();
      deliver(s3, site.balancer, yesterday + 23 * HOUR, probes(yesterday + 23 * HOUR, '198.51.100.21'));
      at(clock, START.getTime());
      const second = h.newTask([site.tenantId], { s3, clock, lease });
      expect(await second.task.runOnce()).toMatchObject({ backlog: 1, objects: 1 });
      const [digest] = (await h.findings(site)).filter((row) => row.ruleId === '990400');
      expect(digest?.eventName).toContain('2 endereços no dia: 24 sondas');
    });
  });

  it('a parada no meio de muitos objetos: os lotes já avaliados ficam registrados', async () => {
    const site = await h.newSite('lotes');
    const { task, s3 } = h.newTask([site.tenantId]);
    for (let i = 0; i < 40; i += 1) deliver(s3, site.balancer, NOON, visits(NOON, 1), { random: `l${i}` });
    const controller = new AbortController();
    s3.onGet = () => {
      if (s3.gets.length === 30) controller.abort(new DOMException('o worker está parando', 'AbortError'));
      return undefined;
    };
    await expect(task.runOnce(controller.signal)).rejects.toThrow();
    expect(await h.ledger(site)).toHaveLength(25);
    expect(await billed(site)).toBe(25);
  });

  it('retirada com a fonte quieta: o estado do motor não é gravado', async () => {
    const site = await h.newSite('quieta e retirada');
    const { task, s3 } = h.newTask([site.tenantId]);
    s3.onList = async () => {
      await prisma.awsSource.update({
        where: { id: site.sourceId },
        data: { state: 'revoked', revokedAt: new Date(), stateCode: null },
      });
      return undefined;
    };
    expect(await task.runOnce()).toMatchObject({ withdrawn: 1 });
    expect(await h.state(site)).toBeNull();
  });

  describe('a posição', () => {
    it('não passa do que ficou por ler, sem atraso nenhum', async () => {
      const site = await h.newSite('posição e fila');
      await h.setCursor(site, new Date(NOON - 60 * MINUTE));
      const { task, s3, clock } = h.newTask([site.tenantId], {
        amounts: { ...WEB_LOGS_RUN_AMOUNTS, objects: 3 },
      });
      for (let i = 0; i < 10; i += 1) deliver(s3, site.balancer, NOON - i * SLOT, visits(NOON - i * SLOT, 1));
      expect(await task.runOnce()).toMatchObject({ objects: 3, capped: 1, backlog: 0 });
      // Lidos os de 11:15 a 11:25; o de 11:30 espera.
      expect((await h.cursor(site)).cursorAt).toEqual(new Date(NOON - 35 * MINUTE));
      clock.advance(2 * MINUTE);
      await task.runOnce();
      expect((await h.cursor(site)).cursorAt).toEqual(new Date(NOON - 20 * MINUTE));
    });

    it('não passa do atraso que não acabou, mesmo com o ao vivo em dia', async () => {
      const site = await h.newSite('posição e atraso', { authorizedAt: new Date(NOON - 12 * HOUR) });
      await h.setCursor(site, new Date(NOON - 6 * HOUR));
      const { task, s3 } = h.newTask([site.tenantId], { amounts: { ...WEB_LOGS_RUN_AMOUNTS, objects: 4 } });
      deliver(s3, site.balancer, NOON, visits(NOON, 1));
      for (let i = 0; i < 8; i += 1) {
        const endMs = NOON - 5 * HOUR + i * SLOT;
        deliver(s3, site.balancer, endMs, visits(endMs, 1));
      }
      expect(await task.runOnce()).toMatchObject({ objects: 4, backlog: 1, capped: 1 });
      expect((await h.cursor(site)).cursorAt).toEqual(new Date(NOON - 5 * HOUR + 2 * SLOT));
      expect((await h.sourceRow(site)).lagSeconds).toBe(
        (START.getTime() - (NOON - 5 * HOUR + 2 * SLOT)) / 1000,
      );
    });
  });

  it('a divisa do atraso com o ao vivo no fim de uma janela de listagem também é vista inteira', async () => {
    const site = await h.newSite('divisa na janela', { authorizedAt: new Date(NOON - 12 * HOUR) });
    const border = Math.ceil(START.getTime() / SLOT) * SLOT - 14 * SLOT;
    await h.setCursor(site, new Date(border - 36 * SLOT));
    const { task, s3 } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, border, failures(border, 12));
    deliver(s3, site.balancer, border + SLOT, failures(border + SLOT, 12));
    expect(await task.runOnce()).toMatchObject({ objects: 2, backlog: 1, replayed: 1 });
    expect(await h.findings(site)).toMatchObject([{ ruleId: '990405' }]);
  });

  it('o volume das últimas 24 h esquece o que é mais velho', async () => {
    const site = await h.newSite('volume do dia');
    const { task, s3, clock } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, NOON, visits(NOON, 4));
    await task.runOnce();
    expect(await h.sourceRow(site)).toMatchObject({ eventsLast24h: 4 });
    at(clock, NOON + 23 * HOUR);
    deliver(s3, site.balancer, NOON + 23 * HOUR, visits(NOON + 23 * HOUR, 2));
    await task.runOnce();
    expect(await h.sourceRow(site)).toMatchObject({ eventsLast24h: 6 });
    at(clock, NOON + 25 * HOUR);
    await task.runOnce();
    expect(await h.sourceRow(site)).toMatchObject({ eventsLast24h: 2, state: 'collecting' });
  });

  it('a fonte do WAF que não está coletando não rebaixa nada; a do cadastro anterior, coletando, vale', async () => {
    const probes = times(400, (i) => ({
      client: '198.51.100.9',
      path: `/p${i}/.env`,
      status: 403,
      actions: 'waf',
    }));
    const levelWith = async (waf: { state: string; region: string; origin: 'discovered' | 'legacy' }) => {
      const site = await h.newSite(`WAF ${waf.state} ${waf.origin}`);
      await prisma.awsSource.create({
        data: {
          tenantId: site.tenantId,
          cloudAccountId: site.accountRow,
          kind: 'waf',
          resourceId: waf.origin === 'legacy' ? 'legacy' : 'acl',
          name: 'acl',
          method: 's3',
          availability: 'available',
          authorizedAt: new Date(NOON - 24 * HOUR),
          ...waf,
        },
      });
      const { task, s3 } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, probes);
      await task.runOnce();
      return (await h.findings(site)).find((row) => row.ruleId === '990402')?.ruleLevel;
    };
    expect(await levelWith({ state: 'permission_error', region: 'sa-east-1', origin: 'discovered' })).toBe(7);
    expect(await levelWith({ state: 'collecting', region: 'sa-east-1', origin: 'discovered' })).toBe(4);
    expect(await levelWith({ state: 'collecting', region: 'global', origin: 'legacy' })).toBe(4);
    // A Web ACL do CloudFront é global, e não é a do balanceador.
    expect(await levelWith({ state: 'collecting', region: 'global', origin: 'discovered' })).toBe(7);
  });
});
