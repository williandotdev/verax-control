import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore } from '../src/alerts/finding-store.js';
import { CaseReconcileJob, reconcileCase } from '../src/cases/case-reconcile-job.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { FindingSeverity } from '../src/generated/prisma/client.js';
import { AlertNotices } from '../src/notifications/finding-notices.js';
import { RetentionJob } from '../src/retention/retention-job.js';
import { DAY_MS } from '../src/retention/retention-policy.js';
import {
  assignAll,
  assignJob,
  CASE_ACCOUNT,
  casesOf,
  cleanCases,
  expectExactCounters,
  expectSettled,
  insertFinding,
  insertIncident,
  insertMixed,
  loops,
  onlyTenantPhases,
  recentIds,
  SEVERITIES,
  STATUSES,
  watchedLogger,
} from './support/cases.js';

/**
 * A atribuição dos casos com tudo o que mexe nos alertas rodando ao mesmo tempo, no banco real: a gravação dos coletores,
 * a triagem e os incidentes (os comandos da API, em conexões próprias), o expurgo, a conferência das contagens e outra
 * réplica. O que se prova: ninguém cai em deadlock, nenhum alerta fica em dois casos nem sem caso, e as contagens fecham.
 * Pela API de verdade, está em `case-assign-api.test.ts`.
 */

