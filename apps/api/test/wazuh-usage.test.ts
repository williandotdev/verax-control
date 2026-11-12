import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CloudAccountConnection, towerSummarySchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { awsStallDedupeKey } from '../src/notifications/ingestion-notices.js';
import {
  type AnalysisdCounters,
  type AnalysisdStatsSource,
  WazuhApiError,
  type WazuhApiErrorKind,
} from '../src/usage/wazuh-stats.js';
import { WAZUH_COUNTER_ID, WazuhCounterConflict, WazuhUsage } from '../src/usage/wazuh-usage.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = new Date('2026-11-09T06:00:00.000Z');

/** A API do manager falsa: os contadores que o analysisd teria, um erro, ou algo que acontece no meio da leitura. */
class FakeStats implements AnalysisdStatsSource {
  counters: AnalysisdCounters = { startedAt: START, bytesReceived: 0, awsEvents: 0 };
  failure: WazuhApiErrorKind | null = null;
  duringRead: (() => Promise<void>) | null = null;

  async read(): Promise<AnalysisdCounters> {
    if (this.duringRead !== null) await this.duringRead();
    if (this.failure !== null) throw new WazuhApiError(this.failure);
    return { ...this.counters };
  }

  advance(bytes: number, events: number): void {
    this.counters = {
      ...this.counters,
      bytesReceived: this.counters.bytesReceived + bytes,
      awsEvents: this.counters.awsEvents + events,
    };
  }

  restart(at: Date, bytes: number, events: number): void {
    this.counters = { startedAt: at, bytesReceived: bytes, awsEvents: events };
  }
}

