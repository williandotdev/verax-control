import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  type CaseDetail,
  caseDetailSchema,
  casePageSchema,
  type CaseSummary,
  MAX_TRIAGE_AUTHORS,
  ROLES,
  type TriageAuthors,
  triageAuthorsSchema,
  triageFilterSchema,
  type TriagePreview,
  triagePreviewSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TriageOperationsService } from '../src/cases/triage-operations.service.js';
import type { RequestAuth } from '../src/common/auth/request-auth.js';
import { requestContext } from '../src/common/context/request-context.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { createTenant, createUser } from './support/auth-helpers.js';
import { findingsOfCase, isPendingFinding, noTally, seeded, seedWorld } from './support/case-world.js';
import {
  assignAll,
  casesOf,
  cleanCases,
  findingData,
  HOUR_MS,
  insertFinding,
  insertOperation,
} from './support/cases.js';
import { createApp } from './support/create-app.js';
import {
  caseWith,
  operate,
  operation,
  type Operator,
  operatorFor,
  post,
  read,
  statusRequest,
  undo,
} from './support/triage.js';

const DAY_MS = 24 * HOUR_MS;

/** O que a tela dos casos precisava e a API não dizia. */
describe('casos: o que a tela pedia à API', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];

  async function customer(name: string, role: Operator['role'] = 'analista_cliente') {
    const tenantId = await createTenant(app, `Cliente Demo (tela: ${name})`);
    tenants.push(tenantId);
    return { tenantId, who: await operatorFor(app, tenantId, role) };
  }
  const detail = async (who: Operator, id: string): Promise<CaseDetail> =>
    caseDetailSchema.parse((await read(app, who, `/v1/cases/${id}`).expect(200)).body);
  const listed = async (who: Operator, query = 'state=all'): Promise<CaseSummary[]> =>
    casePageSchema.parse((await read(app, who, `/v1/cases?pageSize=100&${query}`).expect(200)).body).items;

  beforeAll(async () => {
    app = await createApp({ casesMode: 'on' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  describe('as operações no detalhe do caso dizem o que se pode fazer', () => {
    it(
      'a mesma resposta de `/v1/triage-operations`, em todo estado, ação e papel',
      { timeout: 60_000 },
      async () => {
        const { tenantId, who } = await customer('operações');
        const colleague = await operatorFor(app, tenantId, 'analista_cliente');
        const people = [who, colleague];
        for (const role of ['admin_cliente', 'leitura', 'admin_verax'] as const) {
          people.push(await operatorFor(app, tenantId, role));
        }
        const soon = new Date(Date.now() + HOUR_MS);
        const past = new Date(Date.now() - HOUR_MS);
        const groups: string[][] = [];
        const seed = async (overrides: Parameters<typeof insertOperation>[2]) =>
          insertOperation(prisma, tenantId, {
            changed: 2,
            matched: 3,
            undoUntil: soon,
            createdById: who.userId,
            ...overrides,
          });
        for (const state of [
          'queued',
          'running',
          'done',
          'partial',
          'failed',
          'canceled',
          'undoing',
          'undone',
        ] as const) {
          groups.push([
            await seed({ state }),
            await seed({ state, undoUntil: past }),
            await seed({ state, changed: 0 }),
            await seed({ state, action: 'promote', status: null }),
            await seed({ state, action: 'attach', status: null, createdById: null }),
          ]);
        }
        const promoted = await seed({ state: 'undone', action: 'promote', status: null });
        groups.push([
          await seed({ state: 'partial', action: 'undo', status: null, undoOfId: promoted, undoUntil: null }),
          await seed({ state: 'done', action: 'undo_all_of', status: null, undoUntil: null }),
        ]);
        let offered = 0;
        for (const ids of groups) {
          const { caseId } = await caseWith(
            prisma,
            tenantId,
            ids.map((triageOpId) => ({ triageOpId })),
          );
          for (const person of people) {
            const { operations } = await detail(person, caseId);
            expect(operations.length).toBeGreaterThanOrEqual(ids.length);
            for (const { id, can } of operations) {
              const alone = await operation(app, person, id);
              expect(can, `${person.role} ${alone.action} ${alone.state}`).toEqual(alone.can);
              offered += Object.values(can ?? {}).filter(Boolean).length;
            }
          }
        }
        expect(offered).toBeGreaterThan(20);
      },
    );

    it('o que a resposta oferece, a rota aceita; o que não oferece, ela recusa', async () => {
      const { tenantId, who } = await customer('oferecer e aceitar');
      const { caseId } = await caseWith(prisma, tenantId, [{}, {}]);
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 2));
      const colleague = await operatorFor(app, tenantId, 'analista_cliente');
      expect((await detail(colleague, caseId)).operations).toMatchObject([
        { id: made.id, can: { cancel: false, continue: false, undo: false } },
      ]);
      await post(app, colleague, `/v1/triage-operations/${made.id}/undo`, { requestId: randomUUID() }).expect(
        403,
      );
      expect((await detail(who, caseId)).operations).toMatchObject([
        { id: made.id, can: { cancel: false, continue: false, undo: true } },
      ]);
      await undo(app, who, made.id);
      const after = await detail(who, caseId);
      expect(after.operations.map(({ can }) => can?.undo)).toEqual([false, false]);
      expect(after.can).toEqual({ triage: true, promote: true });
    });
  });

  describe('prévia de um filtro: protegidos e status por severidade', () => {
    const previewOf = async (who: Operator, query: string): Promise<TriagePreview> =>
      triagePreviewSchema.parse(
        (await read(app, who, `/v1/triage-operations/preview?${query}`).expect(200)).body,
      );

    it.each([4, 17, 60])(
      'cliente sorteado %i: contra a lista e os alertas',
      { timeout: 60_000 },
      async (seed) => {
        const { tenantId, who } = await customer(`prévia ${seed}`);
        const world = await seedWorld(prisma, tenantId, { seed, now: new Date(), cases: 40 });
        await prisma.protectedResource.create({
          data: {
            tenantId,
            type: 's3_bucket',
            identifier: 'bucket-protegido',
            reason: 'teste',
            createdById: who.userId,
          },
        });
        for (const query of [
          'q=fict%C3%ADcio',
          'severity=high',
          'severity=critical&queue=detection',
          'source=inspector',
          'q=bucket-protegido',
          'state=investigating&q=fict%C3%ADcio',
          'severity=low&period=7d',
          'q=nada-disso',
        ]) {
          const rows = await listed(who, query);
          const preview = await previewOf(who, query);
          expect(preview.cases, query).toBe(rows.length);
          expect(preview.protectedCases, query).toBe(rows.filter((row) => row.protected).length);
          const expected = { new: noTally(), investigating: noTally() };
          for (const row of rows) {
            for (const finding of findingsOfCase(world, row.id).filter(isPendingFinding)) {
              expected[finding.status as 'new' | 'investigating'][finding.severity] += 1;
            }
          }
          expect(preview.byStatus, query).toEqual(expected);
          const sum = (tally: Record<string, number>) => Object.values(tally).reduce((a, b) => a + b, 0);
          expect([sum(expected.new), sum(expected.investigating)], query).toEqual([
            preview.new,
            preview.investigating,
          ]);
          for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
            expect(preview.pending[severity], query).toBe(
              expected.new[severity] + expected.investigating[severity],
            );
          }
        }
      },
    );

    it('o que a prévia diz é o que a operação muda: sem os críticos, e sem quem já está em análise', async () => {
      const { tenantId, who } = await customer('prévia e operação');
      await caseWith(
        prisma,
        tenantId,
        [
          { severity: 'critical' },
          { severity: 'critical', status: 'investigating' },
          { severity: 'high' },
          { severity: 'high' },
          { severity: 'high', status: 'investigating' },
        ],
        { actors: ['pessoa-da-previa'] },
      );
      const { byStatus } = await previewOf(who, 'q=pessoa-da-previa');
      expect(byStatus).toEqual({
        new: { critical: 1, high: 2, medium: 0, low: 0 },
        investigating: { critical: 1, high: 1, medium: 0, low: 0 },
      });
      const made = await operate(
        app,
        who,
        statusRequest({ filter: { q: 'pessoa-da-previa' } }, 2, { status: 'investigating' }),
      );
      expect(made).toMatchObject({ matched: byStatus?.new.high, changed: 2 });
    });

    it('passou do prazo do banco: a prévia vem sem o status por severidade', async () => {
      const { tenantId, who } = await customer('prévia lenta');
      await caseWith(prisma, tenantId, [{}, { status: 'investigating' }], { actors: ['pessoa-lenta'] });
      const service = app.get(TriageOperationsService);
      const auth = { role: who.role, userId: who.userId, scopeTenantId: tenantId } as unknown as RequestAuth;
      const preview = () =>
        requestContext.run({ auth }, () => service.preview(triageFilterSchema.parse({ q: 'pessoa-lenta' })));
      expect((await preview()).byStatus).toBeDefined();
      vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('prazo', {
          code: 'P2010',
          clientVersion: 'teste',
          meta: { driverAdapterError: { cause: { originalCode: '57014' } } },
        }),
      );
      expect(await preview()).toEqual({
        cases: 1,
        alerts: 2,
        new: 1,
        investigating: 1,
        pending: { critical: 0, high: 2, medium: 0, low: 0 },
        protectedCases: 0,
      });
      // Outra falha não é escondida.
      vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('o banco caiu'));
      await expect(preview()).rejects.toThrow('o banco caiu');
    });

    it('A/B: os protegidos, os casos e os alertas do outro cliente não entram', async () => {
      const a = await customer('prévia A');
      const b = await customer('prévia B');
      for (const { tenantId, who } of [a, b]) {
        await caseWith(prisma, tenantId, [{}], { actors: ['mesma-pessoa'], resources: ['bucket-do-b'] });
        void who;
      }
      await prisma.protectedResource.create({
        data: {
          tenantId: b.tenantId,
          type: 's3_bucket',
          identifier: 'bucket-do-b',
          reason: 'teste',
          createdById: b.who.userId,
        },
      });
      expect(await previewOf(a.who, 'q=mesma-pessoa')).toMatchObject({
        cases: 1,
        alerts: 1,
        protectedCases: 0,
      });
      expect(await previewOf(b.who, 'q=mesma-pessoa')).toMatchObject({
        cases: 1,
        alerts: 1,
        protectedCases: 1,
      });
    });

    it('a prévia conta como protegido o caso que só toca a chave de acesso protegida', async () => {
      const { tenantId, who } = await customer('prévia da chave');
      const key = 'DEMOCHAVEDEACESSO4';
      await caseWith(prisma, tenantId, [{}], { actors: ['dono-da-chave'], accessKeys: [key] });
      await caseWith(prisma, tenantId, [{}], { actors: ['dono-da-chave'] });
      await prisma.protectedResource.create({
        data: { tenantId, type: 'access_key', identifier: key, reason: 'teste', createdById: who.userId },
      });
      expect(await previewOf(who, 'q=dono-da-chave')).toMatchObject({ cases: 2, protectedCases: 1 });
    });
  });

  describe('quem pediu operações nos últimos 30 dias', () => {
    const authorsOf = async (who: Operator): Promise<TriageAuthors> =>
      triageAuthorsSchema.parse((await read(app, who, '/v1/triage-operations/authors').expect(200)).body);

    it('cada pessoa uma vez, do pedido mais recente para trás; só o id e o nome', async () => {
      const { tenantId, who } = await customer('autores');
      const person = async (name: string) =>
        (await createUser(app, { role: 'analista_cliente', tenantId, name })).id;
      const ana = await person('Ana Demo');
      const bia = await person('Bia Demo');
      const old = await person('Pessoa Antiga Demo');
      const at = (days: number) => new Date(Date.now() - days * DAY_MS);
      for (const [createdById, days] of [
        [ana, 12],
        [bia, 5],
        [ana, 1],
        [bia, 20],
        [old, 30.01],
        [null, 2],
      ] as const) {
        await insertOperation(prisma, tenantId, { createdById, createdAt: at(days) });
      }
      const edge = await person('Na Ponta Demo');
      await insertOperation(prisma, tenantId, { createdById: edge, createdAt: at(29.99) });
      expect(await authorsOf(who)).toEqual({
        items: [
          { id: ana, name: 'Ana Demo' },
          { id: bia, name: 'Bia Demo' },
          { id: edge, name: 'Na Ponta Demo' },
        ],
        truncated: false,
      });
      // O filtro da lista aceita o id.
      const page = await read(app, who, `/v1/triage-operations?authorId=${bia}`).expect(200);
      expect((page.body as { total: number }).total).toBe(2);
    });

    it('o desfazer também conta, com quem o pediu', async () => {
      const { tenantId, who } = await customer('autor do desfazer');
      const admin = await operatorFor(app, tenantId, 'admin_cliente');
      const { caseId } = await caseWith(prisma, tenantId, [{}, {}]);
      const made = await operate(app, who, statusRequest({ caseIds: [caseId] }, 2));
      expect((await authorsOf(who)).items.map(({ id }) => id)).toEqual([who.userId]);
      await undo(app, admin, made.id);
      expect((await authorsOf(who)).items.map(({ id }) => id)).toEqual([admin.userId, who.userId]);
    });

    it('no máximo cem, os mais recentes, e diz que há mais', { timeout: 60_000 }, async () => {
      const { tenantId, who } = await customer('muitos autores');
      const people = Array.from({ length: MAX_TRIAGE_AUTHORS + 2 }, (_, index) => ({
        id: randomUUID(),
        name: `Pessoa Demo ${index}`,
        email: `autor-${randomUUID()}@cliente.example`,
        emailVerified: true,
        role: 'analista_cliente' as const,
        status: 'active' as const,
        tenantId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      await prisma.user.createMany({ data: people });
      await prisma.triageOperation.createMany({
        data: people.map(({ id }, index) => ({
          tenantId,
          requestId: randomUUID(),
          action: 'status',
          status: 'resolved' as const,
          target: { caseIds: [] },
          cutoffAt: new Date(),
          expectedCount: 0,
          state: 'done',
          createdById: id,
          createdAt: new Date(Date.now() - index * 60_000),
        })),
      });
      const { items, truncated } = await authorsOf(who);
      expect(truncated).toBe(true);
      expect(items.map(({ id }) => id)).toEqual(people.slice(0, MAX_TRIAGE_AUTHORS).map(({ id }) => id));
    });

    it('A/B, papéis, sem sessão e sem cliente', async () => {
      const a = await customer('autores A');
      const b = await customer('autores B');
      await insertOperation(prisma, b.tenantId, { createdById: b.who.userId });
      expect(await authorsOf(a.who)).toEqual({ items: [], truncated: false });
      expect((await authorsOf(b.who)).items).toHaveLength(1);
      for (const role of ROLES) {
        const who = await operatorFor(app, a.tenantId, role);
        await read(app, who, '/v1/triage-operations/authors').expect(200);
        await read(app, who, '/v1/triage-operations/authors?x=1').expect(400);
      }
      await request(app.getHttpServer()).get('/v1/triage-operations/authors').expect(401);
    });
  });

  describe('voltou depois de tratado', () => {
    /** As voltas depois de tratado, andando pela corrente dos casos anteriores. */
    async function chainOf(tenantId: string): Promise<Map<string, number>> {
      const rows = await casesOf(prisma, tenantId);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return new Map(
        rows.map((row) => {
          let treated = 0;
          for (
            let before = row.previousCaseId === null ? undefined : byId.get(row.previousCaseId);
            before;
            before = before.previousCaseId === null ? undefined : byId.get(before.previousCaseId)
          ) {
            if (before.sealReason === 'treated') treated += 1;
          }
          return [row.id, treated];
        }),
      );
    }

    it.each([8, 21, 34])(
      'sequência sorteada %i: a lista e o detalhe batem com a corrente',
      { timeout: 120_000 },
      async (seed) => {
        const { tenantId, who } = await customer(`voltas ${seed}`);
        const random = seeded(seed);
        let at = Date.now() - 60 * DAY_MS;
        for (let step = 0; step < 26; step += 1) {
          // Ora dentro da janela do caso, ora depois dela (24 h de silêncio).
          at +=
            random() < 0.5
              ? Math.floor(random() * 10 * HOUR_MS)
              : 25 * HOUR_MS + Math.floor(random() * 40 * HOUR_MS);
          const actorUser = `pessoa-${Math.floor(random() * 2)}`;
          const vulnerability = random() < 0.3;
          await prisma.finding.create({
            data: findingData(tenantId, {
              actorUser,
              createdAt: new Date(at),
              ...(vulnerability && {
                logSource: 'inspector',
                ruleId: '990511',
                title: 'Vulnerabilidade em pacote: CVE-2099-1 - openssl',
                resource: 'i-0a1b2c3d4e5f67890',
                caseGroup: 'openssl',
              }),
            }),
          });
          await assignAll(prisma, [tenantId]);
          if (random() < 0.4) {
            await prisma.finding.updateMany({
              where: { tenantId, actorUser, status: 'new' },
              data: { status: 'resolved', triagedAt: new Date(at + 60_000) },
            });
          }
        }
        const expected = await chainOf(tenantId);
        const rows = await listed(who);
        expect(rows).toHaveLength(expected.size);
        expect(rows.some((row) => (row.recurrenceTreated ?? 0) > 0)).toBe(true);
        expect(rows.some((row) => row.recurrence > (row.recurrenceTreated ?? 0))).toBe(true);
        for (const row of rows) {
          expect(row.recurrenceTreated, row.id).toBe(expected.get(row.id));
          expect(row.recurrenceTreated).toBeLessThanOrEqual(row.recurrence);
        }
        for (const row of rows.slice(0, 5)) {
          const one = await detail(who, row.id);
          expect(one.recurrenceTreated).toBe(row.recurrenceTreated);
          if (one.previous.length < 10) {
            expect(one.previous.filter(({ sealReason }) => sealReason === 'treated')).toHaveLength(
              one.recurrenceTreated ?? -1,
            );
          }
        }
      },
    );

    it('a janela que passou não é "depois de tratado"; o tratado é; o dividido herda', async () => {
      const { tenantId, who } = await customer('janela e tratado');
      const at = (days: number) => new Date(Date.now() - days * DAY_MS);
      const arrive = async (days: number) => {
        await insertFinding(prisma, tenantId, { createdAt: at(days) });
        await assignAll(prisma, [tenantId]);
      };
      const last = async () => (await casesOf(prisma, tenantId)).at(-1)?.id ?? '';
      const countsOf = async () => {
        const row = (await listed(who)).find(({ id }) => id === newest);
        return [row?.recurrence, row?.recurrenceTreated];
      };
      await arrive(20);
      let newest = await last();
      expect(await countsOf()).toEqual([0, 0]);
      // Dez dias de silêncio: a janela passou, e o anterior continua pendente.
      await arrive(10);
      newest = await last();
      expect(await countsOf()).toEqual([1, 0]);
      await prisma.finding.updateMany({
        where: { caseId: newest },
        data: { status: 'resolved', triagedAt: at(9) },
      });
      await arrive(8.9);
      newest = await last();
      expect(await countsOf()).toEqual([2, 1]);
      await arrive(8.8);
      const rows = await prisma.finding.findMany({ where: { caseId: newest }, select: { id: true } });
      expect(rows).toHaveLength(2);
      const split = await post(app, who, `/v1/cases/${newest}/split`, { findingIds: [rows[0]?.id] }).expect(
        201,
      );
      const { caseId } = split.body as { caseId: string };
      const divided = (await listed(who)).find(({ id }) => id === caseId);
      expect([divided?.recurrence, divided?.recurrenceTreated]).toEqual([2, 1]);
      expect(await countsOf()).toEqual([2, 1]);
    });

    it('A/B: a mesma chave no outro cliente não conta', async () => {
      const a = await customer('volta A');
      const b = await customer('volta B');
      for (const { tenantId } of [a, b]) {
        await insertFinding(prisma, tenantId, { createdAt: new Date(Date.now() - 3 * HOUR_MS) });
        await assignAll(prisma, [tenantId]);
        if (tenantId === b.tenantId) {
          await prisma.finding.updateMany({
            where: { tenantId },
            data: { status: 'resolved', triagedAt: new Date(Date.now() - 2 * HOUR_MS) },
          });
        }
        await insertFinding(prisma, tenantId, { createdAt: new Date(Date.now() - HOUR_MS) });
        await assignAll(prisma, [tenantId]);
      }
      // Em A, o segundo alerta entrou no mesmo caso; finge-se a volta para a conta ter o que procurar.
      const [own] = await casesOf(prisma, a.tenantId);
      await prisma.alertCase.update({ where: { id: own?.id ?? '' }, data: { recurrence: 3 } });
      expect((await listed(a.who)).map((row) => row.recurrenceTreated)).toEqual([0]);
      expect((await listed(b.who)).map((row) => row.recurrenceTreated).sort()).toEqual([0, 1]);
    });

    it('nunca passa das voltas, e cada caso tem a própria conta', async () => {
      const { tenantId, who } = await customer('limite');
      const groupKey = 'a'.repeat(64);
      const at = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
      for (const [hours, reason] of [
        [50, 'treated'],
        [40, 'treated'],
        [30, 'window'],
        [20, 'treated'],
      ] as const) {
        await caseWith(prisma, tenantId, [{ status: 'resolved' }], {
          groupKey,
          openedAt: at(hours),
          sealedAt: at(hours - 5),
          sealReason: reason,
        });
      }
      // Uma volta só gravada: a conta não passa dela.
      const { caseId: capped } = await caseWith(prisma, tenantId, [{}], {
        groupKey,
        openedAt: at(10),
        recurrence: 1,
      });
      const { caseId: middle } = await caseWith(prisma, tenantId, [{}], {
        groupKey,
        openedAt: at(35),
        sealedAt: at(34),
        sealReason: 'window',
        recurrence: 9,
      });
      const other = await caseWith(prisma, tenantId, [{}], { recurrence: 5 });
      const rows = new Map((await listed(who)).map((row) => [row.id, row.recurrenceTreated]));
      expect(rows.get(capped)).toBe(1);
      expect(rows.get(middle)).toBe(2);
      expect(rows.get(other.caseId)).toBe(0);
    });
  });
});