/** Um gerador fixo (mulberry32): as misturas rodam iguais em toda execução. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('case-assign com escritas ao mesmo tempo', () => {
  let prisma: PrismaService;
  const tenants: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await prisma.$disconnect();
  });

  async function customer(name: string): Promise<string> {
    const { id } = await prisma.tenant.create({
      data: { name: `Cliente Demo ${name} (casos ao mesmo tempo)` },
      select: { id: true },
    });
    tenants.push(id);
    return id;
  }

  const draft = (tenantId: string, index: number, overrides: Partial<FindingDraft> = {}): FindingDraft => ({
    tenantId,
    accountId: CASE_ACCOUNT,
    source: 'wazuh',
    sourceEventId: `casos-ao-mesmo-tempo-${index}-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    severity: SEVERITIES[index % 4] as FindingSeverity,
    ruleId: `10030${index % 3}`,
    ruleLevel: 10,
    title: 'Alerta de teste',
    logSource: 'cloudtrail',
    eventName: null,
    region: null,
    resource: null,
    actorUser: `pessoa-${index % 4}`,
    actorType: null,
    accessKeyId: null,
    sourceIp: null,
    mitreTactics: [],
    mitreTechniques: [],
    ...overrides,
  });

  it('coletores, triagens, incidentes, expurgo, conferência e duas réplicas: sem deadlock, e tudo fecha', async () => {
    const tenantId = await customer('tudo');
    const old = new Date(Date.now() - 200 * DAY_MS);
    await insertMixed(prisma, tenantId, 160, new Date());
    // E os que o expurgo leva no meio.
    await insertMixed(prisma, tenantId, 50, old);
    const ids = await recentIds(prisma, tenantId, old);
    const incidentIds = [await insertIncident(prisma, tenantId), await insertIncident(prisma, tenantId)];
    const { errors, logger } = watchedLogger();
    // Duas réplicas sem a concessão entre elas (nomes diferentes): a correção não depende dela.
    const replicas = [0, 1].map(() => assignJob(prisma, [tenantId], { batch: 7, logger }));
    const background = loops(...replicas.map((job) => () => job.runOnce()), () =>
      new CaseReconcileJob(prisma, {
        tenantIds: [tenantId],
        name: `conf-${randomBytes(6).toString('hex')}`,
      }).runOnce(),
    );
    // Sem aviso por e-mail: a fila de saída é uma só, e outra suíte a lê inteira.
    const store = new FindingStore(
      prisma,
      new (class extends AlertNotices {
        override enqueue = () => Promise.resolve(0);
      })(),
    );
    const collect = async (collector: number) => {
      const outcomes: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        outcomes.push(await store.persist(draft(tenantId, collector * 100 + index), null, new Date()));
      }
      return outcomes;
    };
    const url = inject('testDatabaseUrl');
    const clients = Array.from({ length: 4 }, () => new pg.Client({ connectionString: url }));
    await Promise.all(clients.map((client) => client.connect()));
    /** A triagem pela API: um alerta por transação, sem o lock do cliente, e parte volta atrás. */
    const triage = async (client: pg.Client, part: number) => {
      const next = random(100 + part);
      for (let index = part; index < ids.length; index += 3) {
        await client.query('BEGIN');
        await client.query('UPDATE "Finding" SET "status" = $2, "updatedAt" = now() WHERE "id" = $1', [
          ids[index],
          STATUSES[Math.floor(next() * 4)],
        ]);
        await new Promise((resolve) => setTimeout(resolve, 3));
        await client.query(next() < 0.15 ? 'ROLLBACK' : 'COMMIT');
      }
    };
    /** Promover, anexar e remover: vários alertas por transação, sob o lock do cliente. */
    const attach = async (client: pg.Client) => {
      const next = random(7);
      for (let round = 0; round < 30; round += 1) {
        const several = Array.from({ length: 6 }, () => ids[Math.floor(next() * ids.length)]);
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`verax:findings:${tenantId}`]);
        await client.query('UPDATE "Finding" SET "incidentId" = $2 WHERE "id" = ANY($1::uuid[])', [
          several,
          next() < 0.4 ? null : incidentIds[round % 2],
        ]);
        await client.query('COMMIT');
      }
    };
    const purge = () =>
      new RetentionJob(onlyTenantPhases(prisma), {
        historyDays: 90,
        name: `casos-${randomBytes(4).toString('hex')}`,
        batch: 4,
        pauseMs: 0,
        tenantIds: [tenantId],
      }).maybeRun(new Date(new Date().setUTCHours(23, 59, 0, 0)));
    try {
      const [report, outcomes] = await Promise.all([
        purge(),
        Promise.all([collect(0), collect(1)]),
        ...clients.slice(0, 3).map((client, part) => triage(client, part)),
        attach(clients[3] as pg.Client),
      ]);
      expect(outcomes.flat().filter((outcome) => outcome === 'created')).toHaveLength(50);
      expect(report).toMatchObject({ status: 'done', deleted: { findings: 50 } });
    } finally {
      await background.stop();
      await Promise.all(clients.map((client) => client.end()));
    }
    // Só a espera longa devolve um lote; nem deadlock (40P01), nem alerta isolado.
    expect(errors.filter(({ sqlState }) => sqlState !== '55P03')).toEqual([]);
    await assignAll(prisma, [tenantId]);
    await expectSettled(prisma, tenantId, 160 + 50);
  });

  it('a triagem de um alerta de um caso enquanto o lote sela esse caso: uma espera a outra, sem ciclo', async () => {
    const tenantId = await customer('selo');
    const now = new Date();
    const [inside] = [
      await insertFinding(prisma, tenantId, { createdAt: new Date(now.getTime() - 3 * DAY_MS) }),
    ];
    await assignAll(prisma, [tenantId]);
    const [row] = await casesOf(prisma, tenantId);
    const client = new pg.Client({ connectionString: inject('testDatabaseUrl') });
    await client.connect();
    try {
      for (let round = 0; round < 10; round += 1) {
        await insertFinding(prisma, tenantId, { createdAt: new Date(now.getTime() + round) });
        // A triagem tem o alerta e o caso presos (o gatilho); o lote quer selar o mesmo caso.
        await client.query('BEGIN');
        await client.query('UPDATE "Finding" SET "status" = $2 WHERE "id" = $1', [
          inside,
          STATUSES[round % 2] as string,
        ]);
        const running = assignAll(prisma, [tenantId], {
          now: () => new Date(now.getTime() + 10_000),
          caseLockTimeoutMs: 30_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await client.query(round % 3 === 0 ? 'ROLLBACK' : 'COMMIT');
        await running;
      }
    } finally {
      await client.end();
    }
    const cases = await casesOf(prisma, tenantId);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ id: row?.id, sealReason: 'window', total: 1 });
    expect(cases[1]).toMatchObject({ previousCaseId: row?.id, total: 10 });
    await expectExactCounters(prisma, [tenantId]);
  });

  it.each([
    ['com a contagem certa', null],
    ['com a contagem errada, que ela corrige', { total: 99, newCount: 50 }],
  ] as const)(
    'a conferência espera a escrita em curso no caso e não perde a que vem depois, %s',
    async (_, drift) => {
      const tenantId = await customer('conferência');
      const ids = [await insertFinding(prisma, tenantId), await insertFinding(prisma, tenantId)];
      await assignAll(prisma, [tenantId]);
      const [row] = await casesOf(prisma, tenantId);
      const caseId = row?.id as string;
      const url = inject('testDatabaseUrl');
      const [before, after] = [
        new pg.Client({ connectionString: url }),
        new pg.Client({ connectionString: url }),
      ];
      await Promise.all([before.connect(), after.connect()]);
      try {
        if (drift !== null) await prisma.alertCase.update({ where: { id: caseId }, data: drift });
        // Uma triagem já contou no caso e ainda não confirmou: a conferência espera por ela.
        await before.query('BEGIN');
        await before.query('UPDATE "Finding" SET "status" = \'resolved\' WHERE "id" = $1', [ids[0]]);
        const running = reconcileCase(prisma, tenantId, caseId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        // Outra chega enquanto a conferência está na fila.
        await after.query('BEGIN');
        const second = after.query('UPDATE "Finding" SET "status" = \'legitimate\' WHERE "id" = $1', [
          ids[1],
        ]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await before.query('COMMIT');
        expect(await running).toEqual(drift === null ? [] : ['total', 'newCount']);
        await second;
        await after.query('COMMIT');
      } finally {
        await Promise.all([before.end(), after.end()]);
      }
      expect((await casesOf(prisma, tenantId))[0]).toMatchObject({
        total: 2,
        resolvedCount: 1,
        legitimateCount: 1,
        newCount: 0,
        pending: false,
      });
      await expectExactCounters(prisma, [tenantId]);
    },
  );
});