class Clock {
  constructor(public at: Date) {}
  tick(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}

describe('medidor e saúde da ingestão do Wazuh do nó: a tarefa wazuh-usage (fase 2, PR-V6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const accountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
  async function awsAccount(tenantId: string, connection: CloudAccountConnection = 'connected') {
    return prisma.cloudAccount.create({
      data: { tenantId, provider: 'aws', accountId: accountId(), regions: ['sa-east-1'], connection },
      select: { id: true },
    });
  }

  /** O uso de um cliente, lido pelo escopo dele, como a página "Plano e uso" lê. */
  const usageOf = async (tenantId: string) =>
    (await prisma.forTenant(tenantId).ingestUsage.findMany({ orderBy: { month: 'asc' } })).map((row) => ({
      month: row.month.toISOString().slice(0, 10),
      source: row.source,
      bytes: row.bytes,
      events: row.events,
    }));
  const daysOf = async (tenantId: string) =>
    (await prisma.forTenant(tenantId).ingestUsageDay.findMany({ orderBy: { day: 'asc' } })).map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      source: row.source,
      bytes: row.bytes,
      events: row.events,
    }));
  const healthOf = (tenantId: string) =>
    prisma.forTenant(tenantId).ingestHealth.findFirst({
      where: { source: 'aws' },
      select: { lastProgressAt: true, stallNotifiedFor: true },
    });
  const noticesOf = (tenantId: string) =>
    prisma.forTenant(tenantId).notification.findMany({
      where: { kind: 'aws_ingestion_stalled' },
      orderBy: { createdAt: 'asc' },
      select: { dedupeKey: true, status: true },
    });

  /** A tarefa de um caso: só os clientes dele, a própria linha da base e o relógio dele. */
  function task(
    tenantIds: string[],
    clock: Clock,
    options: { agentsTenantId?: string; mode?: 'dedicated' | 'cell' } = {},
  ) {
    const stats = new FakeStats();
    const warnings: { fields: object; message: string }[] = [];
    const counterId = `teste-${randomInt(1_000_000, 9_999_999)}`;
    const usage = new WazuhUsage(prisma, stats, {
      now: () => clock.at,
      logger: { warn: (fields, message) => warnings.push({ fields, message }) },
      tenantIds,
      counterId,
      agentsTenantId: options.agentsTenantId ?? null,
      ...(options.mode !== undefined && { mode: options.mode }),
    });
    return { usage, stats, warnings, counterId };
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.wazuhCounter.deleteMany({ where: { id: WAZUH_COUNTER_ID } });
    await app.close();
  });

  it('medidor: a primeira leitura é só a base; depois, a diferença dos bytes e dos eventos da AWS, no mês de Brasília', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (medidor do Wazuh)');
    await awsAccount(tenant);
    const clock = new Clock(new Date('2026-11-30T23:50:00.000Z'));
    const { usage, stats, counterId } = task([tenant], clock);
    stats.advance(50_000, 40);

    expect(await usage.runOnce()).toMatchObject({ read: 'ok', meter: 'baseline', bytes: 0, events: 0 });
    expect(await usageOf(tenant)).toEqual([]);
    expect(await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } })).toMatchObject({
      startedAt: START,
      bytesReceived: 50_000n,
      awsEvents: 40n,
      meterBlocked: null,
    });

    stats.advance(12_000, 9);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({
      meter: 'recorded',
      restarted: false,
      bytes: 12_000,
      events: 9,
    });
    // Sem nada novo, nada muda.
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ meter: 'recorded', bytes: 0, events: 0 });
    expect(await usageOf(tenant)).toEqual([
      { month: '2026-11-01', source: 'aws', bytes: 12_000n, events: 9n },
    ]);

    // 01/12 às 03:00 UTC é a virada do mês em Brasília: o que chega depois vai para dezembro.
    clock.at = new Date('2026-12-01T03:05:00.000Z');
    stats.advance(1_000, 1);
    await usage.runOnce();
    expect(await usageOf(tenant)).toEqual([
      { month: '2026-11-01', source: 'aws', bytes: 12_000n, events: 9n },
      { month: '2026-12-01', source: 'aws', bytes: 1_000n, events: 1n },
    ]);
    // No nó dedicado, a mesma diferença entra no volume por dia (CE-09), no dia de Brasília da leitura: 30/11 às
    // 20:55 e 21:00 de Brasília; 01/12 às 00:05.
    expect(await daysOf(tenant)).toEqual([
      { day: '2026-11-30', source: 'aws', bytes: 12_000n, events: 9n },
      { day: '2026-12-01', source: 'aws', bytes: 1_000n, events: 1n },
    ]);
  });

  it('medidor: o analysisd reiniciou (outra partida ou contador menor): soma o valor inteiro, uma vez', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (reinício do analysisd)');
    await awsAccount(tenant);
    const clock = new Clock(new Date('2026-11-09T12:00:00.000Z'));
    const { usage, stats } = task([tenant], clock);
    stats.advance(90_000, 70);
    await usage.runOnce();

    stats.restart(new Date('2026-11-09T12:02:00.000Z'), 3_000, 2);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({
      meter: 'recorded',
      restarted: true,
      bytes: 3_000,
      events: 2,
    });
    stats.advance(500, 1);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ restarted: false, bytes: 500, events: 1 });
    // A mesma partida (o uptime só tem segundos), mas os contadores menores: também é reinício.
    stats.counters = { ...stats.counters, bytesReceived: 100, awsEvents: 0 };
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ restarted: true, bytes: 100, events: 0 });
    expect(await usageOf(tenant)).toEqual([
      { month: '2026-11-01', source: 'aws', bytes: 3_600n, events: 3n },
    ]);
  });

  it('A/B: um cliente por nó; com dois (ou os agentes de outro), não mede para ninguém, avisa e grava o motivo', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (um cliente por nó)');
    const tenantB = await createTenant(app, 'Cliente Demo B (um cliente por nó)');
    await awsAccount(tenantA);
    const clock = new Clock(new Date('2026-11-09T12:00:00.000Z'));
    const { usage, stats, warnings, counterId } = task([tenantA, tenantB], clock);
    stats.advance(10_000, 10);
    await usage.runOnce();
    stats.advance(2_000, 2);
    clock.tick(5 * MINUTE);
    await usage.runOnce();
    expect(await healthOf(tenantA)).not.toBeNull();

    // B ganha uma conta AWS no mesmo nó: o volume de agora é de quem? De ninguém.
    const intruder = await awsAccount(tenantB);
    stats.advance(7_000, 7);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ meter: 'multiple_tenants', bytes: 0, events: 0 });
    expect(await usageOf(tenantA)).toEqual([
      { month: '2026-11-01', source: 'aws', bytes: 2_000n, events: 2n },
    ]);
    expect(await usageOf(tenantB)).toEqual([]);
    expect((await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } })).meterBlocked).toBe(
      'multiple_tenants',
    );
    // A saúde dos dois é limpa (nada a afirmar), e o log diz quantos clientes, sem citar nenhum.
    expect(await healthOf(tenantA)).toEqual({ lastProgressAt: null, stallNotifiedFor: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ tenants: 2 });
    expect(warnings[0]?.message).toContain('mais de um cliente');
    expect(JSON.stringify(warnings)).not.toContain(tenantA);
    expect(JSON.stringify(warnings)).not.toContain(tenantB);

    // B sai do nó: a primeira leitura depois da base ambígua é só a base nova (o intervalo desde a última leitura ainda
    // pode ter volume de B); só o que vem depois é de A.
    await prisma.cloudAccount.update({ where: { id: intruder.id }, data: { status: 'inactive' } });
    stats.advance(1_000, 1);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ meter: 'baseline', bytes: 0, events: 0 });
    stats.advance(300, 1);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ meter: 'recorded', bytes: 300, events: 1 });
    expect(await usageOf(tenantA)).toEqual([
      { month: '2026-11-01', source: 'aws', bytes: 2_300n, events: 3n },
    ]);
    expect(await usageOf(tenantB)).toEqual([]);
    expect(
      (await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } })).meterBlocked,
    ).toBeNull();

    // Os agentes do Wazuh de outro cliente passam pelo mesmo analysisd: também é ambíguo.
    const withAgents = task([tenantA], clock, { agentsTenantId: tenantB });
    await withAgents.usage.runOnce();
    withAgents.stats.advance(4_000, 4);
    clock.tick(5 * MINUTE);
    expect(await withAgents.usage.runOnce()).toMatchObject({ meter: 'multiple_tenants' });
    // Sem conta AWS nenhuma, não há o que medir como aws.
    expect(await task([tenantB], clock).usage.runOnce()).toMatchObject({ meter: 'no_tenant' });
  });

  it('A/B: a leitura que falha com dois clientes marca a base; o que veio no meio nunca é cobrado de quem sobra', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (ambíguo sem leitura)');
    const tenantB = await createTenant(app, 'Cliente Demo B (ambíguo sem leitura)');
    await awsAccount(tenantA);
    const clock = new Clock(new Date('2026-11-09T12:00:00.000Z'));
    const { usage, stats, counterId } = task([tenantA, tenantB], clock);
    stats.advance(5_000, 5);
    await usage.runOnce();
    expect(
      (await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } })).meterBlocked,
    ).toBeNull();

    // B entra, 1.000 bytes chegam e a leitura falha: a ambiguidade fica gravada na base, mesmo sem contadores novos.
    const intruder = await awsAccount(tenantB);
    stats.advance(1_000, 1);
    stats.failure = 'timeout';
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ read: 'timeout', meter: 'not_read' });
    expect(await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } })).toMatchObject({
      bytesReceived: 5_000n,
      meterBlocked: 'multiple_tenants',
    });

    // B sai antes da próxima leitura bem-sucedida, e mais 100 bytes chegam: os 1.100 desde a base não vão para A.
    await prisma.cloudAccount.update({ where: { id: intruder.id }, data: { status: 'inactive' } });
    stats.failure = null;
    stats.advance(100, 1);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ read: 'ok', meter: 'baseline', bytes: 0, events: 0 });
    expect(await usageOf(tenantA)).toEqual([]);
    expect(await usageOf(tenantB)).toEqual([]);
    expect(await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } })).toMatchObject({
      bytesReceived: 6_100n,
      meterBlocked: null,
    });
    // Da base nova em diante, A volta a ser medido.
    stats.advance(40, 1);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ meter: 'recorded', bytes: 40, events: 1 });
    expect(await usageOf(tenantA)).toEqual([{ month: '2026-11-01', source: 'aws', bytes: 40n, events: 1n }]);
  });

  it('célula (CE-09): vários clientes não bloqueiam; o analysisd vira só o contador do nó por dia, sem uso de cliente', async () => {
    const a = await createTenant(app, 'Cliente Demo A (célula, analysisd)');
    const b = await createTenant(app, 'Cliente Demo B (célula, analysisd)');
    await awsAccount(a);
    await awsAccount(b);
    // A saúde antiga de um cliente (de quando o nó era dedicado) é limpa: na célula, ela sai da medição na origem.
    await prisma.ingestHealth.create({
      data: { tenantId: a, source: 'aws', lastProgressAt: new Date('2026-08-01') },
    });
    // Um dia sem uso de outro teste: o contador do nó é por dia, sem cliente.
    const clock = new Clock(new Date('2026-08-14T12:00:00.000Z'));
    const { usage, stats, warnings, counterId } = task([a, b], clock, { mode: 'cell' });
    stats.advance(10_000, 5);
    expect(await usage.runOnce()).toMatchObject({ meter: 'baseline', bytes: 0, health: 'not_evaluated' });
    stats.advance(4_000, 3);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ meter: 'node', bytes: 4_000, events: 3, stallNotices: 0 });
    stats.advance(1_000, 1);
    clock.tick(5 * MINUTE);
    await usage.runOnce();

    expect(await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } })).toMatchObject({
      meterBlocked: null,
    });
    expect(warnings).toEqual([]);
    expect(
      await prisma.nodeUsageDay.findUniqueOrThrow({
        where: { day_metric: { day: new Date('2026-08-14T00:00:00Z'), metric: 'analysisd' } },
        select: { bytes: true, events: true },
      }),
    ).toEqual({ bytes: 5_000n, events: 4n });
    // Nada vai para o uso de cliente nenhum: o volume de cada um vem da medição na origem (aws-volume).
    for (const tenant of [a, b]) {
      expect(await usageOf(tenant)).toEqual([]);
      expect(await daysOf(tenant)).toEqual([]);
    }
    expect(await healthOf(a)).toEqual({ lastProgressAt: null, stallNotifiedFor: null });
  });

  it('saúde: sem conta AWS ativa, a observação some; a conta que volta começa do zero, sem aviso na hora', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (última conta desativada)');
    const account = await awsAccount(tenant);
    const clock = new Clock(new Date('2026-11-09T08:00:00.000Z'));
    const { usage } = task([tenant], clock);
    await usage.runOnce();
    clock.tick(2 * HOUR + 5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ health: 'stalled', stallNotices: 1 });
    const stalledSince = new Date('2026-11-09T08:00:00.000Z');
    expect(await healthOf(tenant)).toEqual({ lastProgressAt: stalledSince, stallNotifiedFor: stalledSince });

    // O cliente desativa a última conta AWS: ninguém é dono do volume, e a observação dele é limpa.
    await prisma.cloudAccount.update({ where: { id: account.id }, data: { status: 'inactive' } });
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ meter: 'no_tenant', health: 'not_evaluated' });
    expect(await healthOf(tenant)).toEqual({ lastProgressAt: null, stallNotifiedFor: null });

    // Horas depois, a conta volta: uma observação nova, sem a parada antiga nem um aviso imediato.
    clock.tick(6 * HOUR);
    await prisma.cloudAccount.update({ where: { id: account.id }, data: { status: 'active' } });
    expect(await usage.runOnce()).toMatchObject({ health: 'waiting', stallNotices: 0 });
    expect(await healthOf(tenant)).toEqual({ lastProgressAt: clock.at, stallNotifiedFor: null });
    expect(await noticesOf(tenant)).toHaveLength(1);
  });

  it('saúde: o cliente que sai do nó perde a observação, e o que fica segue a dele', async () => {
    const tenantA = await createTenant(app, 'Cliente Demo A (troca de dono)');
    const tenantB = await createTenant(app, 'Cliente Demo B (troca de dono)');
    const accountA = await awsAccount(tenantA);
    const clock = new Clock(new Date('2026-11-09T08:00:00.000Z'));
    const { usage } = task([tenantA, tenantB], clock);
    await usage.runOnce();
    expect(await healthOf(tenantA)).not.toEqual({ lastProgressAt: null, stallNotifiedFor: null });

    await prisma.cloudAccount.update({ where: { id: accountA.id }, data: { status: 'inactive' } });
    await awsAccount(tenantB);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ health: 'waiting' });
    expect(await healthOf(tenantA)).toEqual({ lastProgressAt: null, stallNotifiedFor: null });
    expect(await healthOf(tenantB)).toEqual({ lastProgressAt: clock.at, stallNotifiedFor: null });
  });

  it('saúde: parada há mais de 2 h vira um aviso por parada; os eventos de volta rearmam', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (saúde da AWS)');
    await awsAccount(tenant);
    const other = await createTenant(app, 'Cliente Demo B (saúde da AWS)');
    const clock = new Clock(new Date('2026-11-09T08:00:00.000Z'));
    const { usage, stats } = task([tenant], clock);

    // A primeira leitura começa a observação.
    expect(await usage.runOnce()).toMatchObject({ health: 'waiting', stallNotices: 0 });
    const watchStart = clock.at;
    expect(await healthOf(tenant)).toEqual({ lastProgressAt: watchStart, stallNotifiedFor: null });
    stats.advance(800, 3);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ health: 'flowing' });
    const lastEvents = clock.at;

    // Parado: até 2 h, só espera.
    clock.tick(2 * HOUR);
    expect(await usage.runOnce()).toMatchObject({ health: 'waiting', stallNotices: 0 });
    expect(await noticesOf(tenant)).toEqual([]);
    // Passou das 2 h: um aviso, pelo começo da parada.
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ health: 'stalled', stallNotices: 1 });
    expect(await noticesOf(tenant)).toEqual([
      { dedupeKey: awsStallDedupeKey(lastEvents), status: 'pending' },
    ]);
    expect(await healthOf(tenant)).toEqual({ lastProgressAt: lastEvents, stallNotifiedFor: lastEvents });
    // A mesma parada não avisa de novo, por mais que a tarefa rode.
    for (let run = 0; run < 3; run += 1) {
      clock.tick(5 * MINUTE);
      expect(await usage.runOnce()).toMatchObject({ health: 'stalled', stallNotices: 0 });
    }
    expect(await noticesOf(tenant)).toHaveLength(1);
    // Nada do aviso vai para outro cliente.
    expect(await noticesOf(other)).toEqual([]);

    // Os eventos voltam: a parada acaba e o aviso fica rearmado.
    stats.advance(400, 2);
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ health: 'flowing', stallNotices: 0 });
    const resumed = clock.at;
    // Uma parada nova, depois: outro aviso.
    clock.tick(2 * HOUR + 5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({ health: 'stalled', stallNotices: 1 });
    expect((await noticesOf(tenant)).map((notice) => notice.dedupeKey)).toEqual([
      awsStallDedupeKey(lastEvents),
      awsStallDedupeKey(resumed),
    ]);
  });

  it('saúde: o manager fora do ar não mede nada, mas o prazo corre e a parada avisa', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (manager fora do ar)');
    await awsAccount(tenant);
    const clock = new Clock(new Date('2026-11-09T08:00:00.000Z'));
    const { usage, stats, warnings, counterId } = task([tenant], clock);
    await usage.runOnce();
    const base = await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } });

    stats.failure = 'connection';
    stats.advance(5_000, 5);
    clock.tick(2 * HOUR + MINUTE);
    expect(await usage.runOnce()).toEqual({
      read: 'connection',
      meter: 'not_read',
      restarted: false,
      bytes: 0,
      events: 0,
      health: 'stalled',
      stallNotices: 1,
    });
    expect(await prisma.wazuhCounter.findUniqueOrThrow({ where: { id: counterId } })).toEqual(base);
    expect(await usageOf(tenant)).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ kind: 'connection' });
    expect(warnings[0]?.message).toContain('não foram lidos');

    // De volta, a diferença desde a base conta inteira (nada se perdeu), e a parada acaba.
    stats.failure = null;
    clock.tick(5 * MINUTE);
    expect(await usage.runOnce()).toMatchObject({
      meter: 'recorded',
      bytes: 5_000,
      events: 5,
      health: 'flowing',
    });
  });

  it('saúde: sem conta conectada, nada a observar; a conexão nova começa do zero, sem aviso na hora', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (conta não conectada)');
    const account = await awsAccount(tenant, 'error');
    const clock = new Clock(new Date('2026-11-09T08:00:00.000Z'));
    const { usage } = task([tenant], clock);
    expect(await usage.runOnce()).toMatchObject({ meter: 'baseline', health: 'not_watching' });
    expect(await healthOf(tenant)).toBeNull();

    clock.tick(6 * HOUR);
    await prisma.cloudAccount.update({ where: { id: account.id }, data: { connection: 'connected' } });
    expect(await usage.runOnce()).toMatchObject({ health: 'waiting', stallNotices: 0 });
    expect(await healthOf(tenant)).toEqual({ lastProgressAt: clock.at, stallNotifiedFor: null });
    // Desconectada de novo: a observação é limpa.
    await prisma.cloudAccount.update({ where: { id: account.id }, data: { connection: 'error' } });
    clock.tick(3 * HOUR);
    expect(await usage.runOnce()).toMatchObject({ health: 'not_watching', stallNotices: 0 });
    expect(await healthOf(tenant)).toEqual({ lastProgressAt: null, stallNotifiedFor: null });
    expect(await noticesOf(tenant)).toEqual([]);
  });

  it('outra execução no meio da leitura muda a base: esta é desfeita (nada conta duas vezes)', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (base disputada)');
    await awsAccount(tenant);
    const clock = new Clock(new Date('2026-11-09T08:00:00.000Z'));
    const { usage, stats, counterId } = task([tenant], clock);
    await usage.runOnce();
    stats.advance(1_000, 1);
    stats.duringRead = async () => {
      stats.duringRead = null;
      await prisma.wazuhCounter.update({
        where: { id: counterId },
        data: { readAt: new Date('2026-11-09T08:01:00.000Z'), bytesReceived: 1_000n, awsEvents: 1n },
      });
    };
    clock.tick(5 * MINUTE);
    await expect(usage.runOnce()).rejects.toBeInstanceOf(WazuhCounterConflict);
    expect(await usageOf(tenant)).toEqual([]);
  });

  it('o banco recusa saúde de outra fonte, aviso de uma parada futura e contador negativo', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (CHECK da saúde)');
    const at = new Date('2026-11-09T08:00:00.000Z');
    await expect(
      prisma.ingestHealth.create({ data: { tenantId: tenant, source: 'gcp', lastProgressAt: at } }),
    ).rejects.toThrow(/IngestHealth_source_check/);
    await expect(
      prisma.ingestHealth.create({
        data: {
          tenantId: tenant,
          source: 'aws',
          lastProgressAt: at,
          stallNotifiedFor: new Date(at.getTime() + 1),
        },
      }),
    ).rejects.toThrow(/IngestHealth_stall_notice_check/);
    await expect(
      prisma.ingestHealth.create({ data: { tenantId: tenant, source: 'aws', stallNotifiedFor: at } }),
    ).rejects.toThrow(/IngestHealth_stall_notice_check/);
    const id = `teste-${randomInt(1_000_000, 9_999_999)}`;
    await expect(
      prisma.wazuhCounter.create({
        data: { id, startedAt: at, bytesReceived: -1n, awsEvents: 0n, readAt: at },
      }),
    ).rejects.toThrow(/WazuhCounter_counters_check/);
    await expect(
      prisma.wazuhCounter.create({
        data: { id, startedAt: at, bytesReceived: 0n, awsEvents: 0n, readAt: at, meterBlocked: 'outro' },
      }),
    ).rejects.toThrow(/WazuhCounter_meter_blocked_check/);
  });

  describe('Torre: "Sem logs novos da AWS" e o medidor parado', () => {
    async function signedIn(role: 'leitura' | 'admin_verax', tenantId: string) {
      const user =
        role === 'admin_verax'
          ? await createSignedInUser(app, { role: 'admin_verax' })
          : await createSignedInUser(app, { role, tenantId });
      let cookie = user.cookie;
      if (role === 'admin_verax') {
        const csrf = await withCsrf(app, user.cookie);
        cookie = csrf.cookie;
        await request(app.getHttpServer())
          .post('/v1/session/tenant')
          .set('Cookie', cookie)
          .set('Origin', TEST_WEB_ORIGIN)
          .set('X-CSRF-Token', csrf.token)
          .send({ tenantId })
          .expect(200);
      }
      return async () =>
        towerSummarySchema.parse(
          (await request(app.getHttpServer()).get('/v1/tower').set('Cookie', cookie).expect(200)).body,
        ).coverage;
    }

    it('A/B: só o cliente com a parada a vê; sem conta conectada, nada; o medidor parado só para a Verax', async () => {
      const tenantA = await createTenant(app, 'Cliente Demo A (Torre da AWS)');
      const tenantB = await createTenant(app, 'Cliente Demo B (Torre da AWS)');
      const accountA = await awsAccount(tenantA);
      await awsAccount(tenantB);
      const stalledSince = new Date(Date.now() - 3 * HOUR);
      await prisma.forTenant(tenantA).ingestHealth.create({
        data: { tenantId: tenantA, source: 'aws', lastProgressAt: stalledSince },
      });
      await prisma.forTenant(tenantB).ingestHealth.create({
        data: { tenantId: tenantB, source: 'aws', lastProgressAt: new Date(Date.now() - 10 * MINUTE) },
      });

      const towerA = await signedIn('leitura', tenantA);
      const towerB = await signedIn('leitura', tenantB);
      expect(await towerA()).toMatchObject({
        awsLogsStalledSince: stalledSince.toISOString(),
        awsStalledAfterHours: 2,
      });
      // O cliente nunca recebe o estado do medidor do nó.
      expect(await towerA()).not.toHaveProperty('awsMeterBlocked');
      expect(await towerB()).toMatchObject({ awsLogsStalledSince: null });
      // O escopo de B não alcança a saúde de A.
      expect(await prisma.forTenant(tenantB).ingestHealth.findMany()).toEqual([
        expect.objectContaining({ tenantId: tenantB }),
      ]);

      // A conta de A desconectada: a parada não é mostrada (a conexão já diz o problema).
      await prisma.cloudAccount.update({ where: { id: accountA.id }, data: { connection: 'error' } });
      expect(await towerA()).toMatchObject({ awsLogsStalledSince: null });

      // A equipe da Verax vê o medidor parado do nó (a linha de verdade da base), sem cliente nenhum citado.
      const verax = await signedIn('admin_verax', tenantA);
      await prisma.wazuhCounter.upsert({
        where: { id: WAZUH_COUNTER_ID },
        create: {
          id: WAZUH_COUNTER_ID,
          startedAt: START,
          bytesReceived: 0n,
          awsEvents: 0n,
          readAt: START,
          meterBlocked: 'multiple_tenants',
        },
        update: { meterBlocked: 'multiple_tenants' },
      });
      expect(await verax()).toMatchObject({ awsMeterBlocked: true });
      await prisma.wazuhCounter.update({ where: { id: WAZUH_COUNTER_ID }, data: { meterBlocked: null } });
      expect(await verax()).toMatchObject({ awsMeterBlocked: false });
    });
  });
});
