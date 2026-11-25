import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  MAX_ACTIVE_TRIAGE_OPERATIONS,
  type Role,
  TRIAGE_ALERTS_PER_DAY,
  TRIAGE_ALERTS_PER_OPERATION,
  triageOperationPageSchema,
} from '@verax/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIAGE_LIMITS,
  TRIAGE_LIMITS,
  type TriageLimits,
} from '../src/cases/triage-operations.service.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createTenant } from './support/auth-helpers.js';
import {
  cleanCases,
  expectExactCounters,
  insertCase,
  insertFinding,
  insertIncident,
} from './support/cases.js';
import { createApp } from './support/create-app.js';
import {
  caseWith,
  drain,
  earlier,
  findingsById,
  manyFindings,
  operate,
  operation,
  type Operator,
  operatorFor,
  patch,
  post,
  read,
  statusRequest,
  trail,
  undo,
} from './support/triage.js';

/** O pedido de triagem em massa: idempotência, na requisição ou na fila, cotas e a trilha de auditoria. */
describe('pedidos de triagem em massa', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  const tenants: string[] = [];
  const limits: TriageLimits = { ...DEFAULT_TRIAGE_LIMITS };

  const newTenant = async (name: string): Promise<string> => {
    const id = await createTenant(app, `Cliente Demo (lote: ${name})`);
    tenants.push(id);
    return id;
  };
  /** Um cliente novo e quem opera nele. */
  async function customer(name: string, role: Role = 'admin_cliente') {
    const tenantId = await newTenant(name);
    return { tenantId, who: await operatorFor(app, tenantId, role) };
  }

  beforeAll(async () => {
    app = await createApp({
      casesMode: 'on',
      overrideProviders: [{ provide: TRIAGE_LIMITS, useValue: limits }],
    });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantA = await newTenant('A');
  }, 60_000);

  beforeEach(() => {
    Object.assign(limits, DEFAULT_TRIAGE_LIMITS);
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  describe('idempotência', () => {
    it('o mesmo pedido de novo devolve a operação, sem mudar nada nem repetir a trilha', async () => {
      const { tenantId, who } = await customer('repetido');
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
      const body = statusRequest({ caseIds: [caseId] }, 2);
      const first = await operate(app, who, body);
      // O alerta que volta a ser novo, e o que chega depois, não são tocados pela repetição.
      await patch(app, who, `/v1/findings/${ids[0]}/status`, { status: 'new' }).expect(200);
      const late = await insertFinding(prisma, tenantId, { caseId, createdAt: earlier() });
      const second = await operate(app, who, body, 200);
      expect(second.id).toBe(first.id);
      const rows = await findingsById(prisma, [...ids, late]);
      expect([ids[0] as string, late].map((id) => rows.get(id)?.status)).toEqual(['new', 'new']);
      expect(await prisma.triageOperation.count({ where: { tenantId } })).toBe(1);
      expect(await trail(prisma, tenantId, 'triage.bulk.request')).toHaveLength(1);
      expect(await trail(prisma, tenantId, 'triage.bulk.finish')).toHaveLength(1);
      expect(await trail(prisma, tenantId, 'triage.bulk.replay')).toHaveLength(1);
    });

    it('o mesmo requestId em outro pedido, ou de outra pessoa, é 409', async () => {
      const { tenantId, who } = await customer('reusado');
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
      const incidentId = await insertIncident(prisma, tenantId);
      const body = statusRequest({ findingIds: [ids[0]] }, 1);
      const made = await operate(app, who, body);
      const other = await operatorFor(app, tenantId, 'admin_cliente');
      const attempts: [Operator, object][] = [
        [other, body],
        [who, { ...body, status: 'legitimate' }],
        [who, { ...body, target: { findingIds: [ids[1]] } }],
        [who, { ...body, target: { caseIds: [caseId] } }],
        [who, { ...body, expectedCount: 2 }],
        [who, { ...body, includeCritical: true }],
        [who, { ...body, reason: 'outro' }],
        [who, { ...body, reason: undefined }],
        [who, { ...body, action: 'promote', status: undefined }],
        [who, { ...body, action: 'attach', status: undefined, incidentId }],
        [
          who,
          {
            requestId: body['requestId'],
            action: 'undo_all_of',
            target: { userId: who.userId },
            reason: 'Manutenção programada',
          },
        ],
      ];
      for (const [person, attempt] of attempts) {
        const response = await post(app, person, '/v1/triage-operations', attempt);
        expect(response.status, JSON.stringify(attempt)).toBe(409);
        expect(response.body).toMatchObject({ code: 'TRIAGE_REQUEST_REUSED' });
      }
      const undoing = await post(app, who, `/v1/triage-operations/${made.id}/undo`, {
        requestId: body['requestId'],
      });
      expect(undoing.status).toBe(409);
      expect(undoing.body).toMatchObject({ code: 'TRIAGE_REQUEST_REUSED' });
      expect((await findingsById(prisma, [ids[1] as string])).get(ids[1] as string)?.status).toBe('new');
    });

    it('o pedido de promover não se repete como anexar', async () => {
      const { tenantId, who } = await customer('outra ação');
      const { caseId } = await caseWith(prisma, tenantId, [{}]);
      const body = { ...statusRequest({ caseIds: [caseId] }, 1), action: 'promote', status: undefined };
      const made = await operate(app, who, body);
      const other = { ...body, action: 'attach', incidentId: made.incidentId };
      const response = await post(app, who, '/v1/triage-operations', other);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'TRIAGE_REQUEST_REUSED' });
    });

    it('a ordem das chaves do alvo e a caixa do id não fazem outro pedido', async () => {
      const { tenantId, who } = await customer('mesmo alvo');
      await caseWith(prisma, tenantId, [{}], { actors: ['fulano-de-tal'] });
      const body = statusRequest({ filter: { q: 'fulano-de-tal', queue: 'detection' } }, 1);
      const first = await operate(app, who, body);
      const again = {
        ...body,
        target: { filter: { queue: 'detection', state: 'pending', q: 'fulano-de-tal' } },
      };
      expect((await operate(app, who, again, 200)).id).toBe(first.id);
    });

    it.each([2, 6])('%i envios do mesmo pedido ao mesmo tempo: uma operação só', async (times) => {
      const { tenantId, who } = await customer(`duplo ${times}`);
      const { caseId } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, caseId, 120);
      const body = statusRequest({ caseIds: [caseId] }, 120);
      const answers = await Promise.all(
        Array.from({ length: times }, () => post(app, who, '/v1/triage-operations', body)),
      );
      expect(answers.map((answer) => answer.status).sort()).toEqual([
        ...Array.from({ length: times - 1 }, () => 200),
        201,
      ]);
      expect(new Set(answers.map((answer) => (answer.body as { id: string }).id)).size).toBe(1);
      expect(await prisma.triageOperation.count({ where: { tenantId } })).toBe(1);
      expect(await prisma.triageOperationItem.count({ where: { tenantId } })).toBe(120);
      expect(await trail(prisma, tenantId, 'triage.bulk.request')).toHaveLength(1);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('dois pedidos diferentes sobre os mesmos alertas ao mesmo tempo: cada alerta entra num só', async () => {
      const { tenantId, who } = await customer('disputa');
      const { caseId } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, caseId, 80);
      const answers = await Promise.all(
        ['resolved', 'legitimate'].map((status) =>
          post(app, who, '/v1/triage-operations', statusRequest({ caseIds: [caseId] }, 80, { status })),
        ),
      );
      const statuses = answers.map((answer) => answer.status).sort();
      // O segundo só acha o que o primeiro deixou: nada.
      expect(statuses).toEqual([201, 409]);
      expect(await prisma.triageOperationItem.count({ where: { tenantId } })).toBe(80);
      await expectExactCounters(prisma, [tenantId]);
    });
  });

  describe('na requisição ou na fila', () => {
    it('até 200 alertas, na requisição; com 201, na fila', async () => {
      const { tenantId, who } = await customer('limiar');
      const { caseId: small } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, small, 200);
      const { caseId: large } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, large, 201);
      const startedAt = performance.now();
      const done = await operate(app, who, statusRequest({ caseIds: [small] }, 200));
      const elapsed = performance.now() - startedAt;
      expect(done).toMatchObject({ state: 'done', changed: 200 });
      // O limite da requisição é de 15 s.
      expect(elapsed).toBeLessThan(5_000);
      const queued = await operate(app, who, statusRequest({ caseIds: [large] }, 201), 202);
      expect(queued).toMatchObject({
        state: 'queued',
        matched: 201,
        changed: 0,
        remaining: 201,
        can: { cancel: true, continue: false, undo: false },
      });
      expect(await prisma.finding.count({ where: { tenantId, caseId: large, status: 'new' } })).toBe(201);
      const active = await read(app, who, '/v1/triage-operations?state=active').expect(200);
      expect(triageOperationPageSchema.parse(active.body).items.map((item) => item.id)).toEqual([queued.id]);
      const report = await drain(prisma, [tenantId]);
      expect(report).toMatchObject({ batches: 1, changed: 201, finished: 1 });
      const finished = await operation(app, who, queued.id);
      expect(finished).toMatchObject({ state: 'done', changed: 201, skipped: 0, remaining: 0 });
      expect(finished.can).toEqual({ cancel: false, continue: false, undo: true });
      // O conjunto congelado sai quando a operação termina.
      const stored = await prisma.triageOperation.findUniqueOrThrow({ where: { id: queued.id } });
      expect(stored.target).toEqual({
        caseIds: [large],
        run: { ...(stored.target as { run: object }).run },
      });
      const ended = await read(app, who, '/v1/triage-operations?state=finished').expect(200);
      expect(triageOperationPageSchema.parse(ended.body).items.map((item) => item.id)).toEqual([
        queued.id,
        done.id,
      ]);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('a fila de um cliente tem no máximo dez operações; a que cabe na requisição não conta', async () => {
      const { tenantId, who } = await customer('fila cheia');
      limits.syncAlerts = 1;
      expect(MAX_ACTIVE_TRIAGE_OPERATIONS).toBe(10);
      for (let index = 0; index < 10; index += 1) {
        const { caseId } = await caseWith(prisma, tenantId, [{}, {}]);
        await operate(app, who, statusRequest({ caseIds: [caseId] }, 2), 202);
      }
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
      const full = await post(app, who, '/v1/triage-operations', statusRequest({ caseIds: [caseId] }, 2));
      expect(full.status).toBe(409);
      expect(full.body).toMatchObject({ code: 'TRIAGE_QUEUE_FULL', details: { limit: 10 } });
      await operate(app, who, statusRequest({ findingIds: [ids[0]] }, 1));
      await drain(prisma, [tenantId]);
      await operate(app, who, statusRequest({ caseIds: [caseId] }, 1));
    });

    it('acima do teto de alertas, 409', async () => {
      const { tenantId, who } = await customer('teto');
      limits.maxAlerts = 3;
      const { caseId } = await caseWith(prisma, tenantId, [{}, {}, {}, {}]);
      const refused = await post(app, who, '/v1/triage-operations', statusRequest({ caseIds: [caseId] }, 4));
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'TRIAGE_TOO_LARGE', details: { max: 3 } });
      expect(await prisma.triageOperation.count({ where: { tenantId } })).toBe(0);
    });
  });

  describe('cotas de quem não administra', () => {
    it('os limites do contrato', () => {
      expect([TRIAGE_ALERTS_PER_OPERATION, TRIAGE_ALERTS_PER_DAY]).toEqual([2_000, 5_000]);
      expect(limits).toMatchObject({ alertsPerOperation: 2_000, alertsPerDay: 5_000 });
    });

    it('por operação: o analista para no limite, quem administra passa', async () => {
      const { tenantId, who: analyst } = await customer('cota operação', 'analista_cliente');
      limits.alertsPerOperation = 3;
      const { caseId } = await caseWith(prisma, tenantId, [{}, {}, {}, {}]);
      const body = statusRequest({ caseIds: [caseId] }, 4);
      const refused = await post(app, analyst, '/v1/triage-operations', body);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'TRIAGE_QUOTA_EXCEEDED', details: { limit: 3, count: 4 } });
      const [denied] = await trail(prisma, tenantId, 'triage.bulk.request');
      expect(denied).toMatchObject({ outcome: 'denied', statusCode: 403, actorId: analyst.userId });
      expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(4);
      for (const role of ['admin_cliente', 'admin_verax'] as const) {
        const who = await operatorFor(app, tenantId, role);
        const { caseId: another } = await caseWith(prisma, tenantId, [{}, {}, {}, {}]);
        await operate(app, who, statusRequest({ caseIds: [another] }, 4));
      }
      // O que a equipe da Verax faz entra na trilha do cliente, o pedido e o fim.
      expect(
        (await trail(prisma, tenantId, 'triage.bulk.request', 'triage.bulk.finish'))
          .filter((row) => row.outcome === 'success')
          .map((row) => row.action),
      ).toEqual(['triage.bulk.finish', 'triage.bulk.request', 'triage.bulk.finish', 'triage.bulk.request']);
      // No limite exato, passa.
      limits.alertsPerOperation = 4;
      await operate(app, analyst, body);
    });

    it('por 24 horas: soma as operações da pessoa, inclusive a desfeita, e a janela anda com o relógio', async () => {
      const { tenantId, who: analyst } = await customer('cota dia', 'analista_cliente');
      const colleague = await operatorFor(app, tenantId, 'analista_cliente');
      limits.alertsPerDay = 5;
      const of = async (count: number) =>
        statusRequest(
          {
            caseIds: [
              (
                await caseWith(
                  prisma,
                  tenantId,
                  Array.from({ length: count }, () => ({})),
                )
              ).caseId,
            ],
          },
          count,
        );
      const start = new Date();
      const first = await operate(app, analyst, await of(3));
      await undo(app, analyst, first.id);
      const tooMany = await post(app, analyst, '/v1/triage-operations', await of(3));
      expect(tooMany.status).toBe(403);
      expect(tooMany.body).toMatchObject({ code: 'TRIAGE_QUOTA_EXCEEDED', details: { limit: 5, count: 6 } });
      await operate(app, analyst, await of(2));
      expect((await post(app, analyst, '/v1/triage-operations', await of(1))).status).toBe(403);
      // A cota é de cada pessoa.
      await operate(app, colleague, await of(5));
      // Um instante antes das 24 h ainda conta; depois, não.
      limits.now = () => new Date(start.getTime() + 24 * 3_600_000 - 1_000);
      expect((await post(app, analyst, '/v1/triage-operations', await of(1))).status).toBe(403);
      limits.now = () => new Date(start.getTime() + 24 * 3_600_000 + 120_000);
      await operate(app, analyst, await of(5));
    });

    it('as cotas de um cliente não contam no outro', async () => {
      limits.alertsPerDay = 1;
      const { caseId: a } = await caseWith(prisma, tenantA, [{}]);
      const fresh = await customer('cota outro', 'analista_cliente');
      const { caseId: b } = await caseWith(prisma, fresh.tenantId, [{}]);
      await operate(app, fresh.who, statusRequest({ caseIds: [b] }, 1));
      const other = await operatorFor(app, tenantA, 'analista_cliente');
      await operate(app, other, statusRequest({ caseIds: [a] }, 1));
    });
  });

  describe('trilha de auditoria', () => {
    it('um pedido, com as contagens de antes, e um fim do sistema; o alerta não ganha registro próprio', async () => {
      const { tenantId, who } = await customer('auditoria');
      const { caseId, ids } = await caseWith(prisma, tenantId, [
        { severity: 'high' },
        { severity: 'high', status: 'investigating' },
        { severity: 'low' },
        { severity: 'critical' },
      ]);
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 3));
      const rows = await prisma.auditLog.findMany({
        where: { tenantId, actorType: { not: 'anonymous' } },
        orderBy: { id: 'asc' },
      });
      const bulk = rows.filter((row) => row.action.startsWith('triage.'));
      expect(bulk.map((row) => [row.action, row.actorType, row.outcome])).toEqual([
        ['triage.bulk.finish', 'system', 'success'],
        ['triage.bulk.request', 'user', 'success'],
      ]);
      const [finish, asked] = bulk;
      expect(asked).toMatchObject({
        actorId: who.userId,
        resourceType: 'triage_operation',
        resourceId: made.id,
        statusCode: 201,
        before: {
          cases: 1,
          alerts: [
            { status: 'new', severity: 'high', count: 1 },
            { status: 'new', severity: 'low', count: 1 },
            { status: 'investigating', severity: 'high', count: 1 },
          ],
        },
        after: {
          action: 'status',
          status: 'resolved',
          target: { caseIds: [caseId] },
          cutoffAt: made.cutoffAt,
          expectedCount: 3,
          matched: 3,
          includeCritical: false,
          excludedCritical: 1,
          reason: 'Manutenção programada',
          sync: true,
        },
      });
      expect(finish).toMatchObject({
        actorId: null,
        resourceType: 'triage_operation',
        resourceId: made.id,
        after: {
          action: 'status',
          status: 'resolved',
          requestedBy: who.userId,
          state: 'done',
          stop: null,
          matched: 3,
          changed: 3,
          skipped: 0,
          failed: 0,
        },
      });
      expect(rows.filter((row) => ids.includes(row.resourceId ?? ''))).toEqual([]);
      expect(rows.filter((row) => row.action === 'finding.status')).toEqual([]);
    });

    it('o maior alvo cabe no teto do estado da trilha: 500 alertas, com o motivo no limite', async () => {
      const { tenantId, who } = await customer('estado');
      const { caseId } = await caseWith(prisma, tenantId, []);
      const ids = await manyFindings(prisma, tenantId, caseId, 500);
      const reason = 'ç'.repeat(500);
      await operate(app, who, statusRequest({ findingIds: ids }, 500, { reason }), 202);
      const [asked] = await trail(prisma, tenantId, 'triage.bulk.request');
      const after = asked?.after as { target: { findings: number; findingIds: string[] }; reason: string };
      expect(after.target.findings).toBe(500);
      expect(after.target.findingIds).toEqual(ids.slice(0, 100));
      expect(after.reason).toBe(reason);
      expect(JSON.stringify(asked?.after)).not.toContain('truncated');
      await drain(prisma, [tenantId]);
    });

    it('50 casos com o subgrupo no limite cabem no estado', async () => {
      const { tenantId, who } = await customer('estado casos');
      const caseIds: string[] = [];
      const group = 'g'.repeat(128);
      for (let index = 0; index < 50; index += 1) {
        caseIds.push(await insertCase(prisma, tenantId));
        if (index < 2)
          await insertFinding(prisma, tenantId, {
            caseId: caseIds[index] as string,
            caseGroup: group,
            createdAt: earlier(),
          });
      }
      await operate(app, who, statusRequest({ caseIds, group }, 2));
      const [asked] = await trail(prisma, tenantId, 'triage.bulk.request');
      expect((asked?.after as { target: { caseIds: string[] } }).target.caseIds).toEqual(caseIds);
    });
  });
});
