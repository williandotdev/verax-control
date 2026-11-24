import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  MITRE_TACTIC_NAMES,
  mitreReport,
  REPORT_KINDS,
  type ReportFinding,
  type ReportIncident,
  reportSchemas,
  towerSummarySchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { REPORT_BATCH_SIZE } from '../src/reports/reports.service.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 3_600_000;

describe('relatórios e resumo MITRE da Torre', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let get: (path: string) => request.Test;
  let tenantA: string;
  let tenantB: string;
  const account = String(randomInt(100_000_000_000, 999_999_999_999));

  async function insertFinding(tenantId: string, hoursAgo: number, tactics: string[], ruleId = '80202') {
    return prisma.finding.create({
      data: {
        tenantId,
        accountId: account,
        source: 'wazuh',
        sourceEventId: randomUUID(),
        logSource: 'cloudtrail',
        occurredAt: new Date(Date.now() - hoursAgo * HOUR),
        severity: 'high',
        ruleId,
        ruleLevel: 10,
        title: `Regra ${ruleId}`,
        actorUser: 'deploy-bot',
        sourceIp: '198.51.100.23',
        mitreTactics: tactics,
        mitreTechniques: tactics.length > 0 ? ['T1562.008'] : [],
      },
    });
  }

  beforeAll(async () => {
    // Lotes de 2 achados: todo relatório aqui passa por mais de um lote, como um cliente grande em produção.
    app = await createApp({ overrideProviders: [{ provide: REPORT_BATCH_SIZE, useValue: 2 }] });
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (relatórios)');
    tenantB = await createTenant(app, 'Cliente B (relatórios)');
    await prisma.cloudAccount.create({
      data: { tenantId: tenantA, accountId: account, regions: ['sa-east-1'] },
    });
    const reader = await createSignedInUser(app, { role: 'leitura', tenantId: tenantA });
    get = (path: string) => request(app.getHttpServer()).get(path).set('Cookie', reader.cookie);

    await insertFinding(tenantA, 2, ['Defense Evasion']);
    await insertFinding(tenantA, 3, ['Defense Evasion', 'Credential Access'], '80255');
    // Fora dos 7 dias, dentro dos 30.
    await insertFinding(tenantA, 24 * 10, ['Impact'], '80300');
    // De outro cliente: não pode contar.
    await insertFinding(tenantB, 1, ['Defense Evasion']);
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(REPORT_KINDS)('relatório %s: no formato do contrato', async (kind) => {
    const response = await get(`/v1/reports/${kind}?period=30d`).expect(200);
    expect(reportSchemas[kind].safeParse(response.body).success).toBe(true);
  });

  it('o período conta só o que começou nele, e só do próprio cliente', async () => {
    const week = reportSchemas.summary.parse((await get('/v1/reports/summary?period=7d').expect(200)).body);
    expect(week.findings.total).toBe(2);
    const month = reportSchemas.summary.parse((await get('/v1/reports/summary').expect(200)).body);
    expect(month.period).toBe('30d');
    expect(month.findings.total).toBe(3);

    const mitre = reportSchemas.mitre.parse((await get('/v1/reports/mitre?period=7d').expect(200)).body);
    expect(mitre.tactics.find((tactic) => tactic.name === 'Defense Evasion')?.findings).toBe(2);
    expect(mitre.tactics.find((tactic) => tactic.name === 'Impact')?.findings).toBe(0);

    const rules = reportSchemas.rules.parse((await get('/v1/reports/rules?period=30d').expect(200)).body);
    expect(rules.items.map((rule) => rule.ruleId).sort()).toEqual(['80202', '80255', '80300']);

    const coverage = reportSchemas.coverage.parse((await get('/v1/reports/coverage').expect(200)).body);
    expect(coverage.accounts).toEqual([expect.objectContaining({ accountId: account, findings: 3 })]);
  });

  it('lê o período inteiro em lotes: nenhum achado fica de fora nem conta duas vezes, mesmo com a mesma data', async () => {
    const tenantC = await createTenant(app, 'Cliente C (relatórios em lotes)');
    const readerC = await createSignedInUser(app, { role: 'leitura', tenantId: tenantC });
    const exception = await prisma.alertException.create({
      data: {
        tenantId: tenantC,
        ruleId: '80202',
        field: 'user',
        value: 'scanner-interno',
        reason: 'Varredura interna agendada',
        matchedCount: 9,
        createdById: readerC.id,
      },
    });
    const incident = await prisma.incident.create({
      data: {
        tenantId: tenantC,
        severity: 'high',
        status: 'resolved',
        riskScore: 55,
        findingCount: 2,
        firstSeenAt: new Date(Date.now() - 6 * HOUR),
        lastSeenAt: new Date(Date.now() - 5 * HOUR),
        createdAt: new Date(Date.now() - 6 * HOUR),
        resolvedAt: new Date(Date.now() - 4 * HOUR),
        mitreTactics: ['Discovery'],
      },
    });
    const at = new Date(Date.now() - 5 * HOUR);
    const times = [new Date(Date.now() - HOUR), at, at, at, new Date(Date.now() - 6 * HOUR)];
    for (const [index, occurredAt] of times.entries()) {
      await prisma.finding.create({
        data: {
          // Dois achados silenciados pela exceção e dois no incidente, na virada dos lotes de 2.
          exceptionId: index < 2 ? exception.id : null,
          incidentId: index >= 3 ? incident.id : null,
          tenantId: tenantC,
          accountId: account,
          source: 'wazuh',
          sourceEventId: randomUUID(),
          logSource: 'cloudtrail',
          occurredAt,
          severity: 'medium',
          ruleId: '80202',
          ruleLevel: 7,
          title: 'Regra 80202',
          mitreTactics: ['Discovery'],
          mitreTechniques: ['T1087'],
        },
      });
    }
    const getC = (path: string) => request(app.getHttpServer()).get(path).set('Cookie', readerC.cookie);
    const summary = reportSchemas.summary.parse(
      (await getC('/v1/reports/summary?period=7d').expect(200)).body,
    );
    expect(summary.findings.total).toBe(5);
    expect(summary.daily.reduce((sum, day) => sum + day.medium, 0)).toBe(5);
    const rules = reportSchemas.rules.parse((await getC('/v1/reports/rules?period=7d').expect(200)).body);
    expect(rules.items).toEqual([expect.objectContaining({ ruleId: '80202', findings: 5 })]);
    const tower = towerSummarySchema.parse((await getC('/v1/tower').expect(200)).body);
    expect(tower.mitre.tactics.find((tactic) => tactic.name === 'Discovery')).toMatchObject({
      findings: 5,
      incidents: 1,
      techniques: [{ id: 'T1087', findings: 5 }],
    });

    const exceptions = reportSchemas.exceptions.parse(
      (await getC('/v1/reports/exceptions?period=7d').expect(200)).body,
    );
    expect(exceptions.items).toEqual([
      expect.objectContaining({ id: exception.id, matchedInPeriod: 2, matchedTotal: 9, active: true }),
    ]);
    const incidents = reportSchemas.incidents.parse(
      (await getC('/v1/reports/incidents?period=7d').expect(200)).body,
    );
    expect(incidents.bySeverity.find((row) => row.severity === 'high')).toEqual({
      severity: 'high',
      opened: 1,
      resolved: 1,
      meanTimeToResolveMinutes: 120,
    });
    expect(incidents.items).toEqual([expect.objectContaining({ id: incident.id, status: 'resolved' })]);
    const entities = reportSchemas.entities.parse(
      (await getC('/v1/reports/entities?period=7d').expect(200)).body,
    );
    expect(entities.users).toEqual([]);
  });

  it('a Torre traz o resumo MITRE dos últimos 30 dias', async () => {
    const summary = towerSummarySchema.parse((await get('/v1/tower').expect(200)).body);
    expect(summary.mitre.periodDays).toBe(30);
    expect(summary.mitre.tactics).toHaveLength(14);
    expect(summary.mitre.tactics.find((tactic) => tactic.name === 'Defense Evasion')).toMatchObject({
      findings: 2,
      techniques: [{ id: 'T1562.008', findings: 2 }],
    });
    expect(summary.mitre.tactics.find((tactic) => tactic.name === 'Impact')?.findings).toBe(1);
  });

  describe('o MITRE contado pelo banco é o mesmo, achado a achado', () => {
    const DAY = 24 * HOUR;
    /** Sorteio repetível (xorshift): o mesmo dado a cada execução. */
    const random = (() => {
      let state = 20_261_124;
      return (below: number) => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
      };
    })();
    const pick = <T>(list: readonly T[]): T => list[random(list.length)] as T;
    let getD: (path: string) => request.Test;
    let getE: (path: string) => request.Test;
    let tenantD: string;
    let tenantE: string;
    let now: number;
    const boundary = { from: 0, to: 0 };

    function row(tenantId: string, at: number, overrides: Partial<Record<string, unknown>> = {}) {
      return {
        tenantId,
        accountId: account,
        source: 'wazuh',
        sourceEventId: randomUUID(),
        logSource: 'cloudtrail',
        occurredAt: new Date(at),
        severity: 'medium' as const,
        ruleId: '80202',
        ruleLevel: 7,
        title: 'Regra 80202',
        mitreTactics: [] as string[],
        mitreTechniques: [] as string[],
        ...overrides,
      };
    }

    const asReportFinding = (finding: {
      occurredAt: Date;
      mitreTactics: string[];
      mitreTechniques: string[];
    }): ReportFinding =>
      ({
        occurredAt: finding.occurredAt.toISOString(),
        mitreTactics: finding.mitreTactics,
        mitreTechniques: finding.mitreTechniques,
      }) as unknown as ReportFinding;

    /** O relatório calculado achado por achado, como no modo de demonstração, sobre tudo o que o cliente tem. */
    async function oneByOne(
      tenantId: string,
      window: { period: 'custom' | '30d'; from: string; to: string },
    ) {
      const findings = await prisma.finding.findMany({ where: { tenantId } });
      const incidents = await prisma.incident.findMany({ where: { tenantId } });
      return mitreReport(
        findings.map(asReportFinding),
        incidents.map(
          (incident) =>
            ({
              firstSeenAt: incident.firstSeenAt.toISOString(),
              mitreTactics: incident.mitreTactics,
            }) as unknown as ReportIncident,
        ),
        window,
      );
    }

    beforeAll(async () => {
      tenantD = await createTenant(app, 'Cliente D (MITRE contado pelo banco)');
      tenantE = await createTenant(app, 'Cliente E (MITRE contado pelo banco)');
      const readerD = await createSignedInUser(app, { role: 'leitura', tenantId: tenantD });
      const readerE = await createSignedInUser(app, { role: 'leitura', tenantId: tenantE });
      getD = (path) => request(app.getHttpServer()).get(path).set('Cookie', readerD.cookie);
      getE = (path) => request(app.getHttpServer()).get(path).set('Cookie', readerE.cookie);
      now = Date.now();
      boundary.from = now - 20 * DAY;
      boundary.to = now - 10 * DAY;
      const exception = await prisma.alertException.create({
        data: {
          tenantId: tenantD,
          ruleId: '80202',
          field: 'user',
          value: 'scanner-interno',
          reason: 'Varredura interna agendada',
          createdById: readerD.id,
        },
      });
      const incidents: { id: string }[] = [];
      for (const [index, days] of [1, 5, 15, 25, 40].entries()) {
        incidents.push(
          await prisma.incident.create({
            data: {
              tenantId: tenantD,
              severity: 'high',
              status: index % 2 === 0 ? 'open' : 'resolved',
              riskScore: 50,
              findingCount: 1,
              firstSeenAt: new Date(now - days * DAY),
              lastSeenAt: new Date(now),
              resolvedAt: index % 2 === 0 ? null : new Date(now - HOUR),
              mitreTactics:
                index === 2 ? ['Impact', 'Impact', 'Discovery'] : [pick(MITRE_TACTIC_NAMES), 'Impact'],
            },
          }),
        );
      }
      // Incidentes exatamente nas pontas da janela, e um milissegundo fora dela.
      for (const at of [boundary.from, boundary.to, boundary.from - 1, boundary.to + 1]) {
        await prisma.incident.create({
          data: {
            tenantId: tenantD,
            severity: 'low',
            status: 'open',
            riskScore: 10,
            findingCount: 0,
            firstSeenAt: new Date(at),
            lastSeenAt: new Date(now),
            mitreTactics: ['Collection'],
          },
        });
      }
      const tactics = [...MITRE_TACTIC_NAMES, 'Tática fora da lista', 'impact', ''];
      const techniques = Array.from(
        { length: 30 },
        (_, index) => `T${1000 + index}${index % 3 === 0 ? '.001' : ''}`,
      );
      const rows = Array.from({ length: 400 }, (_, index) => {
        const some = Array.from({ length: random(4) }, () => pick(tactics));
        return row(tenantD, now - random(35 * DAY), {
          mitreTactics: index % 7 === 0 ? [...some, ...some] : some,
          mitreTechniques: Array.from({ length: random(5) }, () => pick(techniques)),
          severity: pick(['critical', 'high', 'medium', 'low'] as const),
          status: pick(['new', 'legitimate', 'resolved'] as const),
          exceptionId: index % 9 === 0 ? exception.id : null,
          incidentId: index % 11 === 0 ? pick(incidents).id : null,
        });
      });
      for (const at of [boundary.from, boundary.to, boundary.from - 1, boundary.to + 1]) {
        rows.push(row(tenantD, at, { mitreTactics: ['Collection'], mitreTechniques: ['T1530'] }));
      }
      await prisma.finding.createMany({ data: rows });
      // O outro cliente, com muito mais do mesmo: nada dele pode contar.
      await prisma.finding.createMany({
        data: Array.from({ length: 50 }, () =>
          row(tenantE, now - HOUR, { mitreTactics: ['Collection'], mitreTechniques: ['T9999'] }),
        ),
      });
    });

    it('o relatório, em várias janelas: com repetidos, táticas fora da lista, empates, incidentes, exceções e as pontas', async () => {
      const windows = [
        [now - 35 * DAY, now],
        [now - 7 * DAY, now],
        [now - DAY, now],
        [boundary.from, boundary.to],
        [now - 34 * DAY, now - 33 * DAY],
        [now - HOUR, now - HOUR + 1000],
      ].map(([from, to]) => ({
        period: 'custom' as const,
        from: new Date(from as number).toISOString(),
        to: new Date(to as number).toISOString(),
      }));
      for (const window of windows) {
        const response = await getD(`/v1/reports/mitre?from=${window.from}&to=${window.to}`).expect(200);
        expect(reportSchemas.mitre.parse(response.body)).toEqual(await oneByOne(tenantD, window));
      }
      // As pontas da janela contam, e o milissegundo fora dela não.
      const inside = reportSchemas.mitre.parse(
        (await getD(`/v1/reports/mitre?from=${windows[3]?.from}&to=${windows[3]?.to}`).expect(200)).body,
      );
      const collection = inside.tactics.find((tactic) => tactic.name === 'Collection');
      expect(collection?.incidents).toBeGreaterThanOrEqual(2);
      expect(collection?.techniques.find((technique) => technique.id === 'T1530')).toEqual({
        id: 'T1530',
        findings: 2,
      });
    });

    it('a Torre dá os mesmos números do relatório de 30 dias, e de cada cliente só os dele', async () => {
      const tower = towerSummarySchema.parse((await getD('/v1/tower').expect(200)).body);
      const report = reportSchemas.mitre.parse((await getD('/v1/reports/mitre?period=30d').expect(200)).body);
      expect(tower.mitre).toEqual({ periodDays: 30, tactics: report.tactics });
      expect(report).toEqual(await oneByOne(tenantD, { ...report, period: '30d' }));
      expect(JSON.stringify(tower.mitre)).not.toContain('T9999');

      // O outro cliente, logo depois (com o resumo do primeiro ainda guardado): só o dele, e o primeiro não muda.
      const other = towerSummarySchema.parse((await getE('/v1/tower').expect(200)).body);
      expect(other.mitre.tactics.find((tactic) => tactic.name === 'Collection')).toMatchObject({
        findings: 50,
        incidents: 0,
        techniques: [{ id: 'T9999', findings: 50 }],
      });
      expect(other.mitre.tactics.filter((tactic) => tactic.findings > 0)).toHaveLength(1);
      const again = towerSummarySchema.parse((await getD('/v1/tower').expect(200)).body);
      expect(again.mitre).toEqual(tower.mitre);
    });

    it('a Torre repete o resumo MITRE por um tempo curto, e o relatório nunca', async () => {
      const tenantF = await createTenant(app, 'Cliente F (resumo guardado)');
      const readerF = await createSignedInUser(app, { role: 'leitura', tenantId: tenantF });
      const getF = (path: string) => request(app.getHttpServer()).get(path).set('Cookie', readerF.cookie);
      const impact = async (path: string) => {
        const body = (await getF(path).expect(200)).body as {
          tactics?: { name: string; findings: number }[];
        } & {
          mitre?: { tactics: { name: string; findings: number }[] };
        };
        return (body.mitre?.tactics ?? body.tactics)?.find((tactic) => tactic.name === 'Impact')?.findings;
      };
      expect(await impact('/v1/tower')).toBe(0);
      await insertFinding(tenantF, 1, ['Impact']);
      expect(await impact('/v1/reports/mitre?period=30d')).toBe(1);
      expect(await impact('/v1/tower')).toBe(0);
      // O resto da Torre é sempre o de agora.
      const summary = towerSummarySchema.parse((await getF('/v1/tower').expect(200)).body);
      expect(summary.radar?.total).toBe(1);
    });

    it('sem cliente escolhido, a equipe da Verax recebe a mesma recusa na Torre e no relatório', async () => {
      const staff = await createSignedInUser(app, { role: 'admin_verax' });
      for (const path of ['/v1/tower', '/v1/reports/mitre?period=7d']) {
        const response = await request(app.getHttpServer()).get(path).set('Cookie', staff.cookie).expect(409);
        expect(JSON.stringify(response.body)).toContain('TENANT_REQUIRED');
      }
    });
  });

  it('últimas 24 horas e intervalo personalizado (tela Detecções): a janela da resposta é a pedida', async () => {
    const day = reportSchemas.summary.parse((await get('/v1/reports/summary?period=24h').expect(200)).body);
    expect(day.period).toBe('24h');
    expect(day.findings.total).toBe(2);

    const from = new Date(Date.now() - 11 * 24 * HOUR).toISOString();
    const to = new Date(Date.now() - 5 * 24 * HOUR).toISOString();
    const range = `from=${from}&to=${to}`;
    const custom = reportSchemas.summary.parse((await get(`/v1/reports/summary?${range}`).expect(200)).body);
    expect(custom).toMatchObject({ period: 'custom', from, to });
    expect(custom.findings.total).toBe(1);

    const mitre = reportSchemas.mitre.parse((await get(`/v1/reports/mitre?${range}`).expect(200)).body);
    expect(mitre).toMatchObject({ period: 'custom', from, to });
    expect(mitre.tactics.find((tactic) => tactic.name === 'Impact')?.findings).toBe(1);
    expect(mitre.tactics.find((tactic) => tactic.name === 'Defense Evasion')?.findings).toBe(0);

    for (const kind of REPORT_KINDS) {
      const response = await get(`/v1/reports/${kind}?${range}`).expect(200);
      expect(reportSchemas[kind].safeParse(response.body).success, kind).toBe(true);
    }
  });

  it.each([
    '/v1/reports/tudo',
    '/v1/reports/summary?period=1y',
    '/v1/reports/summary?period=7d&extra=1',
    '/v1/reports/summary?from=2026-01-01T00:00:00Z',
    '/v1/reports/summary?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
    '/v1/reports/summary?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&period=7d',
    '/v1/reports/summary?from=2025-01-01T00:00:00Z&to=2026-06-01T00:00:00Z',
  ])('parâmetro inválido é recusado: %s', async (path) => {
    await get(path).expect(400);
  });
});
