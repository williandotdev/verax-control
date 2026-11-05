import 'reflect-metadata';
import { POSTURE_HISTORY_MAX_DAYS, reportSchemas } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateDaysAgo, type PlanHistoryFixture, planHistoryFixture } from './support/plan-history.js';

/** Sem informar o plano, o nó de teste é o `interno` (o nó da Verax): histórico sem limite. */
describe('histórico do plano nas telas: Interno, sem limite (fase 2, PR-20)', () => {
  let fx: PlanHistoryFixture;

  beforeAll(async () => {
    fx = await planHistoryFixture();
  });

  afterAll(async () => {
    await fx.app.close();
  });

  it('o histórico sem limite chega como null', async () => {
    expect((await fx.as.leitura('/v1/plan/history').expect(200)).body).toEqual({ historyDays: null });
  });

  it('12 meses é aceito em achados, auditoria e relatórios', async () => {
    const finding = await fx.insertFinding(fx.tenantA, 300);
    expect(await fx.findingIds('leitura', '12m')).toContain(finding);
    const entry = await fx.insertAudit(fx.tenantA, 300);
    expect(await fx.auditIds('12m')).toContain(entry);
    const summary = reportSchemas.summary.parse(
      (await fx.as.leitura('/v1/reports/summary?period=12m').expect(200)).body,
    );
    expect(summary.findings.total).toBe(1);
  });

  it('a evolução da postura vai até o teto de 365 dias', async () => {
    const now = Date.now();
    await fx.insertScans(Array.from({ length: 400 }, (_, days) => days));
    const [account] = (await fx.posture()).accounts;
    expect(account?.history).toHaveLength(POSTURE_HISTORY_MAX_DAYS);
    expect(account?.history[0]?.date).toBe(dateDaysAgo(POSTURE_HISTORY_MAX_DAYS - 1, now));
  });
});
