import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { casePageSchema, PERIOD_BEYOND_HISTORY_CODE, resolvePlan } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { cleanCases, insertCase, insertFinding } from './support/cases.js';
import { createApp } from './support/create-app.js';

const DAY_MS = 24 * 3_600_000;
const HISTORY_DAYS = resolvePlan('essencial').limits.historyDays as number;

/** O período e o intervalo da lista de casos não passam do histórico do plano, como nos alertas. */
describe('casos e o histórico do plano (Essencial)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let cookie: string;

  beforeAll(async () => {
    app = await createApp({ casesMode: 'on', plan: { PLAN: 'essencial' } });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo (casos e histórico)');
    cookie = (await createSignedInUser(app, { role: 'leitura', tenantId })).cookie;
    const at = new Date(Date.now() - 60 * DAY_MS);
    const caseId = await insertCase(prisma, tenantId, {
      openedAt: at,
      firstSeenAt: at,
      lastSeenAt: at,
      lastAlertAt: at,
    });
    await insertFinding(prisma, tenantId, { caseId });
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantId]);
    await app.close();
  }, 60_000);

  const list = (query: string) =>
    request(app.getHttpServer()).get(`/v1/cases?${query}`).set('Cookie', cookie);
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

  it('os períodos que cabem no plano', async () => {
    expect(HISTORY_DAYS).toBe(90);
    for (const [period, total] of [
      ['24h', 0],
      ['7d', 0],
      ['30d', 0],
      ['90d', 1],
    ] as const) {
      const response = await list(`period=${period}`).expect(200);
      expect(casePageSchema.parse(response.body).total, period).toBe(total);
    }
    // Sem período, tudo o que está guardado.
    expect(casePageSchema.parse((await list('').expect(200)).body).total).toBe(1);
  });

  it('o período e o intervalo além do histórico são recusados, com o código de sempre', async () => {
    const period = await list('period=12m').expect(400);
    expect(period.body).toMatchObject({ code: PERIOD_BEYOND_HISTORY_CODE });
    const range = await list(`from=${daysAgo(120)}&to=${daysAgo(100)}`).expect(400);
    expect(range.body).toMatchObject({ code: PERIOD_BEYOND_HISTORY_CODE });
    await list(`from=${daysAgo(89)}&to=${daysAgo(1)}`).expect(200);
  });
});
