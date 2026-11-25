import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type IncidentDetail, incidentDetailSchema } from '@verax/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIAGE_LIMITS,
  TRIAGE_LIMITS,
  type TriageLimits,
} from '../src/cases/triage-operations.service.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { FindingSeverity, Prisma } from '../src/generated/prisma/client.js';
import {
  incidentFindingSelect,
  type IncidentSummaryData,
  incidentSummaryData,
  mergeIncidentSummary,
  protectedItemsOf,
} from '../src/incidents/incident-summary.js';
import {
  addToIncidentSummary,
  aggregateIncidentSummary,
  resummarizeIncident,
  SUMMARY_IN_MEMORY_MAX,
} from '../src/incidents/incident-summary-store.js';
import { createTenant } from './support/auth-helpers.js';
import {
  cleanCases,
  expectExactCounters,
  findingData,
  insertFinding,
  insertIncident,
} from './support/cases.js';
import { createApp } from './support/create-app.js';
import {
  caseRow,
  caseWith,
  drain,
  earlier,
  expectNoDrift,
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
  triageJob,
  undo,
} from './support/triage.js';

/** Promover e anexar em massa: o incidente, os avisos, o resumo e o desfazer. */
describe('triagem em massa: incidentes', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];
  const limits: TriageLimits = { ...DEFAULT_TRIAGE_LIMITS };

  async function customer(name: string): Promise<{ tenantId: string; who: Operator }> {
    const tenantId = await createTenant(app, `Cliente Demo (incidente: ${name})`);
    tenants.push(tenantId);
    return { tenantId, who: await operatorFor(app, tenantId, 'analista_cliente') };
  }

  const promote = (target: object, expectedCount: number, overrides: object = {}) => ({
    ...statusRequest(target, expectedCount),
    action: 'promote',
    status: undefined,
    ...overrides,
  });
  const attach = (incidentId: string, target: object, expectedCount: number, overrides: object = {}) => ({
    ...statusRequest(target, expectedCount),
    action: 'attach',
    status: undefined,
    incidentId,
    ...overrides,
  });
  const incident = async (who: Operator, id: string | null): Promise<IncidentDetail> =>
    incidentDetailSchema.parse((await read(app, who, `/v1/incidents/${id}`).expect(200)).body);
  const notices = (tenantId: string) =>
    prisma.notification.findMany({
      where: { tenantId, incidentId: { not: null } },
      select: { kind: true, severity: true, dedupeKey: true },
      orderBy: { id: 'asc' },
    });
  /** Um recurso por alerta: o resumo muda a cada um que sai do incidente. */
  const distinctResources = (ids: readonly string[], prefix: string) =>
    Promise.all(
      ids.map((id, index) =>
        prisma.finding.update({
          where: { id },
          data: { resource: `${prefix}-${index}` },
          select: { id: true },
        }),
      ),
    );
  const attached = (incidentId: string | null) => prisma.finding.count({ where: { incidentId } });

  /** O resumo gravado é o que sairia dos alertas do incidente, um por um. */
  async function expectSummary(tenantId: string, incidentId: string | null): Promise<void> {
    const rows = await prisma.finding.findMany({ where: { incidentId }, select: incidentFindingSelect });
    const items = await prisma.protectedResource.findMany({
      where: { tenantId },
      select: { type: true, identifier: true },
    });
    const row = await prisma.incident.findUniqueOrThrow({ where: { id: incidentId as string } });
    expect(row).toMatchObject(incidentSummaryData(rows, protectedItemsOf(items)));
  }

  beforeAll(async () => {
    app = await createApp({
      casesMode: 'on',
      overrideProviders: [{ provide: TRIAGE_LIMITS, useValue: limits }],
    });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
  }, 60_000);

  beforeEach(() => {
    Object.assign(limits, DEFAULT_TRIAGE_LIMITS);
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  describe('promover', () => {
    it('um caso: o incidente nasce com todos, um aviso só, e o alerta que abriu o caso é a âncora', async () => {
      const { tenantId, who } = await customer('um caso');
      const { caseId, ids } = await caseWith(prisma, tenantId, [
        { severity: 'high', createdAt: earlier(30_000) },
        { severity: 'medium', createdAt: earlier(90_000) },
        { severity: 'low', status: 'investigating' },
        { status: 'resolved' },
      ]);
      const anchor = ids[1] as string;
      await prisma.alertCase.update({ where: { id: caseId }, data: { anchorFindingId: anchor } });
      const made = await operate(app, who, promote({ caseIds: [caseId] }, 3));
      expect(made).toMatchObject({ action: 'promote', state: 'done', changed: 3, skipped: 0, status: null });
      const opened = await incident(who, made.incidentId);
      expect(opened).toMatchObject({
        status: 'open',
        severity: 'high',
        findingCount: 3,
        createdBy: { id: who.userId },
      });
      expect(opened.findings.map((finding) => finding.id).sort()).toEqual(ids.slice(0, 3).sort());
      const rows = await findingsById(prisma, ids);
      // O status de cada um não muda, como ao promover à mão.
      expect(ids.map((id) => rows.get(id)?.status)).toEqual(['new', 'new', 'investigating', 'resolved']);
      expect(ids.map((id) => rows.get(id)?.triageOpId === made.id)).toEqual([true, true, true, false]);
      expect(rows.get(ids[3] as string)?.incidentId).toBeNull();
      expect(await caseRow(prisma, caseId)).toMatchObject({
        incidentId: made.incidentId,
        incidentCount: 3,
        pending: false,
      });
      expect(await notices(tenantId)).toEqual([
        { kind: 'incident_opened', severity: 'high', dedupeKey: `incident:${made.incidentId}:high` },
      ]);
      const stored = await prisma.triageOperation.findUniqueOrThrow({ where: { id: made.id } });
      expect((stored.target as { run: { anchorId: string } }).run.anchorId).toBe(anchor);
      const records = await trail(
        prisma,
        tenantId,
        'triage.bulk.request',
        'triage.bulk.finish',
        'incident.create',
      );
      expect(records.map((row) => [row.action, row.actorType, row.resourceId])).toEqual([
        ['triage.bulk.finish', 'system', made.id],
        ['triage.bulk.request', 'user', made.id],
        ['incident.create', 'user', made.incidentId],
      ]);
      expect(records[2]?.after).toMatchObject({ severity: 'high', findingCount: 3 });
      await expectSummary(tenantId, made.incidentId);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('de 51 a 200 alertas, na requisição: os 50 piores abrem, o resto entra, com um aviso só', async () => {
      const { tenantId, who } = await customer('na requisição');
      const { caseId } = await caseWith(prisma, tenantId, []);
      const ids = await manyFindings(prisma, tenantId, caseId, 180);
      const made = await operate(app, who, promote({ caseIds: [caseId] }, 180));
      expect(made).toMatchObject({ state: 'done', matched: 180, changed: 180, skipped: 0, remaining: 0 });
      expect(await attached(made.incidentId)).toBe(180);
      expect(await prisma.triageOperationItem.count({ where: { operationId: made.id } })).toBe(180);
      const [created] = await trail(prisma, tenantId, 'incident.create');
      const first = (created?.after as { findingIds: string[] }).findingIds;
      expect(first).toHaveLength(50);
      const severities = (await findingsById(prisma, first)).values();
      expect([...severities].every((row) => row.severity === 'high')).toBe(true);
      expect(ids).toEqual(expect.arrayContaining(first));
      expect(await notices(tenantId)).toHaveLength(1);
      await expectSummary(tenantId, made.incidentId);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('acima disso: o incidente já nasce com 50, o worker anexa o resto, e continua um aviso só', async () => {
      const { tenantId, who } = await customer('na fila');
      await prisma.protectedResource.create({
        data: {
          tenantId,
          type: 'iam_user',
          identifier: 'pessoa-3',
          reason: 'teste',
          createdById: who.userId,
        },
      });
      const cases: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const { caseId } = await caseWith(prisma, tenantId, [], { actors: ['o-alvo'] });
        await manyFindings(prisma, tenantId, caseId, 190, { resource: `ec2:i-${index}` });
        cases.push(caseId);
      }
      const made = await operate(app, who, promote({ filter: { q: 'o-alvo' } }, 760), 202);
      expect(made).toMatchObject({ state: 'queued', matched: 760, changed: 50, remaining: 710 });
      expect(await incident(who, made.incidentId)).toMatchObject({ findingCount: 50, severity: 'high' });
      for (const caseId of cases) expect((await caseRow(prisma, caseId)).incidentId).toBe(made.incidentId);
      const report = await drain(prisma, [tenantId], { batch: 300 });
      expect(report).toMatchObject({ batches: 3, changed: 710 });
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', changed: 760, skipped: 0 });
      // Passa de 500: o resumo é feito no banco, com o mesmo resultado.
      expect(SUMMARY_IN_MEMORY_MAX).toBe(500);
      const opened = await incident(who, made.incidentId);
      expect(opened.findingCount).toBe(760);
      expect(opened.resources).toEqual(['ec2:i-0', 'ec2:i-1', 'ec2:i-2', 'ec2:i-3']);
      await expectSummary(tenantId, made.incidentId);
      expect(await notices(tenantId)).toEqual([
        { kind: 'incident_opened', severity: 'high', dedupeKey: `incident:${made.incidentId}:high` },
      ]);
      await expectExactCounters(prisma, [tenantId]);
      await expectNoDrift(prisma, [tenantId]);
    });

    it('o alerta que a origem agravou entre o pedido e o lote não faz o promover avisar de novo', async () => {
      const { tenantId, who } = await customer('agravado');
      limits.syncAlerts = 1;
      const { caseId } = await caseWith(prisma, tenantId, []);
      const ids = await manyFindings(prisma, tenantId, caseId, 60, { severity: 'medium' });
      const made = await operate(app, who, promote({ caseIds: [caseId] }, 60), 202);
      const waiting = await prisma.finding.findFirstOrThrow({
        where: { id: { in: ids }, incidentId: null },
        select: { id: true },
      });
      await prisma.finding.update({ where: { id: waiting.id }, data: { severity: 'high' } });
      await drain(prisma, [tenantId]);
      expect(await incident(who, made.incidentId)).toMatchObject({ severity: 'high', findingCount: 60 });
      expect((await notices(tenantId)).map((row) => [row.kind, row.severity])).toEqual([
        ['incident_opened', 'medium'],
      ]);
    });

    it('um subgrupo ou alertas escolhidos não fazem do caso um promovido', async () => {
      const { tenantId, who } = await customer('parte');
      const { caseId, ids } = await caseWith(prisma, tenantId, [{ caseGroup: 'a' }, { caseGroup: 'b' }, {}]);
      const byGroup = await operate(app, who, promote({ caseIds: [caseId], group: 'a' }, 1));
      const byId = await operate(app, who, promote({ findingIds: [ids[1]] }, 1));
      expect((await caseRow(prisma, caseId)).incidentId).toBeNull();
      expect(byGroup.incidentId).not.toBe(byId.incidentId);
      expect(await attached(byGroup.incidentId)).toBe(1);
    });

    it('o caso que já é de outro incidente aberto continua apontando para ele', async () => {
      const { tenantId, who } = await customer('já promovido');
      const open = await insertIncident(prisma, tenantId);
      const resolved = await insertIncident(prisma, tenantId, { status: 'resolved', resolvedAt: new Date() });
      const a = await caseWith(prisma, tenantId, [{}], { incidentId: open });
      const b = await caseWith(prisma, tenantId, [{}], { incidentId: resolved });
      const made = await operate(app, who, promote({ caseIds: [a.caseId, b.caseId] }, 2));
      expect((await caseRow(prisma, a.caseId)).incidentId).toBe(open);
      expect((await caseRow(prisma, b.caseId)).incidentId).toBe(made.incidentId);
    });

    it('o crítico só entra confirmado; sem ele, o incidente nasce com a severidade dos outros', async () => {
      const { tenantId, who } = await customer('críticos');
      const { caseId } = await caseWith(prisma, tenantId, [{ severity: 'critical' }, { severity: 'medium' }]);
      const without = await operate(app, who, promote({ caseIds: [caseId] }, 2));
      expect(without).toMatchObject({ changed: 1, excludedCritical: 1, warnings: ['critical_excluded'] });
      expect((await incident(who, without.incidentId)).severity).toBe('medium');
      const other = await caseWith(prisma, tenantId, [{ severity: 'critical' }, { severity: 'medium' }]);
      const made = await operate(
        app,
        who,
        promote({ caseIds: [other.caseId] }, 2, { includeCritical: true }),
      );
      expect((await incident(who, made.incidentId)).severity).toBe('critical');
    });

    it('o pedido repetido devolve o mesmo incidente; dois ao mesmo tempo abrem um só', async () => {
      const { tenantId, who } = await customer('repetido');
      const { caseId } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, caseId, 60);
      const body = promote({ caseIds: [caseId] }, 60);
      const answers = await Promise.all([1, 2, 3].map(() => post(app, who, '/v1/triage-operations', body)));
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 200, 201]);
      expect(new Set(answers.map((answer) => (answer.body as { incidentId: string }).incidentId)).size).toBe(
        1,
      );
      expect(await prisma.incident.count({ where: { tenantId } })).toBe(1);
      expect(await notices(tenantId)).toHaveLength(1);
    });
  });

  describe('anexar', () => {
    it('entra no incidente aberto; a severidade que sobe avisa uma vez, com os lotes que forem', async () => {
      const { tenantId, who } = await customer('anexar');
      const base = await caseWith(prisma, tenantId, [{ severity: 'low' }]);
      const opened = await operate(app, who, promote({ caseIds: [base.caseId] }, 1));
      const { caseId } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, caseId, 600);
      await prisma.finding.updateMany({
        where: {
          id: {
            in: (await prisma.finding.findMany({ where: { caseId }, take: 5, select: { id: true } })).map(
              (row) => row.id,
            ),
          },
        },
        data: { severity: 'critical' },
      });
      const made = await operate(
        app,
        who,
        attach(opened.incidentId as string, { caseIds: [caseId] }, 600, { includeCritical: true }),
        202,
      );
      expect(made).toMatchObject({ action: 'attach', incidentId: opened.incidentId, changed: 0 });
      await drain(prisma, [tenantId], { batch: 100 });
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', changed: 600 });
      expect(await incident(who, opened.incidentId)).toMatchObject({
        severity: 'critical',
        findingCount: 601,
      });
      expect((await notices(tenantId)).map((row) => [row.kind, row.severity])).toEqual([
        ['incident_opened', 'low'],
        ['incident_escalated', 'critical'],
      ]);
      await expectSummary(tenantId, opened.incidentId);
      // Anexar não faz do caso um promovido.
      expect((await caseRow(prisma, caseId)).incidentId).toBeNull();
      await expectExactCounters(prisma, [tenantId]);
    });

    it('sem subir a severidade, não avisa', async () => {
      const { tenantId, who } = await customer('sem subir');
      const base = await caseWith(prisma, tenantId, [{ severity: 'high' }]);
      const opened = await operate(app, who, promote({ caseIds: [base.caseId] }, 1));
      const other = await caseWith(prisma, tenantId, [{ severity: 'high' }, { severity: 'low' }]);
      await operate(app, who, attach(opened.incidentId as string, { caseIds: [other.caseId] }, 2));
      expect(await notices(tenantId)).toHaveLength(1);
    });

    it('incidente resolvido recusa; resolvido no meio, a operação para parcial e continua quando ele reabre', async () => {
      const { tenantId, who } = await customer('resolvido');
      const { caseId } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, caseId, 250);
      const base = await caseWith(prisma, tenantId, [{}]);
      const opened = await operate(app, who, promote({ caseIds: [base.caseId] }, 1));
      const incidentId = opened.incidentId as string;
      const resolve = (status: string) =>
        patch(app, who, `/v1/incidents/${incidentId}`, { status }).expect(200);
      await resolve('resolved');
      const refused = await post(
        app,
        who,
        '/v1/triage-operations',
        attach(incidentId, { caseIds: [caseId] }, 250),
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'INCIDENT_RESOLVED' });
      await resolve('open');
      const made = await operate(app, who, attach(incidentId, { caseIds: [caseId] }, 250), 202);
      await triageJob(prisma, [tenantId], { batch: 100, workMs: 0 }).runOnce();
      await resolve('resolved');
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, made.id)).toMatchObject({
        state: 'partial',
        stop: 'incident_resolved',
        changed: 100,
        remaining: 150,
        can: { continue: true, undo: true },
      });
      expect(await attached(incidentId)).toBe(101);
      const blocked = await post(app, who, `/v1/triage-operations/${made.id}/continue`);
      expect(blocked.body).toMatchObject({ code: 'INCIDENT_RESOLVED' });
      await resolve('investigating');
      await post(app, who, `/v1/triage-operations/${made.id}/continue`).expect(202);
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', changed: 250, stop: null });
      expect((await incident(who, incidentId)).findingCount).toBe(251);
    });

    it('o incidente que sumiu no meio para a operação', async () => {
      const { tenantId, who } = await customer('sumiu');
      limits.syncAlerts = 1;
      const incidentId = await insertIncident(prisma, tenantId);
      const { caseId } = await caseWith(prisma, tenantId, [{}, {}]);
      const made = await operate(app, who, attach(incidentId, { caseIds: [caseId] }, 2), 202);
      await prisma.incident.delete({ where: { id: incidentId } });
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'failed', stop: 'incident_gone' });
      await post(app, who, `/v1/triage-operations/${made.id}/continue`).expect(404);
    });

    it('anexar e tirar à mão no meio dos lotes: o resumo fecha', async () => {
      const { tenantId, who } = await customer('à mão');
      limits.syncAlerts = 1;
      const { caseId } = await caseWith(prisma, tenantId, []);
      const ids = await manyFindings(prisma, tenantId, caseId, 60);
      const loose = await insertFinding(prisma, tenantId, { createdAt: earlier(), severity: 'critical' });
      const base = await caseWith(prisma, tenantId, [{}]);
      const opened = await operate(app, who, promote({ findingIds: base.ids }, 1));
      const incidentId = opened.incidentId as string;
      const made = await operate(app, who, attach(incidentId, { caseIds: [caseId] }, 60), 202);
      const job = triageJob(prisma, [tenantId], { batch: 20, workMs: 0 });
      await job.runOnce();
      await post(app, who, `/v1/incidents/${incidentId}/findings`, { findingIds: [loose] }).expect(200);
      const taken = await prisma.finding.findFirstOrThrow({ where: { id: { in: ids }, incidentId } });
      const { default: request } = await import('supertest');
      await request(app.getHttpServer())
        .delete(`/v1/incidents/${incidentId}/findings/${taken.id}`)
        .set('Cookie', who.cookie)
        .set('Origin', 'http://localhost:5173')
        .set('X-CSRF-Token', who.csrfToken)
        .expect(200);
      await expectSummary(tenantId, incidentId);
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', changed: 60 });
      await expectSummary(tenantId, incidentId);
      // O desfazer não mexe no que foi tirado à mão nem no que foi posto à mão.
      const undone = await undo(app, who, made.id, 202);
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, undone.id)).toMatchObject({ state: 'done', changed: 59, skipped: 1 });
      expect(
        (await prisma.finding.findMany({ where: { incidentId }, select: { id: true } }))
          .map((row) => row.id)
          .sort(),
      ).toEqual([...base.ids, loose].sort());
      await expectSummary(tenantId, incidentId);
      await expectExactCounters(prisma, [tenantId]);
    });
  });

  describe('desfazer', () => {
    it.each([3, 260])(
      'promover %i alertas: saem todos menos a âncora, o incidente é encerrado e o aviso não volta',
      async (count) => {
        const { tenantId, who } = await customer(`desfazer ${count}`);
        const { caseId } = await caseWith(prisma, tenantId, []);
        const ids = await manyFindings(prisma, tenantId, caseId, count);
        await prisma.alertCase.update({ where: { id: caseId }, data: { anchorFindingId: ids[1] as string } });
        const sync = count <= 200;
        const made = await operate(app, who, promote({ caseIds: [caseId] }, count), sync ? 201 : 202);
        await drain(prisma, [tenantId]);
        const before = await notices(tenantId);
        const undone = await undo(app, who, made.id, sync ? 201 : 202, { reason: 'Era manutenção' });
        await drain(prisma, [tenantId], { batch: 90 });
        const after = await operation(app, who, undone.id);
        expect(after).toMatchObject({
          state: 'done',
          changed: count - 1,
          skipped: 1,
          incidentId: made.incidentId,
          warnings: ['notice_not_recalled', 'anchor_kept'],
        });
        expect(await operation(app, who, made.id)).toMatchObject({ state: 'undone' });
        expect(await incident(who, made.incidentId)).toMatchObject({ status: 'resolved', findingCount: 1 });
        const row = await prisma.incident.findUniqueOrThrow({ where: { id: made.incidentId as string } });
        expect(row.resolvedAt).not.toBeNull();
        const rows = await findingsById(prisma, ids);
        expect(ids.filter((id) => rows.get(id)?.incidentId !== null)).toEqual([ids[1]]);
        expect([...rows.values()].every((finding) => finding.status === 'new')).toBe(true);
        expect(await caseRow(prisma, caseId)).toMatchObject({
          incidentId: null,
          incidentCount: 1,
          newCount: count - 1,
          pending: true,
        });
        // O e-mail que saiu (ou vai sair) não é chamado de volta, e nenhum outro nasce.
        expect(await notices(tenantId)).toEqual(before);
        const [closed] = await trail(prisma, tenantId, 'incident.update');
        expect(closed).toMatchObject({
          actorType: 'system',
          resourceId: made.incidentId,
          after: {
            status: 'resolved',
            cause: 'triage_undo',
            operationId: undone.id,
            requestedBy: who.userId,
            reason: 'Era manutenção',
          },
        });
        const finishes = await trail(prisma, tenantId, 'triage.bulk.finish');
        expect(finishes.at(-1)?.after).toMatchObject({
          action: 'undo',
          undoneAction: 'promote',
          incidentResolved: true,
        });
        await expectSummary(tenantId, made.incidentId);
        await expectExactCounters(prisma, [tenantId]);
      },
    );

    it('promover com outro alerta posto depois: o incidente fica aberto, só com o que sobra', async () => {
      const { tenantId, who } = await customer('posto depois');
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}, {}]);
      const made = await operate(app, who, promote({ caseIds: [caseId] }, 3));
      const extra = await insertFinding(prisma, tenantId, { createdAt: earlier() });
      await post(app, who, `/v1/incidents/${made.incidentId}/findings`, { findingIds: [extra] }).expect(200);
      const undone = await undo(app, who, made.id);
      expect(undone).toMatchObject({ changed: 2, skipped: 1 });
      expect(await incident(who, made.incidentId)).toMatchObject({ status: 'open', findingCount: 2 });
      const kept = await prisma.finding.findMany({
        where: { incidentId: made.incidentId },
        select: { id: true },
      });
      expect(kept.map((row) => row.id)).toEqual(expect.arrayContaining([extra]));
      expect(ids.filter((id) => kept.some((row) => row.id === id))).toHaveLength(1);
      const [finish] = (await trail(prisma, tenantId, 'triage.bulk.finish')).slice(-1);
      expect(finish?.after).toMatchObject({ incidentResolved: false });
      expect(await trail(prisma, tenantId, 'incident.update')).toEqual([]);
    });

    it('com o incidente resolvido, recusa; reaberto, desfaz', async () => {
      const { tenantId, who } = await customer('já resolvido');
      const { caseId } = await caseWith(prisma, tenantId, [{}, {}]);
      const made = await operate(app, who, promote({ caseIds: [caseId] }, 2));
      await patch(app, who, `/v1/incidents/${made.incidentId}`, { status: 'resolved' }).expect(200);
      const refused = await post(app, who, `/v1/triage-operations/${made.id}/undo`, {
        requestId: randomUUID(),
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'INCIDENT_RESOLVED' });
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'done' });
      await patch(app, who, `/v1/incidents/${made.incidentId}`, { status: 'open' }).expect(200);
      expect(await undo(app, who, made.id)).toMatchObject({ changed: 1 });
    });

    it('o incidente resolvido no meio do desfazer para os lotes; reaberto, continua', async () => {
      const { tenantId, who } = await customer('resolvido no meio');
      limits.syncAlerts = 1;
      const { caseId } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, caseId, 30);
      const made = await operate(app, who, promote({ caseIds: [caseId] }, 30), 202);
      await drain(prisma, [tenantId]);
      const undone = await undo(app, who, made.id, 202);
      await triageJob(prisma, [tenantId], { batch: 10, workMs: 0 }).runOnce();
      await patch(app, who, `/v1/incidents/${made.incidentId}`, { status: 'resolved' }).expect(200);
      await drain(prisma, [tenantId]);
      const stopped = await operation(app, who, undone.id);
      expect(stopped).toMatchObject({ state: 'partial', stop: 'incident_resolved' });
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'undoing' });
      await patch(app, who, `/v1/incidents/${made.incidentId}`, { status: 'open' }).expect(200);
      await post(app, who, `/v1/triage-operations/${undone.id}/continue`).expect(202);
      await drain(prisma, [tenantId], { batch: 10 });
      expect(await operation(app, who, undone.id)).toMatchObject({ state: 'done', changed: 29, skipped: 1 });
      expect(await attached(made.incidentId)).toBe(1);
      expect((await incident(who, made.incidentId)).status).toBe('resolved');
    });

    it('anexar: sai só o que a operação anexou, o resumo volta, e o incidente nunca fica sem alerta', async () => {
      const { tenantId, who } = await customer('desfazer anexar');
      const base = await caseWith(prisma, tenantId, [{ severity: 'low' }]);
      const opened = await operate(app, who, promote({ caseIds: [base.caseId] }, 1));
      const incidentId = opened.incidentId as string;
      const before = await prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
      const { caseId } = await caseWith(prisma, tenantId, [{ severity: 'high' }, { severity: 'medium' }]);
      const made = await operate(app, who, attach(incidentId, { caseIds: [caseId] }, 2));
      const undone = await undo(app, who, made.id);
      expect(undone).toMatchObject({ changed: 2, skipped: 0, warnings: [] });
      const restored = await prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
      expect({ ...restored, updatedAt: null }).toEqual({ ...before, updatedAt: null });
      expect((await incident(who, incidentId)).status).toBe('open');
      // De novo, e o alerta da base sai à mão: um dos anexados fica.
      const again = await operate(app, who, attach(incidentId, { caseIds: [caseId] }, 2));
      const { default: request } = await import('supertest');
      await request(app.getHttpServer())
        .delete(`/v1/incidents/${incidentId}/findings/${base.ids[0]}`)
        .set('Cookie', who.cookie)
        .set('Origin', 'http://localhost:5173')
        .set('X-CSRF-Token', who.csrfToken)
        .expect(200);
      expect(await undo(app, who, again.id)).toMatchObject({ changed: 1, skipped: 1 });
      expect(await attached(incidentId)).toBe(1);
      await expectSummary(tenantId, incidentId);
      await expectExactCounters(prisma, [tenantId]);
    });

    it('anexar num incidente grande: a contagem acompanha cada lote do desfazer, e o resumo se refaz no fim ou ao cancelar', async () => {
      const { tenantId, who } = await customer('desfazer grande');
      limits.syncAlerts = 1;
      const base = await caseWith(prisma, tenantId, [{ severity: 'low' }]);
      const incidentId = (await operate(app, who, promote({ findingIds: base.ids }, 1))).incidentId as string;
      const { caseId: bulkCase } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, bulkCase, 560, { severity: 'low', resource: 's3:base' });
      await operate(app, who, attach(incidentId, { caseIds: [bulkCase] }, 560), 202);
      await drain(prisma, [tenantId]);
      const before = await prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
      const { caseId } = await caseWith(prisma, tenantId, []);
      await distinctResources(
        await manyFindings(prisma, tenantId, caseId, 30, { severity: 'high' }),
        's3:engano',
      );
      const made = await operate(app, who, attach(incidentId, { caseIds: [caseId] }, 30), 202);
      await drain(prisma, [tenantId]);
      expect(await incident(who, incidentId)).toMatchObject({ severity: 'high', findingCount: 591 });
      await expectSummary(tenantId, incidentId);

      const first = await undo(app, who, made.id, 202);
      await triageJob(prisma, [tenantId], { batch: 10, workMs: 0 }).runOnce();
      expect(await attached(incidentId)).toBe(581);
      expect((await incident(who, incidentId)).findingCount).toBe(581);
      await post(app, who, `/v1/triage-operations/${first.id}/cancel`).expect(200);
      await expectSummary(tenantId, incidentId);

      await undo(app, who, made.id, 202);
      await drain(prisma, [tenantId], { batch: 8 });
      const after = await prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
      expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    });

    it('num incidente pequeno, o resumo acompanha cada lote do desfazer', async () => {
      const { tenantId, who } = await customer('desfazer pequeno');
      limits.syncAlerts = 1;
      const { caseId } = await caseWith(prisma, tenantId, []);
      await distinctResources(await manyFindings(prisma, tenantId, caseId, 30), 's3:balde');
      await operate(app, who, promote({ caseIds: [caseId] }, 30), 202);
      await drain(prisma, [tenantId]);
      const made = await prisma.triageOperation.findFirstOrThrow({ where: { tenantId } });
      await undo(app, who, made.id, 202);
      for (let round = 0; round < 2; round += 1) {
        await triageJob(prisma, [tenantId], { batch: 10, workMs: 0 }).runOnce();
        await expectSummary(tenantId, made.incidentId);
      }
    });

    it('o alerta triado à mão dentro do incidente fica nele', async () => {
      const { tenantId, who } = await customer('triado dentro');
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}, {}]);
      const made = await operate(app, who, promote({ caseIds: [caseId] }, 3));
      const { target } = await prisma.triageOperation.findUniqueOrThrow({ where: { id: made.id } });
      const { anchorId } = (target as { run: { anchorId: string } }).run;
      const touched = ids.find((id) => id !== anchorId) as string;
      await patch(app, who, `/v1/findings/${touched}/status`, { status: 'investigating' }).expect(200);
      expect(await undo(app, who, made.id)).toMatchObject({ changed: 1, skipped: 2 });
      expect((await findingsById(prisma, [touched])).get(touched)).toMatchObject({
        incidentId: made.incidentId,
        status: 'investigating',
      });
      expect((await incident(who, made.incidentId)).status).toBe('open');
    });
  });

  describe('o resumo no banco é o mesmo que em memória', () => {
    /** Um gerador fixo (mulberry32). */
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
    /** Textos que quem ataca escreve: maiúsculas, acentos, além do plano básico, área privada, vazio e "admin". */
    const TEXTS = [
      null,
      '',
      'maria',
      'Maria',
      'MARIA',
      'joão',
      'joao',
      'Zé',
      '\u{1F600}',
      '\u{10FFFF}',
      '',
      '�',
      'z',
      'á',
      'administrador',
      'xadmin',
      'x-admin',
      'ADMIN',
      '9Admin',
      'éadmin',
      'KKadmin',
      'ıadmin',
      'ſadmin',
      'arn:aws:iam::111111111111:root',
      'root',
      ':root',
      'raiz:roots',
      'a\nadmin',
      'linha\n:root',
      'a\'b"c\\d',
      '%_',
    ];
    const pick = <T>(next: () => number, values: readonly T[]): T =>
      values[Math.floor(next() * values.length)] as T;

    it.each([1, 2, 3, 4, 5, 6, 7, 8])('mistura %i', async (seed) => {
      const { tenantId } = await customer(`paridade ${seed}`);
      const next = random(seed);
      const count = [1, 2, 5, 6, 7, 40, 300, 700][seed - 1] as number;
      const incidentId = await insertIncident(prisma, tenantId);
      // Outro incidente e outro cliente, que não podem entrar na conta.
      const noise = await insertIncident(prisma, tenantId);
      const severities: FindingSeverity[] =
        seed % 3 === 0 ? ['low', 'medium'] : seed % 3 === 1 ? ['low'] : ['critical', 'high', 'medium', 'low'];
      const data: Prisma.FindingCreateManyInput[] = Array.from({ length: count + 20 }, (_, index) => ({
        ...findingData(tenantId),
        sourceEventId: `paridade-${randomUUID()}`,
        occurredAt: new Date(Date.UTC(2026, 10, 1) + Math.floor(next() * 1e10)),
        severity: pick(next, severities),
        actorUser: pick(next, count > 100 && seed % 2 === 0 ? [...TEXTS, `u${index}`] : TEXTS),
        actorType: pick(next, [null, 'IAMUser', 'AssumedRole', seed > 6 ? 'Root' : 'root']),
        accessKeyId: pick(next, [null, 'CHAVE1', 'CHAVE2', `CHAVE${index % 90}`]),
        sourceIp: pick(next, [null, '203.0.113.7', '2001:db8::1', `198.51.100.${index % 250}`]),
        resource: pick(next, [...TEXTS, `ec2:i-${index}`, `s3:balde-${index % 60}`]),
        accountId: String(111111111111 + (index % (seed * 9))),
        mitreTactics: Array.from(
          { length: Math.floor(next() * 3) },
          () => `Tática ${Math.floor(next() * 30)}`,
        ),
        mitreTechniques: Array.from(
          { length: Math.floor(next() * 3) },
          () => `T${1000 + Math.floor(next() * 80)}`,
        ),
        incidentId: index < count ? incidentId : noise,
      }));
      await prisma.finding.createMany({ data });
      const rows = await prisma.finding.findMany({ where: { incidentId }, select: incidentFindingSelect });
      expect(rows).toHaveLength(count);
      for (const items of [[], ['maria'], ['s3:balde-1', 'CHAVE2'], ['a\'b"c\\d'], ['203.0.113.7'], ['']]) {
        const set = new Set(items);
        expect(
          await aggregateIncidentSummary(prisma, tenantId, incidentId, set),
          JSON.stringify(items),
        ).toEqual(incidentSummaryData(rows, set));
      }
      // E juntado aos pedaços, de qualquer tamanho e em qualquer ordem, dá o mesmo que de uma vez.
      for (const items of [[], ['maria', 's3:balde-1']]) {
        const set = new Set(items);
        let merged: IncidentSummaryData | null = null;
        for (let start = 0; start < rows.length;) {
          const size = 1 + Math.floor(next() * Math.min(120, rows.length));
          const part: IncidentSummaryData = incidentSummaryData(rows.slice(start, start + size), set);
          merged = merged === null ? part : mergeIncidentSummary(merged, part);
          expect(merged).not.toBeNull();
          start += size;
        }
        expect(merged).toEqual(incidentSummaryData(rows, set));
      }
      // E pelo caminho de gravar, dos dois lados do limite.
      const both = await prisma.$transaction(async (tx) => [
        await resummarizeIncident(tx, tenantId, incidentId, 0),
        await resummarizeIncident(tx, tenantId, incidentId, 10_000),
      ]);
      expect(both[0]).toEqual(both[1]);
    });

    it('a identidade privilegiada é reconhecida igual, texto por texto', { timeout: 60_000 }, async () => {
      const { tenantId } = await customer('paridade identidade');
      const flags: boolean[] = [];
      for (const actorUser of TEXTS) {
        const incidentId = await insertIncident(prisma, tenantId);
        await insertFinding(prisma, tenantId, { incidentId, actorUser, severity: 'low' });
        const rows = await prisma.finding.findMany({ where: { incidentId }, select: incidentFindingSelect });
        const inMemory = incidentSummaryData(rows, new Set());
        expect(
          await aggregateIncidentSummary(prisma, tenantId, incidentId, new Set()),
          String(actorUser),
        ).toEqual(inMemory);
        flags.push(inMemory.riskScore === 20);
      }
      // As duas respostas aparecem no conjunto.
      expect(new Set(flags).size).toBe(2);
    });

    it('anexar aos lotes grava o mesmo resumo que refazer tudo, e a nota de outra conta é refeita', async () => {
      const { tenantId } = await customer('paridade anexar');
      const incidentId = await insertIncident(prisma, tenantId);
      const noise = await insertIncident(prisma, tenantId);
      const batches: string[][] = [];
      for (const [index, severity] of (['medium', 'low', 'high', 'low'] as const).entries()) {
        const ids: string[] = [];
        for (let each = 0; each < 4; each += 1) {
          ids.push(
            await insertFinding(prisma, tenantId, {
              severity,
              actorUser: index === 1 ? 'administrador' : `pessoa-${index}-${each}`,
              resource: `s3:balde-${index}`,
            }),
          );
        }
        batches.push(ids);
      }
      const add = async (ids: string[], max: number) => {
        await prisma.finding.updateMany({ where: { id: { in: ids } }, data: { incidentId } });
        return prisma.$transaction((tx) => addToIncidentSummary(tx, tenantId, incidentId, ids, max));
      };
      const stored = async () => prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
      for (const [index, ids] of batches.entries()) {
        const data = await add(ids, 3);
        const rows = await prisma.finding.findMany({ where: { incidentId }, select: incidentFindingSelect });
        // O incidente nasceu vazio, com uma nota de teste: a primeira vez refaz, as outras juntam.
        expect(data, String(index)).toEqual(incidentSummaryData(rows, new Set()));
        expect(await stored()).toMatchObject(data);
        if (index === 2) {
          // A nota mudada à mão (ou por outra versão) não é desta conta: o lote seguinte refaz.
          await prisma.incident.update({ where: { id: incidentId }, data: { riskScore: 97 } });
        }
      }
      expect((await prisma.incident.findUniqueOrThrow({ where: { id: noise } })).findingCount).toBe(0);
    });

    it('incidente sem alerta não tem resumo, e o de outro cliente também não', async () => {
      const { tenantId } = await customer('paridade vazia');
      const { tenantId: other } = await customer('paridade outro');
      const incidentId = await insertIncident(prisma, tenantId);
      expect(await aggregateIncidentSummary(prisma, tenantId, incidentId, new Set())).toBeNull();
      await insertFinding(prisma, tenantId, { incidentId });
      expect(await aggregateIncidentSummary(prisma, other, incidentId, new Set())).toBeNull();
      expect(await aggregateIncidentSummary(prisma, tenantId, incidentId, new Set())).toMatchObject({
        findingCount: 1,
      });
    });
  });
});
