import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { findingRow, FindingStore, lockTenantFindings } from '../src/alerts/finding-store.js';
import { boundedCaseGroup, caseKeyOf } from '../src/cases/case-key.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import type { FindingSeverity, FindingStatus, Prisma } from '../src/generated/prisma/client.js';
import { RetentionJob } from '../src/retention/retention-job.js';
import { DAY_MS } from '../src/retention/retention-policy.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

/**
 * A base dos casos e da triagem em massa (migration `20261127120000_alert_cases`), no banco real: as contagens dos
 * gatilhos (exatas também com escritas ao mesmo tempo e pelos caminhos que já existem: triagem, incidentes e expurgo),
 * as chaves compostas por cliente e o escopo.
 */

const ACCOUNT = '111111111111';
const SEVERITIES: readonly FindingSeverity[] = ['critical', 'high', 'medium', 'low'];
const STATUSES: readonly FindingStatus[] = ['new', 'investigating', 'legitimate', 'resolved'];

const COUNTERS = {
  pending: true,
  total: true,
  pendingCritical: true,
  pendingHigh: true,
  pendingMedium: true,
  pendingLow: true,
  newCount: true,
  investigatingCount: true,
  legitimateCount: true,
  resolvedCount: true,
  incidentCount: true,
} as const;

type Counters = Record<Exclude<keyof typeof COUNTERS, 'pending'>, number> & { pending: boolean };

const ZERO: Counters = {
  pending: false,
  total: 0,
  pendingCritical: 0,
  pendingHigh: 0,
  pendingMedium: 0,
  pendingLow: 0,
  newCount: 0,
  investigatingCount: 0,
  legitimateCount: 0,
  resolvedCount: 0,
  incidentCount: 0,
};

/** A conta refeita em código, alerta por alerta: o que os gatilhos têm de dar. */
function recount(
  findings: readonly { severity: FindingSeverity; status: FindingStatus; incidentId: string | null }[],
): Counters {
  const counters = { ...ZERO };
  for (const { severity, status, incidentId } of findings) {
    counters.total += 1;
    if (incidentId !== null) {
      counters.incidentCount += 1;
      continue;
    }
    if (status === 'legitimate') counters.legitimateCount += 1;
    if (status === 'resolved') counters.resolvedCount += 1;
    if (status === 'new') counters.newCount += 1;
    if (status === 'investigating') counters.investigatingCount += 1;
    if (status !== 'new' && status !== 'investigating') continue;
    counters.pending = true;
    if (severity === 'critical') counters.pendingCritical += 1;
    if (severity === 'high') counters.pendingHigh += 1;
    if (severity === 'medium') counters.pendingMedium += 1;
    if (severity === 'low') counters.pendingLow += 1;
  }
  return counters;
}

const hexKey = () => randomBytes(32).toString('hex');

function only<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) throw new Error(`esperava uma linha, vieram ${rows.length}`);
  return row;
}

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

