import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  casePageSchema,
  MITRE_TACTIC_NAMES,
  ROLES,
  type TowerSummary,
  towerSummarySchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TOWER_MITRE_TTL_MS } from '../src/tower/tower.service.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import {
  expectedTacticCases,
  expectedTowerCases,
  expectedValidation,
  findingsOfCase,
  readWorld,
  seedWorld,
  worstOf,
} from './support/case-world.js';
import { cleanCases, HOUR_MS, insertCase, insertFinding, insertIncident } from './support/cases.js';
import { createApp } from './support/create-app.js';
import { type Operator, operate, operatorFor, patch, read, statusRequest } from './support/triage.js';

const DAY_MS = 24 * HOUR_MS;
const ALL = '/v1/tower?cases=true';

/** Os casos no resumo da situação e no radar, com eles ligados. */
describe('casos na Torre (CASES_MODE=on)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];

  async function setup(name: string, role: Operator['role'] = 'analista_cliente') {
    const tenantId = await createTenant(app, `Cliente Demo (${name})`);
    tenants.push(tenantId);
    const who = await operatorFor(app, tenantId, role);
    return {
      tenantId,
      who,
      tower: async (path = ALL): Promise<TowerSummary> =>
        towerSummarySchema.parse((await read(app, who, path).expect(200)).body),
    };
  }

  /** Um caso com alertas, com os horários dele pelos dos alertas. */
  async function seedCase(
    tenantId: string,
    data: Parameters<typeof insertCase>[2],
    findings: readonly Parameters<typeof insertFinding>[2][],
  ): Promise<string> {
    const id = await insertCase(prisma, tenantId, data);
    for (const finding of findings) await insertFinding(prisma, tenantId, { caseId: id, ...finding });
    return id;
  }

  const kindsOf = (summary: TowerSummary) =>
    Object.fromEntries(summary.pendingDecisions.map(({ kind, count }) => [kind, count]));

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

  describe('só para quem pede', () => {
    it('sem o pedido, a resposta é a de antes dos casos: nenhum campo e nenhum valor novo', async () => {
      const { tenantId, tower } = await setup('sem pedir');
      await seedCase(tenantId, {}, [{ severity: 'critical', mitreTactics: ['Impact'] }]);
      await seedCase(tenantId, { queue: 'vulnerability', family: 'package' }, [{ severity: 'high' }]);
      const before = await tower('/v1/tower');
      expect(JSON.stringify(before)).not.toContain('"cases"');
      expect(before.pendingDecisions).toEqual([{ kind: 'untriaged_finding', count: 2 }]);
      const after = await tower();
      expect(after.pendingDecisions).toEqual([
        { kind: 'untriaged_case', count: 1 },
        { kind: 'untriaged_vulnerability_case', count: 1 },
      ]);
      // O que não é dos casos continua igual.
      const common = ({
        cases: _cases,
        radar,
        mitre,
        pendingDecisions: _d,
        generatedAt: _g,
        ...rest
      }: TowerSummary) => ({
        ...rest,
        radar: { ...radar, since: null, cases: undefined },
        mitre: mitre.tactics.map(({ cases: _tacticCases, ...tactic }) => tactic),
      });
      expect(common(after)).toEqual(common(before));
      // A ordem das leituras não mistura as duas respostas (a memória do MITRE é uma para cada).
      expect(JSON.stringify(await tower('/v1/tower'))).not.toContain('"cases"');
      expect((await tower()).mitre.tactics.every((tactic) => tactic.cases !== undefined)).toBe(true);
    });

    it.each(['cases=1', 'cases=false', 'cases=', 'cases=true&cases=true', 'casos=true'])(
      'um pedido que não é o do contrato é 400: %s',
      async (query) => {
        const { who } = await setup('pedido inválido');
        await read(app, who, `/v1/tower?${query}`).expect(400);
      },
    );

    it('todos os papéis do cliente leem, e a equipe da Verax com o cliente escolhido; sem cliente, 409; sem sessão, 401', async () => {
      const { tenantId } = await setup('papéis');
      await seedCase(tenantId, {}, [{ severity: 'critical' }]);
      for (const role of ROLES) {
        const who = await operatorFor(app, tenantId, role);
        const summary = towerSummarySchema.parse((await read(app, who, ALL).expect(200)).body);
        expect(summary.cases?.detection, role).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
        expect(kindsOf(summary), role).toMatchObject({ untriaged_case: 1 });
        expect(summary.radar?.cases, role).toMatchObject({ total: 1, alerts: 1 });
      }
      const staff = await createSignedInUser(app, { role: 'admin_verax' });
      await request(app.getHttpServer()).get(ALL).set('Cookie', staff.cookie).expect(409);
      await request(app.getHttpServer()).get(ALL).expect(401);
    });
  });

  describe('isolamento', () => {
    it('A e B, com os mesmos dados: cada um só conta, desenha e classifica os próprios casos', async () => {
      const a = await setup('A');
      const b = await setup('B');
      const ids = new Map<string, string>();
      for (const [name, { tenantId }, times] of [
        ['a', a, 1],
        ['b', b, 3],
      ] as const) {
        for (let index = 0; index < times; index += 1) {
          ids.set(
            `${name}${index}`,
            await seedCase(tenantId, { title: `Caso de ${name}` }, [
              { severity: 'critical', mitreTactics: ['Impact'] },
              { severity: 'high', status: 'investigating' },
            ]),
          );
        }
      }
      const incident = await insertIncident(prisma, b.tenantId);
      await prisma.alertCase.update({
        where: { id: ids.get('b0') as string },
        data: { incidentId: incident },
      });
      const seenA = await a.tower();
      const seenB = await b.tower();
      expect(seenA.cases?.detection.critical).toBe(1);
      expect(seenB.cases?.detection.critical).toBe(3);
      expect(seenA.radar?.cases).toMatchObject({ total: 1, alerts: 2 });
      expect(seenB.radar?.cases).toMatchObject({ total: 3, alerts: 6 });
      expect(seenA.mitre.tactics.find((tactic) => tactic.name === 'Impact')).toMatchObject({ cases: 1 });
      expect(seenB.mitre.tactics.find((tactic) => tactic.name === 'Impact')).toMatchObject({ cases: 3 });
      for (const secret of [ids.get('b0'), ids.get('b1'), ids.get('b2'), incident, 'Caso de b']) {
        expect(JSON.stringify(seenA)).not.toContain(secret);
      }
      expect(JSON.stringify(seenB)).not.toContain(ids.get('a0'));
    });
  });

  describe('casos pendentes e decisões, contra a conta refeita alerta por alerta', () => {
    it.each([11, 23, 37, 51, 68])('cliente sorteado %i', { timeout: 60_000 }, async (seed) => {
      const { tenantId, tower } = await setup(`sorteado ${seed}`);
      const world = await seedWorld(prisma, tenantId, { seed, now: new Date(), cases: 36 });
      const summary = await tower();
      expect(summary.cases).toEqual(expectedTowerCases(world));
      const expected = expectedValidation(world);
      expect(summary.pendingDecisions.filter(({ kind }) => kind !== 'unassigned_incident')).toEqual(
        [
          { kind: 'untriaged_case', count: expected.cases },
          { kind: 'untriaged_vulnerability_case', count: expected.vulnerabilityCases },
          { kind: 'untriaged_finding', count: expected.uncovered },
        ].filter(({ count }) => count > 0),
      );
      // Sem os casos, o mesmo semáforo, e a mesma conta de alertas de sempre.
      const plain = await tower('/v1/tower');
      expect([summary.light, summary.reasons]).toEqual([plain.light, plain.reasons]);
      expect(kindsOf(plain)['untriaged_finding'] ?? 0).toBe(expected.total);
    });

    it('o caso misto só conta pelos alertas altos ou críticos em "novo"', async () => {
      const { tenantId, tower } = await setup('misto');
      // Altos só em análise, e um baixo em "novo": nada alto a validar (como hoje), mas o caso é alto.
      await seedCase(tenantId, {}, [{ severity: 'high', status: 'investigating' }, { severity: 'low' }]);
      const only = await tower();
      expect(only.cases?.detection).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
      expect(only).toMatchObject({ light: 'green', reasons: [], pendingDecisions: [] });
      // Um crítico em "novo" no meio: uma decisão.
      await seedCase(tenantId, {}, [
        { severity: 'critical' },
        { severity: 'high', status: 'investigating' },
        { severity: 'low' },
      ]);
      expect(await tower()).toMatchObject({
        light: 'yellow',
        reasons: [],
        pendingDecisions: [{ kind: 'untriaged_case', count: 1 }],
      });
    });

    it('um caso com um crítico e muitos baixos é um caso crítico, e uma decisão', async () => {
      const { tenantId, tower } = await setup('pior severidade');
      await seedCase(tenantId, { queue: 'vulnerability', family: 'package' }, [
        { severity: 'critical' },
        ...Array.from({ length: 30 }, () => ({ severity: 'low' as const })),
      ]);
      const summary = await tower();
      expect(summary.cases?.vulnerability).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
      expect(summary.pendingDecisions).toEqual([{ kind: 'untriaged_vulnerability_case', count: 1 }]);
    });

    it('o alerta ainda sem caso e o que está num incidente continuam amarelos, com a decisão deles', async () => {
      const { tenantId, tower } = await setup('fora dos casos');
      const incidentId = await insertIncident(prisma, tenantId, {
        status: 'resolved',
        resolvedAt: new Date(),
        assigneeId: null,
      });
      await insertFinding(prisma, tenantId, { severity: 'critical' });
      await seedCase(tenantId, {}, [{ severity: 'high', incidentId }]);
      expect(await tower()).toMatchObject({
        light: 'yellow',
        reasons: [],
        pendingDecisions: [{ kind: 'untriaged_finding', count: 2 }],
        cases: { detection: { critical: 0, high: 0, medium: 0, low: 0 } },
      });
    });

    it('a decisão acompanha a triagem na hora: nada dela fica guardado', async () => {
      const { tenantId, who, tower } = await setup('na hora');
      const first = await seedCase(tenantId, {}, [{ severity: 'high' }, { severity: 'high' }]);
      const second = await seedCase(tenantId, {}, [{ severity: 'critical' }]);
      expect(kindsOf(await tower())).toEqual({ untriaged_case: 2 });
      await operate(app, who, statusRequest({ caseIds: [first] }, 2));
      expect(kindsOf(await tower())).toEqual({ untriaged_case: 1 });
      const [finding] = await prisma.finding.findMany({ where: { caseId: second }, select: { id: true } });
      await patch(app, who, `/v1/findings/${finding?.id}/status`, { status: 'investigating' }).expect(200);
      const done = await tower();
      expect(done).toMatchObject({ light: 'green', pendingDecisions: [] });
      expect(done.cases?.detection.critical).toBe(1);
    });

    it('com a contagem de um caso errada, o amarelo não fica sem explicação: valem os alertas', async () => {
      const { tenantId, tower } = await setup('contagem errada');
      const id = await seedCase(tenantId, {}, [{ severity: 'high' }, { severity: 'critical' }]);
      await prisma.alertCase.update({
        where: { id },
        data: { pendingHigh: 0, pendingCritical: 0, newCount: 0 },
      });
      expect(await tower()).toMatchObject({
        light: 'yellow',
        reasons: [],
        pendingDecisions: [{ kind: 'untriaged_finding', count: 2 }],
      });
    });

    it('o alto que pode estar todo em análise é procurado nos alertas do caso', async () => {
      const { tenantId, tower } = await setup('procurado');
      // Dois altos, três em análise e dois novos, nos dois casos: só os alertas dizem em qual há um alto em "novo".
      const held = await seedCase(tenantId, {}, [
        { severity: 'high', status: 'investigating' },
        { severity: 'high', status: 'investigating' },
        { severity: 'low', status: 'investigating' },
        { severity: 'low' },
        { severity: 'low' },
      ]);
      expect(await tower()).toMatchObject({ light: 'green', pendingDecisions: [] });
      const fresh = await seedCase(tenantId, {}, [
        { severity: 'high' },
        { severity: 'high', status: 'investigating' },
        { severity: 'low', status: 'investigating' },
        { severity: 'low', status: 'investigating' },
        { severity: 'low' },
      ]);
      const [a, b] = await Promise.all(
        [held, fresh].map((id) =>
          prisma.alertCase.findUniqueOrThrow({
            where: { id },
            select: { newCount: true, investigatingCount: true, pendingHigh: true, pendingLow: true },
          }),
        ),
      );
      expect(a).toEqual(b);
      expect(kindsOf(await tower())).toEqual({ untriaged_case: 1 });
    });

    it('cliente sem caso nenhum: tudo zerado', async () => {
      const { tower } = await setup('vazio');
      const zero = { critical: 0, high: 0, medium: 0, low: 0 };
      expect(await tower()).toMatchObject({
        light: 'green',
        pendingDecisions: [],
        cases: {
          detection: zero,
          vulnerability: zero,
          posture: zero,
          oldestPendingAt: { detection: null, vulnerability: null, posture: null },
        },
        radar: { cases: { total: 0, alerts: 0, limit: 100, items: [] } },
      });
    });
  });

  describe('radar', () => {
    it.each([5, 19, 42])(
      'cliente sorteado %i: total, alertas e cada caso, contra a conta refeita',
      async (seed) => {
        const { tenantId, who, tower } = await setup(`radar ${seed}`);
        await seedWorld(prisma, tenantId, { seed, now: new Date(), cases: 48 });
        const summary = await tower();
        const radar = summary.radar;
        const world = await readWorld(prisma, tenantId);
        const since = Date.parse(radar?.since ?? '');
        const until = Date.parse(summary.generatedAt);
        const active = world.cases
          .filter((row) => row.queue === 'detection' && findingsOfCase(world, row.id).length > 0)
          .filter((row) => Math.max(row.lastSeenAt.getTime(), row.lastAlertAt.getTime()) >= since);
        const recentOf = (id: string) =>
          findingsOfCase(world, id).filter((row) => {
            const at = row.occurredAt.getTime();
            return at >= since && at <= until;
          }).length;
        expect(radar?.cases).toMatchObject({
          total: active.length,
          alerts: active.reduce((sum, row) => sum + recentOf(row.id), 0),
        });
        const incidents = new Map(world.incidents.map((row) => [row.id, row]));
        const rank = ['critical', 'high', 'medium', 'low', null];
        const worse = (a: string | null, b: string | null) => Math.min(rank.indexOf(a), rank.indexOf(b));
        // O incidente aberto mais grave em que há alerta do caso; no empate, o que começou por último.
        const openOf = (id: string) =>
          findingsOfCase(world, id)
            .flatMap((row) => (row.incidentId === null ? [] : (incidents.get(row.incidentId) ?? [])))
            .filter((row) => row.status !== 'resolved')
            .sort(
              (x, y) =>
                rank.indexOf(x.severity) - rank.indexOf(y.severity) ||
                y.firstSeenAt.getTime() - x.firstSeenAt.getTime(),
            )[0];
        const incidentOf = (row: (typeof active)[number]) => {
          const incident =
            openOf(row.id) ?? (row.incidentId === null ? undefined : incidents.get(row.incidentId));
          return incident === undefined
            ? null
            : { id: incident.id, open: incident.status !== 'resolved', severity: incident.severity };
        };
        const gravity = (id: string) =>
          worse(worstOf(findingsOfCase(world, id)), openOf(id)?.severity ?? null);
        expect(radar?.cases?.items).toEqual(
          [...active]
            .sort(
              (x, y) =>
                gravity(x.id) - gravity(y.id) ||
                y.lastAlertAt.getTime() - x.lastAlertAt.getTime() ||
                (x.id < y.id ? 1 : -1),
            )
            .map((row) => {
              const own = findingsOfCase(world, row.id);
              return expect.objectContaining({
                id: row.id,
                severity: worstOf(own),
                total: own.length,
                pending: own.filter(
                  ({ incidentId, status }) =>
                    incidentId === null && (status === 'new' || status === 'investigating'),
                ).length,
                recent: recentOf(row.id),
                incident: incidentOf(row),
              }) as object;
            }),
        );
        // O mesmo total da lista de casos no período.
        const listed = casePageSchema.parse(
          (await read(app, who, '/v1/cases?queue=detection&state=all&period=24h&pageSize=1').expect(200))
            .body,
        );
        expect(radar?.cases?.total).toBe(listed.total);
        // Os alertas continuam contados como sempre.
        const plain = (await tower('/v1/tower')).radar;
        expect(radar?.total).toBe(plain?.total);
        expect(radar?.bySeverity).toEqual(plain?.bySeverity);
        expect(radar?.bySector).toEqual(plain?.bySector);
        expect(radar?.detections.map(({ id }) => id)).toEqual(plain?.detections.map(({ id }) => id));
      },
    );

    it('o teto: os 100 mais graves, com o total e os alertas de todos', { timeout: 60_000 }, async () => {
      const { tenantId, tower } = await setup('teto do radar');
      const now = Date.now();
      await seedCase(tenantId, { title: 'O crítico antigo', lastAlertAt: new Date(now - 20 * HOUR_MS) }, [
        { severity: 'critical', createdAt: new Date(now - 20 * HOUR_MS) },
      ]);
      for (let index = 0; index < 104; index += 1) {
        await seedCase(tenantId, { lastAlertAt: new Date(now - index * 60_000) }, [{ severity: 'low' }]);
      }
      const cases = (await tower()).radar?.cases;
      expect(cases).toMatchObject({ total: 105, alerts: 105, limit: 100 });
      expect(cases?.items).toHaveLength(100);
      expect(cases?.items[0]).toMatchObject({ title: 'O crítico antigo', severity: 'critical' });
    });

    it('a atividade: o evento dentro da janela, a chegada do que veio atrasado, e nunca depois de agora', async () => {
      const { tenantId, tower } = await setup('atividade');
      const now = Date.now();
      const at = (ms: number) => new Date(now - ms);
      const normal = await seedCase(tenantId, { lastSeenAt: at(3 * HOUR_MS), lastAlertAt: at(2 * HOUR_MS) }, [
        { occurredAt: at(3 * HOUR_MS) },
      ]);
      const late = await seedCase(
        tenantId,
        { firstSeenAt: at(5 * DAY_MS), lastSeenAt: at(5 * DAY_MS), lastAlertAt: at(HOUR_MS) },
        [{ occurredAt: at(5 * DAY_MS) }],
      );
      const future = await seedCase(tenantId, { lastSeenAt: at(-9 * DAY_MS), lastAlertAt: at(HOUR_MS) }, [
        { occurredAt: at(-9 * DAY_MS) },
      ]);
      const quiet = await seedCase(
        tenantId,
        {
          openedAt: at(3 * DAY_MS),
          firstSeenAt: at(3 * DAY_MS),
          lastSeenAt: at(2 * DAY_MS),
          lastAlertAt: at(2 * DAY_MS),
        },
        [{ occurredAt: at(2 * DAY_MS) }],
      );
      const empty = await insertCase(prisma, tenantId);
      const otherQueue = await seedCase(tenantId, { queue: 'posture', family: 'control' }, [{}]);
      const summary = await tower();
      const items = summary.radar?.cases?.items ?? [];
      const byId = new Map(items.map((item) => [item.id, item]));
      expect([...byId.keys()].sort()).toEqual([normal, late, future].sort());
      for (const id of [quiet, empty, otherQueue]) expect(byId.has(id)).toBe(false);
      expect(byId.get(normal)).toMatchObject({ lastActivityAt: at(3 * HOUR_MS).toISOString(), recent: 1 });
      expect(byId.get(late)).toMatchObject({
        lastActivityAt: at(HOUR_MS).toISOString(),
        recent: 0,
        total: 1,
      });
      expect(byId.get(future)).toMatchObject({ lastActivityAt: summary.generatedAt, recent: 0 });
      expect(summary.radar?.cases?.alerts).toBe(1);
    });

    it('o caso inteiro num incidente aberto não tem nada pendente, mas continua com a gravidade e o lugar dele', async () => {
      const { tenantId, tower } = await setup('em incidente');
      const other = await setup('em incidente de outro');
      const critical = await insertIncident(prisma, tenantId, {
        severity: 'critical',
        firstSeenAt: new Date(Date.now() - 2 * HOUR_MS),
      });
      const medium = await insertIncident(prisma, tenantId, { severity: 'medium' });
      const resolved = await insertIncident(prisma, tenantId, {
        severity: 'critical',
        status: 'resolved',
        resolvedAt: new Date(),
      });
      const pending = await seedCase(tenantId, {}, [{ severity: 'high' }]);
      // Promovido a um incidente já resolvido, mas com um alerta num aberto: vale o aberto, o mais grave.
      const held = await seedCase(tenantId, { incidentId: resolved }, [
        { severity: 'critical', incidentId: critical },
        { severity: 'low', incidentId: medium },
        { severity: 'low', incidentId: resolved },
      ]);
      const done = await seedCase(tenantId, {}, [{ severity: 'critical', incidentId: resolved }]);
      const foreign = await insertIncident(prisma, other.tenantId, { severity: 'critical' });
      const foreignCase = await seedCase(other.tenantId, {}, [{ incidentId: foreign }]);
      const items = (await tower()).radar?.cases?.items ?? [];
      expect(items.map(({ id, severity, incident }) => [id, severity, incident])).toEqual([
        [held, null, { id: critical, open: true, severity: 'critical' }],
        [pending, 'high', null],
        [done, null, null],
      ]);
      expect(JSON.stringify(items)).not.toContain(foreign);
      expect((await other.tower()).radar?.cases?.items.map(({ id }) => id)).toEqual([foreignCase]);
    });

    it('o setor e as fontes de cada caso, o tratado (sem severidade) e o incidente dele', async () => {
      const { tenantId, tower } = await setup('setores');
      const open = await insertIncident(prisma, tenantId);
      const resolved = await insertIncident(prisma, tenantId, {
        status: 'resolved',
        resolvedAt: new Date(),
      });
      const expected: [string, object][] = [];
      const add = async (
        data: Parameters<typeof insertCase>[2],
        item: object,
        status: 'new' | 'resolved' = 'new',
      ) => {
        expected.push([await seedCase(tenantId, data, [{ status }]), item]);
      };
      await add(
        { incidentId: open },
        { sector: 'aws', sources: ['cloudtrail'], incident: { id: open, open: true, severity: 'high' } },
      );
      await add(
        { family: 'gcp-audit', incidentId: resolved },
        {
          sector: 'gcp',
          sources: ['gcp_audit'],
          incident: { id: resolved, open: false, severity: 'high' },
        },
      );
      await add(
        { family: 'waf', ruleIds: ['990330'] },
        { sector: 'cloudflare', sources: ['cloudflare_waf'], incident: null },
      );
      await add({ family: 'host' }, { sector: 'agents', sources: ['wazuh_agent'] }, 'resolved');
      await add({ family: 'other', accounts: ['agent:001'] }, { sector: 'agents', sources: [] });
      await add(
        { family: 'other', accounts: ['d0e0000000000000000000000000a1fa'] },
        { sector: 'cloudflare' },
      );
      await add({ family: 'other', accounts: ['loja-demo'] }, { sector: 'gcp' });
      await add({ family: 'other', accounts: [] }, { sector: 'aws' });
      const items = new Map((await tower()).radar?.cases?.items.map((item) => [item.id, item]));
      for (const [id, item] of expected) expect(items.get(id), JSON.stringify(item)).toMatchObject(item);
      expect(items.get(expected[3]?.[0] ?? '')).toMatchObject({ severity: null, pending: 0, total: 1 });
    });
  });

  describe('MITRE com os casos', () => {
    it.each([7, 29])('cliente sorteado %i: cada tática, contra a conta refeita', async (seed) => {
      const { tenantId, tower } = await setup(`mitre ${seed}`);
      const world = await seedWorld(prisma, tenantId, { seed, now: new Date(), cases: 40 });
      const summary = await tower();
      const to = new Date(summary.generatedAt);
      const from = new Date(to.getTime() - 30 * DAY_MS);
      expect(summary.mitre.tactics.map(({ name, cases }) => [name, cases])).toEqual(
        MITRE_TACTIC_NAMES.map((name) => [name, expectedTacticCases(world, name, from, to)]),
      );
      const plain = (await tower('/v1/tower')).mitre.tactics;
      expect(summary.mitre.tactics.map(({ cases: _cases, ...tactic }) => tactic)).toEqual(plain);
    });

    it('vale por um tempo curto, por cliente, e depois é calculado de novo', async () => {
      const { tenantId, tower } = await setup('memória');
      const impact = async () =>
        (await tower()).mitre.tactics.find((tactic) => tactic.name === 'Impact')?.cases;
      await seedCase(tenantId, {}, [{ mitreTactics: ['Impact'] }]);
      expect(await impact()).toBe(1);
      await seedCase(tenantId, {}, [{ mitreTactics: ['Impact'] }]);
      expect(await impact()).toBe(1);
      // O outro cliente não espera a memória deste.
      const other = await setup('memória de outro');
      await seedCase(other.tenantId, {}, [{ mitreTactics: ['Impact'] }]);
      expect((await other.tower()).mitre.tactics.find((tactic) => tactic.name === 'Impact')?.cases).toBe(1);
      const real = performance.now.bind(performance);
      vi.spyOn(performance, 'now').mockImplementation(() => real() + TOWER_MITRE_TTL_MS + 1);
      expect(await impact()).toBe(2);
    });
  });
});
