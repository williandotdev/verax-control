import 'reflect-metadata';
import { REPORT_KINDS, reportSchemas, resolvePlan } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateDaysAgo, type PlanHistoryFixture, planHistoryFixture } from './support/plan-history.js';

/** O nó destes testes está no Profissional: o histórico vem da tabela de planos do repositório. */
const HISTORY_DAYS = resolvePlan('profissional').limits.historyDays as number;

describe('histórico do plano nas telas: Profissional (fase 2, PR-20)', () => {
  let fx: PlanHistoryFixture;

  beforeAll(async () => {
    fx = await planHistoryFixture({ PLAN: 'profissional' });
  });

  afterAll(async () => {
    await fx.app.close();
  });

  it('o Profissional guarda 365 dias, e todo papel lê isso', async () => {
    expect(HISTORY_DAYS).toBe(365);
    for (const role of ['admin_cliente', 'analista_cliente', 'leitura'] as const) {
      expect((await fx.as[role]('/v1/plan/history').expect(200)).body).toEqual({ historyDays: 365 });
    }
  });

  it('achados de 12 meses: o de 200 dias aparece, só em 12 meses, e nada do outro cliente', async () => {
    const finding = await fx.insertFinding(fx.tenantA, 200);
    const otherFinding = await fx.insertFinding(fx.tenantB, 200);
    for (const role of ['admin_cliente', 'analista_cliente', 'leitura'] as const) {
      const ids = await fx.findingIds(role, '12m');
      expect(ids).toContain(finding);
      expect(ids).not.toContain(otherFinding);
    }
    expect(await fx.findingIds('leitura', '90d')).not.toContain(finding);
  });

  it('auditoria de 12 meses: o registro de 200 dias aparece, e nada do outro cliente', async () => {
    const entry = await fx.insertAudit(fx.tenantA, 200);
    const otherEntry = await fx.insertAudit(fx.tenantB, 200);
    const ids = await fx.auditIds('12m');
    expect(ids).toContain(entry);
    expect(ids).not.toContain(otherEntry);
    expect(await fx.auditIds('90d')).not.toContain(entry);
  });

  it('relatórios de 12 meses, no contrato; o resumo tem 366 dias e conta o achado de 300 dias', async () => {
    for (const kind of REPORT_KINDS) {
      const response = await fx.as.leitura(`/v1/reports/${kind}?period=12m`).expect(200);
      expect(reportSchemas[kind].safeParse(response.body).success).toBe(true);
    }
    await fx.insertFinding(fx.tenantA, 300);
    const year = reportSchemas.summary.parse(
      (await fx.as.leitura('/v1/reports/summary?period=12m').expect(200)).body,
    );
    const quarter = reportSchemas.summary.parse(
      (await fx.as.leitura('/v1/reports/summary?period=90d').expect(200)).body,
    );
    expect(year.period).toBe('12m');
    expect(year.daily).toHaveLength(366);
    expect(year.findings.total).toBeGreaterThan(quarter.findings.total);
  });

  it('a evolução da postura mostra 365 dias', async () => {
    const now = Date.now();
    await fx.insertScans(Array.from({ length: 400 }, (_, days) => days));
    const [account] = (await fx.posture()).accounts;
    expect(account?.history).toHaveLength(HISTORY_DAYS);
    expect(account?.history[0]?.date).toBe(dateDaysAgo(HISTORY_DAYS - 1, now));
    expect(account?.history.at(-1)?.date).toBe(dateDaysAgo(0, now));
  });
});
