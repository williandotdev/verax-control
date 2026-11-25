import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  type CaseDetail,
  caseDetailSchema,
  type CaseGroup,
  caseGroupPageSchema,
  casePageSchema,
  caseStatusSchema,
  type CaseSummary,
  findingTriageSchema,
  ROLES,
  type Role,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASE_ASSIGN_TASK } from '../src/cases/case-assign-job.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import {
  assignAll,
  CASE_ACCOUNT,
  cleanCases,
  HOUR_MS,
  insertCase,
  insertFinding,
  insertIncident,
  insertOperation,
} from './support/cases.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { describeTenantIsolation, type TestSession } from './support/tenant-isolation.js';

/** A leitura dos casos com `CASES_MODE=on`: a lista, os grupos, o detalhe, a trilha de um alerta e a situação. */
describe('leitura dos casos', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let analystA: TestSession;
  let analystB: TestSession;
  const tenants: string[] = [];
  const cookies = new Map<Role, string>();

  const newTenant = async (name: string): Promise<string> => {
    const id = await createTenant(app, `Cliente Demo (casos: ${name})`);
    tenants.push(id);
    return id;
  };

  async function sessionFor(tenantId: string, role: Role): Promise<TestSession> {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token };
  }

  const get = (cookie: string, path: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie);

  /** Um cliente novo e o GET de quem só lê nele: cada teste de filtro vê só os próprios casos. */
  async function reader(name: string) {
    const tenantId = await newTenant(name);
    const { cookie } = await sessionFor(tenantId, 'leitura');
    const list = async (query = ''): Promise<CaseSummary[]> =>
      casePageSchema.parse((await get(cookie, `/v1/cases?pageSize=100&${query}`).expect(200)).body).items;
    return {
      tenantId,
      cookie,
      list,
      ids: async (query = '') => (await list(query)).map((item) => item.id),
      titles: async (query = '') => (await list(query)).map((item) => item.title),
      detail: async (id: string): Promise<CaseDetail> =>
        caseDetailSchema.parse((await get(cookie, `/v1/cases/${id}`).expect(200)).body),
      groups: async (query: string): Promise<CaseGroup[]> =>
        caseGroupPageSchema.parse(
          (await get(cookie, `/v1/cases/groups?pageSize=100&${query}`).expect(200)).body,
        ).items,
    };
  }

  /** Um caso com um alerta pendente (ou o que vier). */
  async function caseWith(
    tenantId: string,
    overrides: Partial<Prisma.AlertCaseUncheckedCreateInput> = {},
    findings: Partial<Prisma.FindingUncheckedCreateInput>[] = [{}],
  ): Promise<string> {
    const id = await insertCase(prisma, tenantId, overrides);
    for (const finding of findings) await insertFinding(prisma, tenantId, { caseId: id, ...finding });
    return id;
  }

  beforeAll(async () => {
    app = await createApp({ casesMode: 'on' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantA = await newTenant('A');
    tenantB = await newTenant('B');
    analystA = await sessionFor(tenantA, 'analista_cliente');
    analystB = await sessionFor(tenantB, 'analista_cliente');
    for (const role of ['admin_cliente', 'analista_cliente', 'leitura'] as const) {
      cookies.set(role, (await createSignedInUser(app, { role, tenantId: tenantA })).cookie);
    }
    const verax = await createSignedInUser(app, { role: 'admin_verax' });
    const { cookie, token } = await withCsrf(app, verax.cookie);
    await request(app.getHttpServer())
      .post('/v1/session/tenant')
      .set('Cookie', cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', token)
      .send({ tenantId: tenantA })
      .expect(200);
    cookies.set('admin_verax', cookie);
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  describeTenantIsolation({
    resource: 'casos',
    basePath: '/v1/cases',
    context: () => ({ app, sessionA: analystA, sessionB: analystB }),
    createInTenantB: () => caseWith(tenantB),
    readDirect: (id) => prisma.alertCase.findUniqueOrThrow({ where: { id } }),
  });

  describe('isolamento em cada rota', () => {
    const withoutId = (body: object) => ({ ...body, requestId: undefined });

    it('o caso e o alerta do outro cliente respondem como os que não existem', async () => {
      const caseB = await caseWith(tenantB, { actors: ['segredo-do-cliente-b'] });
      const { id: findingB } = await prisma.finding.findFirstOrThrow({ where: { caseId: caseB } });
      for (const [path, missing] of [
        [`/v1/cases/${caseB}`, `/v1/cases/${randomUUID()}`],
        [`/v1/cases/${caseB}/findings`, `/v1/cases/${randomUUID()}/findings`],
        [`/v1/cases/${caseB}/timeline`, `/v1/cases/${randomUUID()}/timeline`],
        [`/v1/findings/${findingB}/triage`, `/v1/findings/${randomUUID()}/triage`],
      ] as const) {
        const other = await get(analystA.cookie, path).expect(404);
        const none = await get(analystA.cookie, missing).expect(404);
        expect(withoutId(other.body as object), path).toEqual(withoutId(none.body as object));
        expect(JSON.stringify(other.body)).not.toContain(caseB);
        await get(analystB.cookie, path).expect(200);
      }
    });

    it('a busca, os filtros e os grupos nunca alcançam o outro cliente', async () => {
      const marker = `marca-${randomUUID()}`;
      const caseB = await caseWith(
        tenantB,
        {
          queue: 'vulnerability',
          family: 'package',
          keyParts: [
            { name: 'package', value: marker },
            { name: 'resource', value: marker },
          ],
          accounts: ['999988887777'],
          actors: [marker],
          ips: ['203.0.113.201'],
          resources: [marker],
          ruleIds: ['990511'],
          mitreTactics: ['Impact'],
          mitreTechniques: ['T1485'],
        },
        [{ severity: 'critical', logSource: 'inspector', ruleId: '990511', accountId: '999988887777' }],
      );
      const queries = [
        `q=${marker}`,
        'q=203.0.113.201',
        `groupBy=package&group=${marker}`,
        `groupBy=resource&group=${marker}`,
        'groupBy=account&group=999988887777',
        'accountId=999988887777',
        'tactic=Impact&technique=T1485',
        'source=inspector&queue=vulnerability&severity=critical',
        'state=all&sort=recent&pageSize=100',
      ];
      for (const query of queries) {
        const mine = await get(analystA.cookie, `/v1/cases?${query}`).expect(200);
        expect(JSON.stringify(mine.body), query).not.toContain(caseB);
        const theirs = await get(analystB.cookie, `/v1/cases?${query}`).expect(200);
        expect(JSON.stringify(theirs.body), query).toContain(caseB);
      }
      for (const by of ['package', 'resource', 'account']) {
        const mine = await get(analystA.cookie, `/v1/cases/groups?by=${by}`).expect(200);
        expect(mine.body, by).toMatchObject({ items: [], total: 0 });
        const theirs = await get(analystB.cookie, `/v1/cases/groups?by=${by}`).expect(200);
        expect(JSON.stringify(theirs.body)).toContain(by === 'account' ? '999988887777' : marker);
      }
    });

    it('dois clientes com a mesma chave e os mesmos valores: cada um vê o seu', async () => {
      const values = { groupKey: 'a'.repeat(64), actors: ['pessoa-comum'], ips: ['198.51.100.9'] };
      const a = await caseWith(tenantA, values, [{ actorUser: 'pessoa-comum', sourceIp: '198.51.100.9' }]);
      const b = await caseWith(tenantB, values, [
        { actorUser: 'pessoa-comum', sourceIp: '198.51.100.9' },
        { actorUser: 'pessoa-comum', sourceIp: '198.51.100.9' },
      ]);
      const own = await get(analystA.cookie, '/v1/cases?q=pessoa-comum').expect(200);
      expect(casePageSchema.parse(own.body).items.map((item) => item.id)).toEqual([a]);
      const detail = caseDetailSchema.parse((await get(analystA.cookie, `/v1/cases/${a}`).expect(200)).body);
      expect(detail.analysis).toMatchObject({ alerts: 1, rare: { ips: { values: [{ count: 1 }] } } });
      const other = caseDetailSchema.parse((await get(analystB.cookie, `/v1/cases/${b}`).expect(200)).body);
      expect(other.analysis).toMatchObject({ alerts: 2, rare: { ips: { values: [{ count: 2 }] } } });
    });

    it('a ligação com o caso anterior de outro cliente não é seguida', async () => {
      const caseB = await caseWith(tenantB);
      const bridge = await caseWith(tenantA, { previousCaseId: caseB, recurrence: 1 });
      const detail = caseDetailSchema.parse(
        (await get(analystA.cookie, `/v1/cases/${bridge}`).expect(200)).body,
      );
      expect(detail.previous).toEqual([]);
      // Nem no segundo passo da corrente.
      const next = await caseWith(tenantA, { previousCaseId: bridge, recurrence: 2 });
      const second = caseDetailSchema.parse(
        (await get(analystA.cookie, `/v1/cases/${next}`).expect(200)).body,
      );
      expect(second.previous.map((item) => item.id)).toEqual([bridge]);
    });

    it('a operação do outro cliente num alerta (dado corrompido) não aparece', async () => {
      const operationB = await insertOperation(prisma, tenantB, { reason: 'motivo do cliente B' });
      const id = await caseWith(tenantA, {}, [{ triageOpId: operationB }]);
      const { id: findingId } = await prisma.finding.findFirstOrThrow({ where: { caseId: id } });
      const detail = caseDetailSchema.parse((await get(analystA.cookie, `/v1/cases/${id}`).expect(200)).body);
      expect(detail.operations).toEqual([]);
      const trail = await get(analystA.cookie, `/v1/findings/${findingId}/triage`).expect(200);
      expect(trail.body).toEqual({ operation: null, operations: [] });
    });
  });

  describe('papéis', () => {
    it('sem sessão, 401 em todas as rotas', async () => {
      const id = randomUUID();
      for (const path of [
        '/v1/cases/status',
        '/v1/cases',
        '/v1/cases/groups?by=package',
        `/v1/cases/${id}`,
        `/v1/cases/${id}/findings`,
        `/v1/cases/${id}/timeline`,
        `/v1/findings/${id}/triage`,
      ]) {
        await request(app.getHttpServer()).get(path).expect(401);
      }
    });

    it.each(ROLES)('%s lê todas as rotas do cliente da sessão', async (role) => {
      const cookie = cookies.get(role) ?? '';
      const id = await caseWith(tenantA);
      const { id: findingId } = await prisma.finding.findFirstOrThrow({ where: { caseId: id } });
      for (const path of [
        '/v1/cases/status',
        '/v1/cases',
        '/v1/cases/groups?by=package',
        `/v1/cases/${id}`,
        `/v1/cases/${id}/findings`,
        `/v1/cases/${id}/timeline`,
        `/v1/findings/${findingId}/triage`,
      ]) {
        await get(cookie, path).expect(200);
      }
      const detail = caseDetailSchema.parse((await get(cookie, `/v1/cases/${id}`).expect(200)).body);
      const operator = role !== 'leitura';
      expect(detail.can).toEqual({ triage: operator, promote: operator });
    });

    it('nenhuma rota dos casos aceita escrita', async () => {
      const id = await caseWith(tenantA);
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        for (const path of ['/v1/cases', `/v1/cases/${id}`, `/v1/cases/${id}/findings`]) {
          const server = request(app.getHttpServer());
          await server[method](path)
            .set('Cookie', analystA.cookie)
            .set('Origin', TEST_WEB_ORIGIN)
            .set('X-CSRF-Token', analystA.csrfToken)
            .expect(404);
        }
      }
    });

    it('a equipe da Verax sem cliente escolhido recebe 409 nos dados, e a situação sem atraso', async () => {
      const verax = await createSignedInUser(app, { role: 'admin_verax' });
      const id = randomUUID();
      for (const path of [
        '/v1/cases',
        '/v1/cases/groups?by=package',
        `/v1/cases/${id}`,
        `/v1/cases/${id}/findings`,
        `/v1/cases/${id}/timeline`,
        `/v1/findings/${id}/triage`,
      ]) {
        const response = await get(verax.cookie, path).expect(409);
        expect(response.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      }
      const status = caseStatusSchema.parse((await get(verax.cookie, '/v1/cases/status').expect(200)).body);
      expect(status).toMatchObject({ mode: 'on', oldestUnassignedMinutes: null });
    });
  });

  describe('a situação', () => {
    it('o atraso é o do alerta pendente mais antigo sem caso, de qualquer severidade, do próprio cliente', async () => {
      const { tenantId, cookie } = await reader('situação');
      const status = async () =>
        caseStatusSchema.parse((await get(cookie, '/v1/cases/status').expect(200)).body);
      expect(await status()).toMatchObject({ mode: 'on', oldestUnassignedMinutes: null });
      const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000 - 5_000);
      await insertFinding(prisma, tenantId, { severity: 'low', createdAt: minutesAgo(7) });
      await insertFinding(prisma, tenantId, { createdAt: minutesAgo(3) });
      // Os que não esperam caso: tratado, em incidente e já num caso.
      await insertFinding(prisma, tenantId, { status: 'resolved', createdAt: minutesAgo(90) });
      const incidentId = await insertIncident(prisma, tenantId);
      await insertFinding(prisma, tenantId, { incidentId, createdAt: minutesAgo(90) });
      const caseId = await insertCase(prisma, tenantId);
      await insertFinding(prisma, tenantId, { caseId, createdAt: minutesAgo(90) });
      expect((await status()).oldestUnassignedMinutes).toBe(7);
      await assignAll(prisma, [tenantId]);
      expect((await status()).oldestUnassignedMinutes).toBeNull();
      // O relógio que voltou não dá minutos negativos.
      await insertFinding(prisma, tenantId, { createdAt: new Date(Date.now() + HOUR_MS) });
      expect((await status()).oldestUnassignedMinutes).toBe(0);
    });

    it('o "até quando" é a última passagem da tarefa', async () => {
      const before = await prisma.syncState.findUnique({ where: { name: CASE_ASSIGN_TASK } });
      const lastRunAt = new Date('2026-11-24T10:00:00.000Z');
      await prisma.syncState.upsert({
        where: { name: CASE_ASSIGN_TASK },
        create: { name: CASE_ASSIGN_TASK, lastRunAt },
        update: { lastRunAt },
      });
      const status = caseStatusSchema.parse(
        (await get(analystA.cookie, '/v1/cases/status').expect(200)).body,
      );
      expect(status.asOf).toBe('2026-11-24T10:00:00.000Z');
      if (before === null) await prisma.syncState.delete({ where: { name: CASE_ASSIGN_TASK } });
      else {
        await prisma.syncState.update({
          where: { name: CASE_ASSIGN_TASK },
          data: { lastRunAt: before.lastRunAt },
        });
      }
    });
  });

  describe('a lista', () => {
    it('sem caso nenhum: página vazia', async () => {
      const { cookie } = await reader('vazio');
      expect((await get(cookie, '/v1/cases').expect(200)).body).toEqual({
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
      });
      expect((await get(cookie, '/v1/cases/groups?by=resource').expect(200)).body).toMatchObject({
        items: [],
        total: 0,
      });
    });

    it('o resumo: contagens dos gatilhos, pior severidade pendente, amostras cortadas e nada do evento no título', async () => {
      const { tenantId, list } = await reader('resumo');
      const incidentId = await insertIncident(prisma, tenantId);
      const id = await caseWith(
        tenantId,
        {
          actors: ['a1', 'a2', 'a3', 'a4', '<img src=x onerror=alert(1)>'],
          ips: ['198.51.100.1'],
          resources: [],
          keyParts: [{ name: 'actor', value: '<script>alert(1)</script>' }],
          recurrence: 2,
          mitreTactics: ['Impact'],
        },
        [
          { severity: 'critical', status: 'resolved' },
          { severity: 'high', title: '<b>título do evento</b>' },
          { severity: 'high', status: 'investigating' },
          { severity: 'low' },
          { severity: 'critical', incidentId },
          { severity: 'medium', status: 'legitimate' },
        ],
      );
      const [item, ...rest] = await list();
      expect(rest).toEqual([]);
      expect(item).toMatchObject({
        id,
        title: 'Atividade suspeita na conta da AWS',
        severity: 'high',
        sources: ['cloudtrail'],
        protected: false,
        pending: { critical: 0, high: 2, medium: 0, low: 1 },
        counts: { total: 6, new: 2, investigating: 1, legitimate: 1, resolved: 1, incident: 1 },
        recurrence: 2,
        sealedAt: null,
        sealReason: null,
        preview: {
          accounts: [CASE_ACCOUNT],
          actors: ['a1', 'a2', 'a3'],
          ips: ['198.51.100.1'],
          resources: [],
        },
        mitreTactics: ['Impact'],
        // Texto do evento sai só como dado, por inteiro.
        keyParts: [{ name: 'actor', value: '<script>alert(1)</script>' }],
      });
    });

    it('os estados: pendente, em análise, tratado e todos; o caso sem alerta guardado não entra', async () => {
      const { tenantId, ids } = await reader('estados');
      const incidentId = await insertIncident(prisma, tenantId);
      const fresh = await caseWith(tenantId);
      const investigating = await caseWith(tenantId, {}, [{ status: 'investigating' }]);
      const treated = await caseWith(tenantId, {}, [{ status: 'resolved' }, { status: 'legitimate' }]);
      const promoted = await caseWith(tenantId, {}, [{ incidentId }]);
      const sealed = await caseWith(tenantId, { sealedAt: new Date(), sealReason: 'window' });
      const empty = await caseWith(tenantId, {}, []);
      const sorted = (values: string[]) => [...values].sort();
      expect(sorted(await ids())).toEqual(sorted([fresh, investigating, sealed]));
      expect(sorted(await ids('state=pending'))).toEqual(sorted([fresh, investigating, sealed]));
      expect(await ids('state=investigating')).toEqual([investigating]);
      expect(sorted(await ids('state=treated'))).toEqual(sorted([treated, promoted]));
      const all = await ids('state=all');
      expect(sorted(all)).toEqual(sorted([fresh, investigating, treated, promoted, sealed]));
      expect(all).not.toContain(empty);
    });

    it('o selado diz quando e por quê; um motivo que esta versão não conhece sai sem motivo', async () => {
      const { tenantId, list } = await reader('selados');
      await caseWith(tenantId, { sealedAt: new Date('2026-11-24T10:00:00Z'), sealReason: 'treated' });
      expect((await list())[0]).toMatchObject({
        sealedAt: '2026-11-24T10:00:00.000Z',
        sealReason: 'treated',
      });
    });

    it('prioridade: pior severidade pendente, item protegido, chegada mais recente; no fim, o id', async () => {
      const { tenantId, ids } = await reader('prioridade');
      await prisma.protectedResource.create({
        data: {
          tenantId,
          type: 's3_bucket',
          identifier: 'cofre-demo',
          reason: 'teste',
          createdById: (await createUser(app, { role: 'admin_cliente', tenantId })).id,
        },
      });
      const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
      const make = (
        severity: 'critical' | 'high' | 'medium' | 'low',
        minutes: number,
        overrides: Partial<Prisma.AlertCaseUncheckedCreateInput> = {},
        status: 'new' | 'resolved' = 'new',
      ) => caseWith(tenantId, { lastAlertAt: at(minutes), ...overrides }, [{ severity, status }]);
      const low = await make('low', 1);
      const highOld = await make('high', 50);
      const highNew = await make('high', 5);
      const highProtected = await make('high', 90, { resources: ['s3:cofre-demo'] });
      const critical = await make('critical', 500);
      const medium = await make('medium', 2);
      // Muitos altos não passam à frente de um crítico, e o crítico já tratado não conta.
      const manyHigh = await caseWith(
        tenantId,
        { lastAlertAt: at(400) },
        Array.from({ length: 5 }, () => ({ severity: 'high' as const })),
      );
      const treatedCritical = await caseWith(tenantId, { lastAlertAt: at(0) }, [
        { severity: 'critical', status: 'resolved' },
        { severity: 'low' },
      ]);
      const order = [critical, highProtected, highNew, highOld, manyHigh, medium, treatedCritical, low];
      expect(await ids()).toEqual(order);
      expect(await ids('sort=priority')).toEqual(order);
      // Em todos, o que não tem nada pendente fica no fim, pela chegada.
      const done = await make('critical', 3, {}, 'resolved');
      expect(await ids('state=all')).toEqual([...order, done]);

      const recent = [treatedCritical, low, medium, highNew, highOld, highProtected, manyHigh, critical];
      expect(await ids('sort=recent')).toEqual(recent);
      // Volume: os pendentes primeiro, e não o total; no empate, o total; depois a chegada.
      const busy = await caseWith(tenantId, { lastAlertAt: at(700) }, [
        ...Array.from({ length: 9 }, () => ({ severity: 'high' as const, status: 'resolved' as const })),
        { severity: 'low' as const },
        { severity: 'low' as const },
      ]);
      const heavy = await caseWith(tenantId, { lastAlertAt: at(800) }, [
        ...Array.from({ length: 3 }, () => ({ status: 'resolved' as const })),
        { severity: 'low' as const },
      ]);
      const volume = await ids('sort=volume');
      expect(volume.slice(0, 5)).toEqual([manyHigh, busy, heavy, treatedCritical, low]);
    });

    it('o item protegido é o usuário ou o IP também, e só o do próprio cliente', async () => {
      const a = await reader('protegido A');
      const b = await reader('protegido B');
      const createdById = (await createUser(app, { role: 'admin_cliente', tenantId: a.tenantId })).id;
      const item = { tenantId: a.tenantId, reason: 'teste', createdById };
      await prisma.protectedResource.createMany({
        data: [
          { ...item, type: 'ip_address', identifier: '198.51.100.77' },
          { ...item, type: 'iam_user', identifier: 'conta-raiz-demo' },
        ],
      });
      const protectedOf = async (fx: typeof a) =>
        Object.fromEntries(
          (await fx.list()).map((row) => [
            String(row.preview.ips[0] ?? row.preview.actors[0]),
            row.protected,
          ]),
        );
      for (const fx of [a, b]) {
        await caseWith(fx.tenantId, { ips: ['198.51.100.77'] });
        await caseWith(fx.tenantId, { ips: [], actors: ['conta-raiz-demo'] });
        await caseWith(fx.tenantId, { ips: [], actors: ['conta-raiz-demo-2'] });
      }
      expect(await protectedOf(a)).toEqual({
        '198.51.100.77': true,
        'conta-raiz-demo': true,
        'conta-raiz-demo-2': false,
      });
      expect(Object.values(await protectedOf(b))).toEqual([false, false, false]);
    });

    it('a chave de acesso protegida marca o caso e o põe na frente, só no próprio cliente, e não sai na lista', async () => {
      const a = await reader('chave protegida A');
      const b = await reader('chave protegida B');
      const createdById = (await createUser(app, { role: 'admin_cliente', tenantId: a.tenantId })).id;
      const key = 'DEMOCHAVEDEACESSO2';
      await prisma.protectedResource.create({
        data: { tenantId: a.tenantId, type: 'access_key', identifier: key, reason: 'teste', createdById },
      });
      for (const fx of [a, b]) {
        const withKey = await caseWith(fx.tenantId, {
          accessKeys: [key],
          ips: [],
          actors: [],
          resources: [],
        });
        await caseWith(fx.tenantId, {
          accessKeys: ['DEMOCHAVEDEACESSO3'],
          ips: [],
          actors: [],
          resources: [],
        });
        const rows = await fx.list('sort=priority');
        const own = fx === a;
        expect(rows.filter((row) => row.protected).map((row) => row.id)).toEqual(own ? [withKey] : []);
        if (own) expect(rows[0]?.id).toBe(withKey);
        expect(JSON.stringify(rows)).not.toContain(key);
      }
    });

    it('a ordem é total: com tudo igual, o id decide, e as páginas não repetem nem pulam', async () => {
      const { tenantId, cookie, ids } = await reader('páginas');
      const at = new Date();
      const created: string[] = [];
      for (let index = 0; index < 13; index += 1) {
        created.push(await caseWith(tenantId, { lastAlertAt: at }));
      }
      const expected = [...created].sort().reverse();
      for (const sort of ['priority', 'recent', 'volume']) {
        expect(await ids(`sort=${sort}`), sort).toEqual(expected);
        const paged: string[] = [];
        for (let page = 1; page <= 4; page += 1) {
          const response = await get(cookie, `/v1/cases?sort=${sort}&pageSize=5&page=${page}`).expect(200);
          const parsed = casePageSchema.parse(response.body);
          expect(parsed).toMatchObject({ page, pageSize: 5, total: 13 });
          paged.push(...parsed.items.map((item) => item.id));
        }
        expect(paged, sort).toEqual(expected);
      }
      // Depois do fim (e na última página aceita), vazio com o total certo.
      const beyond = await get(cookie, '/v1/cases?pageSize=100&page=10000').expect(200);
      expect(beyond.body).toMatchObject({ items: [], total: 13 });
    });

    it('fila, severidade, conta, tática e técnica', async () => {
      const { tenantId, ids } = await reader('filtros');
      const detection = await caseWith(
        tenantId,
        { accounts: ['111111111111'], mitreTactics: ['Impact', 'Discovery'], mitreTechniques: ['T1562.008'] },
        [{ severity: 'high' }, { severity: 'low' }],
      );
      const posture = await caseWith(
        tenantId,
        { queue: 'posture', family: 'control', accounts: ['222222222222'], mitreTactics: ['Discovery'] },
        [{ severity: 'medium' }, { severity: 'critical', status: 'resolved' }],
      );
      const agent = await caseWith(
        tenantId,
        { queue: 'vulnerability', family: 'package', ruleIds: ['23504'], accounts: ['agent:001'] },
        [{ severity: 'critical', status: 'investigating', accountId: 'agent:001' }],
      );
      const sorted = async (query: string) => (await ids(query)).sort();
      expect(await ids('queue=detection')).toEqual([detection]);
      expect(await ids('queue=posture')).toEqual([posture]);
      expect(await ids('queue=vulnerability')).toEqual([agent]);
      expect(await ids('severity=high')).toEqual([detection]);
      expect(await ids('severity=low')).toEqual([detection]);
      expect(await ids('severity=medium')).toEqual([posture]);
      // O crítico resolvido não conta: só o que está pendente.
      expect(await ids('severity=critical')).toEqual([agent]);
      expect(await ids('severity=critical&state=investigating')).toEqual([agent]);
      expect(await ids('severity=high&state=investigating')).toEqual([]);
      expect(await ids('accountId=111111111111')).toEqual([detection]);
      expect(await ids('accountId=agent:001')).toEqual([agent]);
      expect(await ids('tactic=Impact')).toEqual([detection]);
      expect(await sorted('tactic=Discovery')).toEqual([detection, posture].sort());
      expect(await ids('technique=T1562.008')).toEqual([detection]);
      expect(await ids('technique=T1562')).toEqual([]);
      // Os filtros se somam.
      expect(await ids('queue=detection&severity=high&accountId=111111111111&tactic=Impact')).toEqual([
        detection,
      ]);
      expect(await ids('queue=posture&tactic=Impact')).toEqual([]);
    });

    it('fonte: pela família e pelas regras, com alertas de verdade; a família desconhecida aparece em todas', async () => {
      const { tenantId, ids, list } = await reader('fontes');
      const instance = 'ec2:i-0123456789abcdef0';
      await insertFinding(prisma, tenantId, {});
      await insertFinding(prisma, tenantId, {
        source: 'aws',
        logSource: 'inspector',
        ruleId: '990511',
        caseGroup: 'openssl',
        resource: instance,
      });
      await insertFinding(prisma, tenantId, {
        source: 'aws',
        logSource: 'security_hub',
        ruleId: '990502',
        title: 'Achado do Security Hub (Inspector): CVE-2026-0001 - openssl',
        eventName: 'Software and Configuration Checks/Vulnerabilities/CVE',
        resource: instance,
      });
      await insertFinding(prisma, tenantId, {
        logSource: 'wazuh_agent',
        ruleId: '23504',
        title: 'CVE-2026-0002 affects bash',
        accountId: 'agent:001',
        resource: instance,
      });
      await insertFinding(prisma, tenantId, {
        logSource: 'cloudflare_waf',
        ruleId: '990330',
        resource: 'zona-demo',
        sourceIp: '203.0.113.9',
      });
      await assignAll(prisma, [tenantId]);
      const unknown = await caseWith(tenantId, { family: 'other', ruleIds: ['1'] }, [
        { logSource: 'gcp_audit', source: 'gcp' },
      ]);
      const byFamily = new Map(
        (await list()).map((item) => [`${item.family}:${item.sources.join('+')}`, item.id]),
      );
      expect([...byFamily.keys()].sort()).toEqual([
        'cloudtrail:cloudtrail',
        'other:',
        // O alerta do Inspector e a cópia do Security Hub, no mesmo caso.
        'package:security_hub+inspector',
        'package:wazuh_agent',
        'waf:cloudflare_waf',
      ]);
      const bySource = async (source: string) => {
        const found = await ids(`source=${source}`);
        // Na dúvida, o caso aparece.
        expect(found, source).toContain(unknown);
        return found.filter((id) => id !== unknown);
      };
      const id = (key: string) => byFamily.get(key);
      expect(await bySource('cloudtrail')).toEqual([id('cloudtrail:cloudtrail')]);
      expect(await bySource('inspector')).toEqual([id('package:security_hub+inspector')]);
      expect(await bySource('security_hub')).toEqual([id('package:security_hub+inspector')]);
      expect(await bySource('wazuh_agent')).toEqual([id('package:wazuh_agent')]);
      expect(await bySource('cloudflare_waf')).toEqual([id('waf:cloudflare_waf')]);
      expect(await bySource('waf')).toEqual([]);
      expect(await bySource('gcp_audit')).toEqual([]);
      expect(await bySource('guardduty')).toEqual([]);
    });

    it('fonte: o caso que reúne médias e baixas', async () => {
      const { tenantId, ids } = await reader('fonte reunida');
      const rollup = (source: string) =>
        caseWith(tenantId, {
          family: 'rollup',
          keyParts: [
            { name: 'source', value: source },
            { name: 'fold', value: 'rollup' },
          ],
        });
      const waf = await rollup('waf');
      const guardduty = await rollup('guardduty');
      expect(await ids('source=waf')).toEqual([waf]);
      expect(await ids('source=guardduty')).toEqual([guardduty]);
      expect(await ids('source=cloudtrail')).toEqual([]);
    });

    it('janela: pelo horário do evento ou pela chegada no servidor', async () => {
      const { tenantId, ids } = await reader('janela');
      const ago = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
      const old = { firstSeenAt: ago(400), lastSeenAt: ago(390), openedAt: ago(400), lastAlertAt: ago(390) };
      const past = await caseWith(tenantId, old);
      const recent = await caseWith(tenantId, {
        firstSeenAt: ago(30),
        lastSeenAt: ago(1),
        openedAt: ago(30),
        lastAlertAt: ago(1),
      });
      // Os eventos vieram com data de meses atrás, mas chegaram agora: não some das últimas 24 h.
      const backdated = await caseWith(tenantId, {
        firstSeenAt: ago(3_000),
        lastSeenAt: ago(2_900),
        openedAt: ago(2),
        lastAlertAt: ago(1),
      });
      const iso = (hours: number) => ago(hours).toISOString();
      const sorted = async (query: string) => (await ids(query)).sort();
      expect(await sorted('')).toEqual([past, recent, backdated].sort());
      expect(await sorted('period=24h')).toEqual([recent, backdated].sort());
      // O alerta chegou há muito tempo, mas a origem o viu de novo agora.
      const revisited = await caseWith(tenantId, { ...old, lastSeenAt: ago(2) });
      expect(await sorted('period=24h')).toEqual([recent, backdated, revisited].sort());
      await prisma.finding.deleteMany({ where: { caseId: revisited } });
      expect(await sorted('period=30d')).toEqual([past, recent, backdated].sort());
      expect(await sorted(`from=${iso(395)}&to=${iso(380)}`)).toEqual([past, backdated].sort());
      expect(await sorted(`from=${iso(10_000)}&to=${iso(9_000)}`)).toEqual([]);
      expect(await sorted(`from=${iso(29)}&to=${iso(28)}`)).toEqual([recent, backdated].sort());
      expect(await sorted(`from=${iso(3_100)}&to=${iso(2_950)}`)).toEqual([backdated]);
    });

    it('busca: no título, nas partes da chave e nas amostras; nunca nos alertas', async () => {
      const { tenantId, ids } = await reader('busca');
      const titled = await caseWith(tenantId, { title: 'Falhas de login no console da AWS' });
      const sampled = await caseWith(tenantId, {
        actors: ['Operador_Noturno', '100% seguro'],
        ips: ['203.0.113.77'],
        resources: ['arn:aws:s3:::bucket-de-backup', 'C:\\pasta\\arquivo'],
        accounts: ['444455556666'],
        ruleIds: ['80254'],
        keyParts: [{ name: 'package', value: 'libção-açaí' }],
      });
      await caseWith(tenantId, {}, [
        { title: 'título secreto do alerta', actorUser: 'usuario-so-do-alerta' },
      ]);
      const idsOf = (q: string) => ids(`q=${encodeURIComponent(q)}`);
      expect(await idsOf('FALHAS DE LOGIN')).toEqual([titled]);
      for (const q of [
        'operador_noturno',
        '203.0.113',
        'BUCKET-DE-BACKUP',
        '44445555',
        '80254',
        '100%',
        'açaí',
        'libção',
        'pasta\\arq',
      ]) {
        expect(await idsOf(q), q).toEqual([sampled]);
      }
      // Os curingas do ILIKE e a barra são texto comum.
      for (const q of [
        '%',
        '%%',
        '_',
        'operador%',
        'operador.noturno',
        'r__N',
        '\\',
        'O_erador',
        '%secreto%',
      ]) {
        const found = await idsOf(q);
        const literal = q === '%' ? [sampled] : q === '_' ? [sampled] : q === '\\' ? [sampled] : [];
        expect(found, q).toEqual(literal);
      }
      // Dois valores vizinhos não formam um terceiro, nem com a separação escrita na busca.
      const joined = await caseWith(tenantId, { actors: ['abre', 'fecha'], ips: ['10.0.0.1'] });
      expect(await idsOf('abre')).toEqual([joined]);
      for (const q of ['abrefecha', 'abre fecha', 'abre,fecha', 'fecha10.0', 'AWS100305']) {
        expect(await idsOf(q), q).toEqual([]);
      }
      for (const q of [
        'título secreto',
        'usuario-so-do-alerta',
        "' OR '1'='1",
        "'; DROP TABLE x; --",
        '"name":"package"',
        'package',
        '😀',
        String.fromCodePoint(0x202e),
      ]) {
        expect(await idsOf(q), q).toEqual([]);
      }
    });

    it('grupo: o valor exato da chave, e os casos sem o valor', async () => {
      const { tenantId, ids } = await reader('grupo na lista');
      const vulnerability = (parts: { name: string; value: string }[], account = CASE_ACCOUNT) =>
        caseWith(tenantId, {
          queue: 'vulnerability',
          family: 'package',
          keyParts: parts,
          accounts: [account],
        });
      const openssl = await vulnerability([
        { name: 'package', value: 'openssl' },
        { name: 'resource', value: 'ec2:i-1' },
      ]);
      const curl = await vulnerability(
        [
          { name: 'package', value: 'curl' },
          { name: 'resource', value: 'ec2:i-1' },
        ],
        '222222222222',
      );
      const code = await vulnerability([{ name: 'resource', value: 'arn:aws:lambda:x' }]);
      const tricky = await vulnerability([
        { name: 'package', value: '"},{"name":"package","value":"openssl' },
      ]);
      const sorted = async (query: string) => (await ids(query)).sort();
      expect(await ids('groupBy=package&group=openssl')).toEqual([openssl]);
      expect(await ids('groupBy=package&group=OPENSSL')).toEqual([]);
      expect(await ids('groupBy=package&group=open')).toEqual([]);
      expect(await ids('groupBy=package&group=ec2:i-1')).toEqual([]);
      expect(await sorted('groupBy=resource&group=ec2:i-1')).toEqual([openssl, curl].sort());
      expect(await ids('groupBy=account&group=222222222222')).toEqual([curl]);
      expect(await ids('groupBy=package')).toEqual([code]);
      expect(await ids('groupBy=resource')).toEqual([tricky]);
      expect(await ids('groupBy=account')).toEqual([]);
      const value = encodeURIComponent('"},{"name":"package","value":"openssl');
      expect(await ids(`groupBy=package&group=${value}`)).toEqual([tricky]);
      // Em todos os estados e filas também.
      expect(await ids('state=all&queue=vulnerability&groupBy=package&group=openssl')).toEqual([openssl]);
      expect(await ids('queue=detection&groupBy=package&group=openssl')).toEqual([]);
    });

    it.each([
      'desconhecido=1',
      'tenantId=018f2c1e-0000-7000-8000-000000000001',
      'state=treated&severity=high',
      'state=all&severity=high',
      'group=openssl',
      'queue=ruido',
      'sort=severity',
      'page=0',
      'page=10001',
      'pageSize=101',
      'q=%00',
      'q=%0A',
      'groupBy=package&group=%00',
      'severity=high&severity=low',
      'from=2026-01-01T00:00:00Z',
    ])('filtro inválido é recusado: %s', async (query) => {
      await get(analystA.cookie, `/v1/cases?${query}`).expect(400);
    });
  });

  describe('os grupos', () => {
    it('por pacote, recurso e conta: os pendentes por severidade, o mais grave primeiro', async () => {
      const { tenantId, groups, cookie } = await reader('grupos');
      const make = (
        name: string | null,
        resource: string,
        account: string,
        findings: Partial<Prisma.FindingUncheckedCreateInput>[],
      ) =>
        caseWith(
          tenantId,
          {
            queue: 'vulnerability',
            family: name === null ? 'code' : 'package',
            keyParts: [
              ...(name === null ? [] : [{ name: 'package', value: name }]),
              { name: 'resource', value: resource },
            ],
            accounts: [account],
          },
          findings,
        );
      await make('openssl', 'ec2:i-1', '111111111111', [{ severity: 'high' }, { severity: 'high' }]);
      await make('openssl', 'ec2:i-2', '222222222222', [{ severity: 'critical', status: 'investigating' }]);
      await make('curl', 'ec2:i-1', '111111111111', [
        { severity: 'high' },
        { severity: 'critical', status: 'resolved' },
      ]);
      await make('zlib', 'ec2:i-2', '222222222222', [{ severity: 'low' }]);
      await make('zlib-tratado', 'ec2:i-9', '222222222222', [{ severity: 'critical', status: 'resolved' }]);
      await make(null, 'arn:aws:lambda:f', '111111111111', [{ severity: 'medium' }]);
      // De outra fila: não conta.
      await caseWith(tenantId, { keyParts: [{ name: 'package', value: 'openssl' }] }, [
        { severity: 'critical' },
      ]);
      const pending = (critical: number, high: number, medium: number, low: number) => ({
        critical,
        high,
        medium,
        low,
      });
      expect(await groups('by=package')).toEqual([
        { value: 'openssl', cases: 2, pending: pending(1, 2, 0, 0) },
        { value: 'curl', cases: 1, pending: pending(0, 1, 0, 0) },
        { value: null, cases: 1, pending: pending(0, 0, 1, 0) },
        { value: 'zlib', cases: 1, pending: pending(0, 0, 0, 1) },
      ]);
      expect(await groups('by=resource')).toEqual([
        { value: 'ec2:i-2', cases: 2, pending: pending(1, 0, 0, 1) },
        { value: 'ec2:i-1', cases: 2, pending: pending(0, 3, 0, 0) },
        { value: 'arn:aws:lambda:f', cases: 1, pending: pending(0, 0, 1, 0) },
      ]);
      expect(await groups('by=account')).toEqual([
        { value: '222222222222', cases: 2, pending: pending(1, 0, 0, 1) },
        { value: '111111111111', cases: 3, pending: pending(0, 3, 1, 0) },
      ]);
      const valuesOf = async (query: string) => (await groups(query)).map((group) => group.value);
      expect(await valuesOf('by=package&state=investigating')).toEqual(['openssl']);
      expect(await valuesOf('by=package&severity=high')).toEqual(['openssl', 'curl']);
      expect(await valuesOf('by=package&severity=critical')).toEqual(['openssl']);
      expect(await valuesOf('by=package&accountId=222222222222')).toEqual(['openssl', 'zlib']);
      expect(await valuesOf('by=package&q=LIB')).toEqual(['zlib']);
      expect(await valuesOf('by=package&q=%25')).toEqual([]);
      expect(await valuesOf('by=resource&q=i-1')).toEqual(['ec2:i-1']);
      // Páginas: nada repete nem some, e o total é o dos grupos.
      const paged: (string | null)[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const response = await get(cookie, `/v1/cases/groups?by=package&pageSize=2&page=${page}`).expect(200);
        const parsed = caseGroupPageSchema.parse(response.body);
        expect(parsed).toMatchObject({ page, pageSize: 2, total: 4 });
        paged.push(...parsed.items.map((group) => group.value));
      }
      expect(paged).toEqual(['openssl', 'curl', null, 'zlib']);
      // Cada grupo leva à lista dele.
      const listed = await get(cookie, '/v1/cases?queue=vulnerability&groupBy=package&group=openssl').expect(
        200,
      );
      expect(listed.body).toMatchObject({ total: 2 });
    });

    it('com alertas de verdade, o pacote e o recurso literais são os da chave (decisão D1)', async () => {
      const { tenantId, groups } = await reader('grupos reais');
      for (const [name, resource] of [
        ['openssl', 'ec2:i-0123456789abcdef0'],
        ['openssl', 'ec2:i-0123456789abcdef1'],
        ['curl', 'ec2:i-0123456789abcdef0'],
      ] as const) {
        await insertFinding(prisma, tenantId, {
          source: 'aws',
          logSource: 'inspector',
          ruleId: '990511',
          caseGroup: name,
          resource,
          severity: 'critical',
        });
      }
      await insertFinding(prisma, tenantId, {
        source: 'aws',
        logSource: 'inspector',
        ruleId: '990513',
        resource: 'arn:aws:lambda:us-east-1:111122223333:function:demo:3',
        severity: 'low',
      });
      await assignAll(prisma, [tenantId]);
      expect((await groups('by=package')).map(({ value, cases }) => [value, cases])).toEqual([
        ['openssl', 2],
        ['curl', 1],
        [null, 1],
      ]);
      expect((await groups('by=resource')).map(({ value, cases }) => [value, cases])).toEqual([
        ['ec2:i-0123456789abcdef0', 2],
        ['ec2:i-0123456789abcdef1', 1],
        ['arn:aws:lambda:us-east-1:111122223333:function:demo', 1],
      ]);
    });

    it.each([
      '',
      'by=rule',
      'by=package&queue=detection',
      'by=package&state=treated',
      'by=package&x=1',
      'by=package&page=10001',
      'by=package&by=resource',
    ])('pedido inválido é recusado: %s', async (query) => {
      await get(analystA.cookie, `/v1/cases/groups?${query}`).expect(400);
    });
  });

  describe('o detalhe', () => {
    it('um caso sem alerta nenhum guardado ainda abre', async () => {
      const { tenantId, detail } = await reader('sem alerta');
      const id = await caseWith(tenantId, { actors: ['quem-foi'] }, []);
      expect(await detail(id)).toMatchObject({
        counts: { total: 0 },
        severity: null,
        samples: { actors: ['quem-foi'] },
        analysis: {
          alerts: 0,
          complete: true,
          rare: { ips: { distinct: 0, values: [] }, users: { distinct: 0, values: [] } },
          groups: { distinct: 0, values: [] },
          stillActive: 0,
        },
        previous: [],
        incidents: [],
        operations: [],
      });
    });

    it('valores raros: o menos frequente primeiro, no empate o visto por último, no máximo dez', async () => {
      const { tenantId, detail } = await reader('raros');
      const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
      const id = await caseWith(tenantId, {}, [
        ...Array.from({ length: 6 }, (_, index) => ({
          sourceIp: '198.51.100.1',
          actorUser: 'frequente',
          occurredAt: at(index),
        })),
        ...Array.from({ length: 2 }, () => ({
          sourceIp: '198.51.100.2',
          actorUser: null,
          occurredAt: at(5),
        })),
        { sourceIp: '203.0.113.50', actorUser: '<i>raro</i>', occurredAt: at(90) },
        { sourceIp: '203.0.113.51', actorUser: 'raro-2', occurredAt: at(10) },
        { sourceIp: null, actorUser: 'raro-2', occurredAt: at(1) },
      ]);
      // Mais valores que o teto: ficam os menos frequentes, mesmo com os frequentes vistos por último.
      const crowded = await caseWith(tenantId, {}, [
        ...Array.from({ length: 10 }, (_, index) => ({
          sourceIp: `203.0.113.${index}`,
          actorUser: `raro-${index}`,
          occurredAt: at(100 + index),
        })),
        ...Array.from({ length: 6 }, (_, index) => ({
          sourceIp: `198.51.100.${index % 3}`,
          actorUser: `frequente-${index % 3}`,
          occurredAt: at(index),
        })),
      ]);
      const { rare } = (await detail(crowded)).analysis as NonNullable<CaseDetail['analysis']>;
      expect(rare.ips.distinct).toBe(13);
      expect(rare.ips.values.map(({ value }) => value)).toEqual(
        Array.from({ length: 10 }, (_, index) => `203.0.113.${index}`),
      );
      expect(rare.users.values.map(({ value }) => value)).toEqual(
        Array.from({ length: 10 }, (_, index) => `raro-${index}`),
      );

      const { analysis } = await detail(id);
      expect(analysis?.alerts).toBe(11);
      expect(analysis?.rare.ips.distinct).toBe(4);
      expect(analysis?.rare.ips.values.map(({ value, count }) => [value, count])).toEqual([
        ['203.0.113.51', 1],
        ['203.0.113.50', 1],
        ['198.51.100.2', 2],
        ['198.51.100.1', 6],
      ]);
      expect(analysis?.rare.users.values.map(({ value, count }) => [value, count])).toEqual([
        ['<i>raro</i>', 1],
        ['raro-2', 2],
        ['frequente', 6],
      ]);

      const many = await caseWith(
        tenantId,
        {},
        Array.from({ length: 25 }, (_, index) => ({
          sourceIp: `203.0.113.${index}`,
          actorUser: `pessoa-${index}`,
          occurredAt: at(index),
        })),
      );
      const bounded = await detail(many);
      expect(bounded.analysis?.rare.ips).toMatchObject({ distinct: 25 });
      expect(bounded.analysis?.rare.ips.values).toHaveLength(10);
      expect(bounded.analysis?.rare.ips.values[0]?.value).toBe('203.0.113.0');
      expect(bounded.analysis?.rare.users.values).toHaveLength(10);
    });

    it('subgrupos: o mais grave pendente primeiro, no máximo 50, com o total e os pendentes', async () => {
      const { tenantId, detail } = await reader('subgrupos');
      const incidentId = await insertIncident(prisma, tenantId);
      const id = await caseWith(tenantId, { queue: 'posture', family: 'control' }, [
        { caseGroup: 's3:a', severity: 'high' },
        { caseGroup: 's3:a', severity: 'low' },
        { caseGroup: 's3:b', severity: 'critical' },
        { caseGroup: 's3:c', severity: 'critical', status: 'resolved' },
        { caseGroup: 's3:d', severity: 'critical', incidentId },
        { caseGroup: 's3:d', severity: 'medium', status: 'investigating' },
        { caseGroup: null, severity: 'critical' },
      ]);
      const { analysis } = await detail(id);
      const pending = (critical: number, high: number, medium: number, low: number) => ({
        critical,
        high,
        medium,
        low,
      });
      expect(analysis?.groups).toEqual({
        distinct: 4,
        values: [
          { value: 's3:b', total: 1, pending: pending(1, 0, 0, 0) },
          { value: 's3:a', total: 2, pending: pending(0, 1, 0, 1) },
          { value: 's3:d', total: 2, pending: pending(0, 0, 1, 0) },
          { value: 's3:c', total: 1, pending: pending(0, 0, 0, 0) },
        ],
      });
      const many = await caseWith(
        tenantId,
        { queue: 'posture', family: 'control' },
        Array.from({ length: 60 }, (_, index) => ({ caseGroup: `s3:${String(index).padStart(2, '0')}` })),
      );
      const bounded = await detail(many);
      expect(bounded.analysis?.groups.distinct).toBe(60);
      expect(bounded.analysis?.groups.values).toHaveLength(50);
      expect(bounded.analysis?.groups.values[0]?.value).toBe('s3:00');
    });

    it('resolvidos que a origem voltou a ver depois da triagem', async () => {
      const { tenantId, detail } = await reader('ainda ativos');
      const incidentId = await insertIncident(prisma, tenantId);
      const triagedAt = new Date('2026-11-20T10:00:00Z');
      const later = new Date('2026-11-21T10:00:00Z');
      const earlier = new Date('2026-11-19T10:00:00Z');
      const id = await caseWith(tenantId, {}, [
        { status: 'resolved', triagedAt, lastSeenAt: later },
        { status: 'resolved', triagedAt, lastSeenAt: later },
        { status: 'resolved', triagedAt, lastSeenAt: earlier },
        { status: 'resolved', triagedAt, lastSeenAt: triagedAt },
        { status: 'resolved', triagedAt, lastSeenAt: null },
        { status: 'resolved', triagedAt: null, lastSeenAt: later },
        { status: 'legitimate', triagedAt, lastSeenAt: later },
        { status: 'investigating', triagedAt, lastSeenAt: later },
        { status: 'resolved', triagedAt, lastSeenAt: later, incidentId },
      ]);
      expect((await detail(id)).analysis?.stillActive).toBe(2);
    });

    it('a corrente de casos anteriores: em ordem, com limite, e sem prender num ciclo', async () => {
      const { tenantId, detail } = await reader('corrente');
      const groupKey = 'b'.repeat(64);
      let previousCaseId: string | null = null;
      const chain: string[] = [];
      for (let index = 0; index < 13; index += 1) {
        previousCaseId = await caseWith(
          tenantId,
          {
            groupKey,
            previousCaseId,
            recurrence: index,
            sealedAt: new Date(Date.now() - (13 - index) * HOUR_MS),
            sealReason: 'treated',
          },
          [{ status: 'resolved' }, { status: 'investigating' }],
        );
        chain.unshift(previousCaseId);
      }
      const current = await caseWith(tenantId, { groupKey, previousCaseId, recurrence: 13 });
      const { previous, recurrence } = await detail(current);
      expect(recurrence).toBe(13);
      expect(previous.map((item) => item.id)).toEqual(chain.slice(0, 10));
      expect(previous[0]).toMatchObject({
        sealReason: 'treated',
        pending: 1,
        counts: { total: 2, resolved: 1 },
      });

      // O anterior que já saiu pela retenção: a corrente para nele.
      const orphan = await caseWith(tenantId, { previousCaseId: randomUUID(), recurrence: 4 });
      expect((await detail(orphan)).previous).toEqual([]);

      const first = await caseWith(tenantId);
      const second = await caseWith(tenantId, { previousCaseId: first });
      await prisma.alertCase.update({ where: { id: first }, data: { previousCaseId: second } });
      expect((await detail(first)).previous.map((item) => item.id)).toEqual([second, first]);
    });

    it('os incidentes: o do caso e os dos alertas, com a contagem, no limite', async () => {
      const { tenantId, detail } = await reader('incidentes do caso');
      const own = await insertIncident(prisma, tenantId, { severity: 'critical' });
      const other = await insertIncident(prisma, tenantId, { status: 'resolved', resolvedAt: new Date() });
      const id = await caseWith(tenantId, { incidentId: own }, [
        { incidentId: own },
        { incidentId: other },
        { incidentId: other },
        {},
      ]);
      expect((await detail(id)).incidents).toEqual([
        { id: own, status: 'open', severity: 'critical', alerts: 1, promoted: true },
        { id: other, status: 'resolved', severity: 'high', alerts: 2, promoted: false },
      ]);
      const alone = await caseWith(tenantId, { incidentId: own });
      expect((await detail(alone)).incidents).toEqual([
        { id: own, status: 'open', severity: 'critical', alerts: 0, promoted: true },
      ]);
      const many = await caseWith(tenantId, { incidentId: own }, []);
      for (let index = 0; index < 12; index += 1) {
        await insertFinding(prisma, tenantId, {
          caseId: many,
          incidentId: await insertIncident(prisma, tenantId),
        });
      }
      const { incidents } = await detail(many);
      expect(incidents).toHaveLength(11);
      expect(incidents[0]).toMatchObject({ id: own, promoted: true });
    });

    it('as operações em vigor nos alertas e as que elas desfizeram, com o autor e o motivo', async () => {
      const { tenantId, detail } = await reader('operações');
      const author = await createUser(app, { role: 'analista_cliente', tenantId, name: 'Analista Demo' });
      const undone = await insertOperation(prisma, tenantId, {
        state: 'undone',
        reason: 'falso positivo conhecido',
        createdById: author.id,
        createdAt: new Date('2026-11-20T10:00:00Z'),
        matched: 3,
        changed: 2,
        skipped: 1,
      });
      const undo = await insertOperation(prisma, tenantId, {
        action: 'undo',
        status: null,
        undoOfId: undone,
        createdAt: new Date('2026-11-21T10:00:00Z'),
      });
      const unrelated = await insertOperation(prisma, tenantId);
      const id = await caseWith(tenantId, {}, [{ triageOpId: undo }, { triageOpId: undo }, {}]);
      const { operations } = await detail(id);
      expect(operations.map((operation) => operation.id)).toEqual([undo, undone]);
      expect(operations[0]).toMatchObject({ action: 'undo', status: null, author: null, undoOfId: undone });
      expect(operations[1]).toEqual({
        id: undone,
        action: 'status',
        status: 'resolved',
        state: 'undone',
        reason: 'falso positivo conhecido',
        author: { id: author.id, name: 'Analista Demo' },
        createdAt: '2026-11-20T10:00:00.000Z',
        matched: 3,
        changed: 2,
        skipped: 1,
        undoUntil: null,
        undoOfId: null,
        can: { cancel: false, continue: false, undo: false },
      });
      expect(JSON.stringify(operations)).not.toContain(unrelated);
      // Um id de operação que já saiu (o cabeçalho tem retenção própria) não quebra nada.
      const gone = await caseWith(tenantId, {}, [{ triageOpId: randomUUID() }]);
      expect((await detail(gone)).operations).toEqual([]);
    });

    it('no máximo 20 operações, as mais recentes', async () => {
      const { tenantId, detail } = await reader('muitas operações');
      const id = await caseWith(tenantId, {}, []);
      const created: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const operation = await insertOperation(prisma, tenantId, {
          createdAt: new Date(Date.now() - (25 - index) * 60_000),
        });
        created.unshift(operation);
        await insertFinding(prisma, tenantId, { caseId: id, triageOpId: operation });
      }
      expect((await detail(id)).operations.map((operation) => operation.id)).toEqual(created.slice(0, 20));
    });

    it('id que não é UUID e parâmetro de consulta são recusados', async () => {
      await get(analystA.cookie, '/v1/cases/abc').expect(400);
      await get(analystA.cookie, `/v1/cases/${randomUUID()}?x=1`).expect(400);
      await get(analystA.cookie, `/v1/cases/${randomUUID()}/timeline?x=1`).expect(400);
      await get(analystA.cookie, `/v1/findings/${randomUUID()}/triage?x=1`).expect(400);
      await get(analystA.cookie, '/v1/cases/status?x=1').expect(400);
    });
  });

  describe('a trilha da triagem em massa de um alerta', () => {
    it('sem operação: nula, sem erro; com a triagem de um alerta só, também', async () => {
      const { tenantId, cookie } = await reader('trilha vazia');
      const id = await insertFinding(prisma, tenantId, { status: 'resolved', triagedAt: new Date() });
      const response = await get(cookie, `/v1/findings/${id}/triage`).expect(200);
      expect(response.body).toEqual({ operation: null, operations: [] });
    });

    it('a que vale e as anteriores, com o que o alerta era', async () => {
      const { tenantId, cookie } = await reader('trilha');
      const author = await createUser(app, { role: 'admin_cliente', tenantId, name: 'Admin Demo' });
      const first = await insertOperation(prisma, tenantId, {
        status: 'legitimate',
        reason: 'manutenção programada',
        createdById: author.id,
      });
      const second = await insertOperation(prisma, tenantId, { status: 'resolved', reason: 'corrigido' });
      const id = await insertFinding(prisma, tenantId, { status: 'resolved', triageOpId: second });
      const at = (minutes: number) => new Date(Date.parse('2026-11-24T10:00:00Z') + minutes * 60_000);
      // A mesma operação mexeu em outro alerta: não é deste.
      const neighbor = await insertFinding(prisma, tenantId, { status: 'resolved', triageOpId: second });
      await prisma.triageOperationItem.createMany({
        data: [
          { tenantId, operationId: second, findingId: neighbor, previousStatus: 'new', createdAt: at(9) },
          { tenantId, operationId: first, findingId: id, previousStatus: 'new', createdAt: at(0) },
          { tenantId, operationId: second, findingId: id, previousStatus: 'legitimate', createdAt: at(5) },
        ],
      });
      const trail = findingTriageSchema.parse(
        (await get(cookie, `/v1/findings/${id}/triage`).expect(200)).body,
      );
      expect(trail.operations.map((entry) => entry.operation.id)).toEqual([second, first]);
      expect(trail.operation).toEqual(trail.operations[0]);
      expect(trail.operations[1]).toMatchObject({
        at: '2026-11-24T10:00:00.000Z',
        previousStatus: 'new',
        operation: {
          action: 'status',
          status: 'legitimate',
          reason: 'manutenção programada',
          author: { id: author.id, name: 'Admin Demo' },
        },
      });
      // Mudado à mão depois (o vínculo sai): a trilha fica, mas nenhuma operação vale.
      await prisma.finding.update({ where: { id }, data: { triageOpId: null } });
      const after = findingTriageSchema.parse(
        (await get(cookie, `/v1/findings/${id}/triage`).expect(200)).body,
      );
      expect(after.operation).toBeNull();
      expect(after.operations).toHaveLength(2);
    });

    it('a pessoa excluída não quebra a trilha; no máximo 20 entradas', async () => {
      const { tenantId, cookie } = await reader('trilha longa');
      const id = await insertFinding(prisma, tenantId, { status: 'resolved' });
      for (let index = 0; index < 23; index += 1) {
        const operationId = await insertOperation(prisma, tenantId, { createdById: null });
        await prisma.triageOperationItem.create({
          data: {
            tenantId,
            operationId,
            findingId: id,
            previousStatus: 'new',
            createdAt: new Date(Date.now() - index * 60_000),
          },
        });
      }
      const trail = findingTriageSchema.parse(
        (await get(cookie, `/v1/findings/${id}/triage`).expect(200)).body,
      );
      expect(trail.operations).toHaveLength(20);
      expect(trail.operations.every((entry) => entry.operation.author === null)).toBe(true);
    });
  });
});
