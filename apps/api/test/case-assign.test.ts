import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { findingRow } from '../src/alerts/finding-store.js';
import { type CaseAssignReport, QUARANTINE_LIMIT } from '../src/cases/case-assign-job.js';
import { CaseBatchError, isAlertFault, sqlStateOf } from '../src/cases/case-errors.js';
import { caseKeyOf, foldedCaseKey } from '../src/cases/case-key.js';
import { lockOutboxRows, oldestUnassigned, readOutboxPage } from '../src/cases/case-store.js';
import { caseTasks } from '../src/cases/case-tasks.js';
import { CaseWatch } from '../src/cases/case-watch.js';
import { loadWorkerConfig } from '../src/common/config/load-config.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { DAY_MS } from '../src/retention/retention-policy.js';
import { createTenant } from './support/auth-helpers.js';
import {
  assignAll,
  assignJob,
  CASE_ACCOUNT,
  casesOf,
  cleanCases,
  expectExactCounters,
  findingData,
  HOUR_MS,
  insertFinding,
  insertIncident,
} from './support/cases.js';
import { createApp } from './support/create-app.js';

/**
 * A tarefa `case-assign` no banco real: o que entra na fila, o ciclo do caso, os limites, o que sobra de uma falha e o
 * isolamento entre clientes. As escritas ao mesmo tempo estão em `case-assign-concurrency.test.ts`.
 */

/** Um instante fixo, no passado: a chegada dos alertas e o relógio da tarefa saem daqui. */
const T0 = new Date('2026-11-02T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

type Transaction = (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => unknown;

/** O banco com defeito: o comando que leva um destes valores falha (`fail`), dentro da transação do lote. */
function broken(
  prisma: PrismaService,
  values: ReadonlySet<string>,
  fail: (tx: Prisma.TransactionClient) => Promise<number>,
): PrismaService {
  const brokenTx = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (property !== '$executeRaw') return value;
        return (strings: TemplateStringsArray, ...params: unknown[]) => {
          const hit =
            strings.join('?').includes('UPDATE "Finding"') &&
            params.some((param) =>
              Array.isArray(param)
                ? param.some((item) => values.has(item as string))
                : values.has(param as string),
            );
          return hit ? fail(tx) : tx.$executeRaw(strings, ...params);
        };
      },
    });
  return new Proxy(prisma, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property !== '$transaction') return value;
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) =>
        (value as Transaction).call(target, (tx) => work(brokenTx(tx)), options);
    },
  });
}

