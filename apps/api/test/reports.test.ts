import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { REPORT_KINDS, reportSchemas, towerSummarySchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
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
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (relatórios)');
    tenantB = await createTenant(app, 'Cliente B (relatórios)');
    await prisma.cloudAccount.create({
      data: { tenantId: tenantA, accountId: account, regions: ['sa-east-1'], externalId: 'x'.repeat(43) },
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

  it.each(['/v1/reports/tudo', '/v1/reports/summary?period=1y', '/v1/reports/summary?period=7d&extra=1'])(
    'parâmetro inválido é recusado: %s',
    async (path) => {
      await get(path).expect(400);
    },
  );
});
