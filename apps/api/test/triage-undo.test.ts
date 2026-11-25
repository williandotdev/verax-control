import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TRIAGE_UNDO_HOURS } from '@verax/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIAGE_LIMITS,
  TRIAGE_LIMITS,
  type TriageLimits,
} from '../src/cases/triage-operations.service.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createTenant } from './support/auth-helpers.js';
import {
  assignAll,
  casesOf,
  cleanCases,
  expectExactCounters,
  expectSettled,
  findingData,
  HOUR_MS,
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
  operatorFor,
  patch,
  post,
  read,
  statusRequest,
  trail,
  triageJob,
  undo,
} from './support/triage.js';

/** Desfazer a triagem em massa: cada estado, o que mudou no meio, o prazo, o caso selado e o undo_all_of. */
describe('desfazer a triagem em massa', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];
  const limits: TriageLimits = { ...DEFAULT_TRIAGE_LIMITS };

  async function customer(name: string) {
    const tenantId = await createTenant(app, `Cliente Demo (desfazer: ${name})`);
    tenants.push(tenantId);
    return { tenantId, who: await operatorFor(app, tenantId, 'admin_cliente') };
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

  it('devolve o status e a data da triagem de cada alerta, e o histórico mostra as duas operações', async () => {
    const { tenantId, who } = await customer('devolve');
    const triaged = earlier(HOUR_MS);
    const { caseId, ids } = await caseWith(prisma, tenantId, [
      { updatedAt: earlier(HOUR_MS) },
      { status: 'investigating', triagedAt: triaged },
      { status: 'investigating', triagedAt: null },
      { triagedAt: triaged },
    ]);
    const before = await findingsById(prisma, ids);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 4));
    const startedAt = new Date();
    const undone = await undo(app, who, made.id, 201, { reason: 'Engano' });
    expect(undone).toMatchObject({
      action: 'undo',
      state: 'done',
      status: null,
      undoOfId: made.id,
      matched: 4,
      changed: 4,
      skipped: 0,
      expectedCount: 4,
      reason: 'Engano',
      target: { kind: 'operation', operationId: made.id },
      undoUntil: null,
      warnings: [],
      can: { cancel: false, continue: false, undo: false },
    });
    expect(await operation(app, who, made.id)).toMatchObject({
      state: 'undone',
      undoId: undone.id,
      can: { undo: false },
    });
    const after = await findingsById(prisma, ids);
    for (const id of ids) {
      const [was, is] = [before.get(id), after.get(id)];
      expect(is).toMatchObject({
        status: was?.status,
        triagedAt: was?.triagedAt,
        incidentId: null,
        triageOpId: undone.id,
        caseId,
      });
      // Desfazer também é atividade de uma pessoa.
      expect(is?.updatedAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    }
    const history = (await read(app, who, `/v1/findings/${ids[0]}/triage`).expect(200)).body as {
      operation: { operation: { id: string }; previousStatus: string };
      operations: { operation: { id: string }; previousStatus: string }[];
    };
    expect(history.operation.operation.id).toBe(undone.id);
    expect(history.operations.map((row) => [row.operation.id, row.previousStatus])).toEqual([
      [undone.id, 'resolved'],
      [made.id, 'new'],
    ]);
    const detail = (await read(app, who, `/v1/cases/${caseId}`).expect(200)).body as {
      operations: { id: string; state: string }[];
    };
    expect(detail.operations.map((row) => [row.id, row.state])).toEqual([
      [undone.id, 'done'],
      [made.id, 'undone'],
    ]);
    expect((await caseRow(prisma, caseId)).pending).toBe(true);
    const records = await trail(prisma, tenantId, 'triage.bulk.undo', 'triage.bulk.finish');
    expect(records.map((row) => [row.action, row.actorType, row.resourceId])).toEqual([
      ['triage.bulk.finish', 'system', made.id],
      ['triage.bulk.finish', 'system', undone.id],
      ['triage.bulk.undo', 'user', made.id],
    ]);
    expect(records[1]?.after).toMatchObject({
      action: 'undo',
      undoOf: made.id,
      undoneAction: 'status',
      changed: 4,
    });
    expect(records[2]).toMatchObject({
      before: { state: 'done', changed: 4 },
      after: { undoId: undone.id, matched: 4, removed: 0, reason: 'Engano', sync: true },
    });
    await expectExactCounters(prisma, [tenantId]);
  });

  it('só volta o que ainda está como a operação deixou; o resto é contado, e não é tocado', async () => {
    const { tenantId, who } = await customer('mudou no meio');
    const { caseId, ids } = await caseWith(
      prisma,
      tenantId,
      Array.from({ length: 9 }, () => ({})),
    );
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 9));
    const [byHand, sameByHand, inIncident, otherOp, severity, moved, plain, gone, byOldVersion] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await patch(app, who, `/v1/findings/${byHand}/status`, { status: 'legitimate' }).expect(200);
    // Mudado à mão para o mesmo status: a decisão é da pessoa, e o desfazer não a desfaz.
    await patch(app, who, `/v1/findings/${sameByHand}/status`, { status: 'resolved' }).expect(200);
    // A versão anterior do nó muda o status sem conhecer a operação (a volta de versão).
    await prisma.finding.update({ where: { id: byOldVersion }, data: { status: 'legitimate' } });
    const incidentId = await insertIncident(prisma, tenantId);
    await prisma.finding.update({ where: { id: inIncident }, data: { incidentId } });
    await patch(app, who, `/v1/findings/${otherOp}/status`, { status: 'new' }).expect(200);
    const second = await operate(app, who, statusRequest({ findingIds: [otherOp] }, 1));
    // O que não é decisão de ninguém (a severidade que a origem mudou, outro caso) não impede.
    await prisma.finding.update({ where: { id: severity }, data: { severity: 'critical' } });
    await post(app, who, `/v1/cases/${caseId}/split`, { findingIds: [moved] }).expect(201);
    await prisma.finding.delete({ where: { id: gone } });

    const frozen = await findingsById(prisma, [byHand, sameByHand, inIncident, otherOp, byOldVersion]);
    const undone = await undo(app, who, made.id);
    expect(undone).toMatchObject({ matched: 8, changed: 3, skipped: 5, expectedCount: 9, state: 'done' });
    const after = await findingsById(prisma, ids);
    for (const [id, row] of frozen) expect(after.get(id)).toEqual(row);
    expect([severity, moved, plain].map((id) => after.get(id)?.status)).toEqual(['new', 'new', 'new']);
    // E a outra operação continua podendo ser desfeita.
    expect(await undo(app, who, second.id)).toMatchObject({ changed: 1, skipped: 0 });
    expect((await findingsById(prisma, [otherOp])).get(otherOp)?.status).toBe('new');
    const [asked] = await trail(prisma, tenantId, 'triage.bulk.undo');
    expect(asked).toMatchObject({ after: { matched: 8, removed: 1 } });
    await expectExactCounters(prisma, [tenantId]);
  });

  it('depois que a retenção levou tudo, o desfazer termina sem mudar nada', async () => {
    const { tenantId, who } = await customer('retenção');
    const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 2));
    await prisma.finding.deleteMany({ where: { id: { in: ids } } });
    expect(await prisma.triageOperationItem.count({ where: { operationId: made.id } })).toBe(0);
    expect(await undo(app, who, made.id)).toMatchObject({
      state: 'done',
      matched: 0,
      changed: 0,
      skipped: 0,
    });
    expect(await operation(app, who, made.id)).toMatchObject({ state: 'undone' });
  });

  it(`até ${TRIAGE_UNDO_HOURS} h depois do fim, e não mais`, async () => {
    const { tenantId, who } = await customer('prazo');
    const { caseId, ids } = await caseWith(prisma, tenantId, [{}]);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 1));
    const until = Date.parse(made.undoUntil as string);
    expect(until - Date.parse(made.createdAt)).toBe(24 * HOUR_MS);
    limits.now = () => new Date(until);
    expect((await operation(app, who, made.id)).can.undo).toBe(false);
    const late = await post(app, who, `/v1/triage-operations/${made.id}/undo`, { requestId: randomUUID() });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'TRIAGE_UNDO_EXPIRED' });
    expect((await findingsById(prisma, ids)).get(ids[0] as string)?.status).toBe('resolved');
    limits.now = () => new Date(until - 1);
    expect((await operation(app, who, made.id)).can.undo).toBe(true);
    await undo(app, who, made.id);
  });

  it('o prazo conta do fim, não do pedido', async () => {
    const { tenantId, who } = await customer('prazo do fim');
    limits.syncAlerts = 1;
    const { caseId } = await caseWith(prisma, tenantId, [{}, {}]);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 2), 202);
    const finishedAt = new Date(Date.now() + 5 * HOUR_MS);
    await drain(prisma, [tenantId], { now: () => finishedAt });
    const { undoUntil } = await operation(app, who, made.id);
    expect(Date.parse(undoUntil as string)).toBe(finishedAt.getTime() + 24 * HOUR_MS);
  });

  it('desfazer de novo: o mesmo requestId devolve o mesmo desfazer; outro é recusado; e o desfazer não se desfaz', async () => {
    const { tenantId, who } = await customer('de novo');
    const { caseId } = await caseWith(prisma, tenantId, [{}]);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 1));
    const requestId = randomUUID();
    const first = await undo(app, who, made.id, 201, { requestId });
    expect((await undo(app, who, made.id, 200, { requestId })).id).toBe(first.id);
    for (const id of [made.id, first.id]) {
      const again = await post(app, who, `/v1/triage-operations/${id}/undo`, { requestId: randomUUID() });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'TRIAGE_NOT_UNDOABLE' });
    }
    expect(await prisma.triageOperation.count({ where: { tenantId, action: 'undo' } })).toBe(1);
    // Para refazer, um pedido novo.
    expect(await operate(app, who, statusRequest({ caseIds: [caseId] }, 1))).toMatchObject({ changed: 1 });
  });

  it('o mesmo desfazer enviado duas vezes ao mesmo tempo roda uma vez', async () => {
    const { tenantId, who } = await customer('desfazer duplo');
    const { caseId } = await caseWith(prisma, tenantId, []);
    await manyFindings(prisma, tenantId, caseId, 100);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 100));
    const requestId = randomUUID();
    const answers = await Promise.all(
      [requestId, requestId, randomUUID()].map((id) =>
        post(app, who, `/v1/triage-operations/${made.id}/undo`, { requestId: id }),
      ),
    );
    const undos = await prisma.triageOperation.findMany({ where: { tenantId, action: 'undo' } });
    expect(undos).toHaveLength(1);
    expect(answers.map((answer) => answer.status).sort()).toEqual(
      undos[0]?.requestId === requestId ? [200, 201, 409] : [201, 409, 409],
    );
    expect(await prisma.triageOperationItem.count({ where: { operationId: undos[0]?.id as string } })).toBe(
      100,
    );
    expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(100);
    await expectExactCounters(prisma, [tenantId]);
  });

  it('em curso, cancela antes; cancelada, desfaz o que tinha feito', async () => {
    const { tenantId, who } = await customer('cancelada');
    limits.syncAlerts = 1;
    const { caseId } = await caseWith(prisma, tenantId, []);
    await manyFindings(prisma, tenantId, caseId, 30);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 30), 202);
    const early = await post(app, who, `/v1/triage-operations/${made.id}/undo`, { requestId: randomUUID() });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: 'TRIAGE_STILL_ACTIVE' });
    // Um lote de dez, e o worker para.
    await triageJob(prisma, [tenantId], { batch: 10, workMs: 0 }).runOnce();
    const running = await operation(app, who, made.id);
    expect(running).toMatchObject({ state: 'running', changed: 10, remaining: 20 });
    const canceled = await post(app, who, `/v1/triage-operations/${made.id}/cancel`).expect(200);
    expect(canceled.body).toMatchObject({
      state: 'canceled',
      changed: 10,
      remaining: 20,
      can: { cancel: false, continue: false, undo: true },
    });
    expect((await post(app, who, `/v1/triage-operations/${made.id}/cancel`)).body).toMatchObject({
      code: 'TRIAGE_NOT_ACTIVE',
    });
    // A fila não roda mais nada dela.
    expect(await drain(prisma, [tenantId])).toMatchObject({ batches: 0, changed: 0 });
    expect(await prisma.finding.count({ where: { tenantId, status: 'resolved' } })).toBe(10);
    const [record] = await trail(prisma, tenantId, 'triage.bulk.cancel');
    expect(record).toMatchObject({
      actorId: who.userId,
      resourceId: made.id,
      before: { state: 'running' },
      after: { state: 'canceled', matched: 30, changed: 10, skipped: 0 },
    });
    const undone = await undo(app, who, made.id, 202);
    expect(undone).toMatchObject({ state: 'queued', matched: 10 });
    expect(await operation(app, who, made.id)).toMatchObject({ state: 'undoing' });
    await drain(prisma, [tenantId], { batch: 3 });
    expect(await operation(app, who, undone.id)).toMatchObject({ state: 'done', changed: 10, skipped: 0 });
    expect(await operation(app, who, made.id)).toMatchObject({ state: 'undone' });
    expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(30);
    await expectExactCounters(prisma, [tenantId]);
  });

  it('cancelada antes de começar, não há o que desfazer', async () => {
    const { tenantId, who } = await customer('cancelada na fila');
    limits.syncAlerts = 1;
    const { caseId } = await caseWith(prisma, tenantId, [{}, {}]);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 2), 202);
    await post(app, who, `/v1/triage-operations/${made.id}/cancel`).expect(200);
    const refused = await post(app, who, `/v1/triage-operations/${made.id}/undo`, {
      requestId: randomUUID(),
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'TRIAGE_NOT_UNDOABLE' });
    expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(2);
    const stored = await prisma.triageOperation.findUniqueOrThrow({ where: { id: made.id } });
    expect(Object.keys(stored.target as object).sort()).toEqual(['caseIds', 'run']);
  });

  it('o desfazer cancelado no meio: a operação volta ao estado dela, e desfazer de novo termina', async () => {
    const { tenantId, who } = await customer('desfazer cancelado');
    limits.syncAlerts = 1;
    const { caseId } = await caseWith(prisma, tenantId, []);
    await manyFindings(prisma, tenantId, caseId, 20);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 20), 202);
    await drain(prisma, [tenantId]);
    const first = await undo(app, who, made.id, 202);
    await triageJob(prisma, [tenantId], { batch: 8, workMs: 0 }).runOnce();
    await post(app, who, `/v1/triage-operations/${first.id}/cancel`).expect(200);
    expect(await operation(app, who, first.id)).toMatchObject({
      state: 'canceled',
      changed: 8,
      undoUntil: null,
    });
    expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', can: { undo: true } });
    const second = await undo(app, who, made.id, 202);
    await drain(prisma, [tenantId]);
    // Os oito já tinham voltado: contam como pulados.
    expect(await operation(app, who, second.id)).toMatchObject({ state: 'done', changed: 12, skipped: 8 });
    expect(await operation(app, who, made.id)).toMatchObject({ state: 'undone', undoId: second.id });
    expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(20);
    await expectExactCounters(prisma, [tenantId]);
  });

  it('duas operações em cima uma da outra: a segunda volta ao que a primeira deixou', async () => {
    const { tenantId, who } = await customer('empilhadas');
    const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
    const first = await operate(
      app,
      who,
      statusRequest({ caseIds: [caseId] }, 2, { status: 'investigating' }),
    );
    const second = await operate(app, who, statusRequest({ caseIds: [caseId] }, 2));
    // Desfazer a primeira com a segunda por cima não muda nada.
    expect(await undo(app, who, first.id)).toMatchObject({ changed: 0, skipped: 2 });
    expect([...(await findingsById(prisma, ids)).values()].map((row) => row.status)).toEqual([
      'resolved',
      'resolved',
    ]);
    expect(await undo(app, who, second.id)).toMatchObject({ changed: 2 });
    expect([...(await findingsById(prisma, ids)).values()].map((row) => row.status)).toEqual([
      'investigating',
      'investigating',
    ]);
  });

  describe('o caso selado', () => {
    it('com um sucessor aberto, os alertas voltam a ele como pendentes, e os seguintes são do sucessor', async () => {
      const { tenantId, who } = await customer('sucessor');
      const at = (minutes: number) => new Date(Date.now() - HOUR_MS + minutes * 60_000);
      const first = await insertFinding(prisma, tenantId, { createdAt: at(0) });
      await assignAll(prisma, [tenantId]);
      const [old] = await casesOf(prisma, tenantId);
      const made = await operate(app, who, statusRequest({ caseIds: [old?.id] }, 1));
      // O alerta seguinte sela o tratado e abre outro.
      await insertFinding(prisma, tenantId, { createdAt: at(1) });
      await assignAll(prisma, [tenantId]);
      const [sealed, successor] = await casesOf(prisma, tenantId);
      expect(sealed).toMatchObject({ id: old?.id, sealReason: 'treated', pending: false });
      expect(successor).toMatchObject({ previousCaseId: old?.id, recurrence: 1, pending: true });

      await undo(app, who, made.id);
      expect(await caseRow(prisma, old?.id as string)).toMatchObject({
        sealReason: 'treated',
        openKey: null,
        pending: true,
        newCount: 1,
      });
      expect((await findingsById(prisma, [first])).get(first)).toMatchObject({
        status: 'new',
        caseId: old?.id,
      });
      // O selado com pendência aparece na lista, e a atribuição segue no sucessor.
      const listed = (await read(app, who, '/v1/cases').expect(200)).body as { items: { id: string }[] };
      expect(listed.items.map((item) => item.id).sort()).toEqual([old?.id, successor?.id].sort());
      await insertFinding(prisma, tenantId, { createdAt: at(2) });
      await assignAll(prisma, [tenantId]);
      expect((await casesOf(prisma, tenantId)).map((row) => [row.id, row.total])).toEqual([
        [old?.id, 1],
        [successor?.id, 2],
      ]);
      await expectSettled(prisma, tenantId, 3);
      await expectNoDrift(prisma, [tenantId]);
    });

    it('sem sucessor aberto, ele reabre e volta a receber os alertas da chave', async () => {
      const { tenantId, who } = await customer('reabre');
      await insertFinding(prisma, tenantId, { createdAt: earlier(HOUR_MS) });
      await assignAll(prisma, [tenantId]);
      const [old] = await casesOf(prisma, tenantId);
      const made = await operate(app, who, statusRequest({ caseIds: [old?.id] }, 1));
      const second = await insertFinding(prisma, tenantId, { createdAt: earlier(HOUR_MS / 2) });
      await assignAll(prisma, [tenantId]);
      // O sucessor sai na retenção, com o alerta dele.
      const [, successor] = await casesOf(prisma, tenantId);
      await prisma.finding.delete({ where: { id: second } });
      await prisma.alertCase.delete({ where: { id: successor?.id as string } });

      await undo(app, who, made.id);
      expect(await caseRow(prisma, old?.id as string)).toMatchObject({
        sealedAt: null,
        sealReason: null,
        openKey: old?.groupKey,
        pending: true,
      });
      await insertFinding(prisma, tenantId, { createdAt: earlier(60_000) });
      await assignAll(prisma, [tenantId]);
      expect((await casesOf(prisma, tenantId)).map((row) => [row.id, row.total])).toEqual([[old?.id, 2]]);
      await expectSettled(prisma, tenantId, 2);
    });

    it('dois selados da mesma chave: reabre o último; o selado pela janela nunca reabre', async () => {
      const { tenantId, who } = await customer('dois selados');
      const groupKey = 'c'.repeat(64);
      const seal = (reason: string, hours: number) => ({
        groupKey,
        sealedAt: earlier(hours * HOUR_MS),
        sealReason: reason,
      });
      const older = await caseWith(prisma, tenantId, [{}], seal('treated', 3));
      const newer = await caseWith(prisma, tenantId, [{}], seal('treated', 2));
      const byWindow = await caseWith(prisma, tenantId, [{}], seal('window', 1));
      const caseIds = [older.caseId, newer.caseId, byWindow.caseId];
      const made = await operate(app, who, statusRequest({ caseIds }, 3));
      await undo(app, who, made.id);
      const rows = await Promise.all(caseIds.map((id) => caseRow(prisma, id)));
      expect(rows.map((row) => [row.openKey === null, row.sealReason, row.pending])).toEqual([
        [true, 'treated', true],
        [false, null, true],
        [true, 'window', true],
      ]);
    });

    it('um selado e um aberto com chaves iguais em outro cliente não se misturam', async () => {
      const { tenantId, who } = await customer('chave A');
      const { tenantId: otherId } = await customer('chave B');
      const groupKey = 'd'.repeat(64);
      const { caseId } = await caseWith(prisma, tenantId, [{}], {
        groupKey,
        sealedAt: earlier(),
        sealReason: 'treated',
      });
      const other = await caseWith(prisma, otherId, [{}], { groupKey });
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 1));
      await undo(app, who, made.id);
      expect((await caseRow(prisma, caseId)).openKey).toBe(groupKey);
      expect((await caseRow(prisma, other.caseId)).openKey).toBe(groupKey);
    });

    it('o alerta tratado antes de ter caso volta à fila da atribuição', async () => {
      const { tenantId, who } = await customer('sem caso');
      const id = await insertFinding(prisma, tenantId, { createdAt: earlier() });
      const made = await operate(app, who, statusRequest({ findingIds: [id] }, 1));
      expect(await assignAll(prisma, [tenantId])).toMatchObject({ assigned: 0 });
      await undo(app, who, made.id);
      expect(await assignAll(prisma, [tenantId])).toMatchObject({ assigned: 1, opened: 1 });
      await expectSettled(prisma, tenantId, 1);
    });
  });

  describe('undo_all_of', () => {
    const all = (userId: string, overrides: object = {}) => ({
      requestId: randomUUID(),
      action: 'undo_all_of',
      target: { userId },
      reason: 'Conta comprometida',
      ...overrides,
    });

    it('cancela o que está na fila e desfaz tudo o que a pessoa fez, e só o dela', async () => {
      const { tenantId, who: admin } = await customer('todas');
      const suspect = await operatorFor(app, tenantId, 'analista_cliente');
      const colleague = await operatorFor(app, tenantId, 'analista_cliente');
      const one = await caseWith(prisma, tenantId, [{}, {}]);
      const two = await caseWith(prisma, tenantId, [{}]);
      const three = await caseWith(prisma, tenantId, []);
      const threeIds = await manyFindings(prisma, tenantId, three.caseId, 12);
      const four = await caseWith(prisma, tenantId, [{}]);
      const first = await operate(app, suspect, statusRequest({ caseIds: [one.caseId] }, 2));
      // O mesmo alerta de novo, por cima (em análise e depois resolvido).
      const reopened = await operate(
        app,
        suspect,
        statusRequest({ caseIds: [two.caseId] }, 1, { status: 'investigating' }),
      );
      const over = await operate(app, suspect, statusRequest({ caseIds: [two.caseId] }, 1));
      const undoneAlready = await operate(app, suspect, statusRequest({ caseIds: [four.caseId] }, 1));
      await undo(app, suspect, undoneAlready.id);
      limits.syncAlerts = 1;
      const running = await operate(app, suspect, statusRequest({ caseIds: [three.caseId] }, 12), 202);
      await triageJob(prisma, [tenantId], { batch: 5, workMs: 0 }).runOnce();
      const queued = await operate(
        app,
        suspect,
        statusRequest({ findingIds: [threeIds[2], threeIds[5]] }, 2),
        202,
      );
      limits.syncAlerts = DEFAULT_TRIAGE_LIMITS.syncAlerts;
      const theirs = await operate(app, colleague, statusRequest({ caseIds: [four.caseId] }, 1));

      const body = all(suspect.userId);
      const header = await operate(app, admin, body, 202);
      expect(header).toMatchObject({
        action: 'undo_all_of',
        state: 'done',
        author: { id: admin.userId },
        target: { kind: 'user', userId: suspect.userId },
        // As cinco dela que valem: a que estava na fila só é cancelada.
        matched: 5,
        changed: 4,
        skipped: 1,
        can: { cancel: false, continue: false, undo: false },
      });
      expect((await operate(app, admin, body, 200)).id).toBe(header.id);
      expect(await operation(app, admin, queued.id)).toMatchObject({ state: 'canceled', undoId: null });
      expect(await operation(app, admin, running.id)).toMatchObject({ state: 'undoing' });
      const undos = await prisma.triageOperation.findMany({
        where: { tenantId, action: 'undo', state: 'queued' },
        orderBy: { createdAt: 'asc' },
      });
      // Da mais recente para a mais antiga.
      expect(undos.map((row) => row.undoOfId)).toEqual([running.id, over.id, reopened.id, first.id]);
      expect(undos.every((row) => row.createdById === admin.userId)).toBe(true);
      await drain(prisma, [tenantId]);
      for (const id of [first.id, over.id, reopened.id, running.id]) {
        expect(await operation(app, admin, id)).toMatchObject({ state: 'undone' });
      }
      const statuses = await findingsById(prisma, [...one.ids, ...threeIds]);
      expect([...statuses.values()].every((row) => row.status === 'new')).toBe(true);
      // O que duas operações dela mudaram volta ao que era antes da última: pendente, à vista.
      expect((await findingsById(prisma, two.ids)).get(two.ids[0] as string)?.status).toBe('investigating');
      // A do colega fica.
      expect(await operation(app, admin, theirs.id)).toMatchObject({ state: 'done' });
      expect((await findingsById(prisma, four.ids)).get(four.ids[0] as string)?.status).toBe('resolved');
      const [record] = await trail(prisma, tenantId, 'triage.bulk.undo_all');
      expect(record).toMatchObject({
        actorId: admin.userId,
        resourceId: header.id,
        after: {
          userId: suspect.userId,
          operations: 5,
          canceled: [queued.id, running.id],
          undone: [running.id, over.id, reopened.id, first.id],
          reason: 'Conta comprometida',
        },
      });
      // Nada mais a desfazer.
      const empty = await post(app, admin, '/v1/triage-operations', all(suspect.userId));
      expect(empty.status).toBe(409);
      expect(empty.body).toMatchObject({ code: 'TRIAGE_NOTHING_TO_DO' });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('fora do prazo, não alcança', async () => {
      const { tenantId, who } = await customer('todas fora do prazo');
      const { caseId } = await caseWith(prisma, tenantId, [{}]);
      await operate(app, who, statusRequest({ caseIds: [caseId] }, 1));
      limits.now = () => new Date(Date.now() + 25 * HOUR_MS);
      expect((await post(app, who, '/v1/triage-operations', all(who.userId))).status).toBe(409);
      expect((await post(app, who, '/v1/triage-operations', all('ninguem'))).status).toBe(409);
    });
  });

  it('o desfazer de uma operação grande vai para a fila, em lotes, e o resultado é o mesmo', async () => {
    const { tenantId, who } = await customer('grande');
    const { caseId } = await caseWith(prisma, tenantId, []);
    const ids = await manyFindings(prisma, tenantId, caseId, 450);
    const before = await findingsById(prisma, ids);
    const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 450), 202);
    await drain(prisma, [tenantId], { batch: 100 });
    expect((await caseRow(prisma, caseId)).resolvedCount).toBe(450);
    const undone = await undo(app, who, made.id, 202);
    const report = await drain(prisma, [tenantId], { batch: 100 });
    expect(report).toMatchObject({ batches: 5, changed: 450, finished: 1 });
    expect(await operation(app, who, undone.id)).toMatchObject({ state: 'done', changed: 450 });
    const after = await findingsById(prisma, ids);
    for (const id of ids) {
      expect(after.get(id)).toMatchObject({ status: 'new', triagedAt: before.get(id)?.triagedAt });
    }
    await expectExactCounters(prisma, [tenantId]);
  });

  it('o alerta que nasceu esperado por exceção não entra em operação, e o desfazer não o toca', async () => {
    const { tenantId, who } = await customer('exceção');
    const { caseId, ids } = await caseWith(prisma, tenantId, [{}]);
    const expected = await prisma.finding.create({
      data: findingData(tenantId, { status: 'legitimate', caseId, createdAt: earlier() }),
    });
    const made = await operate(app, who, statusRequest({ findingIds: [...ids, expected.id] }, 1));
    expect(made).toMatchObject({ matched: 1, changed: 1 });
    await undo(app, who, made.id);
    expect((await findingsById(prisma, [expected.id])).get(expected.id)).toMatchObject({
      status: 'legitimate',
      triageOpId: null,
    });
  });
});