/** Um erro de dado do banco, como o de uma linha que não cabe. */
const dataError = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT 1 / 0`;

describe('case-assign', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  /** Os clientes deste arquivo: a limpeza é só deles. */
  const tenants: string[] = [];

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  });

  async function customer(name: string): Promise<string> {
    const tenantId = await createTenant(app, `Cliente Demo ${name} (atribuição)`);
    tenants.push(tenantId);
    return tenantId;
  }

  /** Uma pessoa do cliente, para assinar a exceção e o item da lista de proteção. */
  async function person(tenantId: string): Promise<string> {
    const { id } = await prisma.user.create({
      data: {
        id: `user-${randomUUID()}`,
        name: 'Pessoa de teste',
        email: `${randomUUID()}@cliente.example`,
        role: 'admin_cliente',
        tenantId,
      },
      select: { id: true },
    });
    return id;
  }

  const insert = (tenantId: string, overrides: Partial<Prisma.FindingUncheckedCreateInput> = {}) =>
    insertFinding(prisma, tenantId, overrides);

  const caseIdOf = async (id: string): Promise<string | null> =>
    (await prisma.finding.findUniqueOrThrow({ where: { id }, select: { caseId: true } })).caseId;

  const unassigned = (tenantId: string): Promise<number> =>
    prisma.finding.count({ where: { tenantId, caseId: null } });

  function only<T>(rows: readonly T[]): T {
    const [row] = rows;
    if (row === undefined || rows.length !== 1) throw new Error(`esperava uma linha, vieram ${rows.length}`);
    return row;
  }

  describe('a fila', () => {
    it('só o alerta pendente e fora de incidente ganha caso; o esperado por exceção, o tratado e o de incidente, não', async () => {
      const tenantId = await customer('fila');
      const incidentId = await insertIncident(prisma, tenantId);
      const exception = await prisma.alertException.create({
        data: {
          tenantId,
          ruleId: '100305',
          field: 'user',
          value: 'arn:aws:iam::111122223333:user/rotina',
          reason: 'rotina conhecida',
          createdById: await person(tenantId),
        },
      });
      const fresh = await insert(tenantId);
      const investigating = await insert(tenantId, { status: 'investigating' });
      const out = [
        await insert(tenantId, { status: 'legitimate', exceptionId: exception.id }),
        await insert(tenantId, { status: 'legitimate' }),
        await insert(tenantId, { status: 'resolved' }),
        await insert(tenantId, { incidentId }),
        await insert(tenantId, { incidentId, status: 'investigating' }),
      ];
      const report = await assignAll(prisma, [tenantId]);
      expect(report).toMatchObject({ assigned: 2, opened: 1, sealed: 0, batches: 1 });
      const row = only(await casesOf(prisma, tenantId));
      expect(await caseIdOf(fresh)).toBe(row.id);
      expect(await caseIdOf(investigating)).toBe(row.id);
      for (const id of out) expect(await caseIdOf(id)).toBeNull();
      await expectExactCounters(prisma, [tenantId]);
    });

    it('o caso leva o título do dicionário, as partes da chave, o alerta âncora, os horários e as amostras', async () => {
      const tenantId = await customer('caso novo');
      const first = await insert(tenantId, {
        createdAt: at(0),
        occurredAt: at(-5 * HOUR_MS),
        sourceIp: '203.0.113.10',
        resource: 's3:relatorios-demo',
        mitreTactics: ['Persistence'],
        mitreTechniques: ['T1098'],
      });
      const second = await insert(tenantId, {
        createdAt: at(1_000),
        occurredAt: at(-9 * HOUR_MS),
        lastSeenAt: at(500),
        sourceIp: '203.0.113.11',
        mitreTactics: ['Persistence', 'Privilege Escalation'],
      });
      await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) });
      const stored = await prisma.finding.findUniqueOrThrow({ where: { id: first } });
      const key = caseKeyOf(stored);
      expect(only(await casesOf(prisma, tenantId))).toMatchObject({
        queue: 'detection',
        keyVersion: 1,
        groupKey: key.groupKey,
        openKey: key.groupKey,
        family: 'cloudtrail',
        title: 'Permissão de administrador concedida',
        keyParts: key.parts,
        previousCaseId: null,
        recurrence: 0,
        anchorFindingId: first,
        // A chegada do primeiro e do último alerta, pelo servidor; o horário do log só mostra.
        openedAt: at(0),
        lastAlertAt: at(1_000),
        firstSeenAt: at(-9 * HOUR_MS),
        lastSeenAt: at(500),
        sealedAt: null,
        sealReason: null,
        incidentId: null,
        ruleIds: ['100305'],
        accounts: [CASE_ACCOUNT],
        actors: [`arn:aws:iam::${CASE_ACCOUNT}:user/maria`],
        ips: ['203.0.113.10', '203.0.113.11'],
        resources: ['s3:relatorios-demo'],
        mitreTactics: ['Persistence', 'Privilege Escalation'],
        mitreTechniques: ['T1098'],
        total: 2,
        pendingHigh: 2,
        newCount: 2,
        pending: true,
      });
      expect(await caseIdOf(second)).toBe(only(await casesOf(prisma, tenantId)).id);
    });

    it('um caso que já existe junta as amostras novas, até o teto, sem perder as de antes', async () => {
      const tenantId = await customer('amostras');
      await insert(tenantId, { createdAt: at(0), sourceIp: '203.0.113.1', resource: 'x'.repeat(2000) });
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      for (let index = 0; index < 30; index += 1) {
        await insert(tenantId, {
          createdAt: at(1_000 + index),
          sourceIp: `203.0.113.${100 + index}`,
          resource: `recurso-${index}`,
          mitreTechniques: Array.from({ length: 3 }, (_, n) => `T${1000 + index * 3 + n}`),
          mitreTactics: [`Tática ${index}`],
        });
      }
      await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS), batch: 7 });
      const row = only(await casesOf(prisma, tenantId));
      expect(row.ips).toHaveLength(20);
      expect(row.ips[0]).toBe('203.0.113.1');
      expect(row.ips[19]).toBe('203.0.113.118');
      expect(row.resources).toHaveLength(20);
      expect(row.resources[0]).toBe('x'.repeat(256));
      expect(row.mitreTechniques).toHaveLength(50);
      expect(row.mitreTactics).toHaveLength(20);
      expect(row.total).toBe(31);
      expect(row.lastAlertAt).toEqual(at(1_029));
    });

    it('a atribuição não mexe no updatedAt e grava o subgrupo da chave, sem apagar o que já havia', async () => {
      const tenantId = await customer('updatedAt');
      const old = at(-200 * DAY_MS);
      const control = await insert(tenantId, {
        source: 'aws',
        logSource: 'security_hub',
        ruleId: '990501',
        eventName: 'S3.8',
        resource: 's3:dados-demo',
        createdAt: old,
        updatedAt: old,
      });
      const agent = await insert(tenantId, {
        source: 'aws',
        logSource: 'inspector',
        ruleId: '990511',
        title: 'Vulnerabilidade em pacote: CVE-2026-0001 - openssl, openssl-libs and 3 more',
        eventName: 'CVE-2026-0001',
        resource: 'ec2:i-0abc1234def567890',
        createdAt: old,
        updatedAt: old,
      });
      const kept = await insert(tenantId, { caseGroup: 'gravado-antes', createdAt: old, updatedAt: old });
      const before = await prisma.finding.findMany({ where: { tenantId }, orderBy: { id: 'asc' } });
      await assignAll(prisma, [tenantId]);
      const after = await prisma.finding.findMany({ where: { tenantId }, orderBy: { id: 'asc' } });
      expect(after.map((row) => row.caseId)).not.toContain(null);
      const groups: Record<string, string | null> = {
        [control]: 's3:dados-demo',
        [agent]: 'openssl',
        [kept]: 'gravado-antes',
      };
      // Só o caso e o subgrupo mudaram: nem o updatedAt, nem mais nada.
      expect(after).toEqual(
        before.map((row) => ({
          ...row,
          caseId: after.find(({ id }) => id === row.id)?.caseId,
          caseGroup: groups[row.id],
        })),
      );
      // A chave do alerta com o subgrupo gravado é a mesma: reabrir o alerta não o leva a outro caso.
      for (const [index, row] of after.entries()) {
        expect(caseKeyOf(row).groupKey).toBe(caseKeyOf(before[index] as (typeof before)[number]).groupKey);
      }
    });

    it('a leitura da fila e a vigia usam o índice parcial, na ordem dele', async () => {
      const tenantId = await customer('índice');
      await prisma.finding.createMany({
        data: Array.from({ length: 400 }, (_, index) =>
          findingData(tenantId, {
            createdAt: at(index * 1_000),
            status: index % 2 === 0 ? 'new' : 'resolved',
            severity: index % 60 === 0 ? 'critical' : 'low',
          }),
        ),
      });
      const explain = (read: (db: Pick<Prisma.TransactionClient, '$queryRaw'>) => Promise<unknown>) =>
        prisma.$transaction(async (tx) => {
          // Sem ordenar nem ler a tabela inteira: só o índice parcial serve, se o predicado é o dele. Assim o plano não
          // depende das estatísticas, que as outras suítes mudam (a medição de carga mostra o plano de verdade).
          await tx.$executeRaw`SET LOCAL enable_sort = off`;
          await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
          let plan = '';
          // O mesmo comando da tarefa, com EXPLAIN na frente.
          const db = {
            $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
              const text = [`EXPLAIN (FORMAT JSON) ${strings[0] ?? ''}`, ...strings.slice(1)];
              const explained = Object.assign(text, { raw: text }) as unknown as TemplateStringsArray;
              plan = JSON.stringify(await tx.$queryRaw(explained, ...values));
              return [];
            },
          } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
          await read(db);
          return plan;
        });
      const cursor = { at: at(0).toISOString(), id: randomUUID() };
      const page = await explain((db) => readOutboxPage(db, tenantId, cursor, [randomUUID()], 200));
      const watch = await explain((db) => oldestUnassigned(db, tenantId));
      for (const plan of [page, watch]) {
        expect(plan).toContain('Finding_case_outbox_idx');
        expect(plan).not.toMatch(/Seq Scan|"Sort"/);
      }
      // Depois do cursor, na ordem, e sem os que ficaram de fora.
      const read = (skip: readonly string[]) =>
        readOutboxPage(prisma, tenantId, { ...cursor, at: at(1).toISOString() }, skip, 3);
      const first = await read([]);
      expect(first.map((row) => row.createdAt)).toEqual([at(2_000), at(4_000), at(6_000)]);
      expect((await read([first[1]?.id as string])).map((row) => row.createdAt)).toEqual([
        at(2_000),
        at(6_000),
        at(8_000),
      ]);
    });

    it('o alerta travado por uma triagem em curso é pulado, e entra na passagem seguinte', async () => {
      const tenantId = await customer('travado');
      const ids = [await insert(tenantId), await insert(tenantId), await insert(tenantId)];
      const client = new pg.Client({ connectionString: inject('testDatabaseUrl') });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE "Finding" SET "status" = $2 WHERE "id" = $1', [ids[1], 'resolved']);
        const started = Date.now();
        expect(await assignAll(prisma, [tenantId])).toMatchObject({ assigned: 2 });
        // Não esperou pela triagem.
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await caseIdOf(ids[1] as string)).toBeNull();
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
      expect(await assignAll(prisma, [tenantId])).toMatchObject({ assigned: 1, opened: 0 });
      expect(await unassigned(tenantId)).toBe(0);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('no lote, só entra o que ainda está na fila: o que mudou depois da leitura, ou é de outro cliente, fica de fora', async () => {
      const [a, b] = [await customer('trava A'), await customer('trava B')];
      const incidentId = await insertIncident(prisma, a);
      const taken = await insert(a);
      await assignAll(prisma, [a]);
      const waiting = [await insert(a), await insert(a, { status: 'investigating' })].sort();
      const gone = [
        taken,
        await insert(a, { status: 'resolved' }),
        await insert(a, { status: 'legitimate' }),
        await insert(a, { incidentId }),
        await insert(b),
      ];
      const locked = await prisma.$transaction((tx) => lockOutboxRows(tx, a, [...waiting, ...gone]));
      expect(locked.map((row) => row.id)).toEqual(waiting);
    });

    it('um lote entra na fila do lock dos alertas do cliente, como os coletores e os incidentes', async () => {
      const tenantId = await customer('lock');
      await insert(tenantId);
      const url = inject('testDatabaseUrl');
      const [holder, watcher] = [
        new pg.Client({ connectionString: url }),
        new pg.Client({ connectionString: url }),
      ];
      await Promise.all([holder.connect(), watcher.connect()]);
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`verax:findings:${tenantId}`]);
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        const running = assignAll(prisma, [tenantId]);
        let waiting: string[] = [];
        for (let tries = 0; waiting.length === 0 && tries < 400; tries += 1) {
          // O texto do comando e quem espera por quem são lidos em instantes diferentes: só vale quem já está no comando esperado.
          const { rows } = await watcher.query<{ query: string }>(
            `SELECT query FROM pg_stat_activity
             WHERE $1::int = ANY(pg_blocking_pids(pid)) AND position($2::text in query) > 0`,
            [pid, 'pg_advisory_xact_lock'],
          );
          waiting = rows.map((row) => row.query);
          if (waiting.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(waiting).toEqual([expect.stringContaining('pg_advisory_xact_lock')]);
        expect(await unassigned(tenantId)).toBe(1);
        await holder.query('COMMIT');
        expect(await running).toMatchObject({ assigned: 1 });
      } finally {
        await Promise.all([holder.end(), watcher.end()]);
      }
    });

    it('o alerta reaberto por uma pessoa volta à fila, inclusive o que nasceu legítimo', async () => {
      const tenantId = await customer('reaberto');
      const id = await insert(tenantId, { status: 'legitimate', createdAt: at(-30 * DAY_MS) });
      expect(await assignAll(prisma, [tenantId])).toMatchObject({ assigned: 0, batches: 0 });
      await prisma.finding.update({ where: { id }, data: { status: 'new' } });
      expect(await assignAll(prisma, [tenantId])).toMatchObject({ assigned: 1, opened: 1 });
      expect(await caseIdOf(id)).not.toBeNull();
    });
  });

  describe('um caso nunca atravessa cliente', () => {
    it('dois clientes com alertas idênticos são dois casos, cada um só com os dele', async () => {
      const [a, b] = [await customer('A'), await customer('B')];
      const rows = [
        {},
        { severity: 'low' as const },
        { logSource: 'vpc_flow', ruleId: '100400', sourceIp: '203.0.113.7', actorUser: null },
        {
          logSource: 'inspector',
          ruleId: '990511',
          caseGroup: 'openssl',
          resource: 'ec2:i-0abc1234def567890',
        },
      ];
      for (const overrides of rows) {
        await insert(a, { ...overrides, createdAt: at(0) });
        await insert(b, { ...overrides, createdAt: at(0) });
      }
      // Numa passagem só, e com mais um cliente no meio sem nada.
      await assignAll(prisma, [a, await customer('vazio'), b]);
      const [casesA, casesB] = [await casesOf(prisma, a), await casesOf(prisma, b)];
      expect(casesA).toHaveLength(4);
      expect(casesB).toHaveLength(4);
      const keys = (cases: typeof casesA) => cases.map((row) => row.groupKey).sort();
      expect(keys(casesA)).toEqual(keys(casesB));
      for (const tenantId of [a, b]) {
        const findings = await prisma.finding.findMany({ where: { tenantId }, include: { alertCase: true } });
        for (const finding of findings) expect(finding.alertCase?.tenantId).toBe(tenantId);
      }
      await expectExactCounters(prisma, [a, b]);
    });

    it('o caso anterior, os limites e a lista de proteção são só do próprio cliente', async () => {
      const [a, b] = [await customer('A2'), await customer('B2')];
      // O cliente A tem um caso selado da mesma chave e já passou do fan-out.
      for (let index = 0; index < 9; index += 1) {
        await insert(a, {
          logSource: 'vpc_flow',
          ruleId: '100400',
          actorUser: null,
          sourceIp: `203.0.${index}.7`,
          createdAt: at(index),
        });
      }
      await insert(a, { createdAt: at(0) });
      await assignAll(prisma, [a], { now: () => at(HOUR_MS) });
      await prisma.finding.updateMany({ where: { tenantId: a }, data: { status: 'resolved' } });
      await insert(a, { createdAt: at(1_000) });
      await assignAll(prisma, [a], { now: () => at(HOUR_MS) });
      expect((await casesOf(prisma, a)).map((row) => row.recurrence)).toContain(1);
      await prisma.protectedResource.create({
        data: {
          tenantId: a,
          type: 'iam_user',
          identifier: 'qualquer',
          reason: 'teste',
          createdById: await person(a),
        },
      });
      // O cliente B, com as mesmas chaves, começa do zero.
      await insert(b, { createdAt: at(1_000) });
      await insert(b, {
        logSource: 'vpc_flow',
        ruleId: '100400',
        actorUser: null,
        sourceIp: '203.0.200.7',
        createdAt: at(1_000),
      });
      expect(await assignAll(prisma, [b], { now: () => at(HOUR_MS) })).toMatchObject({
        opened: 2,
        folded: { distributed: 0 },
      });
      for (const row of await casesOf(prisma, b))
        expect(row).toMatchObject({ previousCaseId: null, recurrence: 0 });
    });
  });

  describe('o ciclo do caso, pelo relógio do servidor', () => {
    it('detecção: entra até 24 h de silêncio; depois, o caso é selado (continua pendente) e outro abre, ligado a ele', async () => {
      const tenantId = await customer('silêncio');
      const now = () => at(30 * DAY_MS);
      await insert(tenantId, { createdAt: at(0) });
      await insert(tenantId, { createdAt: at(DAY_MS) });
      await assignAll(prisma, [tenantId], { now });
      const first = only(await casesOf(prisma, tenantId));
      expect(first).toMatchObject({ total: 2, openKey: first.groupKey });

      await insert(tenantId, { createdAt: at(2 * DAY_MS + 1) });
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({ opened: 1, sealed: 1 });
      const [sealed, second] = await casesOf(prisma, tenantId);
      expect(sealed).toMatchObject({
        id: first.id,
        openKey: null,
        sealReason: 'window',
        sealedAt: now(),
        pending: true,
        total: 2,
        lastAlertAt: at(DAY_MS),
      });
      expect(second).toMatchObject({
        openKey: first.groupKey,
        sealedAt: null,
        sealReason: null,
        previousCaseId: first.id,
        recurrence: 1,
        total: 1,
        openedAt: at(2 * DAY_MS + 1),
      });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('detecção: com alertas todo dia, o caso fecha aos 7 dias de idade', async () => {
      const tenantId = await customer('idade');
      const now = () => at(30 * DAY_MS);
      for (let index = 0; index <= 7; index += 1) await insert(tenantId, { createdAt: at(index * DAY_MS) });
      await assignAll(prisma, [tenantId], { now });
      expect(only(await casesOf(prisma, tenantId)).total).toBe(8);
      await insert(tenantId, { createdAt: at(7 * DAY_MS + 1) });
      await assignAll(prisma, [tenantId], { now });
      expect((await casesOf(prisma, tenantId)).map((row) => [row.total, row.sealReason])).toEqual([
        [8, 'window'],
        [1, null],
      ]);
    });

    it('o horário do log não abre nem segura caso: só a chegada conta', async () => {
      const tenantId = await customer('log');
      const now = () => at(30 * DAY_MS);
      await insert(tenantId, { createdAt: at(0), occurredAt: at(-300 * DAY_MS) });
      await insert(tenantId, { createdAt: at(HOUR_MS), occurredAt: at(300 * DAY_MS) });
      await assignAll(prisma, [tenantId], { now });
      expect(only(await casesOf(prisma, tenantId))).toMatchObject({ total: 2, lastAlertAt: at(HOUR_MS) });
    });

    it('a chegada no futuro (o relógio que voltou) vale agora, e não estica a janela', async () => {
      const tenantId = await customer('relógio');
      await insert(tenantId, { createdAt: at(50 * DAY_MS) });
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      expect(only(await casesOf(prisma, tenantId))).toMatchObject({ openedAt: at(0), lastAlertAt: at(0) });
      await insert(tenantId, { createdAt: at(DAY_MS + 1) });
      await assignAll(prisma, [tenantId], { now: () => at(DAY_MS + 1) });
      expect((await casesOf(prisma, tenantId)).map((row) => row.sealReason)).toEqual(['window', null]);
    });

    it('tratado inteiro: o próximo alerta nunca entra nele, abre outro marcado como volta', async () => {
      const tenantId = await customer('tratado');
      const now = () => at(DAY_MS);
      const ids = [
        await insert(tenantId, { createdAt: at(0) }),
        await insert(tenantId, { createdAt: at(1) }),
      ];
      await assignAll(prisma, [tenantId], { now });
      await prisma.finding.update({ where: { id: ids[0] as string }, data: { status: 'legitimate' } });
      await insert(tenantId, { createdAt: at(2) });
      // Ainda havia pendência: entrou nele.
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({ opened: 0, sealed: 0 });
      await prisma.finding.updateMany({
        where: { tenantId, status: 'new' },
        data: { status: 'resolved' },
      });
      await insert(tenantId, { createdAt: at(3) });
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({ opened: 1, sealed: 1 });
      const [first, second] = await casesOf(prisma, tenantId);
      expect(first).toMatchObject({ sealReason: 'treated', openKey: null, pending: false, total: 3 });
      expect(second).toMatchObject({ previousCaseId: first?.id, recurrence: 1, pending: true, total: 1 });
      // Depois da janela, um caso tratado continua sendo um caso tratado, e não um que a janela fechou.
      await prisma.finding.updateMany({ where: { caseId: second?.id }, data: { status: 'resolved' } });
      await insert(tenantId, { createdAt: at(3 * DAY_MS) });
      await assignAll(prisma, [tenantId], { now: () => at(4 * DAY_MS) });
      expect((await casesOf(prisma, tenantId)).map((row) => [row.sealReason, row.recurrence])).toEqual([
        ['treated', 0],
        ['treated', 1],
        [null, 2],
      ]);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('sem alerta nenhum (saíram na retenção): o próximo sela como idle e abre outro', async () => {
      const tenantId = await customer('idle');
      const id = await insert(tenantId, { createdAt: at(0) });
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      await prisma.finding.delete({ where: { id } });
      await insert(tenantId, { createdAt: at(1) });
      await assignAll(prisma, [tenantId], { now: () => at(1) });
      expect((await casesOf(prisma, tenantId)).map((row) => [row.sealReason, row.total])).toEqual([
        ['idle', 0],
        [null, 1],
      ]);
    });

    it('em análise e promovido continuam abertos dentro da janela: o alerta novo entra neles, como novo', async () => {
      const tenantId = await customer('promovido');
      const now = () => at(DAY_MS);
      const ids = [
        await insert(tenantId, { createdAt: at(0) }),
        await insert(tenantId, { createdAt: at(1) }),
      ];
      await assignAll(prisma, [tenantId], { now });
      await prisma.finding.updateMany({ where: { tenantId }, data: { status: 'investigating' } });
      await insert(tenantId, { createdAt: at(2) });
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({ opened: 0, sealed: 0 });

      // Todos os alertas promovidos a um incidente aberto: nada pendente, e o caso continua recebendo.
      const incidentId = await insertIncident(prisma, tenantId, { status: 'investigating' });
      await prisma.finding.updateMany({ where: { tenantId }, data: { incidentId } });
      await prisma.finding.update({ where: { id: ids[0] as string }, data: { status: 'resolved' } });
      expect(only(await casesOf(prisma, tenantId)).pending).toBe(false);
      const joined = await insert(tenantId, { createdAt: at(3) });
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({ opened: 0, sealed: 0 });
      // O incidente não é alimentado.
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: joined } })).incidentId).toBeNull();
      expect(only(await casesOf(prisma, tenantId))).toMatchObject({ newCount: 1, incidentCount: 3 });

      // Resolvido o incidente (e o alerta que entrou depois), o próximo abre outro caso.
      await prisma.finding.update({ where: { id: joined }, data: { status: 'legitimate' } });
      await prisma.incident.update({ where: { id: incidentId }, data: { status: 'resolved' } });
      await insert(tenantId, { createdAt: at(4) });
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({ opened: 1, sealed: 1 });
      expect((await casesOf(prisma, tenantId)).map((row) => row.sealReason)).toEqual(['treated', null]);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('o incidente do próprio caso (promovido inteiro) também o segura aberto, até ser resolvido', async () => {
      const tenantId = await customer('promovido inteiro');
      const id = await insert(tenantId, { createdAt: at(0) });
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      const incidentId = await insertIncident(prisma, tenantId);
      await prisma.alertCase.updateMany({ where: { tenantId }, data: { incidentId } });
      await prisma.finding.update({ where: { id }, data: { status: 'resolved' } });
      await insert(tenantId, { createdAt: at(1) });
      expect(await assignAll(prisma, [tenantId], { now: () => at(1) })).toMatchObject({ opened: 0 });
      await prisma.finding.updateMany({ where: { tenantId }, data: { status: 'resolved' } });
      await prisma.incident.update({ where: { id: incidentId }, data: { status: 'resolved' } });
      await insert(tenantId, { createdAt: at(2) });
      expect(await assignAll(prisma, [tenantId], { now: () => at(2) })).toMatchObject({ opened: 1 });
    });

    it('a janela vale também para o caso em análise: um caso esquecido não engole alertas para sempre', async () => {
      const tenantId = await customer('esquecido');
      await insert(tenantId, { createdAt: at(0), status: 'investigating' });
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      await insert(tenantId, { createdAt: at(DAY_MS + 1) });
      await assignAll(prisma, [tenantId], { now: () => at(DAY_MS + 1) });
      const [first, second] = await casesOf(prisma, tenantId);
      expect(first).toMatchObject({ sealReason: 'window', pending: true, investigatingCount: 1 });
      expect(second).toMatchObject({ previousCaseId: first?.id, newCount: 1 });
    });

    it('vulnerabilidade e postura não têm janela: o caso fica aberto até ser tratado', async () => {
      const tenantId = await customer('sem janela');
      const vulnerability = {
        source: 'aws',
        logSource: 'inspector',
        ruleId: '990511',
        caseGroup: 'openssl',
        resource: 'ec2:i-0abc1234def567890',
      };
      const posture = {
        source: 'aws',
        logSource: 'security_hub',
        ruleId: '990501',
        eventName: 'S3.8',
        resource: 's3:dados-demo',
      };
      for (const [index, gap] of [0, 60 * DAY_MS, 200 * DAY_MS].entries()) {
        await insert(tenantId, { ...vulnerability, createdAt: at(gap) });
        await insert(tenantId, { ...posture, createdAt: at(gap) });
        await assignAll(prisma, [tenantId], { now: () => at(gap) });
        expect((await casesOf(prisma, tenantId)).map((row) => row.total)).toEqual([index + 1, index + 1]);
      }
      expect((await casesOf(prisma, tenantId)).map((row) => row.queue).sort()).toEqual([
        'posture',
        'vulnerability',
      ]);
      await prisma.finding.updateMany({ where: { tenantId }, data: { status: 'resolved' } });
      await insert(tenantId, { ...vulnerability, createdAt: at(201 * DAY_MS) });
      await insert(tenantId, { ...posture, createdAt: at(201 * DAY_MS) });
      await assignAll(prisma, [tenantId], { now: () => at(201 * DAY_MS) });
      expect((await casesOf(prisma, tenantId)).map((row) => [row.sealReason, row.recurrence])).toEqual([
        ['treated', 0],
        ['treated', 0],
        [null, 1],
        [null, 1],
      ]);
    });

    it('o histórico que atravessa a janela vira uma cadeia de casos, num lote só e com um caso já aberto no banco', async () => {
      const tenantId = await customer('histórico');
      const now = () => at(60 * DAY_MS);
      await insert(tenantId, { createdAt: at(0) });
      await assignAll(prisma, [tenantId], { now });
      const stored = only(await casesOf(prisma, tenantId));
      // Um entra no caso do banco; os outros, em três janelas depois dela.
      for (const day of [0.5, 5, 5.5, 10, 20]) await insert(tenantId, { createdAt: at(day * DAY_MS) });
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({
        batches: 1,
        assigned: 5,
        opened: 3,
        sealed: 3,
      });
      const cases = await casesOf(prisma, tenantId);
      expect(cases.map((row) => [row.total, row.sealReason, row.recurrence, row.openedAt])).toEqual([
        [2, 'window', 0, at(0)],
        [2, 'window', 1, at(5 * DAY_MS)],
        [1, 'window', 2, at(10 * DAY_MS)],
        [1, null, 3, at(20 * DAY_MS)],
      ]);
      expect(cases[0]?.id).toBe(stored.id);
      expect(cases.map((row) => row.previousCaseId)).toEqual([
        null,
        ...cases.slice(0, 3).map((row) => row.id),
      ]);
      // Um aberto por chave: o último.
      expect(cases.map((row) => row.openKey !== null)).toEqual([false, false, false, true]);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('o resultado não depende de quando a tarefa rodou: de uma vez, alerta por alerta ou em lotes', async () => {
      const gaps = [0, 1, 20, 47, 48, 49, 90, 91, 260, 270, 271, 500, 501];
      const shapes: unknown[] = [];
      for (const mode of ['de uma vez', 'um a um', 'lotes'] as const) {
        const tenantId = await customer(`ordem ${mode}`);
        for (const hours of gaps) {
          await insert(tenantId, { createdAt: at(hours * HOUR_MS) });
          // Um a um: com o relógio da chegada de cada alerta, como ao vivo.
          if (mode === 'um a um') await assignAll(prisma, [tenantId], { now: () => at(hours * HOUR_MS) });
        }
        if (mode !== 'um a um') {
          await assignAll(prisma, [tenantId], {
            now: () => at(900 * DAY_MS),
            batch: mode === 'lotes' ? 2 : 200,
          });
        }
        const cases = await casesOf(prisma, tenantId);
        const position = new Map(cases.map((row, index) => [row.id, index]));
        shapes.push(
          cases.map((row) => ({
            total: row.total,
            openedAt: row.openedAt,
            lastAlertAt: row.lastAlertAt,
            sealReason: row.sealReason,
            recurrence: row.recurrence,
            previous: row.previousCaseId === null ? null : position.get(row.previousCaseId),
          })),
        );
      }
      expect(shapes[0]).toHaveLength(5);
      expect(shapes[1]).toEqual(shapes[0]);
      expect(shapes[2]).toEqual(shapes[0]);
    });

    it('o caso selado por outro (a triagem em massa) é o anterior do próximo', async () => {
      const tenantId = await customer('selado fora');
      await insert(tenantId, { createdAt: at(0) });
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      const first = only(await casesOf(prisma, tenantId));
      await prisma.finding.updateMany({ where: { tenantId }, data: { status: 'legitimate' } });
      await prisma.alertCase.update({
        where: { id: first.id },
        data: { openKey: null, sealedAt: at(1), sealReason: 'treated', recurrence: 4 },
      });
      await insert(tenantId, { createdAt: at(2) });
      expect(await assignAll(prisma, [tenantId], { now: () => at(2) })).toMatchObject({
        opened: 1,
        sealed: 0,
      });
      expect((await casesOf(prisma, tenantId)).at(-1)).toMatchObject({
        previousCaseId: first.id,
        recurrence: 5,
      });
    });

    it('um alerta antigo que volta à fila entra no caso aberto da chave, sem andar com os horários para trás', async () => {
      const tenantId = await customer('antigo');
      await insert(tenantId, { createdAt: at(10 * DAY_MS) });
      await assignAll(prisma, [tenantId], { now: () => at(10 * DAY_MS) });
      await insert(tenantId, { createdAt: at(0) });
      await assignAll(prisma, [tenantId], { now: () => at(10 * DAY_MS) });
      expect(only(await casesOf(prisma, tenantId))).toMatchObject({
        total: 2,
        openedAt: at(10 * DAY_MS),
        lastAlertAt: at(10 * DAY_MS),
        firstSeenAt: at(0),
      });
    });
  });

  describe('os limites de abertura', () => {
    const scan = (index: number, overrides: Partial<Prisma.FindingUncheckedCreateInput> = {}) => ({
      logSource: 'vpc_flow',
      ruleId: '100400',
      actorUser: null,
      sourceIp: `203.0.${index}.7`,
      createdAt: at(index * 1_000),
      ...overrides,
    });

    it('a 9ª rede da internet contra o mesmo alvo vai para um caso distribuído; a chave com caso aberto segue nele', async () => {
      const tenantId = await customer('fan-out');
      for (let index = 0; index < 20; index += 1) await insert(tenantId, scan(index));
      // De novo a primeira rede: o caso dela está aberto.
      await insert(tenantId, scan(0, { createdAt: at(60_000) }));
      const report = await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS), batch: 6 });
      expect(report).toMatchObject({ opened: 9, folded: { distributed: 12, overflow: 0, rollup: 0 } });
      const cases = await casesOf(prisma, tenantId);
      const distributed = only(cases.filter((row) => row.title.includes('muitas redes de origem')));
      expect(distributed).toMatchObject({
        title: 'Tráfego de rede suspeito (muitas redes de origem)',
        family: 'vpc-flow',
        queue: 'detection',
        total: 12,
        pendingHigh: 12,
        keyParts: [
          { name: 'rule', value: '100400' },
          { name: 'fold', value: 'distributed' },
        ],
      });
      expect(distributed.ips).toHaveLength(12);
      expect(cases.filter((row) => row.id !== distributed.id).map((row) => row.total)).toEqual([
        2, 1, 1, 1, 1, 1, 1, 1,
      ]);
      // No dia seguinte, com as 8 fora da janela de 24 h, a rede nova abre o próprio caso.
      await insert(tenantId, scan(30, { createdAt: at(DAY_MS + 20_000) }));
      expect(await assignAll(prisma, [tenantId], { now: () => at(2 * DAY_MS) })).toMatchObject({
        opened: 1,
        folded: { distributed: 0 },
      });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('a lista de proteção de um cliente não isenta o outro', async () => {
      const [a, b] = [await customer('proteção A'), await customer('proteção B')];
      const protectedScan = scan(50, { resource: 'ec2:i-0abc1234def567890' });
      for (const tenantId of [a, b]) {
        for (let index = 0; index < 8; index += 1) await insert(tenantId, scan(index));
      }
      await prisma.protectedResource.create({
        data: {
          tenantId: a,
          type: 'ec2_instance',
          identifier: 'i-0abc1234def567890',
          reason: 'produção',
          createdById: await person(a),
        },
      });
      const ids = [await insert(a, protectedScan), await insert(b, protectedScan)];
      await assignAll(prisma, [a, b], { now: () => at(HOUR_MS) });
      const titles = await prisma.finding.findMany({
        where: { id: { in: ids } },
        select: { tenantId: true, alertCase: { select: { title: true } } },
      });
      const distributed = (tenantId: string) =>
        titles.find((row) => row.tenantId === tenantId)?.alertCase?.title.includes('muitas redes de origem');
      expect([distributed(a), distributed(b)]).toEqual([false, true]);
    });

    it('a chave com um caso vencido também passa pelos limites, e o reunido que já está aberto é o mesmo', async () => {
      const tenantId = await customer('vencido');
      const noise = (rule: number, createdAt: Date) =>
        insert(tenantId, { severity: 'low', ruleId: String(80_500 + rule), createdAt });
      const now = () => at(10 * DAY_MS);
      await noise(0, at(0));
      for (let index = 0; index < 9; index += 1) await insert(tenantId, scan(index));
      await assignAll(prisma, [tenantId], { now });
      const day = (ms: number) => at(3 * DAY_MS + ms);
      for (let rule = 1; rule <= 41; rule += 1) await noise(rule, day(rule));
      for (let index = 10; index < 19; index += 1) {
        await insert(tenantId, scan(index, { createdAt: day(1_000 + index) }));
      }
      // A 41ª chave de ruído já foi para o reunido, e a 9ª rede do dia, para o distribuído.
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({
        folded: { rollup: 1, distributed: 1 },
      });
      const before = await casesOf(prisma, tenantId);
      // O ruído e a rede do primeiro dia voltam: o caso de cada um venceu, e a vaga do dia também.
      const ids = [await noise(0, day(2_000)), await insert(tenantId, scan(0, { createdAt: day(2_001) }))];
      expect(await assignAll(prisma, [tenantId], { now })).toMatchObject({
        assigned: 2,
        opened: 0,
        sealed: 0,
        folded: { rollup: 1, distributed: 1 },
      });
      const after = await casesOf(prisma, tenantId);
      expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
      const grown = after.filter((row) => row.total > (before.find(({ id }) => id === row.id)?.total ?? 0));
      expect(grown.map((row) => row.keyParts)).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([{ name: 'fold', value: 'rollup' }]),
          expect.arrayContaining([{ name: 'fold', value: 'distributed' }]),
        ]),
      );
      expect(grown.map((row) => row.id).sort()).toEqual((await Promise.all(ids.map(caseIdOf))).sort());
    });

    it('outra regra, outra conta e outra fonte contam à parte', async () => {
      const tenantId = await customer('fan-out à parte');
      for (let index = 0; index < 8; index += 1) await insert(tenantId, scan(index));
      await insert(tenantId, scan(100, { ruleId: '100401' }));
      await insert(tenantId, scan(101, { accountId: '444455556666' }));
      await insert(tenantId, scan(102, { logSource: 'cloudwatch_logs' }));
      expect(await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) })).toMatchObject({
        opened: 11,
        folded: { distributed: 0 },
      });
    });

    it('não vale para origem privada, para item da lista de proteção nem para o crítico', async () => {
      const tenantId = await customer('fan-out isentos');
      const createdById = await person(tenantId);
      await prisma.protectedResource.create({
        data: {
          tenantId,
          type: 'ec2_instance',
          identifier: 'i-0abc1234def567890',
          reason: 'produção',
          createdById,
        },
      });
      for (let index = 0; index < 8; index += 1) await insert(tenantId, scan(index));
      for (let index = 0; index < 12; index += 1) {
        await insert(tenantId, scan(index, { sourceIp: `10.0.${index}.7` }));
      }
      const exempt = [
        await insert(tenantId, scan(50, { resource: 'ec2:i-0abc1234def567890' })),
        await insert(tenantId, scan(51, { severity: 'critical' })),
      ];
      expect(await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) })).toMatchObject({
        opened: 22,
        folded: { distributed: 0, overflow: 0 },
      });
      for (const id of exempt) {
        const finding = await prisma.finding.findUniqueOrThrow({
          where: { id },
          include: { alertCase: true },
        });
        expect(finding.alertCase?.groupKey).toBe(caseKeyOf(finding).groupKey);
      }
      // E o seguinte, alto, desprotegido e da internet, vai para o distribuído.
      await insert(tenantId, scan(60));
      expect(await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) })).toMatchObject({
        folded: { distributed: 1 },
      });
    });

    it('o crítico só passa do teto próprio, de 100, e aí vai para um caso separado do dos altos', async () => {
      const tenantId = await customer('fan-out crítico');
      const critical = (index: number) =>
        scan(index, { severity: 'critical', sourceIp: `203.${index}.113.7` });
      for (let index = 0; index < 100; index += 1) await insert(tenantId, critical(index));
      await insert(tenantId, scan(150));
      for (let index = 101; index < 104; index += 1) await insert(tenantId, critical(index));
      expect(await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) })).toMatchObject({
        opened: 102,
        folded: { distributed: 1, overflow: 3 },
      });
      const folded = (await casesOf(prisma, tenantId)).filter((row) => row.title.includes('('));
      expect(folded.map((row) => [row.title, row.pendingCritical, row.pendingHigh])).toEqual(
        expect.arrayContaining([
          ['Tráfego de rede suspeito (críticos além do limite diário de casos)', 3, 0],
          ['Tráfego de rede suspeito (muitas redes de origem)', 0, 1],
        ]),
      );
    });

    it('a chave de acesso entra nas amostras ao abrir o caso e ao juntar outro alerta', async () => {
      const tenantId = await customer('chaves');
      await insert(tenantId, { accessKeyId: 'DEMOCHAVE1' });
      await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) });
      expect(only(await casesOf(prisma, tenantId)).accessKeys).toEqual(['DEMOCHAVE1']);
      await insert(tenantId, { accessKeyId: 'DEMOCHAVE2', createdAt: at(1_000) });
      await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) });
      expect(only(await casesOf(prisma, tenantId)).accessKeys).toEqual(['DEMOCHAVE1', 'DEMOCHAVE2']);
    });

    it('com 40 casos na fila, a chave média ou baixa nova vai para um caso por fonte; a alta, a crítica e a protegida, não', async () => {
      const tenantId = await customer('teto');
      const createdById = await person(tenantId);
      const key = 'DEMOCHAVEDEACESSO1';
      await prisma.protectedResource.create({
        data: { tenantId, type: 'access_key', identifier: key, reason: 'produção', createdById },
      });
      const noise = (rule: number, overrides: Partial<Prisma.FindingUncheckedCreateInput> = {}) =>
        insert(tenantId, {
          severity: rule % 2 === 0 ? 'medium' : 'low',
          ruleId: String(80_500 + rule),
          createdAt: at(rule * 1_000),
          ...overrides,
        });
      for (let rule = 0; rule < 39; rule += 1) await noise(rule);
      await insert(tenantId, { createdAt: at(39_000) });
      expect(await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) })).toMatchObject({
        opened: 40,
        folded: { rollup: 0 },
      });
      // Daqui em diante: 41 ou mais.
      for (let rule = 50; rule < 56; rule += 1) await noise(rule);
      await noise(60, { accountId: '444455556666' });
      await noise(61, { logSource: 'gcp_audit', ruleId: '990117' });
      // A chave que já tem caso aberto segue nele.
      await noise(0, { createdAt: at(70_000) });
      await insert(tenantId, { ruleId: '100306', createdAt: at(71_000) });
      await insert(tenantId, { ruleId: '100310', severity: 'critical', createdAt: at(72_000) });
      await noise(62, { accessKeyId: key });
      // A fila de vulnerabilidade não tem teto.
      for (let index = 0; index < 50; index += 1) {
        await insert(tenantId, {
          logSource: 'inspector',
          ruleId: '990511',
          severity: 'low',
          caseGroup: `pacote-${index}`,
          resource: 'ec2:i-0abc1234def567890',
          createdAt: at(80_000 + index),
        });
      }
      // E a de postura conta as próprias aberturas.
      await insert(tenantId, {
        logSource: 'security_hub',
        ruleId: '990501',
        severity: 'low',
        eventName: 'S3.8',
        createdAt: at(90_000),
      });
      expect(await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) })).toMatchObject({
        opened: 2 + 3 + 50 + 1,
        folded: { distributed: 0, overflow: 0, rollup: 8 },
      });
      const cases = await casesOf(prisma, tenantId);
      const rollups = cases.filter((row) => row.family === 'rollup');
      expect(rollups.map((row) => [row.title, row.total, row.accounts])).toEqual([
        ['Alertas médios e baixos reunidos: CloudTrail', 7, [CASE_ACCOUNT, '444455556666']],
        ['Alertas médios e baixos reunidos: auditoria da GCP', 1, [CASE_ACCOUNT]],
      ]);
      for (const row of rollups) expect(row.pendingCritical + row.pendingHigh).toBe(0);
      // A chave do reunido é só da fonte, e a do alerta folgado não se confunde com ela.
      expect(rollups[0]?.groupKey).toBe(
        foldedCaseKey(await prisma.finding.findFirstOrThrow({ where: { caseId: rollups[0]?.id } }), 'rollup')
          .groupKey,
      );
      await expectExactCounters(prisma, [tenantId]);
    });
  });

  describe('a severidade já avisada', () => {
    it('com o aviso por alerta, todo alerta alto ou crítico já avisou sozinho, e o caso acompanha o maior', async () => {
      const tenantId = await customer('aviso por alerta');
      await insert(tenantId, { createdAt: at(0) });
      await insert(tenantId, { createdAt: at(0), severity: 'medium' });
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      const noticed = async () => (await casesOf(prisma, tenantId)).map((row) => row.noticedSeverity);
      expect((await noticed()).sort()).toEqual(['high', null].sort());
      await insert(tenantId, { createdAt: at(1), severity: 'critical' });
      await insert(tenantId, { createdAt: at(2) });
      await assignAll(prisma, [tenantId], { now: () => at(2) });
      expect((await noticed()).sort()).toEqual(['critical', null].sort());
    });

    it('com o aviso por caso, a atribuição não marca nada: quem marca e avisa é a tarefa dos avisos', async () => {
      const tenantId = await customer('aviso por caso');
      const alert = (ruleId: string, createdAt: Date, severity: 'high' | 'critical' = 'high') =>
        insert(tenantId, { ruleId, createdAt, severity });
      await alert('100305', at(-12 * HOUR_MS));
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      await alert('100306', at(0), 'critical');
      // O caso já marcado recebe um crítico: continua como estava.
      await alert('100305', at(HOUR_MS), 'critical');
      await assignAll(prisma, [tenantId], { caseNotices: true, now: () => at(2 * HOUR_MS) });
      expect(
        Object.fromEntries(
          (await casesOf(prisma, tenantId)).map((row) => [row.ruleIds[0] ?? '', row.noticedSeverity]),
        ),
      ).toEqual({ '100305': 'high', '100306': null });
    });
  });

  describe('falhas', () => {
    const passage = async (
      job: { runOnce(signal?: AbortSignal): Promise<CaseAssignReport> },
      signal?: AbortSignal,
    ) => job.runOnce(signal);

    it('o processo morto no meio de um lote não deixa nada; a passagem seguinte grava tudo, uma vez só', async () => {
      const tenantId = await customer('morto');
      for (let index = 0; index < 10; index += 1) await insert(tenantId, { createdAt: at(index) });
      await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) });
      const row = only(await casesOf(prisma, tenantId));
      for (let index = 0; index < 40; index += 1) {
        await insert(tenantId, { createdAt: at(100 + index), ruleId: index % 2 === 0 ? '100305' : '100306' });
      }
      const url = inject('testDatabaseUrl');
      const [blocker, killer] = [
        new pg.Client({ connectionString: url }),
        new pg.Client({ connectionString: url }),
      ];
      await Promise.all([blocker.connect(), killer.connect()]);
      try {
        // O caso preso: o lote para dentro do UPDATE dos alertas, no gatilho das contagens.
        await blocker.query('BEGIN');
        const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        await blocker.query('SELECT 1 FROM "AlertCase" WHERE "id" = $1 FOR UPDATE', [row.id]);
        const running = passage(
          assignJob(prisma, [tenantId], { now: () => at(HOUR_MS), caseLockTimeoutMs: 30_000 }),
        );
        let killed = 0;
        for (let tries = 0; killed === 0 && tries < 400; tries += 1) {
          // O texto do comando e quem espera por quem são lidos em instantes diferentes: só vale quem já está no comando esperado.
          const { rows } = await killer.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE $1::int = ANY(pg_blocking_pids(pid)) AND position($2::text in query) > 0`,
            [pid, 'UPDATE "Finding"'],
          );
          for (const waiting of rows) {
            await killer.query('SELECT pg_terminate_backend($1::int)', [waiting.pid]);
            killed += 1;
          }
          if (killed === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(killed).toBe(1);
        expect(await running).toMatchObject({
          status: 'done',
          assigned: 0,
          failedTenants: 1,
          quarantined: 0,
        });
        await blocker.query('ROLLBACK');
      } finally {
        await Promise.all([blocker.end(), killer.end()]);
      }
      expect(await unassigned(tenantId)).toBe(40);
      expect(only(await casesOf(prisma, tenantId))).toEqual(row);

      expect(await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) })).toMatchObject({
        assigned: 40,
        opened: 1,
      });
      expect(await unassigned(tenantId)).toBe(0);
      expect((await casesOf(prisma, tenantId)).map((each) => each.total)).toEqual([30, 20]);
      expect(await assignAll(prisma, [tenantId], { now: () => at(HOUR_MS) })).toMatchObject({ assigned: 0 });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('um alerta que não grava é isolado, os outros entram, e ele volta depois de um tempo que dobra', async () => {
      const tenantId = await customer('envenenado');
      const ids: string[] = [];
      for (let index = 0; index < 30; index += 1) {
        ids.push(
          await insert(tenantId, { createdAt: at(index), severity: index === 0 ? 'critical' : 'high' }),
        );
      }
      const poison = new Set([ids[0] as string, ids[17] as string]);
      let now = at(HOUR_MS);
      const errors: Record<string, unknown>[] = [];
      const logger = { warn: () => undefined, error: (fields: object) => void errors.push({ ...fields }) };
      const job = assignJob(broken(prisma, poison, dataError), [tenantId], {
        now: () => now,
        workMs: 60_000,
        batch: 12,
        logger,
      });
      expect(await passage(job)).toMatchObject({ assigned: 28, quarantined: 2, failedTenants: 0 });
      expect(await unassigned(tenantId)).toBe(2);
      expect(errors.map(({ findingId, failures, sqlState }) => ({ findingId, failures, sqlState }))).toEqual([
        { findingId: ids[0], failures: 1, sqlState: '22012' },
        { findingId: ids[17], failures: 1, sqlState: '22012' },
      ]);
      // O log não leva nada do alerta.
      expect(JSON.stringify(errors)).not.toContain('maria');
      // Fora por 1 min: o que chega entra, e ele não é tentado.
      await insert(tenantId, { createdAt: at(100) });
      expect(await passage(job)).toMatchObject({ assigned: 1, quarantined: 0 });
      // Volta, falha de novo e fica fora por 2 min.
      now = at(HOUR_MS + 60_000);
      expect(await passage(job)).toMatchObject({ assigned: 0, quarantined: 2 });
      now = at(HOUR_MS + 2 * 60_000);
      expect(await passage(job)).toMatchObject({ quarantined: 0, batches: 0 });
      // Consertado um deles, ele entra; o outro continua fora.
      poison.delete(ids[0] as string);
      now = at(HOUR_MS + 3 * 60_000);
      expect(await passage(job)).toMatchObject({ assigned: 1, quarantined: 1 });
      // O tempo fora tem teto: uma hora.
      for (let tries = 0; tries < 12; tries += 1) {
        now = new Date(now.getTime() + 60 * 60_000);
        expect(await passage(job)).toMatchObject({ quarantined: 1 });
      }
      await expectExactCounters(prisma, [tenantId]);
      expect((await casesOf(prisma, tenantId)).reduce((sum, row) => sum + row.total, 0)).toBe(30);
    });

    it('cheio de alertas isolados, os que sobram não prendem a fila', async () => {
      const tenantId = await customer('cheio');
      expect(QUARANTINE_LIMIT).toBe(1_000);
      const ids: string[] = [];
      for (let index = 0; index < 8; index += 1) ids.push(await insert(tenantId, { createdAt: at(index) }));
      const good = [await insert(tenantId, { createdAt: at(100) })];
      const job = assignJob(broken(prisma, new Set(ids), dataError), [tenantId], {
        now: () => at(HOUR_MS),
        workMs: 60_000,
        batch: 4,
        quarantineLimit: 5,
      });
      expect(await passage(job)).toMatchObject({ quarantined: 8, failedTenants: 0, assigned: 1 });
      // Só três são tentados de novo; os cinco guardados, não.
      good.push(await insert(tenantId, { createdAt: at(101) }));
      expect(await passage(job)).toMatchObject({ quarantined: 3, failedTenants: 0, assigned: 1 });
      for (const id of good) expect(await caseIdOf(id)).not.toBeNull();
      expect(await assignAll(prisma, [tenantId])).toMatchObject({ assigned: 8 });
    });

    it('um trecho que falha não prende a fila: a passagem seguinte continua depois dele e volta ao começo', async () => {
      const tenantId = await customer('roda');
      const ids: string[] = [];
      for (let index = 0; index < 12; index += 1) ids.push(await insert(tenantId, { createdAt: at(index) }));
      const stuck = new Set([ids[1] as string]);
      const job = assignJob(
        broken(prisma, stuck, () => Promise.reject(new Error('conexão caiu'))),
        [tenantId],
        { now: () => at(HOUR_MS), workMs: 60_000, batch: 5 },
      );
      // O primeiro trecho falha por culpa do banco: nada é isolado, e a passagem para nele.
      expect(await passage(job)).toMatchObject({ assigned: 0, failedTenants: 1, quarantined: 0 });
      // A seguinte grava os outros dois trechos, volta ao começo e falha de novo no primeiro.
      expect(await passage(job)).toMatchObject({ assigned: 7, failedTenants: 1 });
      stuck.clear();
      expect(await passage(job)).toMatchObject({ assigned: 5, failedTenants: 0 });
      expect(await unassigned(tenantId)).toBe(0);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('um erro do banco em um cliente não isola alerta nenhum nem para os outros clientes', async () => {
      const [a, b, c] = [await customer('F1'), await customer('F2'), await customer('F3')];
      for (const tenantId of [a, b, c]) {
        for (let index = 0; index < 3; index += 1) await insert(tenantId, { createdAt: at(index) });
      }
      const ordered = [a, b, c].sort();
      const middle = ordered[1] as string;
      const name = `caso-er-${randomUUID().slice(0, 8)}`;
      const job = assignJob(
        broken(prisma, new Set([middle]), () => Promise.reject(new Error('conexão caiu'))),
        [a, b, c],
        { name },
      );
      expect(await passage(job)).toMatchObject({
        tenants: 3,
        failedTenants: 1,
        assigned: 6,
        quarantined: 0,
      });
      expect(await Promise.all(ordered.map(unassigned))).toEqual([0, 3, 0]);
      expect(await prisma.syncState.findUniqueOrThrow({ where: { name } })).toMatchObject({
        lastError: 'Error',
        lastSuccessAt: null,
      });
      await assignAll(prisma, [a, b, c]);
      expect(await Promise.all(ordered.map(unassigned))).toEqual([0, 0, 0]);
    });

    it('a espera longa por uma trava devolve o lote sem isolar ninguém', async () => {
      const tenantId = await customer('espera');
      await insert(tenantId, { createdAt: at(0) });
      await assignAll(prisma, [tenantId], { now: () => at(0) });
      await insert(tenantId, { createdAt: at(1) });
      const row = only(await casesOf(prisma, tenantId));
      const client = new pg.Client({ connectionString: inject('testDatabaseUrl') });
      await client.connect();
      const errors: { sqlState?: unknown }[] = [];
      try {
        await client.query('BEGIN');
        await client.query('SELECT 1 FROM "AlertCase" WHERE "id" = $1 FOR UPDATE', [row.id]);
        const job = assignJob(prisma, [tenantId], {
          now: () => at(1),
          logger: { warn: () => undefined, error: (fields) => void errors.push(fields) },
        });
        expect(await passage(job)).toMatchObject({ failedTenants: 1, quarantined: 0, assigned: 0 });
        expect(errors.map(({ sqlState }) => sqlState)).toEqual(['55P03']);
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
      expect(await assignAll(prisma, [tenantId], { now: () => at(1) })).toMatchObject({ assigned: 1 });
    });

    it('a parada do worker interrompe entre dois lotes, e o resto fica para a próxima', async () => {
      const tenantId = await customer('parada');
      for (let index = 0; index < 25; index += 1) await insert(tenantId, { createdAt: at(index) });
      const controller = new AbortController();
      const reason = new DOMException('o worker está parando', 'AbortError');
      const name = `caso-ab-${randomUUID().slice(0, 8)}`;
      const job = assignJob(prisma, [tenantId], {
        name,
        batch: 10,
        now: () => at(HOUR_MS),
        onBatch: () => controller.abort(reason),
      });
      await expect(passage(job, controller.signal)).rejects.toBe(reason);
      expect(await unassigned(tenantId)).toBe(15);
      // A concessão foi devolvida: outro processo começa na hora.
      const state = await prisma.syncState.findUniqueOrThrow({ where: { name } });
      expect(state).toMatchObject({ leaseOwner: null, leaseUntil: null, lastError: 'AbortError' });
      expect(await passage(assignJob(prisma, [tenantId], { name, now: () => at(HOUR_MS) }))).toMatchObject({
        status: 'done',
        assigned: 15,
      });
      expect(only(await casesOf(prisma, tenantId)).total).toBe(25);
      // Já parado, nem começa.
      const stopped = new AbortController();
      stopped.abort(reason);
      await insert(tenantId, { createdAt: at(50) });
      await expect(passage(assignJob(prisma, [tenantId], { name }), stopped.signal)).rejects.toBe(reason);
      expect(await unassigned(tenantId)).toBe(1);
    });

    it('cada cliente tem 2 s de trabalho por passagem, e a seguinte continua', async () => {
      const tenantId = await customer('tempo');
      for (let index = 0; index < 20; index += 1) await insert(tenantId, { createdAt: at(index) });
      let elapsed = 0;
      const job = assignJob(prisma, [tenantId], {
        batch: 5,
        elapsed: () => elapsed,
        onBatch: () => {
          elapsed += 1_500;
        },
      });
      expect(await passage(job)).toMatchObject({ batches: 2, assigned: 10, unfinishedTenants: 1 });
      expect(await passage(job)).toMatchObject({ batches: 2, assigned: 10, unfinishedTenants: 1 });
      expect(await passage(job)).toMatchObject({ assigned: 0, unfinishedTenants: 0 });
    });

    it('a passagem interrompida continua pelo cliente seguinte: uma fila longa não deixa ninguém para trás', async () => {
      const ids = [await customer('R1'), await customer('R2'), await customer('R3')].sort();
      for (const tenantId of ids) await insert(tenantId, { createdAt: at(0) });
      const order: string[] = [];
      let stopAt: string | null = ids[1] as string;
      let controller = new AbortController();
      const job = assignJob(prisma, ids, {
        batch: 1,
        onBatch: ({ tenantId }) => {
          order.push(tenantId);
          if (tenantId === stopAt) controller.abort();
        },
      });
      await expect(passage(job, controller.signal)).rejects.toThrow();
      expect(order).toEqual(ids.slice(0, 2));
      order.length = 0;
      stopAt = null;
      controller = new AbortController();
      for (const tenantId of ids) await insert(tenantId, { createdAt: at(1) });
      await passage(job, controller.signal);
      // O segundo não tinha acabado: a passagem seguinte começa por ele.
      expect([...new Set(order)]).toEqual([ids[1], ids[2], ids[0]]);
    });

    it('uma réplica por vez; a que perde a concessão no meio para', async () => {
      const tenantId = await customer('réplicas');
      for (let index = 0; index < 6; index += 1) await insert(tenantId, { createdAt: at(index) });
      const name = `caso-lc-${randomUUID().slice(0, 8)}`;
      await prisma.syncState.create({
        data: { name, leaseOwner: 'outra', leaseUntil: new Date(Date.now() + 60_000) },
      });
      expect(await passage(assignJob(prisma, [tenantId], { name }))).toMatchObject({
        status: 'locked',
        assigned: 0,
      });
      await prisma.syncState.update({ where: { name }, data: { leaseUntil: new Date(0) } });
      let elapsed = 0;
      // Logo depois do primeiro lote, outra réplica toma a concessão.
      const stolen = new Proxy(prisma, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (property !== '$transaction') return value;
          return async (...args: unknown[]) => {
            const result = await (value as (...args: unknown[]) => Promise<unknown>).apply(target, args);
            elapsed += 60_000;
            await prisma.syncState.updateMany({
              where: { name },
              data: { leaseOwner: 'outra', leaseUntil: new Date(Date.now() + 60_000) },
            });
            return result;
          };
        },
      });
      const job = assignJob(stolen, [tenantId], {
        name,
        batch: 2,
        workMs: 60_000_000,
        elapsed: () => elapsed,
      });
      expect(await passage(job)).toMatchObject({ status: 'lease_lost', assigned: 2 });
      // A concessão da outra réplica fica como está.
      expect((await prisma.syncState.findUniqueOrThrow({ where: { name } })).leaseOwner).toBe('outra');
    });
  });

  describe('a vigia', () => {
    it('mede o alerta alto ou crítico mais antigo sem caso e avisa no log depois de 10 min', async () => {
      const [a, b] = [await customer('V1'), await customer('V2')];
      const warnings: object[] = [];
      const logger = { warn: (fields: object) => void warnings.push(fields), error: () => undefined };
      const watch = (now: Date) =>
        new CaseWatch(prisma, { tenantIds: [a, b], logger, now: () => now }).runOnce();
      await insert(a, { createdAt: at(0), severity: 'low' });
      expect(await watch(at(DAY_MS))).toEqual({ tenants: 2, lagging: 0, oldestSeconds: null });
      await insert(a, { createdAt: at(60_000), severity: 'high' });
      await insert(a, { createdAt: at(30_000), severity: 'critical' });
      await insert(b, { createdAt: at(500_000), severity: 'high' });
      expect(await watch(at(30_000 + 10 * 60_000))).toEqual({ tenants: 2, lagging: 0, oldestSeconds: 600 });
      expect(warnings).toEqual([]);
      expect(await watch(at(31_000 + 10 * 60_000))).toEqual({ tenants: 2, lagging: 1, oldestSeconds: 601 });
      expect(warnings).toEqual([{ tenantId: a, severity: 'critical', seconds: 601 }]);
      // O tratado e o que já tem caso não contam.
      await prisma.finding.updateMany({
        where: { tenantId: a, severity: 'critical' },
        data: { status: 'resolved' },
      });
      await assignAll(prisma, [a]);
      expect(await watch(at(DAY_MS))).toMatchObject({ lagging: 1, oldestSeconds: DAY_MS / 1000 - 500 });
    });
  });

  it('a migration do autovacuum só muda um parâmetro da tabela de alertas', async () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL('../prisma/migrations/20261129120000_finding_autovacuum/migration.sql', import.meta.url),
      ),
      'utf8',
    );
    expect(sql.replace(/^--.*$/gm, '').trim()).toBe(
      'ALTER TABLE "Finding" SET (autovacuum_vacuum_scale_factor = 0.05);',
    );
    const rows = await prisma.$queryRaw<{ options: string[] }[]>`
      SELECT reloptions AS options FROM pg_class WHERE oid = '"Finding"'::regclass`;
    expect(only(rows).options).toEqual(['autovacuum_vacuum_scale_factor=0.05']);
  });

  it('a falha de um alerta é só a de dado: o SQLSTATE vem do banco, e o resto não parte o lote', async () => {
    const tenantId = await customer('sqlstate');
    const failure = async (work: () => PromiseLike<unknown>): Promise<unknown> => {
      try {
        await work();
      } catch (error) {
        return error;
      }
      throw new Error('deveria falhar');
    };
    const groupKey = 'a'.repeat(64);
    const row = {
      tenantId,
      queue: 'detection' as const,
      keyVersion: 1,
      groupKey,
      openKey: groupKey,
      family: 'cloudtrail',
      title: 'Caso de teste',
      keyParts: [],
      anchorFindingId: randomUUID(),
      firstSeenAt: at(0),
      lastSeenAt: at(0),
      lastAlertAt: at(0),
    };
    const duplicate = await failure(() => prisma.alertCase.createMany({ data: [row, row] }));
    const check = await failure(() => prisma.alertCase.createMany({ data: [{ ...row, groupKey: 'x' }] }));
    const foreign = await failure(() =>
      prisma.finding.create({ data: findingData(tenantId, { caseId: randomUUID() }) }),
    );
    const syntax = await failure(() => prisma.$executeRaw`SELECT "não existe"`);
    const timeout = await failure(() =>
      prisma.$transaction(async (tx) => tx.$executeRaw`SELECT pg_sleep(1)`, { timeout: 50 }),
    );
    expect([duplicate, check, foreign, syntax].map(sqlStateOf)).toEqual(['23505', '23514', '23503', '42703']);
    expect([duplicate, check, foreign].map(isAlertFault)).toEqual([true, true, true]);
    expect(isAlertFault(new CaseBatchError('x'))).toBe(true);
    expect(isAlertFault(new TypeError('x'))).toBe(true);
    for (const error of [
      syntax,
      timeout,
      new Error('conexão'),
      new DOMException('x', 'AbortError'),
      'texto',
    ]) {
      expect(isAlertFault(error)).toBe(false);
    }
  });

  describe('CASES_MODE', () => {
    const env = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://verax:secret@localhost:5432/verax',
    };

    it('shadow é o padrão; off não cria tarefa nenhuma: nenhum alerta ganha caso e nada é gravado', async () => {
      expect(loadWorkerConfig(env).CASES_MODE).toBe('shadow');
      const tenantId = await customer('desligado');
      const id = await insert(tenantId, { createdAt: at(0) });
      const before = await prisma.finding.findUniqueOrThrow({ where: { id } });
      const untouchable = new Proxy(
        {},
        {
          get() {
            throw new Error('o banco não pode ser tocado com CASES_MODE=off');
          },
        },
      ) as PrismaService;
      const tasks = caseTasks('off', untouchable, { warn: () => undefined, error: () => undefined });
      expect(tasks).toEqual([]);
      expect(await prisma.finding.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect(await casesOf(prisma, tenantId)).toEqual([]);
    });

    it('shadow cria três tarefas, e on, as mesmas e mais a fila da triagem em massa', () => {
      const logger = { warn: () => undefined, error: () => undefined };
      const shape = (mode: 'shadow' | 'on') =>
        caseTasks(mode, prisma, logger).map(({ name, intervalMs, budgetMs }) => ({
          name,
          intervalMs,
          budgetMs,
        }));
      expect(shape('shadow')).toEqual([
        { name: 'case-assign', intervalMs: 10_000, budgetMs: 300_000 },
        { name: 'case-watch', intervalMs: 60_000, budgetMs: 60_000 },
        { name: 'case-reconcile', intervalMs: 3_600_000, budgetMs: 300_000 },
      ]);
      expect(shape('on')).toEqual([
        ...shape('shadow'),
        { name: 'triage-ops', intervalMs: 5_000, budgetMs: 180_000 },
      ]);
    });
  });

  it('a gravação dos coletores não mudou: nenhum alerta nasce com caso', () => {
    const row = findingRow(
      {
        tenantId: randomUUID(),
        accountId: CASE_ACCOUNT,
        source: 'wazuh',
        sourceEventId: 'x',
        occurredAt: at(0).toISOString(),
        severity: 'high',
        ruleId: '100305',
        ruleLevel: 10,
        title: 'x',
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
      },
      null,
    );
    expect(row).not.toHaveProperty('caseId');
  });
});
