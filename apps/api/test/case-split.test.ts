import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type CaseDetail, caseDetailSchema, caseSplitResultSchema, MAX_SPLIT_ALERTS } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createTenant } from './support/auth-helpers.js';
import {
  assignAll,
  casesOf,
  cleanCases,
  expectExactCounters,
  expectSettled,
  HOUR_MS,
  insertFinding,
} from './support/cases.js';
import { createApp } from './support/create-app.js';
import {
  caseRow,
  caseWith,
  earlier,
  expectNoDrift,
  findingsById,
  manyFindings,
  operate,
  type Operator,
  operatorFor,
  post,
  read,
  statusRequest,
  trail,
  undo,
} from './support/triage.js';

/** Dividir um caso (`POST /v1/cases/:id/split`). O isolamento entre clientes está em `triage-operations.test.ts`. */
describe('dividir um caso', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];

  async function customer(name: string): Promise<{ tenantId: string; who: Operator }> {
    const tenantId = await createTenant(app, `Cliente Demo (dividir: ${name})`);
    tenants.push(tenantId);
    return { tenantId, who: await operatorFor(app, tenantId, 'analista_cliente') };
  }
  const split = async (who: Operator, caseId: string, body: object, status = 201) => {
    const response = await post(app, who, `/v1/cases/${caseId}/split`, body);
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return status === 201 ? caseSplitResultSchema.parse(response.body) : (response.body as { code?: string });
  };
  const divided = async (who: Operator, caseId: string, body: object) =>
    caseSplitResultSchema.parse(await split(who, caseId, body));
  const detail = async (who: Operator, id: string): Promise<CaseDetail> =>
    caseDetailSchema.parse((await read(app, who, `/v1/cases/${id}`).expect(200)).body);

  beforeAll(async () => {
    app = await createApp({ casesMode: 'on' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  it('os alertas vão para um caso novo, selado, da mesma chave; as contagens e as amostras dos dois se refazem', async () => {
    const { tenantId, who } = await customer('regra');
    const start = Date.now() - HOUR_MS;
    const at = (minutes: number) => new Date(start + minutes * 60_000);
    const base = { mitreTactics: ['Impact'], mitreTechniques: ['T1485'] };
    const { caseId, ids } = await caseWith(
      prisma,
      tenantId,
      [
        {
          createdAt: at(0),
          occurredAt: at(-30),
          actorUser: 'a',
          accessKeyId: 'DEMOCHAVE1',
          sourceIp: '203.0.113.1',
          resource: 's3:um',
          severity: 'critical',
        },
        {
          createdAt: at(1),
          occurredAt: at(1),
          actorUser: 'b',
          accessKeyId: 'DEMOCHAVE2',
          sourceIp: '203.0.113.2',
          resource: 's3:dois',
          ...base,
        },
        {
          createdAt: at(2),
          occurredAt: at(2),
          actorUser: 'b',
          sourceIp: '203.0.113.2',
          status: 'investigating',
          lastSeenAt: at(20),
          ruleId: '100306',
        },
        { createdAt: at(3), occurredAt: at(3), actorUser: 'a', status: 'resolved', severity: 'low' },
      ],
      {
        actors: ['a', 'b'],
        ips: ['203.0.113.1', '203.0.113.2'],
        resources: ['s3:um', 's3:dois'],
        mitreTactics: ['Impact'],
        openedAt: at(0),
        lastAlertAt: at(3),
        recurrence: 2,
        noticedSeverity: 'critical',
        keyParts: [{ name: 'rule', value: '100305' }],
      },
    );
    const [first, second, third, fourth] = ids as [string, string, string, string];
    await prisma.alertCase.update({ where: { id: caseId }, data: { anchorFindingId: second } });
    const before = await findingsById(prisma, ids);
    const original = await caseRow(prisma, caseId);
    const result = await divided(who, caseId, { findingIds: [second, third], reason: 'São duas pessoas' });
    expect(result).toMatchObject({ moved: 2, remaining: 2 });

    const left = await caseRow(prisma, caseId);
    const moved = await caseRow(prisma, result.caseId);
    expect(moved).toMatchObject({
      tenantId,
      queue: original.queue,
      keyVersion: original.keyVersion,
      groupKey: original.groupKey,
      openKey: null,
      sealReason: 'split',
      family: original.family,
      title: original.title,
      keyParts: original.keyParts,
      previousCaseId: caseId,
      recurrence: 2,
      anchorFindingId: second,
      openedAt: original.openedAt,
      firstSeenAt: at(1),
      lastSeenAt: at(20),
      lastAlertAt: at(2),
      noticedSeverity: 'critical',
      pending: true,
      total: 2,
      pendingHigh: 2,
      newCount: 1,
      investigatingCount: 1,
      ruleIds: ['100305', '100306'],
      actors: ['b'],
      accessKeys: ['DEMOCHAVE2'],
      ips: ['203.0.113.2'],
      resources: ['s3:dois'],
      mitreTactics: ['Impact'],
      mitreTechniques: ['T1485'],
      incidentId: null,
    });
    expect(left).toMatchObject({
      openKey: original.groupKey,
      sealedAt: null,
      total: 2,
      pendingCritical: 1,
      newCount: 1,
      resolvedCount: 1,
      // O alerta que abriu o caso saiu: passa a ser o mais antigo dos que ficaram.
      anchorFindingId: first,
      firstSeenAt: at(-30),
      lastSeenAt: at(3),
      lastAlertAt: at(3),
      actors: ['a'],
      accessKeys: ['DEMOCHAVE1'],
      ips: ['203.0.113.1'],
      resources: ['s3:um'],
      mitreTactics: [],
      mitreTechniques: [],
      recurrence: 2,
    });
    const after = await findingsById(prisma, ids);
    for (const id of ids) {
      // Só o caso muda: nem o status, nem a operação, nem o `updatedAt`, que a retenção lê.
      expect({ ...after.get(id), caseId: null }).toEqual({ ...before.get(id), caseId: null });
    }
    expect(ids.map((id) => after.get(id)?.caseId)).toEqual([caseId, result.caseId, result.caseId, caseId]);
    expect(fourth).toBeDefined();
    const [record] = await trail(prisma, tenantId, 'case.split');
    expect(record).toMatchObject({
      actorId: who.userId,
      resourceType: 'alert_case',
      resourceId: caseId,
      outcome: 'success',
      before: { title: original.title, total: 4 },
      after: { caseId: result.caseId, moved: 2, remaining: 2, by: 'alerts', reason: 'São duas pessoas' },
    });
    await expectExactCounters(prisma, [tenantId]);
    await expectNoDrift(prisma, [tenantId]);
    // O novo aparece na lista e liga ao original.
    const shown = await detail(who, result.caseId);
    expect(shown).toMatchObject({ sealReason: 'split', recurrence: 2 });
    expect(shown.previous.map((row) => row.id)).toEqual([caseId]);
  });

  it('por subgrupo, leva o subgrupo inteiro e só ele', async () => {
    const { tenantId, who } = await customer('subgrupo');
    const { caseId, ids } = await caseWith(prisma, tenantId, [
      { caseGroup: 'openssl' },
      { caseGroup: 'openssl', status: 'resolved' },
      { caseGroup: 'openssl-libs' },
      { caseGroup: null },
    ]);
    const result = await divided(who, caseId, { group: 'openssl' });
    expect(result).toMatchObject({ moved: 2, remaining: 2 });
    const rows = await findingsById(prisma, ids);
    expect(ids.map((id) => rows.get(id)?.caseId === result.caseId)).toEqual([true, true, false, false]);
    const [record] = await trail(prisma, tenantId, 'case.split');
    expect(record?.after).toMatchObject({ by: 'group', group: 'openssl' });
    await expectExactCounters(prisma, [tenantId]);
  });

  it('o alerta de outro caso, o que não existe e o subgrupo vazio são 404, e nada muda', async () => {
    const { tenantId, who } = await customer('de outro');
    const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
    const other = await caseWith(prisma, tenantId, [{}, {}]);
    const loose = await insertFinding(prisma, tenantId);
    for (const findingIds of [
      [other.ids[0]],
      [ids[0], other.ids[0]],
      [loose],
      [randomUUID()],
      [ids[0], randomUUID()],
    ]) {
      await split(who, caseId, { findingIds }, 404);
    }
    await split(who, caseId, { group: 'nenhum' }, 404);
    await split(who, randomUUID(), { findingIds: [ids[0]] }, 404);
    expect(await casesOf(prisma, tenantId)).toHaveLength(2);
    await expectExactCounters(prisma, [tenantId]);
  });

  it('o caso nunca fica sem alerta', async () => {
    const { tenantId, who } = await customer('inteiro');
    const { caseId, ids } = await caseWith(prisma, tenantId, [{ caseGroup: 'a' }, { caseGroup: 'a' }]);
    expect(await split(who, caseId, { findingIds: ids }, 409)).toMatchObject({ code: 'CASE_SPLIT_WHOLE' });
    expect(await split(who, caseId, { group: 'a' }, 409)).toMatchObject({ code: 'CASE_SPLIT_WHOLE' });
    expect(await casesOf(prisma, tenantId)).toHaveLength(1);
    const [record] = await trail(prisma, tenantId, 'case.split');
    expect(record).toMatchObject({ outcome: 'failure', statusCode: 409 });
  });

  it('o subgrupo grande demais é recusado; no teto, divide', async () => {
    const { tenantId, who } = await customer('teto');
    expect(MAX_SPLIT_ALERTS).toBe(2_000);
    const { caseId } = await caseWith(prisma, tenantId, [{}]);
    await manyFindings(prisma, tenantId, caseId, 2_001, { caseGroup: 'g' });
    expect(await split(who, caseId, { group: 'g' }, 409)).toMatchObject({
      code: 'CASE_SPLIT_TOO_LARGE',
      details: { max: 2_000 },
    });
    const { id } = await prisma.finding.findFirstOrThrow({
      where: { caseId, caseGroup: 'g' },
      select: { id: true },
    });
    await divided(who, caseId, { findingIds: [id] });
    const startedAt = performance.now();
    expect(await divided(who, caseId, { group: 'g' })).toMatchObject({ moved: 2_000, remaining: 1 });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    await expectExactCounters(prisma, [tenantId]);
  });

  it('o corpo fora do contrato é 400', async () => {
    const { tenantId, who } = await customer('contrato');
    const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
    const bad: object[] = [
      {},
      { findingIds: [] },
      { findingIds: ['x'] },
      { findingIds: [ids[0], ids[0]] },
      { findingIds: Array.from({ length: 501 }, () => randomUUID()) },
      { group: '' },
      { group: 'a\u0000' },
      { group: 'x'.repeat(257) },
      { findingIds: [ids[0]], group: 'a' },
      { findingIds: [ids[0]], reason: '' },
      { findingIds: [ids[0]], caseId },
    ];
    for (const body of bad) await split(who, caseId, body, 400);
    await post(app, who, '/v1/cases/abc/split', { findingIds: [ids[0]] }).expect(400);
  });

  it('as amostras têm os mesmos tetos, na ordem de chegada, e o texto estranho não quebra', async () => {
    const { tenantId, who } = await customer('amostras');
    const start = Date.now() - HOUR_MS;
    const { caseId, ids } = await caseWith(
      prisma,
      tenantId,
      Array.from({ length: 30 }, (_, index) => ({
        createdAt: new Date(start + index * 1000),
        sourceIp: `198.51.100.${index}`,
        actorUser: index === 0 ? '   ' : index === 1 ? `\u{1F600}${'x'.repeat(400)}` : `pessoa-${index}`,
        accountId: `1111111111${10 + index}`,
      })),
    );
    const result = await divided(who, caseId, { findingIds: ids.slice(0, 25) });
    const row = await caseRow(prisma, result.caseId);
    expect(row.ips).toEqual(Array.from({ length: 20 }, (_, index) => `198.51.100.${index}`));
    expect(row.accounts).toHaveLength(25);
    expect(row.actors).toHaveLength(20);
    expect(row.actors[0]).toBe(`\u{1F600}${'x'.repeat(255)}`);
    expect((await caseRow(prisma, caseId)).ips).toHaveLength(5);
  });

  it('a chegada no futuro não empurra o último alerta do caso para depois de agora', async () => {
    const { tenantId, who } = await customer('relógio');
    const { caseId, ids } = await caseWith(prisma, tenantId, [
      {},
      { createdAt: new Date(Date.now() + 10 * HOUR_MS) },
      {},
    ]);
    const result = await divided(who, caseId, { findingIds: [ids[1]] });
    expect((await caseRow(prisma, result.caseId)).lastAlertAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  describe('com a atribuição', () => {
    it('os alertas seguintes da chave ficam no original, e o dividido não conta como abertura', async () => {
      const { tenantId, who } = await customer('seguintes');
      const at = (minutes: number) => earlier(HOUR_MS - minutes * 60_000);
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        ids.push(await insertFinding(prisma, tenantId, { createdAt: at(index) }));
      }
      await assignAll(prisma, [tenantId]);
      const [original] = await casesOf(prisma, tenantId);
      const result = await divided(who, original?.id as string, { findingIds: ids.slice(0, 2) });
      await insertFinding(prisma, tenantId, { createdAt: at(10) });
      await assignAll(prisma, [tenantId]);
      expect((await caseRow(prisma, original?.id as string)).total).toBe(3);
      expect((await caseRow(prisma, result.caseId)).total).toBe(2);
      expect((await caseRow(prisma, result.caseId)).openedAt).toEqual(original?.openedAt);
      await expectSettled(prisma, tenantId, 5);
    });

    it('tratado o original, o alerta seguinte abre um novo com ele como anterior, e não com o dividido', async () => {
      const { tenantId, who } = await customer('anterior');
      const at = (minutes: number) => earlier(HOUR_MS - minutes * 60_000);
      const ids = [
        await insertFinding(prisma, tenantId, { createdAt: at(0) }),
        await insertFinding(prisma, tenantId, { createdAt: at(1) }),
      ];
      await assignAll(prisma, [tenantId]);
      const [original] = await casesOf(prisma, tenantId);
      const originalId = original?.id as string;
      const result = await divided(who, originalId, { findingIds: [ids[0]] });
      await operate(app, who, statusRequest({ caseIds: [originalId] }, 1));
      await insertFinding(prisma, tenantId, { createdAt: at(5) });
      await assignAll(prisma, [tenantId]);
      const rows = await casesOf(prisma, tenantId);
      const successor = rows.find((row) => row.openKey !== null);
      expect(successor).toMatchObject({ previousCaseId: originalId, recurrence: 1, total: 1 });
      expect(await caseRow(prisma, originalId)).toMatchObject({ sealReason: 'treated' });
      // O dividido continua pendente e selado; desfazer o resto não o reabre.
      expect(await caseRow(prisma, result.caseId)).toMatchObject({ sealReason: 'split', pending: true });
      const made = await operate(app, who, statusRequest({ caseIds: [result.caseId] }, 1));
      await undo(app, who, made.id);
      expect(await caseRow(prisma, result.caseId)).toMatchObject({
        sealReason: 'split',
        openKey: null,
        pending: true,
      });
      await expectSettled(prisma, tenantId, 3);
    });

    it('um selado também se divide, e o dividido de novo', async () => {
      const { tenantId, who } = await customer('selado');
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}, {}], {
        sealedAt: earlier(),
        sealReason: 'window',
      });
      const first = await divided(who, caseId, { findingIds: ids.slice(0, 2) });
      const second = await divided(who, first.caseId, { findingIds: [ids[0]] });
      expect(await caseRow(prisma, second.caseId)).toMatchObject({ previousCaseId: first.caseId, total: 1 });
      expect(await caseRow(prisma, caseId)).toMatchObject({ sealReason: 'window', total: 1 });
      await expectExactCounters(prisma, [tenantId]);
    });
  });
});
