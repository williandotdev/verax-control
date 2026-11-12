import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  addDays,
  brasiliaDay,
  currentBillingCycle,
  dayAsDate,
  GB_BYTES,
  planUsageSchema,
  type TenantPlan,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { writeTenantPlan } from '../src/plan/tenant-plan.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import {
  apiHostOf,
  createCellTenant,
  createSignedInUserOnHost,
  testCell,
  uniqueSlug,
} from './support/cell.js';
import { createApp } from './support/create-app.js';

/** Planos FICTÍCIOS (sem relação com o que a Verax vende). */
const PLATAFORMA: TenantPlan = {
  planId: 'plataforma',
  limits: { maxCloudAccounts: 5, maxUsers: 5, monthlyGib: null, historyDays: 90 },
  franchiseGbPerDay: 4,
};
const ENTERPRISE: TenantPlan = {
  planId: 'enterprise',
  limits: { maxCloudAccounts: 5, maxUsers: 5, monthlyGib: 50, historyDays: 90 },
  franchiseGbPerDay: null,
};

describe('contador da franquia no GET /v1/plan (CE-10, célula)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  async function tenantWith(plan: TenantPlan) {
    const slug = uniqueSlug('frq');
    const tenantId = await createCellTenant(app, slug, plan);
    const admin = await createSignedInUserOnHost(app, slug, { role: 'admin_cliente', tenantId });
    const get = () =>
      request(app.getHttpServer()).get('/v1/plan').set('Host', apiHostOf(slug)).set('Cookie', admin.cookie);
    return { tenantId, slug, admin, get };
  }

  const usageDay = (tenantId: string, day: string, source: string, bytes: number) =>
    prisma.ingestUsageDay.create({
      data: { tenantId, day: dayAsDate(day), source, bytes: BigInt(bytes), events: 1n },
    });

  beforeAll(async () => {
    app = await createApp({ cell: testCell() });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('a Plataforma recebe o contador: ciclo, orçamento, volume do ciclo, projeção e 30 dias por fonte; A/B', async () => {
    const a = await tenantWith(PLATAFORMA);
    const b = await tenantWith(PLATAFORMA);
    const today = brasiliaDay(new Date());
    const cycle = currentBillingCycle(new Date());
    await usageDay(a.tenantId, today, 'aws', 2 * GB_BYTES);
    await usageDay(a.tenantId, today, 'gcp', GB_BYTES);
    await usageDay(a.tenantId, today, 'cloudflare', GB_BYTES / 2);
    // 40 dias atrás: fora do ciclo e do gráfico.
    await usageDay(a.tenantId, addDays(today, -40), 'aws', 99 * GB_BYTES);
    // O volume de B nunca aparece para A.
    await usageDay(b.tenantId, today, 'aws', 200 * GB_BYTES);

    // O contrato é o mesmo schema estrito que o painel usa (`usePlanUsage`): API e painel não divergem.
    const body = planUsageSchema.parse((await a.get().expect(200)).body);
    const franchise = body.franchise;
    if (franchise === undefined) throw new Error('a Plataforma tem o contador da franquia');
    expect(body.plan).toMatchObject({ id: 'plataforma', label: 'Plataforma' });
    expect(franchise.cycle).toEqual(cycle);
    expect(franchise.franchiseGbPerDay).toBe(4);
    expect(franchise.schedule).toEqual([{ from: cycle.start, gbPerDay: 4 }]);
    expect(franchise.budgetGb).toBe(4 * cycle.days);
    const used = 3.5 * GB_BYTES;
    expect(franchise.usedBytes).toBe(used);
    expect(franchise.dailyAverageBytes).toBe(Math.floor(used / cycle.day));
    expect(franchise.projectedBytes).toBe(Math.floor((used * cycle.days) / cycle.day));
    expect(franchise.days).toHaveLength(30);
    expect(franchise.days.at(-1)).toEqual({
      day: today,
      aws: 2 * GB_BYTES,
      gcp: GB_BYTES,
      cloudflare: GB_BYTES / 2,
    });
    expect(franchise.days.slice(0, -1).every((day) => day.aws + day.gcp + day.cloudflare === 0)).toBe(true);

    const other = planUsageSchema.parse((await b.get().expect(200)).body);
    expect(other.franchise?.usedBytes).toBe(200 * GB_BYTES);
    // 200 GB num dia contra 4 GB/dia (mais de 31 vezes a franquia): a projeção passa da franquia em qualquer dia do ciclo.
    expect(other.franchise?.projectedOverageUnits).toBeGreaterThan(0);
  });

  it('o plano sem franquia não recebe o bloco', async () => {
    const enterprise = await tenantWith(ENTERPRISE);
    const body = planUsageSchema.parse((await enterprise.get().expect(200)).body);
    expect(body.plan.id).toBe('enterprise');
    expect(body).not.toHaveProperty('franchise');
  });
});

describe('contador da franquia no nó dedicado (CE-10)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp({ plan: { PLAN: 'essencial' } });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('o plano é o do node.conf, sem franquia: nada muda no GET /v1/plan, mesmo com uma linha antiga da Plataforma', async () => {
    const tenantId = await createTenant(app, 'Cliente Demo A (dedicado, sem franquia)');
    await writeTenantPlan(prisma, tenantId, PLATAFORMA, 'control_plane');
    const admin = await createSignedInUser(app, { role: 'admin_cliente', tenantId });
    const body = planUsageSchema.parse(
      (await request(app.getHttpServer()).get('/v1/plan').set('Cookie', admin.cookie).expect(200)).body,
    );
    expect(body.plan.id).toBe('essencial');
    expect(body).not.toHaveProperty('franchise');
  });
});