describe('casos: contagens, chaves por cliente e escopo', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  /** Os clientes deste arquivo: a limpeza é só deles. */
  const tenants: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.triageOperationItem.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.triageOperation.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.notification.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.finding.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.alertCase.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.incident.deleteMany({ where: { tenantId: { in: tenants } } });
    await app.close();
  });

  async function customer(name: string): Promise<string> {
    const tenantId = await createTenant(app, `Cliente Demo ${name} (casos)`);
    tenants.push(tenantId);
    return tenantId;
  }

  async function insertCase(
    tenantId: string,
    overrides: Partial<Prisma.AlertCaseUncheckedCreateInput> = {},
  ): Promise<string> {
    const groupKey = overrides.groupKey ?? hexKey();
    const now = new Date();
    const { id } = await prisma.alertCase.create({
      data: {
        tenantId,
        queue: 'detection',
        keyVersion: 1,
        groupKey,
        openKey: groupKey,
        family: 'cloudtrail',
        title: 'Caso de teste',
        keyParts: [{ name: 'rule', value: '100305' }],
        anchorFindingId: randomUUID(),
        firstSeenAt: now,
        lastSeenAt: now,
        lastAlertAt: now,
        ...overrides,
      },
      select: { id: true },
    });
    return id;
  }

  const findingData = (
    tenantId: string,
    overrides: Partial<Prisma.FindingUncheckedCreateInput> = {},
  ): Prisma.FindingUncheckedCreateInput => ({
    tenantId,
    accountId: ACCOUNT,
    source: 'wazuh',
    sourceEventId: `casos-${randomUUID()}`,
    logSource: 'cloudtrail',
    occurredAt: new Date(),
    severity: 'high',
    ruleId: '100305',
    ruleLevel: 10,
    title: 'Alerta de teste dos casos',
    mitreTactics: [],
    mitreTechniques: [],
    ...overrides,
  });

  async function insertFinding(
    tenantId: string,
    overrides: Partial<Prisma.FindingUncheckedCreateInput> = {},
  ): Promise<string> {
    const { id } = await prisma.finding.create({
      data: findingData(tenantId, overrides),
      select: { id: true },
    });
    return id;
  }

  async function insertIncident(tenantId: string): Promise<string> {
    const now = new Date();
    const { id } = await prisma.incident.create({
      data: {
        tenantId,
        severity: 'high',
        riskScore: 50,
        findingCount: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        keys: [],
        accounts: [],
        resources: [],
        mitreTactics: [],
        mitreTechniques: [],
      },
      select: { id: true },
    });
    return id;
  }

  /** A atribuição como a tarefa dos casos a fará: um comando só, sem tocar no `updatedAt`. */
  const assign = (tenantId: string, caseId: string, ids: readonly string[]) =>
    prisma.$executeRaw`
      UPDATE "Finding" SET "caseId" = ${caseId}::uuid
      WHERE "tenantId" = ${tenantId}::uuid AND "id" = ANY(${[...ids]}::uuid[])`;

  const counters = (id: string): Promise<Counters> =>
    prisma.alertCase.findUniqueOrThrow({ where: { id }, select: COUNTERS });

  const recounted = async (caseId: string): Promise<Counters> =>
    recount(
      await prisma.finding.findMany({
        where: { caseId },
        select: { severity: true, status: true, incidentId: true },
      }),
    );

  async function expectExact(...caseIds: string[]): Promise<void> {
    for (const caseId of caseIds) expect(await counters(caseId)).toEqual(await recounted(caseId));
  }

  /** Quantas linhas de caso um trecho de transação muda, e quantas sem mexer em índice (HOT). */
  function caseWrites(
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<{ updated: number; hot: number }> {
    return prisma.$transaction(async (tx) => {
      // As contagens da sessão ainda não publicadas entram nestas funções: vale a diferença.
      const read = async () => {
        const row = only(
          await tx.$queryRaw<{ updated: bigint; hot: bigint }[]>`
            SELECT pg_stat_get_xact_tuples_updated('"AlertCase"'::regclass) AS updated,
                   pg_stat_get_xact_tuples_hot_updated('"AlertCase"'::regclass) AS hot`,
        );
        return { updated: Number(row.updated), hot: Number(row.hot) };
      };
      const before = await read();
      await work(tx);
      const after = await read();
      return { updated: after.updated - before.updated, hot: after.hot - before.hot };
    });
  }

  describe('contagens pelos gatilhos', () => {
    it('cada alerta conta uma vez só: em incidente, ou no status dele; pendente é fora de incidente, novo ou investigando', async () => {
      const tenantId = await customer('contagem');
      const caseId = await insertCase(tenantId);
      const incidentId = await insertIncident(tenantId);
      expect(await counters(caseId)).toEqual(ZERO);
      const ids: string[] = [];
      for (const severity of SEVERITIES) {
        for (const status of STATUSES) {
          ids.push(await insertFinding(tenantId, { severity, status }));
          ids.push(await insertFinding(tenantId, { severity, status, incidentId }));
        }
      }
      // Sem caso, nada conta.
      expect(await counters(caseId)).toEqual(ZERO);
      expect(await assign(tenantId, caseId, ids)).toBe(32);
      expect(await counters(caseId)).toEqual({
        pending: true,
        total: 32,
        pendingCritical: 2,
        pendingHigh: 2,
        pendingMedium: 2,
        pendingLow: 2,
        newCount: 4,
        investigatingCount: 4,
        legitimateCount: 4,
        resolvedCount: 4,
        incidentCount: 16,
      });
      await expectExact(caseId);
    });

    it('atribuir, mudar de status, de severidade, de incidente e de caso, e apagar: tudo num comando ou um a um', async () => {
      const tenantId = await customer('mudanças');
      const [first, second] = [await insertCase(tenantId), await insertCase(tenantId)];
      const incidentId = await insertIncident(tenantId);
      const ids: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        ids.push(await insertFinding(tenantId, { severity: SEVERITIES[index % 4] as FindingSeverity }));
      }
      const some = (from: number, to: number) => ids.slice(from, to);
      const check = () => expectExact(first, second);

      await assign(tenantId, first, ids);
      expect(await counters(first)).toMatchObject({ total: 12, newCount: 12, pending: true });
      await check();
      // Um a um, como a triagem.
      await prisma.finding.update({ where: { id: ids[0] as string }, data: { status: 'investigating' } });
      await check();
      // Muitos num comando, com severidades diferentes.
      await prisma.finding.updateMany({ where: { id: { in: some(0, 6) } }, data: { status: 'legitimate' } });
      await check();
      await prisma.finding.updateMany({ where: { id: { in: some(4, 10) } }, data: { severity: 'critical' } });
      await check();
      // Entrar e sair de incidente, sem mudar o status.
      await prisma.finding.updateMany({ where: { id: { in: some(3, 9) } }, data: { incidentId } });
      expect(await counters(first)).toMatchObject({ incidentCount: 6 });
      await check();
      await prisma.finding.updateMany({ where: { id: { in: some(3, 5) } }, data: { incidentId: null } });
      await check();
      // Um comando que leva alertas de um caso para outro e muda o status de todos.
      await prisma.$executeRaw`
        UPDATE "Finding" SET "caseId" = ${second}::uuid, "status" = 'resolved', "severity" = 'low'
        WHERE "id" = ANY(${some(6, 12)}::uuid[])`;
      expect((await counters(second)).total).toBe(6);
      await check();
      // Sair do caso.
      await prisma.$executeRaw`UPDATE "Finding" SET "caseId" = NULL WHERE "id" = ANY(${some(6, 8)}::uuid[])`;
      expect((await counters(second)).total).toBe(4);
      await check();
      // Apagar o incidente devolve os alertas dele à fila (a cascata da chave estrangeira também passa pelo gatilho).
      await prisma.incident.delete({ where: { id: incidentId } });
      expect((await counters(first)).incidentCount).toBe(0);
      await check();
      await prisma.finding.deleteMany({ where: { id: { in: ids } } });
      expect(await counters(first)).toEqual(ZERO);
      expect(await counters(second)).toEqual(ZERO);
    });

    it('a pendência vira e volta, e trocas que se anulam no mesmo comando não mudam nada', async () => {
      const tenantId = await customer('pendência');
      const caseId = await insertCase(tenantId);
      const [a, b] = [await insertFinding(tenantId), await insertFinding(tenantId, { status: 'resolved' })];
      await assign(tenantId, caseId, [a, b]);
      expect((await counters(caseId)).pending).toBe(true);
      await prisma.finding.update({ where: { id: a }, data: { status: 'legitimate' } });
      expect((await counters(caseId)).pending).toBe(false);
      await prisma.finding.update({ where: { id: a }, data: { status: 'new' } });
      expect((await counters(caseId)).pending).toBe(true);
      const before = await counters(caseId);
      await prisma.$executeRaw`
        UPDATE "Finding" SET "status" = CASE "status" WHEN 'new' THEN 'resolved'::"FindingStatus" ELSE 'new' END
        WHERE "caseId" = ${caseId}::uuid`;
      expect(await counters(caseId)).toEqual(before);
      await expectExact(caseId);
    });

    it('o alerta inserido já num caso conta, e o que cai como duplicado, não', async () => {
      const tenantId = await customer('inserção');
      const caseId = await insertCase(tenantId);
      const data = [
        findingData(tenantId, { caseId, severity: 'critical' }),
        findingData(tenantId, { caseId, status: 'legitimate' }),
        findingData(tenantId, { severity: 'low' }),
      ];
      expect((await prisma.finding.createMany({ data, skipDuplicates: true })).count).toBe(3);
      expect(await counters(caseId)).toMatchObject({ total: 2, pendingCritical: 1, legitimateCount: 1 });
      expect((await prisma.finding.createMany({ data, skipDuplicates: true })).count).toBe(0);
      await expectExact(caseId);
    });

    it('o comando que volta atrás não deixa contagem', async () => {
      const tenantId = await customer('rollback');
      const caseId = await insertCase(tenantId);
      const id = await insertFinding(tenantId);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.finding.update({ where: { id }, data: { caseId, status: 'resolved' } });
          throw new Error('desfaz');
        }),
      ).rejects.toThrow('desfaz');
      expect(await counters(caseId)).toEqual(ZERO);
    });

    it('a atribuição não mexe no updatedAt do alerta, e a releitura (lastSeenAt) não toca no caso', async () => {
      const tenantId = await customer('updatedAt');
      const caseId = await insertCase(tenantId);
      const old = new Date(Date.now() - 200 * DAY_MS);
      const id = await insertFinding(tenantId, { occurredAt: old, createdAt: old, updatedAt: old });
      await assign(tenantId, caseId, [id]);
      const row = await prisma.finding.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ caseId, updatedAt: old });
      const { updated } = await caseWrites((tx) =>
        tx.finding.update({ where: { id }, data: { lastSeenAt: new Date() } }),
      );
      expect(updated).toBe(0);
      await expectExact(caseId);
    });

    it('a mudança de contagem é um update HOT: nenhum índice do caso é mexido', async () => {
      const tenantId = await customer('hot');
      const caseId = await insertCase(tenantId);
      const ids = [await insertFinding(tenantId), await insertFinding(tenantId)];
      await assign(tenantId, caseId, ids);
      // Várias mudanças: a primeira pode ter de trocar de página (o espaço dela depende dos outros testes); a seguinte
      // acha espaço na página nova. Com um índice numa contagem, nenhuma seria HOT.
      const writes = await caseWrites(async (tx) => {
        for (const status of ['investigating', 'new', 'investigating', 'new'] as const) {
          await tx.finding.update({ where: { id: ids[0] as string }, data: { status } });
        }
      });
      expect(writes.updated).toBe(4);
      expect(writes.hot).toBeGreaterThan(0);
    });

    it('exatas com escritas ao mesmo tempo, sem deadlock: triagem, coletor, incidente, troca de caso e expurgo', async () => {
      const tenantId = await customer('concorrência');
      const caseIds = [await insertCase(tenantId), await insertCase(tenantId), await insertCase(tenantId)];
      const incidents = [await insertIncident(tenantId), await insertIncident(tenantId)];
      await prisma.finding.createMany({
        data: Array.from({ length: 90 }, (_, index) =>
          findingData(tenantId, {
            severity: SEVERITIES[index % 4] as FindingSeverity,
            status: STATUSES[index % 3] as FindingStatus,
            caseId: caseIds[index % 3] as string,
          }),
        ),
      });
      const ids = (await prisma.finding.findMany({ where: { tenantId }, select: { id: true } })).map(
        (row) => row.id,
      );
      const url = inject('testDatabaseUrl');
      const workers = Array.from({ length: 8 }, (_, worker) => ({
        client: new pg.Client({ connectionString: url }),
        next: random(1_000 + worker),
      }));
      await Promise.all(workers.map(({ client }) => client.connect()));
      const done: Record<string, number> = {};
      try {
        await Promise.all(
          workers.map(async ({ client, next }) => {
            const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
            const several = (count: number) => Array.from({ length: count }, () => pick(ids));
            const lock = () =>
              client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`verax:findings:${tenantId}`]);
            const actions: Record<string, () => Promise<unknown>> = {
              // A triagem pela API: um alerta, sem o lock do cliente.
              triage: () =>
                client.query('UPDATE "Finding" SET "status" = $2 WHERE "id" = $1', [
                  pick(ids),
                  pick(STATUSES),
                ]),
              // O coletor que atualiza a severidade, sob o lock do cliente.
              revise: async () => {
                await lock();
                await client.query(
                  'UPDATE "Finding" SET "severity" = $2, "lastSeenAt" = now() WHERE "id" = $1',
                  [pick(ids), pick(SEVERITIES)],
                );
              },
              // Promover, anexar e remover.
              incident: async () => {
                await lock();
                await client.query('UPDATE "Finding" SET "incidentId" = $2 WHERE "id" = ANY($1::uuid[])', [
                  several(6),
                  next() < 0.5 ? null : pick(incidents),
                ]);
              },
              // A tarefa dos casos e o dividir.
              move: async () => {
                await lock();
                await client.query(
                  `UPDATE "Finding" SET "caseId" = $2, "status" = $3 WHERE "id" = ANY($1::uuid[])`,
                  [several(8), next() < 0.2 ? null : pick(caseIds), pick(STATUSES)],
                );
              },
              // O expurgo: trava as linhas, confere e apaga.
              purge: async () => {
                await lock();
                const doomed = several(2);
                await client.query(
                  'SELECT 1 FROM "Finding" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR UPDATE',
                  [doomed],
                );
                await client.query('DELETE FROM "Finding" WHERE "id" = ANY($1::uuid[])', [doomed]);
              },
            };
            for (let round = 0; round < 60; round += 1) {
              const action = pick([
                'triage',
                'triage',
                'triage',
                'triage',
                'revise',
                'revise',
                'incident',
                'move',
                ...(round % 20 === 0 ? ['purge'] : []),
              ]);
              await client.query('BEGIN');
              await actions[action]?.();
              // Uma parte volta atrás: a contagem volta junto.
              await client.query(next() < 0.15 ? 'ROLLBACK' : 'COMMIT');
              done[action] = (done[action] ?? 0) + 1;
            }
          }),
        );
      } finally {
        await Promise.all(workers.map(({ client }) => client.end()));
      }
      expect(Object.values(done).reduce((sum, count) => sum + count, 0)).toBe(480);
      const left = await prisma.finding.count({ where: { tenantId, caseId: { not: null } } });
      expect(left).toBeGreaterThan(0);
      await expectExact(...caseIds);
      const totals = await Promise.all(caseIds.map(counters));
      expect(totals.reduce((sum, { total }) => sum + total, 0)).toBe(left);
    });
  });

  describe('pelos caminhos que já existem', () => {
    async function sessionFor(tenantId: string) {
      const user = await createSignedInUser(app, { role: 'analista_cliente', tenantId });
      const { cookie, token } = await withCsrf(app, user.cookie);
      const write = (method: 'post' | 'patch' | 'delete', path: string, body?: object) => {
        const server = request(app.getHttpServer());
        const sent = server[method](path)
          .set('Cookie', cookie)
          .set('Origin', TEST_WEB_ORIGIN)
          .set('X-CSRF-Token', token);
        return body === undefined ? sent : sent.send(body);
      };
      return { write };
    }

    it('a triagem, o promover, o anexar, o remover e o resolver acertam o caso, e o alerta continua nele', async () => {
      const tenantId = await customer('API');
      const { write } = await sessionFor(tenantId);
      const caseId = await insertCase(tenantId);
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) ids.push(await insertFinding(tenantId));
      const [a, b, c, d, e] = ids as [string, string, string, string, string];
      await assign(tenantId, caseId, ids);

      await write('patch', `/v1/findings/${a}/status`, { status: 'investigating' }).expect(200);
      expect(await counters(caseId)).toMatchObject({ newCount: 4, investigatingCount: 1, pendingHigh: 5 });
      await write('patch', `/v1/findings/${a}/status`, { status: 'resolved' }).expect(200);
      expect(await counters(caseId)).toMatchObject({ newCount: 4, resolvedCount: 1, pendingHigh: 4 });

      const created = await write('post', '/v1/incidents', { findingIds: [b, c] }).expect(201);
      const incidentId = (created.body as { id: string }).id;
      expect(await counters(caseId)).toMatchObject({ incidentCount: 2, newCount: 2, pendingHigh: 2 });
      await write('post', `/v1/incidents/${incidentId}/findings`, { findingIds: [d] }).expect(200);
      expect(await counters(caseId)).toMatchObject({ incidentCount: 3, newCount: 1 });
      await write('delete', `/v1/incidents/${incidentId}/findings/${c}`).expect(200);
      expect(await counters(caseId)).toMatchObject({ incidentCount: 2, newCount: 2 });
      await write('patch', `/v1/incidents/${incidentId}`, { status: 'resolved' }).expect(200);
      await write('patch', `/v1/findings/${e}/status`, { status: 'legitimate' }).expect(200);
      expect(await counters(caseId)).toEqual({
        ...ZERO,
        pending: true,
        total: 5,
        pendingHigh: 1,
        newCount: 1,
        legitimateCount: 1,
        resolvedCount: 1,
        incidentCount: 2,
      });
      await expectExact(caseId);
      expect(await prisma.finding.count({ where: { id: { in: ids }, caseId } })).toBe(5);
    });

    it('triagens ao mesmo tempo pela API e a gravação dos coletores', async () => {
      const tenantId = await customer('API concorrente');
      const { write } = await sessionFor(tenantId);
      const caseId = await insertCase(tenantId);
      const ids: string[] = [];
      for (let index = 0; index < 16; index += 1) ids.push(await insertFinding(tenantId));
      await assign(tenantId, caseId, ids);
      const store = new FindingStore(prisma);
      const draft = (index: number): FindingDraft => ({
        ...(findingData(tenantId) as unknown as FindingDraft),
        sourceEventId: `casos-conc-${index}-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        severity: 'low',
        eventName: null,
        region: null,
        resource: null,
        actorUser: null,
        actorType: null,
        accessKeyId: null,
        sourceIp: null,
        mitreTactics: [],
        mitreTechniques: [],
      });
      const results = await Promise.all([
        ...ids.map((id, index) =>
          write('patch', `/v1/findings/${id}/status`, { status: STATUSES[index % 4] }).then(
            (response) => response.status,
          ),
        ),
        ...Array.from({ length: 8 }, (_, index) => store.persist(draft(index), null, new Date())),
      ]);
      expect(results).toEqual([...ids.map(() => 200), ...Array<string>(8).fill('created')]);
      expect(await counters(caseId)).toMatchObject({
        total: 16,
        newCount: 4,
        investigatingCount: 4,
        legitimateCount: 4,
        resolvedCount: 4,
      });
      await expectExact(caseId);
      // O coletor nunca dá caso a um alerta.
      expect(await prisma.finding.count({ where: { tenantId, caseId: null } })).toBe(8);
    });

    it('a versão nova na origem que muda a severidade acerta o caso (FindingStore.revise)', async () => {
      const tenantId = await customer('revise');
      const caseId = await insertCase(tenantId);
      const store = new FindingStore(prisma);
      const draft = (severity: FindingSeverity, lastSeenAt: string): FindingDraft => ({
        tenantId,
        accountId: ACCOUNT,
        source: 'aws',
        sourceEventId,
        occurredAt: '2026-11-20T10:00:00.000Z',
        severity,
        ruleId: '990511',
        ruleLevel: 7,
        title: 'Vulnerabilidade em pacote: CVE-2026-0001 - openssl',
        logSource: 'inspector',
        eventName: 'CVE-2026-0001',
        region: null,
        resource: 'ec2:i-0abc1234def567890',
        actorUser: null,
        actorType: null,
        accessKeyId: null,
        sourceIp: null,
        mitreTactics: [],
        mitreTechniques: [],
        revision: { lastSeenAt },
        group: 'openssl',
      });
      const sourceEventId = `casos-revise-${randomUUID()}`;
      await store.persist(draft('medium', '2026-11-20T10:00:00.000Z'), null, new Date());
      const row = await prisma.finding.findFirstOrThrow({ where: { tenantId } });
      expect(row.caseGroup).toBe('openssl');
      await assign(tenantId, caseId, [row.id]);
      expect(await counters(caseId)).toMatchObject({ pendingMedium: 1, pendingCritical: 0 });
      await store.persist(draft('critical', '2026-11-21T10:00:00.000Z'), null, new Date());
      expect(await counters(caseId)).toMatchObject({ pendingMedium: 0, pendingCritical: 1, total: 1 });
      await expectExact(caseId);
    });

    it('o expurgo leva alertas de casos, soltos e de incidente, com os itens da triagem, e as contagens acompanham', async () => {
      const tenantId = await customer('expurgo');
      const caseId = await insertCase(tenantId);
      const incidentId = await insertIncident(tenantId);
      const old = new Date(Date.now() - 200 * DAY_MS);
      const aged = { occurredAt: old, createdAt: old, updatedAt: old };
      await prisma.$executeRaw`
        UPDATE "Incident" SET "lastSeenAt" = ${old}, "updatedAt" = ${old} WHERE "id" = ${incidentId}::uuid`;
      const gone = [
        await insertFinding(tenantId, { ...aged, status: 'resolved' }),
        await insertFinding(tenantId, aged),
        await insertFinding(tenantId, { ...aged, incidentId }),
      ];
      const kept = await insertFinding(tenantId);
      await assign(tenantId, caseId, [...gone, kept]);
      await prisma.alertCase.update({ where: { id: caseId }, data: { incidentId } });
      const operation = await prisma.triageOperation.create({
        data: {
          tenantId,
          requestId: randomUUID(),
          action: 'status',
          status: 'resolved',
          target: { caseIds: [caseId] },
          cutoffAt: new Date(),
          expectedCount: 2,
        },
      });
      await prisma.triageOperationItem.createMany({
        data: [gone[0] as string, kept].map((findingId) => ({
          tenantId,
          operationId: operation.id,
          findingId,
          previousStatus: 'new' as const,
        })),
      });
      expect(await counters(caseId)).toMatchObject({
        total: 4,
        incidentCount: 1,
        resolvedCount: 1,
        newCount: 2,
      });

      // O caso com alerta não sai, nem por engano: a chave estrangeira do alerta o segura.
      await expect(prisma.alertCase.delete({ where: { id: caseId } })).rejects.toThrow(
        /Finding_caseId_tenantId_fkey|foreign key/i,
      );
      // Um por lote: cada lote é um comando, sob o lock do cliente.
      const report = await new RetentionJob(prisma, {
        historyDays: 90,
        name: `casos-${randomBytes(4).toString('hex')}`,
        batch: 1,
        pauseMs: 0,
        tenantIds: [tenantId],
      }).maybeRun(new Date(new Date().setUTCHours(23, 59, 0, 0)));
      expect(report).toMatchObject({ status: 'done', deleted: { findings: 3, incidents: 1 } });

      expect((await prisma.finding.findMany({ where: { tenantId } })).map((row) => row.id)).toEqual([kept]);
      expect(await counters(caseId)).toEqual({
        ...ZERO,
        pending: true,
        total: 1,
        pendingHigh: 1,
        newCount: 1,
      });
      // O incidente saiu: o caso ficou, sem ele.
      expect((await prisma.alertCase.findUniqueOrThrow({ where: { id: caseId } })).incidentId).toBeNull();
      // O item saiu com o alerta; o do alerta que ficou segura a operação.
      expect(
        (await prisma.triageOperationItem.findMany({ where: { tenantId } })).map((row) => row.findingId),
      ).toEqual([kept]);
      await expect(prisma.triageOperation.delete({ where: { id: operation.id } })).rejects.toThrow(
        /TriageOperationItem_operationId_tenantId_fkey|foreign key/i,
      );
      await prisma.finding.delete({ where: { id: kept } });
      expect(await counters(caseId)).toEqual(ZERO);
      await prisma.triageOperation.delete({ where: { id: operation.id } });
      await prisma.alertCase.delete({ where: { id: caseId } });
    });
  });

  describe('um caso nunca atravessa cliente', () => {
    it('o banco recusa o alerta de um cliente no caso de outro, na atribuição e na inserção', async () => {
      const [a, b] = [await customer('A'), await customer('B')];
      const [caseA, caseB] = [await insertCase(a), await insertCase(b)];
      const id = await insertFinding(a);
      await expect(assign(a, caseB, [id])).rejects.toThrow(/Finding_caseId_tenantId_fkey/);
      await expect(prisma.finding.update({ where: { id }, data: { caseId: caseB } })).rejects.toThrow(
        /Finding_caseId_tenantId_fkey|foreign key/i,
      );
      await expect(insertFinding(a, { caseId: caseB })).rejects.toThrow(
        /Finding_caseId_tenantId_fkey|foreign key/i,
      );
      await expect(assign(a, randomUUID(), [id])).rejects.toThrow(/Finding_caseId_tenantId_fkey/);
      await assign(a, caseA, [id]);
      expect(await counters(caseA)).toMatchObject({ total: 1 });
      expect(await counters(caseB)).toEqual(ZERO);
      // Nem levando o caso inteiro para outro cliente: os alertas dele o seguram.
      await expect(
        prisma.$executeRaw`UPDATE "AlertCase" SET "tenantId" = ${b}::uuid WHERE "id" = ${caseA}::uuid`,
      ).rejects.toThrow(/Finding_caseId_tenantId_fkey/);
      await expect(
        prisma.$executeRaw`UPDATE "Finding" SET "tenantId" = ${b}::uuid WHERE "id" = ${id}::uuid`,
      ).rejects.toThrow(/Finding_caseId_tenantId_fkey/);
      expect((await prisma.finding.findUniqueOrThrow({ where: { id } })).tenantId).toBe(a);
      await expectExact(caseA, caseB);
    });

    it('o incidente do caso, os itens e o desfazer também são do mesmo cliente', async () => {
      const [a, b] = [await customer('A2'), await customer('B2')];
      const caseA = await insertCase(a);
      const incidentB = await insertIncident(b);
      const incidentA = await insertIncident(a);
      await expect(
        prisma.alertCase.update({ where: { id: caseA }, data: { incidentId: incidentB } }),
      ).rejects.toThrow(/clientes diferentes/);
      await expect(insertCase(a, { incidentId: incidentB })).rejects.toThrow(/clientes diferentes/);
      await prisma.alertCase.update({ where: { id: caseA }, data: { incidentId: incidentA } });

      const operationOf = (
        tenantId: string,
        extra: Partial<Prisma.TriageOperationUncheckedCreateInput> = {},
      ) =>
        prisma.triageOperation.create({
          data: {
            tenantId,
            requestId: randomUUID(),
            action: 'attach',
            target: {},
            cutoffAt: new Date(),
            expectedCount: 1,
            ...extra,
          },
        });
      const [operationA, operationB] = [await operationOf(a), await operationOf(b)];
      const [findingA, findingB] = [await insertFinding(a), await insertFinding(b)];
      const item = (tenantId: string, operationId: string, findingId: string) =>
        prisma.triageOperationItem.create({
          data: { tenantId, operationId, findingId, previousStatus: 'new' },
        });
      await expect(item(a, operationB.id, findingA)).rejects.toThrow(/operationId|foreign key/i);
      await expect(item(a, operationA.id, findingB)).rejects.toThrow(/findingId|foreign key/i);
      await expect(item(b, operationA.id, findingA)).rejects.toThrow(/foreign key/i);
      await item(a, operationA.id, findingA);
      await expect(operationOf(a, { action: 'undo', undoOfId: operationB.id })).rejects.toThrow(
        /undoOfId|foreign key/i,
      );
      await operationOf(a, { action: 'undo', undoOfId: operationA.id });
      // Trocar o cliente da operação ou do alerta não leva os itens junto.
      await expect(
        prisma.$executeRaw`UPDATE "TriageOperation" SET "tenantId" = ${b}::uuid WHERE "id" = ${operationA.id}::uuid`,
      ).rejects.toThrow(/TriageOperation/);
      await expect(
        prisma.$executeRaw`UPDATE "Finding" SET "tenantId" = ${b}::uuid WHERE "id" = ${findingA}::uuid`,
      ).rejects.toThrow(/TriageOperationItem_findingId_tenantId_fkey/);
    });

    it('a mesma chave em dois clientes são dois casos; no mesmo cliente, só um aberto por vez', async () => {
      const [a, b] = [await customer('A3'), await customer('B3')];
      const groupKey = hexKey();
      const first = await insertCase(a, { groupKey });
      await insertCase(b, { groupKey });
      await expect(insertCase(a, { groupKey })).rejects.toThrow(/unique constraint/i);
      const seal = { openKey: null, sealedAt: new Date(), sealReason: 'treated' };
      await prisma.alertCase.update({ where: { id: first }, data: seal });
      const second = await insertCase(a, { groupKey, previousCaseId: first, recurrence: 1 });
      await prisma.alertCase.update({ where: { id: second }, data: { ...seal, sealReason: 'window' } });
      await insertCase(a, { groupKey, previousCaseId: second, recurrence: 2 });
      // Reabrir um selado com outro aberto no lugar não passa.
      await expect(
        prisma.alertCase.update({
          where: { id: first },
          data: { openKey: groupKey, sealedAt: null, sealReason: null },
        }),
      ).rejects.toThrow(/unique constraint/i);
      expect(await prisma.alertCase.count({ where: { tenantId: a, groupKey } })).toBe(3);
    });

    it('o mesmo requestId vale em dois clientes e não se repete num', async () => {
      const [a, b] = [await customer('A4'), await customer('B4')];
      const requestId = randomUUID();
      const create = (tenantId: string) =>
        prisma.triageOperation.create({
          data: {
            tenantId,
            requestId,
            action: 'promote',
            target: {},
            cutoffAt: new Date(),
            expectedCount: 0,
          },
        });
      await create(a);
      await create(b);
      await expect(create(a)).rejects.toThrow(/unique constraint/i);
    });

    it('no escopo de um cliente: o caso só é lido, e só o dele; as operações e os itens, só os dele', async () => {
      const [a, b] = [await customer('A5'), await customer('B5')];
      const [caseA, caseB] = [await insertCase(a), await insertCase(b)];
      const scoped = prisma.forTenant(a);
      expect((await scoped.alertCase.findMany({ select: { id: true } })).map((row) => row.id)).toEqual([
        caseA,
      ]);
      expect(await scoped.alertCase.findUnique({ where: { id: caseB } })).toBeNull();
      expect(await scoped.alertCase.count({ where: { id: caseB } })).toBe(0);
      const now = new Date();
      const groupKey = hexKey();
      const writes: (() => unknown)[] = [
        () =>
          scoped.alertCase.create({
            data: {
              tenantId: a,
              queue: 'detection',
              keyVersion: 1,
              groupKey,
              family: 'x',
              title: 'x',
              keyParts: [],
              anchorFindingId: randomUUID(),
              firstSeenAt: now,
              lastSeenAt: now,
              lastAlertAt: now,
            },
          }),
        () => scoped.alertCase.update({ where: { id: caseA }, data: { total: 99 } }),
        () => scoped.alertCase.updateMany({ data: { pending: false } }),
        () => scoped.alertCase.deleteMany({}),
        () => scoped.alertCase.delete({ where: { id: caseA } }),
      ];
      for (const write of writes) expect(write).toThrow(TenantScopeViolation);

      const operation = await prisma.forTenant(b).triageOperation.create({
        data: {
          requestId: randomUUID(),
          action: 'promote',
          target: {},
          cutoffAt: now,
          expectedCount: 1,
        } as Prisma.TriageOperationUncheckedCreateInput,
      });
      expect(operation.tenantId).toBe(b);
      const findingB = await insertFinding(b);
      await prisma.forTenant(b).triageOperationItem.create({
        data: {
          operationId: operation.id,
          findingId: findingB,
          previousStatus: 'new',
        } as Prisma.TriageOperationItemUncheckedCreateInput,
      });
      expect(await scoped.triageOperation.findUnique({ where: { id: operation.id } })).toBeNull();
      expect(
        (await scoped.triageOperation.updateMany({ where: { id: operation.id }, data: { state: 'done' } }))
          .count,
      ).toBe(0);
      expect((await scoped.triageOperation.deleteMany({ where: { id: operation.id } })).count).toBe(0);
      expect(await scoped.triageOperationItem.count({ where: { findingId: findingB } })).toBe(0);
      expect(
        (await scoped.triageOperationItem.deleteMany({ where: { operationId: operation.id } })).count,
      ).toBe(0);
      expect(await prisma.triageOperation.findUniqueOrThrow({ where: { id: operation.id } })).toMatchObject({
        state: 'queued',
        matched: 0,
      });
    });
  });

  describe('a chave do caso pelas colunas gravadas', () => {
    it('o rascunho como é gravado e a linha lida do banco dão a mesma chave, com texto cortado e unicode partido', async () => {
      const tenantId = await customer('chave');
      const store = new FindingStore(prisma);
      const long = (text: string, size: number) => text.repeat(size).slice(0, size);
      const base: FindingDraft = {
        tenantId,
        accountId: ACCOUNT,
        source: 'aws',
        sourceEventId: '',
        occurredAt: new Date().toISOString(),
        severity: 'high',
        ruleId: '100305',
        ruleLevel: 10,
        title: 'Alerta',
        logSource: 'cloudtrail',
        eventName: null,
        region: null,
        resource: null,
        actorUser: null,
        actorType: null,
        accessKeyId: null,
        sourceIp: null,
        mitreTactics: [],
        mitreTechniques: [],
      };
      const drafts: FindingDraft[] = [
        { ...base, actorUser: 'arn:aws:sts::111111111111:assumed-role/Deploy/sessão-😀' },
        // O corte de 512 unidades cai no meio de um emoji: o banco guarda U+FFFD.
        { ...base, actorUser: `${'a'.repeat(511)}😀` },
        { ...base, actorUser: long('😀', 2_000) },
        { ...base, resource: `${'r'.repeat(2_047)}😀resto` },
        { ...base, actorUser: '"],["actor","x' },
        {
          ...base,
          logSource: 'guardduty',
          ruleId: '80303',
          eventName: `${'t'.repeat(255)}😀`,
          resource: 'ec2:i-0abc1234',
        },
        {
          ...base,
          logSource: 'inspector',
          ruleId: '990511',
          eventName: 'CVE-2026-0001',
          title: 'Vulnerabilidade em pacote: CVE-2026-0001 - openssl, openssl-libs and 3 more',
          resource: 'ec2:i-0abc1234',
          group: 'openssl',
        },
        // O nome que não cabe na coluna entra cortado com o resumo, sem juntar dois.
        { ...base, logSource: 'inspector', ruleId: '990511', group: `${'p'.repeat(300)}a` },
        { ...base, logSource: 'inspector', ruleId: '990511', group: `${'p'.repeat(300)}b` },
        { ...base, logSource: 'inspector', ruleId: '990511', group: long('😀', 600) },
        {
          ...base,
          logSource: 'security_hub',
          ruleId: '990501',
          eventName: 'S3.1',
          resource: 's3:bucket-demo',
        },
        { ...base, logSource: 'waf', ruleId: '80443', resource: 'waf:acl', sourceIp: '::ffff:203.0.113.7' },
      ];
      const seen = new Set<string>();
      for (const draft of drafts) {
        const sourceEventId = `casos-chave-${randomUUID()}`;
        expect(await store.persist({ ...draft, sourceEventId }, null, new Date())).toBe('created');
        const row = await prisma.finding.findUniqueOrThrow({
          where: { source_sourceEventId: { source: 'aws', sourceEventId } },
        });
        const fromDraft = caseKeyOf(findingRow({ ...draft, sourceEventId }, null));
        expect(caseKeyOf(row)).toEqual(fromDraft);
        expect(row.caseGroup).toBe(draft.group === undefined ? null : boundedCaseGroup(draft.group));
        expect(row.caseId).toBeNull();
        // Gravar o subgrupo calculado (o que a atribuição fará) não muda a chave.
        const updated = await prisma.finding.update({
          where: { id: row.id },
          data: { caseGroup: fromDraft.group },
        });
        expect(caseKeyOf(updated).groupKey).toBe(fromDraft.groupKey);
        seen.add(fromDraft.groupKey);
      }
      expect(seen.size).toBe(drafts.length);
    });
  });

  it('o lock do cliente serializa quem mexe em vários casos (a ordem: lock, alertas, casos)', async () => {
    const tenantId = await customer('lock');
    const [first, second] = [await insertCase(tenantId), await insertCase(tenantId)];
    const ids = [await insertFinding(tenantId), await insertFinding(tenantId)];
    const move = (from: string, to: string) =>
      prisma.$transaction(async (tx) => {
        await lockTenantFindings(tx, tenantId);
        await tx.$executeRaw`UPDATE "Finding" SET "caseId" = ${from}::uuid WHERE "id" = ${ids[0]}::uuid`;
        await tx.$executeRaw`UPDATE "Finding" SET "caseId" = ${to}::uuid WHERE "id" = ${ids[1]}::uuid`;
      });
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? move(first, second) : move(second, first))),
    );
    await expectExact(first, second);
  });
});
