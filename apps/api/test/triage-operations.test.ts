import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ROLES, type Role, triageOperationPageSchema, triagePreviewSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIAGE_LIMITS,
  TRIAGE_LIMITS,
  type TriageLimits,
} from '../src/cases/triage-operations.service.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import {
  CASE_ACCOUNT,
  cleanCases,
  expectExactCounters,
  insertFinding,
  insertIncident,
  insertOperation,
} from './support/cases.js';
import { createApp } from './support/create-app.js';
import { describeTenantIsolation } from './support/tenant-isolation.js';
import {
  caseRow,
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

/**
 * A triagem em massa pela API, com `CASES_MODE=on`: o isolamento, os papéis, o alvo e a confirmação. A idempotência, a fila, as
 * cotas e a trilha estão em `triage-requests.test.ts`.
 */
describe('triagem em massa', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let analystA: Operator;
  let analystB: Operator;
  let adminA: Operator;
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
    tenantB = await newTenant('B');
    analystA = await operatorFor(app, tenantA, 'analista_cliente');
    adminA = await operatorFor(app, tenantA, 'admin_cliente');
    analystB = await operatorFor(app, tenantB, 'analista_cliente');
  }, 60_000);

  beforeEach(() => {
    Object.assign(limits, DEFAULT_TRIAGE_LIMITS);
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  const operationInB = async () => {
    const { caseId } = await caseWith(prisma, tenantB, [{}]);
    return (await operate(app, analystB, statusRequest({ caseIds: [caseId] }, 1))).id;
  };

  describeTenantIsolation({
    resource: 'operações de triagem em massa',
    basePath: '/v1/triage-operations',
    context: () => ({ app, sessionA: analystA, sessionB: analystB }),
    createInTenantB: operationInB,
    readDirect: (id) => prisma.triageOperation.findUniqueOrThrow({ where: { id } }),
  });

  describe('isolamento em cada rota e em cada id do corpo', () => {
    const withoutId = (body: object) => ({ ...body, requestId: undefined });

    /** Tudo o que é do cliente B, para conferir que nada mudou. */
    const everythingOfB = async () =>
      JSON.stringify(
        {
          findings: await prisma.finding.findMany({ where: { tenantId: tenantB }, orderBy: { id: 'asc' } }),
          cases: await prisma.alertCase.findMany({ where: { tenantId: tenantB }, orderBy: { id: 'asc' } }),
          incidents: await prisma.incident.findMany({ where: { tenantId: tenantB }, orderBy: { id: 'asc' } }),
          operations: await prisma.triageOperation.findMany({
            where: { tenantId: tenantB },
            orderBy: { id: 'asc' },
          }),
          items: await prisma.triageOperationItem.count({ where: { tenantId: tenantB } }),
        },
        (_, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );

    it('caso, alerta, incidente e operação do outro cliente respondem como os que não existem, e nada muda', async () => {
      const { caseId: caseB, ids: idsB } = await caseWith(prisma, tenantB, [{}, {}]);
      const { caseId: caseA, ids: idsA } = await caseWith(prisma, tenantA, [{}, {}]);
      const incidentB = await insertIncident(prisma, tenantB);
      const operationB = await operationInB();
      const before = await everythingOfB();
      const missing = randomUUID();
      const bodies = (other: { caseId: string; findingId: string; incidentId: string }) => [
        statusRequest({ caseIds: [other.caseId] }, 2),
        statusRequest({ caseIds: [caseA, other.caseId] }, 4),
        statusRequest({ findingIds: [other.findingId] }, 1),
        statusRequest({ findingIds: [idsA[0], other.findingId] }, 2),
        { ...statusRequest({ caseIds: [other.caseId] }, 2), action: 'promote', status: undefined },
        {
          ...statusRequest({ caseIds: [caseA] }, 2),
          action: 'attach',
          status: undefined,
          incidentId: other.incidentId,
        },
      ];
      const ofB = bodies({ caseId: caseB, findingId: idsB[0] as string, incidentId: incidentB });
      const ofNone = bodies({ caseId: missing, findingId: missing, incidentId: missing });
      for (const [index, body] of ofB.entries()) {
        const other = await post(app, analystA, '/v1/triage-operations', body).expect(404);
        const none = await post(app, analystA, '/v1/triage-operations', ofNone[index]).expect(404);
        expect(withoutId(other.body as object), String(index)).toEqual(withoutId(none.body as object));
      }
      const writes = (other: {
        operationId: string;
        caseId: string;
        findingId: string;
      }): [string, object | undefined][] => [
        [`/v1/triage-operations/${other.operationId}/cancel`, undefined],
        [`/v1/triage-operations/${other.operationId}/continue`, undefined],
        [`/v1/triage-operations/${other.operationId}/undo`, { requestId: randomUUID() }],
        [`/v1/cases/${other.caseId}/split`, { findingIds: [other.findingId] }],
        [`/v1/cases/${caseA}/split`, { findingIds: [other.findingId] }],
        [`/v1/cases/${other.caseId}/split`, { group: 'openssl' }],
      ];
      const writesOfB = writes({ operationId: operationB, caseId: caseB, findingId: idsB[0] as string });
      const writesOfNone = writes({ operationId: missing, caseId: missing, findingId: missing });
      for (const [index, [path, body]] of writesOfB.entries()) {
        const [nonePath, noneBody] = writesOfNone[index] as [string, object | undefined];
        const other = await post(app, adminA, path, body).expect(404);
        const none = await post(app, adminA, nonePath, noneBody).expect(404);
        expect(withoutId(other.body as object), path).toEqual(withoutId(none.body as object));
      }
      await read(app, adminA, `/v1/triage-operations/${operationB}`).expect(404);
      expect(await everythingOfB()).toBe(before);
      // E o próprio caso de A também não mudou: o pedido inteiro é recusado.
      const mine = await findingsById(prisma, idsA);
      expect([...mine.values()].map((row) => row.status)).toEqual(['new', 'new']);
    });

    it('o filtro nunca alcança o outro cliente, nem na contagem', async () => {
      const marker = `marca-${randomUUID()}`;
      await caseWith(prisma, tenantB, [{}, {}], { actors: [marker], ips: ['203.0.113.77'] });
      for (const filter of [{ q: marker }, { q: '203.0.113.77' }]) {
        const preview = await read(app, analystA, `/v1/triage-operations/preview?q=${filter.q}`).expect(200);
        expect(triagePreviewSchema.parse(preview.body)).toMatchObject({ cases: 0, alerts: 0 });
        const response = await post(app, analystA, '/v1/triage-operations', statusRequest({ filter }, 2));
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'TRIAGE_NOTHING_TO_DO', details: { count: 0 } });
      }
      expect(
        await prisma.finding.count({
          where: { tenantId: tenantB, status: 'resolved', alertCase: { actors: { has: marker } } },
        }),
      ).toBe(0);
    });

    it('o mesmo requestId em dois clientes são dois pedidos', async () => {
      const a = await caseWith(prisma, tenantA, [{}]);
      const b = await caseWith(prisma, tenantB, [{}]);
      const requestId = randomUUID();
      const first = await operate(app, analystA, statusRequest({ caseIds: [a.caseId] }, 1, { requestId }));
      const second = await operate(app, analystB, statusRequest({ caseIds: [b.caseId] }, 1, { requestId }));
      expect(second.id).not.toBe(first.id);
      // O de A, pedido de novo por A, devolve o de A.
      expect(
        (await operate(app, analystA, statusRequest({ caseIds: [a.caseId] }, 1, { requestId }), 200)).id,
      ).toBe(first.id);
      // E o requestId de um desfazer em B não ocupa o de A.
      const undoRequest = randomUUID();
      await undo(app, analystB, second.id, 201, { requestId: undoRequest });
      await undo(app, analystA, first.id, 201, { requestId: undoRequest });
    });

    it('o undo_all_of só alcança as operações feitas no cliente da sessão', async () => {
      const { caseId } = await caseWith(prisma, tenantB, [{}]);
      const made = await operate(app, analystB, statusRequest({ caseIds: [caseId] }, 1));
      const response = await post(app, adminA, '/v1/triage-operations', {
        requestId: randomUUID(),
        action: 'undo_all_of',
        target: { userId: analystB.userId },
        reason: 'Conta comprometida',
      });
      expect(response.status).toBe(409);
      expect(await operation(app, analystB, made.id)).toMatchObject({ state: 'done', undoId: null });
    });

    it('a lista e o filtro por autor só mostram as operações do cliente', async () => {
      const id = await operationInB();
      const mine = await read(app, adminA, `/v1/triage-operations?authorId=${analystB.userId}`).expect(200);
      expect(triageOperationPageSchema.parse(mine.body).items).toEqual([]);
      const theirs = await read(app, analystB, `/v1/triage-operations?pageSize=100`).expect(200);
      expect(triageOperationPageSchema.parse(theirs.body).items.map((item) => item.id)).toContain(id);
    });

    it('a equipe da Verax sem cliente escolhido não opera', async () => {
      const user = await createSignedInUser(app, { role: 'admin_verax' });
      const { cookie, token } = await withCsrf(app, user.cookie);
      const verax: Operator = { userId: user.id, role: 'admin_verax', cookie, csrfToken: token };
      const body = statusRequest({ caseIds: [randomUUID()] }, 1);
      const response = await post(app, verax, '/v1/triage-operations', body).expect(409);
      expect(response.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      await read(app, verax, '/v1/triage-operations').expect(409);
      await read(app, verax, '/v1/triage-operations/preview?q=x').expect(409);
    });
  });

  describe('papéis', () => {
    /** O que cada papel recebe em cada rota de escrita. */
    const matrix: Record<Role, { operate: number; undoOfOther: number; undoAll: number }> = {
      admin_verax: { operate: 201, undoOfOther: 201, undoAll: 202 },
      admin_cliente: { operate: 201, undoOfOther: 201, undoAll: 202 },
      analista_cliente: { operate: 201, undoOfOther: 403, undoAll: 403 },
      leitura: { operate: 403, undoOfOther: 403, undoAll: 403 },
    };

    it.each(ROLES)('%s', async (role) => {
      const { tenantId, who: author } = await customer(`papel ${role}`, 'analista_cliente');
      const who = await operatorFor(app, tenantId, role);
      const expected = matrix[role];
      const own = await caseWith(prisma, tenantId, [{}]);
      const others = await caseWith(prisma, tenantId, [{}]);
      const splittable = await caseWith(prisma, tenantId, [{}, {}]);
      const theirs = await operate(app, author, statusRequest({ caseIds: [others.caseId] }, 1));

      // Ler, todos.
      await read(app, who, '/v1/triage-operations').expect(200);
      const seen = await operation(app, who, theirs.id);
      expect(seen.author).toEqual({ id: author.userId, name: 'Usuário de teste' });
      expect(seen.can).toEqual({
        cancel: false,
        continue: false,
        undo: expected.undoOfOther === 201,
      });
      const canRead = role === 'leitura' ? 403 : 200;
      await read(app, who, '/v1/triage-operations/preview?q=x').expect(canRead);

      const made = await post(app, who, '/v1/triage-operations', statusRequest({ caseIds: [own.caseId] }, 1));
      expect(made.status).toBe(expected.operate);
      const split = await post(app, who, `/v1/cases/${splittable.caseId}/split`, {
        findingIds: [splittable.ids[0]],
      });
      expect(split.status).toBe(expected.operate);
      const path = `/v1/triage-operations/${theirs.id}`;
      const undone = await post(app, who, `${path}/undo`, { requestId: randomUUID() });
      expect(undone.status).toBe(expected.undoOfOther);
      // Terminada: quem pode mexer recebe 409; quem não pode, 403.
      const blocked = expected.undoOfOther === 201 ? 409 : 403;
      expect((await post(app, who, `${path}/cancel`)).status).toBe(blocked);
      expect((await post(app, who, `${path}/continue`)).status).toBe(blocked);
      const again = await caseWith(prisma, tenantId, [{}]);
      await operate(app, author, statusRequest({ caseIds: [again.caseId] }, 1));
      const all = await post(app, who, '/v1/triage-operations', {
        requestId: randomUUID(),
        action: 'undo_all_of',
        target: { userId: author.userId },
        reason: 'Conta comprometida',
      });
      expect(all.status).toBe(expected.undoAll);
    });

    it('quem deixou de fazer triagem não mexe nem no que pediu', async () => {
      const { tenantId, who } = await customer('rebaixado', 'leitura');
      const id = await insertOperation(prisma, tenantId, {
        createdById: who.userId,
        changed: 1,
        matched: 1,
        undoUntil: new Date(Date.now() + 3_600_000),
      });
      expect((await operation(app, who, id)).can).toEqual({ cancel: false, continue: false, undo: false });
      await post(app, who, `/v1/triage-operations/${id}/undo`, { requestId: randomUUID() }).expect(403);
    });

    it('sem sessão, 401; sem o token CSRF, 403; nada é gravado', async () => {
      const { caseId } = await caseWith(prisma, tenantA, [{}]);
      const body = statusRequest({ caseIds: [caseId] }, 1);
      await request(app.getHttpServer()).post('/v1/triage-operations').send(body).expect(401);
      await request(app.getHttpServer()).get('/v1/triage-operations').expect(401);
      await request(app.getHttpServer())
        .post('/v1/triage-operations')
        .set('Cookie', analystA.cookie)
        .set('Origin', 'http://localhost:5173')
        .send(body)
        .expect(403);
      expect(await prisma.triageOperation.count({ where: { requestId: body['requestId'] as string } })).toBe(
        0,
      );
    });

    it('a recusa por papel fica na trilha, e a pessoa vê que pode desfazer só o que é dela', async () => {
      const { tenantId, who: first } = await customer('autor', 'analista_cliente');
      const second = await operatorFor(app, tenantId, 'analista_cliente');
      const { caseId } = await caseWith(prisma, tenantId, [{}]);
      const made = await operate(app, first, statusRequest({ caseIds: [caseId] }, 1));
      expect(made.can.undo).toBe(true);
      expect((await operation(app, second, made.id)).can.undo).toBe(false);
      await post(app, second, `/v1/triage-operations/${made.id}/undo`, { requestId: randomUUID() }).expect(
        403,
      );
      const [denied] = await trail(prisma, tenantId, 'triage.bulk.undo');
      expect(denied).toMatchObject({
        outcome: 'denied',
        statusCode: 403,
        actorId: second.userId,
        resourceId: made.id,
      });
      await undo(app, first, made.id);
    });
  });

  describe('mudar o status', () => {
    it.each([
      ['legitimate', 'new'],
      ['resolved', 'new'],
      ['resolved', 'investigating'],
      ['investigating', 'new'],
      ['new', 'investigating'],
    ] as const)('%s a partir de %s, como na triagem de um alerta só', async (status, from) => {
      const { tenantId, who } = await customer(`status ${status}`);
      const old = earlier(3_600_000);
      const triaged = earlier(1_800_000);
      const { caseId, ids } = await caseWith(prisma, tenantId, [
        { status: from, updatedAt: old },
        { status: from, updatedAt: old, triagedAt: triaged },
      ]);
      // O mesmo, um por um, pela rota de sempre.
      const single = [
        await insertFinding(prisma, tenantId, { status: from, updatedAt: old }),
        await insertFinding(prisma, tenantId, { status: from, updatedAt: old, triagedAt: triaged }),
      ];
      const startedAt = new Date();
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 2, { status }));
      for (const id of single) await patch(app, who, `/v1/findings/${id}/status`, { status }).expect(200);
      expect(made).toMatchObject({
        action: 'status',
        status,
        state: 'done',
        matched: 2,
        changed: 2,
        skipped: 0,
        remaining: 0,
        failed: 0,
        stop: null,
        expectedCount: 2,
        target: { kind: 'cases', caseIds: [caseId], group: null },
        author: { id: who.userId },
      });
      const bulk = await findingsById(prisma, ids);
      const one = await findingsById(prisma, single);
      for (const [index, id] of ids.entries()) {
        const a = bulk.get(id);
        const b = one.get(single[index] as string);
        expect(a?.status).toBe(status);
        expect(b?.status).toBe(status);
        // A data da triagem: a mesma regra (a primeira saída de "novo" marca; as outras não mudam).
        expect(a?.triagedAt === null).toBe(b?.triagedAt === null);
        if (index === 1) expect(a?.triagedAt).toEqual(triaged);
        else if (from === 'new') expect(a?.triagedAt?.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
        else expect(a?.triagedAt).toBeNull();
        // É atividade de uma pessoa: a retenção lê o `updatedAt`.
        expect(a?.updatedAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
        expect(a?.triageOpId).toBe(made.id);
        expect(b?.triageOpId).toBeNull();
      }
      const items = await prisma.triageOperationItem.findMany({
        where: { operationId: made.id },
        orderBy: { findingId: 'asc' },
      });
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item).toMatchObject({ tenantId, previousStatus: from, previousIncidentId: null });
      }
      expect(items.map((item) => item.previousTriagedAt)).toEqual(
        [...ids].sort().map((id) => (id === ids[1] ? triaged : null)),
      );
      await expectExactCounters(prisma, [tenantId]);
    });

    it('só entram os pendentes, fora de incidente, que chegaram até o corte e ainda não têm o status', async () => {
      const { tenantId, who } = await customer('corte');
      const incidentId = await insertIncident(prisma, tenantId);
      const { caseId, ids } = await caseWith(prisma, tenantId, [
        {},
        { status: 'investigating' },
        { status: 'legitimate' },
        { status: 'resolved' },
        { incidentId },
        { createdAt: new Date(Date.now() + 3_600_000) },
      ]);
      const made = await operate(
        app,
        who,
        statusRequest({ caseIds: [caseId] }, 1, { status: 'investigating' }),
      );
      expect(made).toMatchObject({ matched: 1, changed: 1, skipped: 0 });
      const rows = await findingsById(prisma, ids);
      expect(ids.map((id) => [rows.get(id)?.status, rows.get(id)?.triageOpId === made.id])).toEqual([
        ['investigating', true],
        ['investigating', false],
        ['legitimate', false],
        ['resolved', false],
        ['new', false],
        ['new', false],
      ]);
      // E para resolver entram os dois em análise; o do futuro chegou depois do corte.
      expect(
        await operate(app, who, statusRequest({ caseIds: [caseId] }, 2, { status: 'resolved' })),
      ).toMatchObject({ matched: 2, changed: 2 });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('um subgrupo de um caso, pelo valor inteiro, não leva os outros nem os de nome parecido', async () => {
      const { tenantId, who } = await customer('subgrupo');
      const { caseId, ids } = await caseWith(prisma, tenantId, [
        { caseGroup: 'openssl' },
        { caseGroup: 'openssl' },
        { caseGroup: 'openssl-libs' },
        { caseGroup: 'OpenSSL' },
        { caseGroup: null },
        { caseGroup: 'open_ssl' },
      ]);
      const made = await operate(app, who, statusRequest({ caseIds: [caseId], group: 'openssl' }, 2));
      expect(made).toMatchObject({ changed: 2, target: { kind: 'cases', group: 'openssl' } });
      const rows = await findingsById(prisma, ids);
      expect(ids.map((id) => rows.get(id)?.status)).toEqual([
        'resolved',
        'resolved',
        'new',
        'new',
        'new',
        'new',
      ]);
      // Com um curinga, ele vale como texto.
      const wildcard = await post(
        app,
        who,
        '/v1/triage-operations',
        statusRequest({ caseIds: [caseId], group: 'open%' }, 1),
      );
      expect(wildcard.status).toBe(409);
    });

    it('alertas escolhidos, com caso ou sem, e o já tratado só não conta', async () => {
      const { tenantId, who } = await customer('alertas');
      const { ids } = await caseWith(prisma, tenantId, [{}, { status: 'resolved' }]);
      const loose = await insertFinding(prisma, tenantId, { createdAt: earlier() });
      const made = await operate(app, who, statusRequest({ findingIds: [...ids, loose] }, 3));
      expect(made).toMatchObject({
        matched: 2,
        changed: 2,
        target: { kind: 'findings', count: 3 },
      });
      expect((await findingsById(prisma, [loose])).get(loose)).toMatchObject({
        status: 'resolved',
        caseId: null,
        triageOpId: made.id,
      });
    });

    it('o caso tratado inteiro fica sem pendência, e a trilha do alerta e do caso mostram a operação', async () => {
      const { tenantId, who } = await customer('trilha');
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 2));
      expect(await caseRow(prisma, caseId)).toMatchObject({
        pending: false,
        resolvedCount: 2,
        sealedAt: null,
      });
      const history = await read(app, who, `/v1/findings/${ids[0]}/triage`).expect(200);
      expect(history.body).toMatchObject({
        operation: { operation: { id: made.id, reason: 'Manutenção programada' }, previousStatus: 'new' },
      });
      const detail = await read(app, who, `/v1/cases/${caseId}`).expect(200);
      expect((detail.body as { operations: { id: string }[] }).operations.map((row) => row.id)).toEqual([
        made.id,
      ]);
      // Quem muda um alerta à mão tira a operação dele.
      await patch(app, who, `/v1/findings/${ids[0]}/status`, { status: 'investigating' }).expect(200);
      const after = await read(app, who, `/v1/findings/${ids[0]}/triage`).expect(200);
      expect(after.body).toMatchObject({ operation: null, operations: [{ operation: { id: made.id } }] });
    });
  });

  describe('filtro da lista de casos', () => {
    it('alcança os mesmos casos da lista, além da primeira página, e o grupo é o valor exato', async () => {
      const { tenantId, who } = await customer('filtro');
      const vulnerability = (name: string, resource: string) => ({
        queue: 'vulnerability' as const,
        family: 'package',
        keyParts: [
          { name: 'package', value: name },
          { name: 'resource', value: resource },
        ],
        ruleIds: ['990511'],
      });
      const matching: string[] = [];
      for (let index = 0; index < 30; index += 1) {
        const { ids } = await caseWith(prisma, tenantId, [{}], vulnerability('openssl', `ec2:i-${index}`));
        matching.push(...ids);
      }
      const others = [
        await caseWith(prisma, tenantId, [{}], vulnerability('openssl-libs', 'ec2:i-1')),
        await caseWith(prisma, tenantId, [{}], vulnerability('curl', 'ec2:i-1')),
        await caseWith(prisma, tenantId, [{}], { queue: 'vulnerability', family: 'code', keyParts: [] }),
        await caseWith(prisma, tenantId, [{}], {
          ...vulnerability('openssl', 'ec2:i-9'),
          queue: 'posture',
        }),
      ];
      const filter = { queue: 'vulnerability', groupBy: 'package', group: 'openssl' };
      const query = 'queue=vulnerability&groupBy=package&group=openssl';
      const page = await read(app, who, `/v1/cases?${query}&pageSize=5`).expect(200);
      expect((page.body as { total: number }).total).toBe(30);
      const preview = triagePreviewSchema.parse(
        (await read(app, who, `/v1/triage-operations/preview?${query}`).expect(200)).body,
      );
      expect(preview).toEqual({
        cases: 30,
        alerts: 30,
        new: 30,
        investigating: 0,
        pending: { critical: 0, high: 30, medium: 0, low: 0 },
        protectedCases: 0,
        byStatus: {
          new: { critical: 0, high: 30, medium: 0, low: 0 },
          investigating: { critical: 0, high: 0, medium: 0, low: 0 },
        },
      });
      const made = await operate(app, who, statusRequest({ filter }, preview.alerts));
      expect(made).toMatchObject({
        changed: 30,
        target: { kind: 'filter', filter: { ...filter, state: 'pending' } },
      });
      expect(await prisma.finding.count({ where: { id: { in: matching }, status: 'resolved' } })).toBe(30);
      for (const other of others) {
        expect((await findingsById(prisma, other.ids)).get(other.ids[0] as string)?.status).toBe('new');
      }
      // Sem valor: só os casos sem pacote.
      const without = await operate(
        app,
        who,
        statusRequest({ filter: { queue: 'vulnerability', groupBy: 'package' } }, 1),
      );
      expect(without.changed).toBe(1);
    });

    it('cada campo do filtro vale como na lista: os casos da operação são os da lista', async () => {
      const { tenantId, who } = await customer('campos');
      const make = async (
        overrides: Parameters<typeof caseWith>[3],
        findings: Parameters<typeof caseWith>[2] = [{}],
      ) => caseWith(prisma, tenantId, findings, overrides);
      const old = earlier(40 * 86_400_000);
      await make({ queue: 'posture', family: 'control', ruleIds: ['990501'] }, [{ severity: 'medium' }]);
      await make({ accounts: ['999988887777'] }, [{ severity: 'low' }, {}]);
      await make({ mitreTactics: ['Impact'], mitreTechniques: ['T1485'] }, [{ severity: 'high' }]);
      await make({ actors: ['pessoa-que-busco'] }, [{ status: 'investigating' }, {}]);
      await make({ firstSeenAt: old, lastSeenAt: old, lastAlertAt: old, openedAt: old });
      await make({}, [{ status: 'resolved' }]);
      const filters: Record<string, string>[] = [
        { severity: 'medium' },
        { severity: 'low', queue: 'detection' },
        { accountId: '999988887777' },
        { tactic: 'Impact' },
        { technique: 'T1485' },
        { q: 'que-busco' },
        { q: 'que_busco' },
        { source: 'security_hub' },
        { severity: 'high', period: '24h' },
        {
          severity: 'high',
          from: earlier(50 * 86_400_000).toISOString(),
          to: earlier(30 * 86_400_000).toISOString(),
        },
        { severity: 'high', state: 'investigating' },
        { groupBy: 'account', group: CASE_ACCOUNT },
        { groupBy: 'account', group: '9999' },
      ];
      const reached: number[] = [];
      for (const filter of filters) {
        const query = new URLSearchParams(filter).toString();
        const list = (await read(app, who, `/v1/cases?${query}&pageSize=100`).expect(200)).body as {
          items: { id: string }[];
          total: number;
        };
        const listed = list.items.map((item) => item.id).sort();
        const preview = triagePreviewSchema.parse(
          (await read(app, who, `/v1/triage-operations/preview?${query}`).expect(200)).body,
        );
        const pending = await prisma.finding.count({
          where: { tenantId, caseId: { in: listed }, status: { in: ['new', 'investigating'] } },
        });
        expect([preview.cases, preview.alerts], query).toEqual([list.total, pending]);
        reached.push(list.total);
        if (list.total === 0) continue;
        const made = await operate(app, who, statusRequest({ filter }, pending));
        const items = await prisma.triageOperationItem.findMany({
          where: { operationId: made.id },
          select: { finding: { select: { caseId: true } } },
        });
        expect([...new Set(items.map((item) => item.finding.caseId))].sort(), query).toEqual(listed);
        expect(items, query).toHaveLength(pending);
        await undo(app, who, made.id);
      }
      expect(reached).toEqual([1, 1, 1, 1, 1, 1, 0, 1, 3, 1, 1, 4, 0]);
    });

    it('o conjunto do filtro é congelado: o que a própria operação muda no caso não tira os outros alertas dele', async () => {
      const { tenantId, who } = await customer('congelado');
      limits.syncAlerts = 1;
      // O caso só está no filtro por causa do alerta alto; tratado ele, o filtro não acharia mais o caso.
      const { caseId, ids } = await caseWith(prisma, tenantId, [
        { severity: 'high' },
        ...Array.from({ length: 4 }, () => ({ severity: 'medium' as const })),
      ]);
      const made = await operate(app, who, statusRequest({ filter: { severity: 'high' } }, 5), 202);
      expect(made).toMatchObject({ state: 'queued', matched: 5, changed: 0, remaining: 5 });
      await drain(prisma, [tenantId], { batch: 1 });
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', changed: 5, skipped: 0 });
      expect((await caseRow(prisma, caseId)).pending).toBe(false);
      expect([...(await findingsById(prisma, ids)).values()].every((row) => row.status === 'resolved')).toBe(
        true,
      );
    });

    it('o alerta que entra no caso depois do pedido, mesmo com chegada anterior, fica de fora', async () => {
      const { tenantId, who } = await customer('atrasado');
      limits.syncAlerts = 1;
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}, {}]);
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 3), 202);
      // A atribuição atrasada: chegou antes do corte, mas ninguém o viu no caso ao confirmar.
      const late = await insertFinding(prisma, tenantId, { caseId, createdAt: earlier(3_600_000) });
      const newer = await insertFinding(prisma, tenantId, { caseId });
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, made.id)).toMatchObject({ matched: 3, changed: 3 });
      const rows = await findingsById(prisma, [...ids, late, newer]);
      expect([late, newer].map((id) => rows.get(id)?.status)).toEqual(['new', 'new']);
      expect((await caseRow(prisma, caseId)).newCount).toBe(2);
    });

    it('o filtro precisa estreitar além da fila, do estado e do período', async () => {
      for (const filter of [
        {},
        { queue: 'detection' },
        { state: 'pending', queue: 'vulnerability', period: '24h' },
        { period: '30d' },
        { state: 'treated', severity: 'high' },
        { state: 'all', q: 'x' },
        { group: 'openssl' },
        { q: 'x', sort: 'recent' },
        { q: 'x', page: 2 },
        { q: 'x', desconhecido: 'y' },
      ]) {
        const response = await post(app, analystA, '/v1/triage-operations', statusRequest({ filter }, 1));
        expect(response.status, JSON.stringify(filter)).toBe(400);
      }
      await read(app, analystA, '/v1/triage-operations/preview').expect(400);
      await read(app, analystA, '/v1/triage-operations/preview?queue=detection').expect(400);
      await read(app, analystA, '/v1/triage-operations/preview?severity=high&state=all').expect(400);
    });
  });

  describe('confirmação: o tamanho, os críticos e o motivo', () => {
    it('bem mais alertas que o confirmado: 409 com a contagem nova, e nada muda', async () => {
      const { tenantId, who } = await customer('tamanho');
      const { caseId } = await caseWith(prisma, tenantId, []);
      await manyFindings(prisma, tenantId, caseId, 133);
      // 100 confirmados aceitam até 130 (10% e mais 20).
      const refused = await post(
        app,
        who,
        '/v1/triage-operations',
        statusRequest({ caseIds: [caseId] }, 100),
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        code: 'TRIAGE_SCOPE_CHANGED',
        details: { count: 133, excludedCritical: 0 },
      });
      expect(await prisma.triageOperation.count({ where: { tenantId } })).toBe(0);
      expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(133);
      const [failed] = await trail(prisma, tenantId, 'triage.bulk.request');
      expect(failed).toMatchObject({ outcome: 'failure', statusCode: 409, before: null, after: null });
      // Com a contagem nova (ou perto dela), passa. E menos que o confirmado também.
      await prisma.finding.updateMany({
        where: {
          tenantId,
          id: {
            in: (await prisma.finding.findMany({ where: { tenantId }, take: 3, select: { id: true } })).map(
              (row) => row.id,
            ),
          },
        },
        data: { status: 'legitimate' },
      });
      expect(await operate(app, who, statusRequest({ caseIds: [caseId] }, 100))).toMatchObject({
        matched: 130,
        changed: 130,
      });
      const { caseId: small } = await caseWith(prisma, tenantId, [{}]);
      expect(await operate(app, who, statusRequest({ caseIds: [small] }, 9_000))).toMatchObject({
        changed: 1,
      });
    });

    it('o crítico fica de fora sem o includeCritical, e a resposta diz quantos', async () => {
      const { tenantId, who } = await customer('críticos');
      const { caseId, ids } = await caseWith(prisma, tenantId, [
        { severity: 'critical' },
        { severity: 'critical', status: 'investigating' },
        { severity: 'high' },
        { severity: 'low' },
      ]);
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 4));
      expect(made).toMatchObject({
        matched: 2,
        changed: 2,
        excludedCritical: 2,
        includeCritical: false,
        warnings: ['critical_excluded'],
      });
      const rows = await findingsById(prisma, ids);
      expect(ids.map((id) => rows.get(id)?.status)).toEqual(['new', 'investigating', 'resolved', 'resolved']);
      // Só críticos sobraram: o pedido sem confirmar é recusado, dizendo por quê.
      const empty = await post(app, who, '/v1/triage-operations', statusRequest({ caseIds: [caseId] }, 2));
      expect(empty.status).toBe(409);
      expect(empty.body).toMatchObject({
        code: 'TRIAGE_NOTHING_TO_DO',
        details: { count: 0, excludedCritical: 2 },
        message: 'Só há alertas críticos pendentes no alvo. Confirme que eles entram.',
      });
      expect(
        await operate(app, who, statusRequest({ caseIds: [caseId] }, 2, { includeCritical: true })),
      ).toMatchObject({ changed: 2, excludedCritical: 0, includeCritical: true, warnings: [] });
      const [request1] = await trail(prisma, tenantId, 'triage.bulk.request');
      expect(request1?.after).toMatchObject({ excludedCritical: 2, matched: 2 });
      await expectExactCounters(prisma, [tenantId]);
    });

    it('o alerta que fica crítico entre o pedido e o lote não é tocado', async () => {
      const { tenantId, who } = await customer('virou crítico');
      limits.syncAlerts = 1;
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}, {}]);
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 3), 202);
      await prisma.finding.update({ where: { id: ids[1] as string }, data: { severity: 'critical' } });
      await drain(prisma, [tenantId]);
      expect(await operation(app, who, made.id)).toMatchObject({ state: 'done', changed: 2, skipped: 1 });
      expect((await findingsById(prisma, ids)).get(ids[1] as string)).toMatchObject({
        status: 'new',
        triageOpId: null,
      });
    });

    it.each(['legitimate', 'resolved'] as const)('%s em mais de um alerta pede o motivo', async (status) => {
      const { tenantId, who } = await customer(`motivo ${status}`);
      const { caseId, ids } = await caseWith(prisma, tenantId, [{}, {}]);
      const without = { status, reason: undefined };
      const refused = await post(
        app,
        who,
        '/v1/triage-operations',
        statusRequest({ caseIds: [caseId] }, 2, without),
      );
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'TRIAGE_REASON_REQUIRED' });
      expect(await prisma.finding.count({ where: { tenantId, status: 'new' } })).toBe(2);
      // Vazio (ou só espaços) também não vale; com um alerta só, não precisa.
      for (const reason of ['', '   ', 'a\u0000b', 'x'.repeat(501), '\ud800']) {
        await post(
          app,
          who,
          '/v1/triage-operations',
          statusRequest({ caseIds: [caseId] }, 2, { status, reason }),
        ).expect(400);
      }
      expect(await operate(app, who, statusRequest({ findingIds: [ids[0]] }, 1, without))).toMatchObject({
        changed: 1,
        reason: null,
      });
      expect(
        await operate(
          app,
          who,
          statusRequest({ findingIds: [ids[1]] }, 1, { status, reason: '  linha 1\nlinha 2\t' }),
        ),
      ).toMatchObject({ reason: 'linha 1\nlinha 2' });
    });

    it('para em análise ou novo, o motivo é opcional', async () => {
      const { tenantId, who } = await customer('sem motivo');
      const { caseId } = await caseWith(prisma, tenantId, [{}, {}]);
      const without = { reason: undefined };
      await operate(
        app,
        who,
        statusRequest({ caseIds: [caseId] }, 2, { ...without, status: 'investigating' }),
      );
      await operate(app, who, statusRequest({ caseIds: [caseId] }, 2, { ...without, status: 'new' }));
    });

    it('alvo sem nada pendente: 409, e nenhuma operação fica', async () => {
      const { tenantId, who } = await customer('vazio');
      const { caseId } = await caseWith(prisma, tenantId, [{ status: 'resolved' }]);
      const refused = await post(app, who, '/v1/triage-operations', statusRequest({ caseIds: [caseId] }, 1));
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'TRIAGE_NOTHING_TO_DO' });
      expect(await prisma.triageOperation.count({ where: { tenantId } })).toBe(0);
    });

    it('o corpo fora do contrato é 400 e não grava nada', async () => {
      const id = randomUUID();
      const good = statusRequest({ caseIds: [id] }, 1);
      const bad: object[] = [
        {},
        { ...good, action: 'undo' },
        { ...good, action: 'delete' },
        { ...good, status: 'closed' },
        { ...good, status: undefined },
        { ...good, requestId: 'abc' },
        { ...good, requestId: undefined },
        { ...good, expectedCount: -1 },
        { ...good, expectedCount: 1.5 },
        { ...good, expectedCount: '1' },
        { ...good, expectedCount: undefined },
        { ...good, target: {} },
        { ...good, target: { caseIds: [] } },
        { ...good, target: { caseIds: [id, id] } },
        { ...good, target: { caseIds: [id, id.toUpperCase()] } },
        { ...good, target: { caseIds: Array.from({ length: 51 }, () => randomUUID()) } },
        { ...good, target: { caseIds: ['x'] } },
        { ...good, target: { caseIds: [id], findingIds: [id] } },
        { ...good, target: { findingIds: Array.from({ length: 501 }, () => randomUUID()) } },
        { ...good, target: { findingIds: [] } },
        { ...good, target: { caseIds: [id], group: '' } },
        { ...good, target: { caseIds: [id], group: 'a\u0000' } },
        { ...good, target: { findingIds: [id], group: 'a' } },
        { ...good, target: { userId: 'x' } },
        { ...good, includeCritical: 'sim' },
        { ...good, tenantId: tenantB },
        { ...good, incidentId: id },
        { ...good, action: 'attach', status: undefined },
        { ...good, action: 'promote' },
        { requestId: id, action: 'undo_all_of', target: { userId: 'x' } },
        { requestId: id, action: 'undo_all_of', target: { caseIds: [id] }, reason: 'x' },
      ];
      for (const body of bad) {
        const response = await post(app, adminA, '/v1/triage-operations', body);
        expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(400);
      }
      await post(app, adminA, `/v1/triage-operations/${id}/undo`, {}).expect(400);
      await post(app, adminA, `/v1/triage-operations/abc/undo`, { requestId: id }).expect(400);
      await post(app, adminA, `/v1/triage-operations/${id}/cancel`, { x: 1 }).expect(400);
      await read(app, adminA, '/v1/triage-operations?state=done').expect(400);
      await read(app, adminA, '/v1/triage-operations/abc').expect(400);
    });
  });
});
