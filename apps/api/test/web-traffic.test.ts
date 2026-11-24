import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { UsageMeter } from '../src/usage/usage-meter.js';
import { CLIENT_CLASSES } from '../src/weblogs/client-class.js';
import { settleWebLogObject, type WebLogObjectRecord } from '../src/weblogs/store/web-object-ledger.js';
import {
  type CountryTraffic,
  trafficClassOf,
  type TrafficDelta,
  trafficHourCutoff,
  trafficSlotCutoff,
  WebTrafficStore,
} from '../src/weblogs/store/web-traffic-store.js';

/**
 * O tráfego por país (o mapa) e o registro dos objetos: cada requisição conta uma vez, com releitura, réplicas, queda no
 * meio e passagem para as horas; e as consultas do mapa usam o índice numa tabela de tamanho realista.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SLOT = 5 * MINUTE;
/** Meio-dia: os cortes caem em horas cheias. */
const NOW = new Date('2026-11-24T12:00:00.000Z');
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

interface Source {
  tenantId: string;
  cloudAccountId: string;
  sourceId: string;
}

describe('tráfego por país e registro dos objetos do ALB', () => {
  const url = inject('testDatabaseUrl');
  let prisma: PrismaService;
  let store: WebTrafficStore;

  const connect = async (): Promise<pg.Client> => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client;
  };

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: url });
    store = new WebTrafficStore(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function newSource(name: string, tenantId?: string): Promise<Source> {
    const tenant = tenantId ?? (await prisma.tenant.create({ data: { name: `Cliente Demo ${name}` } })).id;
    const account = await prisma.cloudAccount.create({
      data: {
        tenantId: tenant,
        provider: 'aws',
        accountId: String(100_000_000_000 + Math.floor(Math.random() * 8e11)),
        regions: ['sa-east-1'],
      },
    });
    const source = await prisma.awsSource.create({
      data: {
        tenantId: tenant,
        cloudAccountId: account.id,
        kind: 'elb_logs',
        region: 'sa-east-1',
        resourceId: `loja-${randomBytes(3).toString('hex')}`,
        name: 'loja',
        method: 's3',
        availability: 'available',
        state: 'available',
      },
    });
    return { tenantId: tenant, cloudAccountId: account.id, sourceId: source.id };
  }

  const delta = (source: Source, slotStart: Date, over: Partial<TrafficDelta> = {}): TrafficDelta => ({
    tenantId: source.tenantId,
    sourceId: source.sourceId,
    slotStart,
    country: 'BR',
    clientClass: 'direct',
    requests: 10,
    blocked: 1,
    clientErrors: 2,
    serverErrors: 3,
    flagged: 4,
    ...over,
  });
  const add = (...deltas: TrafficDelta[]) => prisma.$transaction((tx) => store.add(tx, deltas));

  const objectOf = (source: Source, over: Partial<WebLogObjectRecord> = {}): WebLogObjectRecord => ({
    ...source,
    bucket: 'bucket-de-teste',
    key: `AWSLogs/111111111111/${randomUUID()}.log.gz`,
    status: 'read',
    slotStart: NOW,
    lines: 10,
    bytes: 8_000,
    malformed: 0,
    oversize: 0,
    foreign: 0,
    ...over,
  });

  const slotsOf = (tenantId: string) =>
    prisma.webTrafficSlot.findMany({
      where: { tenantId },
      orderBy: [{ slotStart: 'asc' }, { country: 'asc' }, { clientClass: 'asc' }],
    });
  const hoursOf = (tenantId: string) =>
    prisma.webTrafficHour.findMany({
      where: { tenantId },
      orderBy: [{ hourStart: 'asc' }, { country: 'asc' }, { clientClass: 'asc' }],
    });
  const sum = (rows: readonly { requests: bigint }[]): bigint =>
    rows.reduce((total, row) => total + row.requests, 0n);
  const totals = async (tenantId: string): Promise<bigint> =>
    sum(await slotsOf(tenantId)) + sum(await hoursOf(tenantId));
  const everything = (tenantId: string) => store.byCountry(tenantId, at(-60 * DAY), at(DAY));

  describe('soma', () => {
    it('junta por balanceador, intervalo, país e classe; linha só de zeros não é gravada', async () => {
      const source = await newSource('soma');
      await add(
        delta(source, NOW),
        delta(source, NOW),
        delta(source, NOW, { country: 'US' }),
        delta(source, NOW, { clientClass: 'proxy', country: 'ZZ', requests: 1 }),
        delta(source, at(SLOT)),
        delta(source, at(2 * SLOT), {
          requests: 0,
          blocked: 0,
          clientErrors: 0,
          serverErrors: 0,
          flagged: 0,
        }),
      );
      await add(delta(source, NOW, { requests: 5, flagged: 0 }));
      await add();
      expect((await slotsOf(source.tenantId)).map(({ tenantId: _, sourceId: __, ...row }) => row)).toEqual([
        {
          slotStart: NOW,
          country: 'BR',
          clientClass: 'direct',
          requests: 25n,
          blocked: 3n,
          clientErrors: 6n,
          serverErrors: 9n,
          flagged: 8n,
        },
        {
          slotStart: NOW,
          country: 'US',
          clientClass: 'direct',
          requests: 10n,
          blocked: 1n,
          clientErrors: 2n,
          serverErrors: 3n,
          flagged: 4n,
        },
        {
          slotStart: NOW,
          country: 'ZZ',
          clientClass: 'proxy',
          requests: 1n,
          blocked: 1n,
          clientErrors: 2n,
          serverErrors: 3n,
          flagged: 4n,
        },
        {
          slotStart: at(SLOT),
          country: 'BR',
          clientClass: 'direct',
          requests: 10n,
          blocked: 1n,
          clientErrors: 2n,
          serverErrors: 3n,
          flagged: 4n,
        },
      ]);
    });

    it('a linha só com um contador (qualquer deles) é gravada', async () => {
      const source = await newSource('um contador');
      const zero = { requests: 0, blocked: 0, clientErrors: 0, serverErrors: 0, flagged: 0 };
      const names = ['requests', 'blocked', 'clientErrors', 'serverErrors', 'flagged'] as const;
      await add(...names.map((name, i) => delta(source, at(i * SLOT), { ...zero, [name]: 1 })));
      expect(await slotsOf(source.tenantId)).toHaveLength(names.length);
    });

    it('milhares de linhas de uma vez, e contagens acima do que cabe num inteiro de 32 bits', async () => {
      const source = await newSource('muitas');
      const countries = Array.from({ length: 26 * 26 }, (_, i) =>
        String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
      );
      const many = countries.flatMap((country) => [
        delta(source, NOW, { country, requests: 6_000_000_000 }),
        delta(source, at(SLOT), { country }),
        delta(source, NOW, { country, clientClass: 'private' }),
        delta(source, at(SLOT), { country, clientClass: 'unverified' }),
      ]);
      await add(...many);
      await add(...many);
      const rows = await slotsOf(source.tenantId);
      expect(rows).toHaveLength(many.length);
      expect(rows[0]?.requests).toBe(12_000_000_000n);
    });

    it('recusa intervalo, país, classe e contagem fora do contrato, sem gravar nada do lote', async () => {
      const source = await newSource('recusas');
      const bad: Partial<TrafficDelta>[] = [
        { slotStart: at(1) },
        { slotStart: new Date(NaN) },
        { country: 'br' },
        { country: 'BRA' },
        { country: 'B' },
        { country: 'Ã1' },
        { country: '1A' },
        { country: 'A1' },
        { country: '[A' },
        { requests: -1 },
        { requests: 1.5 },
        { blocked: Number.MAX_SAFE_INTEGER + 1 },
        { flagged: NaN },
        { clientErrors: Infinity },
        { serverErrors: -0.5 },
      ];
      for (const over of bad) {
        await expect(add(delta(source, NOW), delta(source, NOW, over)), JSON.stringify(over)).rejects.toThrow(
          RangeError,
        );
      }
      await expect(
        add(delta(source, NOW, { clientClass: 'cdn' as TrafficDelta['clientClass'] })),
      ).rejects.toThrow(/WebTrafficSlot_values_check/);
      expect(await slotsOf(source.tenantId)).toEqual([]);
    });

    it('o balanceador de um cliente não recebe contagem em nome de outro', async () => {
      const [a, b] = [await newSource('A'), await newSource('B')];
      await expect(add(delta({ ...a, sourceId: b.sourceId }, NOW))).rejects.toThrow();
      expect(await slotsOf(a.tenantId)).toEqual([]);
      expect(await slotsOf(b.tenantId)).toEqual([]);
    });

    it('toda classe do motor tem a sua, e CDN e proxy são uma só', () => {
      expect(Object.fromEntries(CLIENT_CLASSES.map((cls) => [cls, trafficClassOf(cls)]))).toEqual({
        direct: 'direct',
        customer_proxy: 'proxy',
        cloudflare: 'proxy',
        cloudfront: 'proxy',
        private: 'private',
        unverified: 'unverified',
      });
    });
  });

  describe('cada objeto uma vez', () => {
    const settle = (object: WebLogObjectRecord, deltas: TrafficDelta[]) =>
      prisma.$transaction((tx) => settleWebLogObject(tx, store, object, deltas));

    it('o objeto relido não soma; outro objeto do mesmo intervalo (outro nó do balanceador) soma', async () => {
      const source = await newSource('relido');
      const object = objectOf(source, { malformed: 1, oversize: 2, foreign: 3 });
      expect(await settle(object, [delta(source, NOW)])).toBe(true);
      expect(await settle(object, [delta(source, NOW)])).toBe(false);
      expect(await settle({ ...object, status: 'late' }, [delta(source, NOW)])).toBe(false);
      expect(await totals(source.tenantId)).toBe(10n);
      expect(await settle(objectOf(source), [delta(source, NOW)])).toBe(true);
      expect(await totals(source.tenantId)).toBe(20n);
      // A mesma chave noutro bucket é outro objeto.
      expect(await settle({ ...object, bucket: 'outro-bucket' }, [delta(source, NOW)])).toBe(true);
      expect(await totals(source.tenantId)).toBe(30n);

      const rows = await prisma.webLogObject.findMany({ where: { tenantId: source.tenantId } });
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row.objectHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows.find((row) => row.malformed === 1)).toMatchObject({
        ...source,
        status: 'read',
        slotStart: NOW,
        lines: 10,
        bytes: 8_000n,
        oversize: 2,
        foreign: 3,
      });
      // A chave não fica guardada.
      const text = JSON.stringify(rows, (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(text).not.toContain('AWSLogs');
      expect(text).not.toContain('bucket-de-teste');
    });

    it('duas réplicas com o mesmo objeto ao mesmo tempo: uma soma', async () => {
      const source = await newSource('réplicas');
      for (let round = 0; round < 5; round += 1) {
        const object = objectOf(source);
        const results = await Promise.all(
          Array.from({ length: 4 }, () => settle(object, [delta(source, NOW)])),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await totals(source.tenantId)).toBe(BigInt(10 * (round + 1)));
      }
    });

    it('a queda depois da soma desfaz a linha, o tráfego e o volume medido; a releitura faz tudo, uma vez', async () => {
      const source = await newSource('queda');
      const object = objectOf(source);
      const run = (crash: boolean) =>
        prisma.$transaction(async (tx) => {
          const fresh = await settleWebLogObject(tx, store, object, [delta(source, NOW)]);
          if (fresh) {
            const meter = new UsageMeter();
            meter.add(source.tenantId, 'aws', object.bytes, object.lines, NOW);
            meter.addDaily(source.tenantId, 'aws', object.bytes, object.lines, NOW);
            await meter.flushIn(tx);
          }
          if (crash) throw new Error('o worker caiu');
          return fresh;
        });
      const usage = () =>
        prisma.ingestUsage.findMany({
          where: { tenantId: source.tenantId },
          select: { bytes: true, events: true },
        });
      await expect(run(true)).rejects.toThrow('o worker caiu');
      expect(await totals(source.tenantId)).toBe(0n);
      expect(await prisma.webLogObject.count({ where: { tenantId: source.tenantId } })).toBe(0);
      expect(await usage()).toEqual([]);
      expect(await run(false)).toBe(true);
      expect(await run(false)).toBe(false);
      expect(await totals(source.tenantId)).toBe(10n);
      expect(await usage()).toEqual([{ bytes: 8_000n, events: 10n }]);
    });

    it('o objeto não analisado é registrado e não soma; tráfego nele, ou de outro balanceador, é erro', async () => {
      const source = await newSource('não analisado');
      const other = await newSource('outro', source.tenantId);
      for (const status of ['quarantined', 'gap'] as const) {
        expect(await settle(objectOf(source, { status, slotStart: null, lines: 0, bytes: 0 }), [])).toBe(
          true,
        );
        await expect(settle(objectOf(source, { status }), [delta(source, NOW)])).rejects.toThrow(/analisado/);
      }
      await expect(settle(objectOf(source), [delta(other, NOW)])).rejects.toThrow(/balanceador/);
      const foreign = await newSource('outro cliente');
      await expect(settle(objectOf(source), [delta(foreign, NOW)])).rejects.toThrow(/balanceador/);
      await expect(
        settle(objectOf(source), [delta(source, NOW, { tenantId: foreign.tenantId })]),
      ).rejects.toThrow(/balanceador/);
      expect(await settle(objectOf(source, { status: 'late' }), [delta(source, NOW)])).toBe(true);
      expect(await prisma.webLogObject.count({ where: { tenantId: source.tenantId } })).toBe(3);
      expect(await totals(source.tenantId)).toBe(10n);
    });

    it('o objeto de um cliente não entra na conta nem na fonte de outro', async () => {
      const [a, b] = [await newSource('A'), await newSource('B')];
      await expect(settle(objectOf({ ...a, sourceId: b.sourceId }), [])).rejects.toThrow();
      await expect(settle(objectOf({ ...a, cloudAccountId: b.cloudAccountId }), [])).rejects.toThrow();
      expect(await prisma.webLogObject.count({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } })).toBe(
        0,
      );
    });
  });

  describe('passagem para as horas', () => {
    /** Dois balanceadores, dois países, 4 horas em volta do corte, um pedido a mais em cada linha. */
    async function seeded(name: string) {
      const one = await newSource(name);
      const two = await newSource(name, one.tenantId);
      const cutoff = trafficSlotCutoff(NOW).getTime();
      const deltas: TrafficDelta[] = [];
      for (const source of [one, two]) {
        for (let slot = -24; slot < 24; slot += 1) {
          for (const country of ['BR', 'US']) {
            deltas.push(delta(source, new Date(cutoff + slot * SLOT), { country }));
          }
        }
      }
      await add(...deltas);
      return { one, two, tenantId: one.tenantId, cutoff, rows: deltas.length };
    }

    it('o corte é a hora cheia de 48 h atrás', () => {
      expect(trafficSlotCutoff(NOW)).toEqual(at(-48 * HOUR));
      expect(trafficSlotCutoff(at(59 * MINUTE + 59_999))).toEqual(at(-48 * HOUR));
      expect(trafficSlotCutoff(at(HOUR))).toEqual(at(-47 * HOUR));
    });

    it('só as horas inteiras antes do corte passam, somadas por balanceador, país e classe; o resto fica', async () => {
      const { one, two, tenantId, cutoff, rows } = await seeded('passagem');
      const before = await everything(tenantId);
      expect(await store.rollup(NOW, [tenantId])).toBe(rows / 2);
      const slots = await slotsOf(tenantId);
      expect(slots).toHaveLength(rows / 2);
      // O intervalo do próprio corte fica.
      expect(slots[0]?.slotStart.getTime()).toBe(cutoff);
      const hours = await hoursOf(tenantId);
      expect(hours).toHaveLength(2 * 2 * 2);
      for (const source of [one, two]) {
        expect(
          hours.filter((row) => row.sourceId === source.sourceId).map((row) => [row.hourStart, row.country]),
        ).toEqual([
          [new Date(cutoff - 2 * HOUR), 'BR'],
          [new Date(cutoff - 2 * HOUR), 'US'],
          [new Date(cutoff - HOUR), 'BR'],
          [new Date(cutoff - HOUR), 'US'],
        ]);
      }
      expect(hours[0]).toMatchObject({
        requests: 120n,
        blocked: 12n,
        clientErrors: 24n,
        serverErrors: 36n,
        flagged: 48n,
      });
      // Nada se perde nem dobra, e o mapa não vê diferença.
      expect(await everything(tenantId)).toEqual(before);
      // De novo: nada a passar.
      expect(await store.rollup(NOW, [tenantId])).toBe(0);
      expect(await hoursOf(tenantId)).toEqual(hours);
    });

    it('na hora, cada classe de cliente do mesmo país continua separada', async () => {
      const source = await newSource('classes');
      const old = new Date(trafficSlotCutoff(NOW).getTime() - HOUR);
      await add(
        delta(source, old),
        delta(source, new Date(old.getTime() + SLOT), { clientClass: 'proxy', requests: 7 }),
        delta(source, new Date(old.getTime() + 2 * SLOT), { clientClass: 'proxy', requests: 1 }),
      );
      expect(await store.rollup(NOW, [source.tenantId])).toBe(3);
      expect((await hoursOf(source.tenantId)).map((row) => [row.clientClass, row.requests])).toEqual([
        ['direct', 10n],
        ['proxy', 8n],
      ]);
    });

    it('o objeto atrasado de uma hora que já passou soma nela na vez seguinte', async () => {
      const { one, tenantId, cutoff } = await seeded('atrasado');
      await store.rollup(NOW, [tenantId]);
      const hour = new Date(cutoff - HOUR);
      const of = async () =>
        (await hoursOf(tenantId)).find(
          (row) =>
            row.sourceId === one.sourceId &&
            row.country === 'BR' &&
            row.hourStart.getTime() === hour.getTime(),
        );
      await add(delta(one, new Date(cutoff - SLOT), { requests: 7, flagged: 0 }));
      // Antes da passagem, o mapa já o soma.
      expect((await of())?.requests).toBe(120n);
      const total = (await everything(tenantId)).find((row) => row.country === 'BR')?.requests;
      expect(await store.rollup(NOW, [tenantId])).toBe(1);
      expect(await of()).toMatchObject({
        requests: 127n,
        blocked: 13n,
        clientErrors: 26n,
        serverErrors: 39n,
        flagged: 48n,
      });
      expect((await everything(tenantId)).find((row) => row.country === 'BR')?.requests).toBe(total);
    });

    it('um cliente por vez: o outro não é tocado', async () => {
      const a = await seeded('A (passagem)');
      const b = await seeded('B (passagem)');
      const before = await slotsOf(b.tenantId);
      await store.rollup(NOW, [a.tenantId]);
      expect(await slotsOf(b.tenantId)).toEqual(before);
      expect(await hoursOf(b.tenantId)).toEqual([]);
    });

    it('o processo do banco derrubado no meio da instrução não perde nem dobra; a vez seguinte termina', async () => {
      const { one, tenantId, cutoff } = await seeded('derrubado');
      const before = await everything(tenantId);
      // A linha da hora existe, e outra transação a segura: a passagem apaga os intervalos e para na soma.
      await prisma.webTrafficHour.create({
        data: {
          tenantId,
          sourceId: one.sourceId,
          hourStart: new Date(cutoff - 2 * HOUR),
          country: 'BR',
          clientClass: 'direct',
          requests: 1n,
          blocked: 0n,
          clientErrors: 0n,
          serverErrors: 0n,
          flagged: 0n,
        },
      });
      const holder = await connect();
      const killer = await connect();
      try {
        const [pid] = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows;
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM "WebTrafficHour" WHERE "tenantId" = $1 FOR UPDATE', [tenantId]);
        const target = { tenantId, sourceId: one.sourceId, hour: new Date(cutoff - 2 * HOUR) };
        const running = store.rollupHour(target).then(
          () => 'passou',
          () => 'caiu',
        );
        let killed = 0;
        for (let i = 0; i < 200 && killed === 0; i += 1) {
          const { rows } = await killer.query<{ killed: boolean }>(
            `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%WITH moved AS%'`,
            [pid?.pid],
          );
          killed = rows.length;
          if (killed === 0) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(killed).toBe(1);
        expect(await running).toBe('caiu');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
        await killer.end();
      }
      const slotsBefore = await slotsOf(tenantId);
      expect(slotsBefore).toHaveLength(2 * 48 * 2);
      expect(sum(await hoursOf(tenantId))).toBe(1n);

      expect(await store.rollup(NOW, [tenantId])).toBe(96);
      const after = await everything(tenantId);
      const extra = (rows: CountryTraffic[]) => rows.find((row) => row.country === 'BR')?.requests ?? 0n;
      expect(extra(after)).toBe(extra(before) + 1n);
      expect(await totals(tenantId)).toBe(BigInt(2 * 48 * 2 * 10 + 1));
    });

    it('parar entre duas horas deixa as outras para depois; nada dobra', async () => {
      const { tenantId, rows } = await seeded('parada');
      const before = await everything(tenantId);
      const controller = new AbortController();
      let done = 0;
      const stopping = new (class extends WebTrafficStore {
        override async rollupHour(target: Parameters<WebTrafficStore['rollupHour']>[0]): Promise<number> {
          const moved = await super.rollupHour(target);
          done += 1;
          if (done === 2) controller.abort();
          return moved;
        }
      })(prisma);
      await expect(stopping.rollup(NOW, [tenantId], controller.signal)).rejects.toThrow();
      expect(done).toBe(2);
      expect(await everything(tenantId)).toEqual(before);
      expect(await store.rollup(NOW, [tenantId])).toBe(rows / 2 - 2 * 12 * 2);
      expect(await everything(tenantId)).toEqual(before);
    });

    it('passagens, somas e leituras ao mesmo tempo: o total é exato, e nenhuma leitura o vê pela metade', async () => {
      const { one, tenantId, cutoff, rows } = await seeded('ao mesmo tempo');
      const base = BigInt(rows * 10);
      const late = Array.from({ length: 20 }, (_, i) =>
        delta(one, new Date(cutoff - (1 + (i % 24)) * SLOT), { requests: 1 }),
      );
      const seen: bigint[] = [];
      let reading = true;
      const reader = (async () => {
        while (reading) seen.push(sum(await everything(tenantId)));
      })();
      await Promise.all([
        ...Array.from({ length: 3 }, () => store.rollup(NOW, [tenantId])),
        ...late.map((item) => add(item)),
      ]);
      await store.rollup(NOW, [tenantId]);
      reading = false;
      await reader;
      expect(await totals(tenantId)).toBe(base + 20n);
      expect((await slotsOf(tenantId)).every((row) => row.slotStart.getTime() >= cutoff)).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      let last = 0n;
      for (const value of seen) {
        expect(value).toBeGreaterThanOrEqual(base);
        expect(value).toBeLessThanOrEqual(base + 20n);
        // Só sobe: nunca some uma hora no meio da passagem.
        expect(value).toBeGreaterThanOrEqual(last);
        last = value;
      }
    });
  });

  describe('limpeza das horas', () => {
    it('sai o que tem mais de 35 dias; o próprio corte fica; o outro cliente, inteiro', async () => {
      const [a, b] = [await newSource('A (limpeza)'), await newSource('B (limpeza)')];
      const cutoff = trafficHourCutoff(NOW);
      expect(cutoff).toEqual(at(-35 * DAY));
      const row = (source: Source, hourStart: Date, country = 'BR') => ({
        tenantId: source.tenantId,
        sourceId: source.sourceId,
        hourStart,
        country,
        clientClass: 'direct',
        requests: 1n,
        blocked: 0n,
        clientErrors: 0n,
        serverErrors: 0n,
        flagged: 0n,
      });
      const old = new Date(cutoff.getTime() - HOUR);
      const older = new Date(cutoff.getTime() - 30 * DAY);
      await prisma.webTrafficHour.createMany({
        data: [a, b].flatMap((source) => [
          row(source, older),
          row(source, old),
          row(source, old, 'US'),
          row(source, cutoff),
          row(source, at(-DAY)),
        ]),
      });
      await add(delta(a, NOW));
      expect(await store.purge(NOW, [a.tenantId])).toBe(3);
      expect((await hoursOf(a.tenantId)).map((item) => item.hourStart)).toEqual([cutoff, at(-DAY)]);
      expect(await hoursOf(b.tenantId)).toHaveLength(5);
      expect(await slotsOf(a.tenantId)).toHaveLength(1);
      expect(await store.purge(NOW, [a.tenantId])).toBe(0);
      // Um milissegundo antes da hora do corte, ela ainda fica.
      expect(await store.purge(at(1), [a.tenantId])).toBe(1);
    });

    it('a busca e a limpeza de uma hora são de um balanceador só', async () => {
      const one = await newSource('um');
      const two = await newSource('dois', one.tenantId);
      const hourStart = at(-40 * DAY);
      for (const source of [one, two]) {
        await prisma.webTrafficHour.create({
          data: {
            tenantId: source.tenantId,
            sourceId: source.sourceId,
            hourStart,
            country: 'BR',
            clientClass: 'direct',
            requests: 1n,
            blocked: 0n,
            clientErrors: 0n,
            serverErrors: 0n,
            flagged: 0n,
          },
        });
      }
      const target = await store.nextToPurge(one.tenantId, trafficHourCutoff(NOW));
      expect(target?.hour).toEqual(hourStart);
      if (target === null) throw new Error('sem hora a limpar');
      expect(await store.purgeHour(target)).toBe(1);
      expect(await hoursOf(one.tenantId)).toHaveLength(1);
      expect(await store.purge(NOW, [one.tenantId])).toBe(1);
      expect(await store.nextToPurge(one.tenantId, trafficHourCutoff(NOW))).toBeNull();
      expect(await store.nextToRollup(one.tenantId, trafficSlotCutoff(NOW))).toBeNull();
    });
  });

  describe('leitura do mapa', () => {
    it('por país e classe, do maior para o menor, de `from` (inclusive) a `to` (exclusive), só do cliente', async () => {
      const [a, b] = [await newSource('A (mapa)'), await newSource('B (mapa)')];
      const a2 = await newSource('A2 (mapa)', a.tenantId);
      await add(
        delta(a, at(-15 * MINUTE), { requests: 100 }),
        delta(a2, at(-10 * MINUTE), { requests: 50 }),
        delta(a, at(-10 * MINUTE), { country: 'US', requests: 150 }),
        delta(a, at(-10 * MINUTE), { country: 'US', clientClass: 'proxy', requests: 150 }),
        delta(a, at(-20 * MINUTE), { country: 'AR', requests: 900 }),
        delta(a, NOW, { country: 'CL', requests: 900 }),
        delta(b, at(-10 * MINUTE), { country: 'DE', requests: 1_000 }),
      );
      const rows = await store.byCountry(a.tenantId, at(-15 * MINUTE), NOW);
      expect(rows.map((row) => [row.country, row.clientClass, row.requests])).toEqual([
        ['BR', 'direct', 150n],
        ['US', 'direct', 150n],
        ['US', 'proxy', 150n],
      ]);
      expect(rows[0]).toEqual({
        country: 'BR',
        clientClass: 'direct',
        requests: 150n,
        blocked: 2n,
        clientErrors: 4n,
        serverErrors: 6n,
        flagged: 8n,
      });
      expect((await store.byCountry(b.tenantId, at(-DAY), at(DAY))).map((row) => row.country)).toEqual([
        'DE',
      ]);
      expect(
        (await store.byCountry(a.tenantId, at(-20 * MINUTE), NOW)).map((row) => [row.country, row.requests]),
      ).toEqual([
        ['AR', 900n],
        ['BR', 150n],
        ['US', 150n],
        ['US', 150n],
      ]);
      expect(await store.byCountry(a.tenantId, at(-5 * MINUTE), at(-5 * MINUTE))).toEqual([]);
      expect(await store.byCountry(randomUUID(), at(-DAY), at(DAY))).toEqual([]);
    });

    it('além de 48 h, a hora em que `from` cai entra inteira; a de `to`, não', async () => {
      const source = await newSource('horas (mapa)');
      const cutoff = trafficSlotCutoff(NOW).getTime();
      await add(
        delta(source, new Date(cutoff - 3 * HOUR), { country: 'AR' }),
        delta(source, new Date(cutoff - 2 * HOUR), { country: 'BR' }),
        delta(source, new Date(cutoff - HOUR), { country: 'CL' }),
      );
      await store.rollup(NOW, [source.tenantId]);
      const countries = async (from: number, to: number) =>
        (await store.byCountry(source.tenantId, new Date(from), new Date(to))).map((row) => row.country);
      expect(await countries(cutoff - 2 * HOUR, cutoff)).toEqual(['BR', 'CL']);
      expect(await countries(cutoff - 2 * HOUR + 59 * MINUTE, cutoff)).toEqual(['BR', 'CL']);
      expect(await countries(cutoff - 3 * HOUR, cutoff - HOUR)).toEqual(['AR', 'BR']);
    });
  });

  describe('custo, numa tabela de tamanho realista (2 clientes; em cada um, 2 dias, 2 balanceadores, 120 países, 3 classes)', () => {
    let tenantId: string;
    let sourceIds: string[];
    let client: pg.Client;
    const tenants: string[] = [];

    beforeAll(async () => {
      client = await connect();
      // Sem os gatilhos das chaves estrangeiras, só nesta sessão: 829.440 linhas válidas de uma vez.
      await client.query('SET session_replication_role = replica');
      for (const name of ['vizinho', 'tamanho']) {
        const one = await newSource(name);
        const two = await newSource(name, one.tenantId);
        tenantId = one.tenantId;
        tenants.push(tenantId);
        sourceIds = [one.sourceId, two.sourceId];
        await client.query(
          `INSERT INTO "WebTrafficSlot"
           SELECT $1::uuid, s, g, chr(65 + c / 26) || chr(65 + c % 26), cl, 100, 5, 10, 1, 2
           FROM generate_series($2::timestamptz - interval '48 hours', $2::timestamptz - interval '5 minutes', interval '5 minutes') AS g,
             unnest($3::uuid[]) AS s, generate_series(0, 119) AS c, unnest(ARRAY['direct', 'proxy', 'private']) AS cl`,
          [tenantId, NOW, sourceIds],
        );
      }
      await client.query('ANALYZE "WebTrafficSlot"');
    }, 180_000);

    afterAll(async () => {
      await client.query('DELETE FROM "WebTrafficSlot" WHERE "tenantId" = ANY($1::uuid[])', [tenants]);
      await client.end();
    }, 120_000);

    /** Como o plano lê uma tabela. */
    function scansOf(plan: string, table: string): string[] {
      const found: string[] = [];
      JSON.parse(plan, (_, value: unknown) => {
        const node = value as { 'Node Type'?: string; 'Relation Name'?: string } | null;
        if (node?.['Relation Name'] === table && node['Node Type']) found.push(node['Node Type']);
        return value;
      });
      expect(found.length).toBeGreaterThan(0);
      return found;
    }

    /** O plano da consulta de verdade, com os parâmetros dela. */
    async function planOf(from: Date, to: Date): Promise<{ plan: string; rows: CountryTraffic[] }> {
      const logged = new PrismaClient({
        adapter: new PrismaPg({ connectionString: url, max: 1 }),
        log: [{ emit: 'event', level: 'query' }],
      });
      try {
        let sql = '';
        logged.$on('query', ({ query }) => {
          sql = query;
        });
        const withDb = Object.assign(logged, { db: () => logged }) as unknown as PrismaService;
        const rows = await new WebTrafficStore(withDb).byCountry(tenantId, from, to);
        expect(sql).toContain('"WebTrafficSlot"');
        const fromHour = new Date(Math.floor(from.getTime() / HOUR) * HOUR);
        const { rows: explained } = await client.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
          [tenantId, from, to, tenantId, fromHour, to],
        );
        return { plan: JSON.stringify(explained), rows };
      } finally {
        await logged.$disconnect();
      }
    }

    it('os últimos 15 minutos e as últimas 24 h usam o índice do cliente e do horário, sem ler a tabela inteira', async () => {
      for (const [minutes, slots] of [
        [15, 3],
        [24 * 60, 288],
      ] as const) {
        const { plan, rows } = await planOf(at(-minutes * MINUTE), NOW);
        const [, took] = /"Execution Time":([\d.]+)/.exec(plan) ?? [];
        console.info(`[web-traffic] mapa, ${minutes} min: ${took} ms`);
        expect(Number(took)).toBeLessThan(5_000);
        expect(plan, `${minutes} min`).toContain('WebTrafficSlot_tenantId_slotStart_idx');
        // Só a tabela dos intervalos: a das horas, quase vazia aqui, o banco pode ler inteira.
        expect(scansOf(plan, 'WebTrafficSlot'), `${minutes} min`).not.toContain('Seq Scan');
        // Nada em disco: 360 grupos cabem na memória.
        expect(plan, `${minutes} min`).not.toContain('"Sort Space Type":"Disk"');
        expect(rows).toHaveLength(360);
        for (const row of rows) expect(row.requests).toBe(BigInt(100 * slots * 2));
      }
    });

    it('achar a hora mais antiga e passar uma hora usam índice, e o apagar de uma fonte também', async () => {
      const plan = async (sql: string, values: unknown[]) =>
        JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, values)).rows);
      const oldest = await plan(
        `SELECT "sourceId", "slotStart" FROM "WebTrafficSlot" WHERE "tenantId" = $1 AND "slotStart" < $2
         ORDER BY "slotStart" ASC LIMIT 1`,
        [tenantId, at(-47 * HOUR)],
      );
      expect(oldest).toContain('WebTrafficSlot_tenantId_slotStart_idx');
      expect(oldest).not.toContain('"Sort"');
      // A tabela das horas tem os mesmos índices (`web-logs-migration.test.ts`).
      expect(
        await plan(
          `DELETE FROM "WebTrafficSlot" WHERE "tenantId" = $1 AND "sourceId" = $2 AND "slotStart" >= $3 AND "slotStart" < $4`,
          [tenantId, sourceIds[0], at(-48 * HOUR), at(-47 * HOUR)],
        ),
      ).toContain('"Index Name":"WebTrafficSlot_pkey"');
      // A consulta que a chave estrangeira em cascata faz, para cada fonte apagada (quase todas sem tráfego nenhum).
      expect(
        await plan(
          `DELETE FROM "WebTrafficSlot" WHERE $1 OPERATOR(pg_catalog.=) "sourceId" AND $2 OPERATOR(pg_catalog.=) "tenantId"`,
          [randomUUID(), tenantId],
        ),
      ).toContain('"Index Name":"WebTrafficSlot_pkey"');
    });

    it('somar um objeto (360 linhas) e passar a hora mais antiga são rápidos nessa tabela', async () => {
      const source: Source = { tenantId, sourceId: sourceIds[0] as string, cloudAccountId: '' };
      const deltas = Array.from({ length: 120 }, (_, c) =>
        (['direct', 'proxy', 'private'] as const).map((clientClass) =>
          delta(source, at(-SLOT), {
            country: String.fromCharCode(65 + Math.floor(c / 26), 65 + (c % 26)),
            clientClass,
          }),
        ),
      ).flat();
      expect(deltas).toHaveLength(360);
      const timed = async (work: () => Promise<unknown>): Promise<number> => {
        const started = performance.now();
        await work();
        return performance.now() - started;
      };
      const added = await timed(() => add(...deltas));
      const target = await store.nextToRollup(tenantId, at(-47 * HOUR));
      expect(target?.hour).toEqual(at(-48 * HOUR));
      if (target === null) throw new Error('sem hora a passar');
      let moved = 0;
      const rolled = await timed(async () => {
        moved = await store.rollupHour(target);
      });
      expect(moved).toBe(12 * 120 * 3);
      // Folga para a máquina do CI.
      expect(added).toBeLessThan(2_000);
      expect(rolled).toBeLessThan(5_000);
      console.info(
        `[web-traffic] somar 360 linhas: ${added.toFixed(0)} ms; passar 4.320: ${rolled.toFixed(0)} ms`,
      );
    });
  });
});
