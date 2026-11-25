import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  MITRE_TACTIC_NAMES,
  type MitreReport,
  REPORT_KINDS,
  reportSchemas,
  ROLES,
  type SummaryReport,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { expectedOutcomes, expectedTacticCases, seedWorld } from './support/case-world.js';
import { cleanCases, HOUR_MS, insertCase, insertFinding, insertIncident } from './support/cases.js';
import { createApp } from './support/create-app.js';
import { operate, operatorFor, read, statusRequest } from './support/triage.js';

const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;

/** Os casos nos relatórios, com eles ligados. */
describe('casos nos relatórios (CASES_MODE=on)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];

  async function setup(name: string) {
    const tenantId = await createTenant(app, `Cliente Demo (${name})`);
    tenants.push(tenantId);
    const who = await operatorFor(app, tenantId, 'admin_cliente');
    return {
      tenantId,
      who,
      summary: async (query = 'period=30d&cases=true'): Promise<SummaryReport> =>
        reportSchemas.summary.parse((await read(app, who, `/v1/reports/summary?${query}`).expect(200)).body),
      mitre: async (query = 'period=30d&cases=true'): Promise<MitreReport> =>
        reportSchemas.mitre.parse((await read(app, who, `/v1/reports/mitre?${query}`).expect(200)).body),
    };
  }

  beforeAll(async () => {
    app = await createApp({ casesMode: 'on' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await app.close();
  }, 60_000);

  const custom = (from: Date, to: Date) => `from=${from.toISOString()}&to=${to.toISOString()}&cases=true`;

  it('sem o pedido, nenhum relatório muda; com ele, só o resumo e o MITRE', async () => {
    const { tenantId, who } = await setup('só para quem pede');
    await seedWorld(prisma, tenantId, { seed: 3, now: new Date(), cases: 12 });
    const strip = (body: unknown) =>
      JSON.parse(JSON.stringify(body), (key, value: unknown) =>
        key === 'cases' || key === 'from' || key === 'to' ? undefined : value,
      ) as unknown;
    for (const kind of REPORT_KINDS) {
      const plain = await read(app, who, `/v1/reports/${kind}?period=30d`).expect(200);
      expect(plain.text, kind).not.toContain('"cases"');
      const asked = await read(app, who, `/v1/reports/${kind}?period=30d&cases=true`).expect(200);
      expect(asked.text.includes('"cases"'), kind).toBe(kind === 'summary' || kind === 'mitre');
      expect(reportSchemas[kind].safeParse(asked.body).success, kind).toBe(true);
      expect(strip(asked.body), kind).toEqual(strip(plain.body));
    }
  });

  it('um pedido que não é o do contrato é 400; todos os papéis leem; sem cliente, 409', async () => {
    const { tenantId, who } = await setup('papéis');
    await insertCase(prisma, tenantId);
    for (const query of ['cases=1', 'cases=false', 'cases=']) {
      await read(app, who, `/v1/reports/summary?${query}`).expect(400);
    }
    for (const role of ROLES) {
      const reader = await operatorFor(app, tenantId, role);
      const body = (await read(app, reader, '/v1/reports/summary?cases=true').expect(200))
        .body as SummaryReport;
      expect(body.cases, role).toEqual({ opened: 0, treated: 0, pending: 0, medianMinutesToTreat: null });
    }
    const staff = await createSignedInUser(app, { role: 'admin_verax' });
    for (const kind of ['summary', 'mitre']) {
      await request(app.getHttpServer())
        .get(`/v1/reports/${kind}?cases=true`)
        .set('Cookie', staff.cookie)
        .expect(409);
    }
  });

  it.each([2, 13, 31])(
    'cliente sorteado %i: em várias janelas, contra a conta refeita',
    { timeout: 60_000 },
    async (seed) => {
      const { tenantId, summary, mitre } = await setup(`sorteado ${seed}`);
      const now = Date.now();
      const world = await seedWorld(prisma, tenantId, { seed, now: new Date(now), cases: 45 });
      const at = (days: number) => new Date(now - days * DAY_MS);
      const openings = world.cases.map((row) => row.openedAt).sort((a, b) => a.getTime() - b.getTime());
      const windows: [Date, Date][] = [
        [at(45), at(0)],
        [at(7), at(0)],
        [at(20), at(2)],
        [at(44), at(43)],
        // As pontas contam: a janela começa e acaba na abertura de um caso.
        [openings[3] as Date, openings[20] as Date],
      ];
      for (const [from, to] of windows) {
        const { cases } = await summary(custom(from, to));
        const expected = expectedOutcomes(world, from, to);
        expect(cases).toMatchObject({
          opened: expected.opened,
          treated: expected.treated,
          pending: expected.pending,
        });
        if (expected.medianMinutesToTreat === null) expect(cases?.medianMinutesToTreat).toBeNull();
        else {
          expect(
            Math.abs((cases?.medianMinutesToTreat ?? -9) - expected.medianMinutesToTreat),
          ).toBeLessThanOrEqual(0.5);
        }
        const report = await mitre(custom(from, to));
        expect(report.tactics.map(({ name, cases: count }) => [name, count])).toEqual(
          MITRE_TACTIC_NAMES.map((name) => [name, expectedTacticCases(world, name, from, to)]),
        );
      }
    },
  );

  it('a mediana é por caso: tratar milhares de alertas de um caso de uma vez não a move', async () => {
    const { tenantId, summary } = await setup('mediana');
    const opened = new Date(Date.now() - 5 * DAY_MS);
    const after = (minutes: number) => new Date(opened.getTime() + minutes * MINUTE_MS);
    const treated = async (minutes: number, alerts = 1) => {
      const id = await insertCase(prisma, tenantId, { openedAt: opened });
      for (let index = 0; index < alerts; index += 1) {
        await insertFinding(prisma, tenantId, {
          caseId: id,
          createdAt: opened,
          status: 'resolved',
          triagedAt: after(minutes),
        });
      }
      return id;
    };
    await treated(10);
    await treated(20);
    await treated(90);
    // O caso grande, tratado 4 dias depois numa operação só.
    await treated(4 * 24 * 60, 60);
    await treated(100);
    // Pendente, não entra na mediana.
    const pending = await insertCase(prisma, tenantId, { openedAt: opened });
    await insertFinding(prisma, tenantId, { caseId: pending, createdAt: opened });
    const report = await summary();
    expect(report.cases).toEqual({ opened: 6, treated: 5, pending: 1, medianMinutesToTreat: 90 });
    expect(report.meanTimeToTriageMinutes).toBeGreaterThan(4_000);
  });

  it('o tempo até tratar: o último alerta a sair de "novo" ou a entrar num incidente, e nunca negativo', async () => {
    const { tenantId, summary } = await setup('tempo até tratar');
    const opened = new Date(Date.now() - 2 * DAY_MS);
    const after = (minutes: number) => new Date(opened.getTime() + minutes * MINUTE_MS);
    const only = async (
      findings: Parameters<typeof insertFinding>[2][],
      from: Date,
    ): Promise<number | null | undefined> => {
      const id = await insertCase(prisma, tenantId, { openedAt: from });
      for (const finding of findings) {
        await insertFinding(prisma, tenantId, { caseId: id, createdAt: from, ...finding });
      }
      const { cases } = await summary(custom(from, from));
      expect(cases).toMatchObject({ opened: 1, treated: 1, pending: 0 });
      return cases?.medianMinutesToTreat;
    };
    const start = (index: number) => new Date(opened.getTime() + index * 1_000);
    const shifted = (index: number, minutes: number) => new Date(after(minutes).getTime() + index * 1_000);
    // O último dos dois.
    expect(
      await only(
        [
          { status: 'resolved', triagedAt: shifted(1, 5) },
          { status: 'legitimate', triagedAt: shifted(1, 45) },
        ],
        start(1),
      ),
    ).toBe(45);
    // O incidente aberto depois; e o alerta que chegou depois do incidente.
    const incidentId = await insertIncident(prisma, tenantId, { createdAt: shifted(2, 30) });
    expect(await only([{ incidentId }], start(2))).toBe(30);
    const early = await insertIncident(prisma, tenantId, { createdAt: shifted(3, -600) });
    expect(await only([{ incidentId: early, createdAt: shifted(3, 12) }], start(3))).toBe(12);
    // Em incidente, vale a entrada nele, e não a triagem de antes.
    const later = await insertIncident(prisma, tenantId, { createdAt: shifted(4, 70) });
    expect(
      await only([{ incidentId: later, status: 'investigating', triagedAt: shifted(4, 3) }], start(4)),
    ).toBe(70);
    expect(await only([{ status: 'resolved', triagedAt: shifted(5, -60) }], start(5))).toBe(0);
    // Sem nenhuma marca (tratado sem passar pela triagem): conta como tratado, sem tempo.
    expect(await only([{ status: 'legitimate', triagedAt: null }], start(6))).toBeNull();
  });

  it('a operação em massa trata o caso: sai dos pendentes na hora', async () => {
    const { tenantId, who, summary } = await setup('operação');
    const id = await insertCase(prisma, tenantId, { openedAt: new Date(Date.now() - 3 * HOUR_MS) });
    for (let index = 0; index < 3; index += 1) {
      await insertFinding(prisma, tenantId, { caseId: id, createdAt: new Date(Date.now() - 3 * HOUR_MS) });
    }
    expect((await summary()).cases).toMatchObject({ opened: 1, treated: 0, pending: 1 });
    await operate(app, who, statusRequest({ caseIds: [id] }, 3));
    const { cases } = await summary();
    expect(cases).toMatchObject({ opened: 1, treated: 1, pending: 0 });
    expect(cases?.medianMinutesToTreat).toBeGreaterThanOrEqual(179);
    expect(cases?.medianMinutesToTreat).toBeLessThanOrEqual(183);
  });

  it('A/B: os casos e os incidentes de um cliente nunca entram no relatório do outro', async () => {
    const a = await setup('A');
    const b = await setup('B');
    const opened = new Date(Date.now() - DAY_MS);
    const own = await insertCase(prisma, a.tenantId, { openedAt: opened });
    await insertFinding(prisma, a.tenantId, {
      caseId: own,
      createdAt: opened,
      status: 'resolved',
      triagedAt: new Date(opened.getTime() + 15 * MINUTE_MS),
      mitreTactics: ['Impact'],
    });
    for (let index = 0; index < 4; index += 1) {
      const other = await insertCase(prisma, b.tenantId, { openedAt: opened });
      await insertFinding(prisma, b.tenantId, {
        caseId: other,
        createdAt: opened,
        status: 'resolved',
        triagedAt: new Date(opened.getTime() + 900 * MINUTE_MS),
        mitreTactics: ['Impact'],
      });
    }
    expect((await a.summary()).cases).toEqual({
      opened: 1,
      treated: 1,
      pending: 0,
      medianMinutesToTreat: 15,
    });
    expect((await b.summary()).cases).toMatchObject({ opened: 4, medianMinutesToTreat: 900 });
    const impact = (report: MitreReport) => report.tactics.find(({ name }) => name === 'Impact')?.cases;
    expect(impact(await a.mitre())).toBe(1);
    expect(impact(await b.mitre())).toBe(4);
  });
});
