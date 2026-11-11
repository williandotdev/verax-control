import 'reflect-metadata';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  PERIOD_BEYOND_HISTORY_CODE,
  PLAN_LIMIT_BOUNDS,
  PLAN_LIMIT_REACHED_CODE,
  planLimitMessage,
  planUsageSchema,
  resolvePlan,
  type TenantPlan,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TENANT_PLAN_MISSING_CODE, TenantPlanResolver, writeTenantPlan } from '../src/plan/tenant-plan.js';
import {
  apiHostOf,
  createCellTenant,
  createSignedInUserOnHost,
  csrfOnHost,
  panelOf,
  testCell,
  uniqueSlug,
} from './support/cell.js';
import { createApp } from './support/create-app.js';

/** Sessão de um administrador no endereço do cliente dele (na célula, a sessão só vale lá, CE-01). */
interface CellSession {
  slug: string;
  cookie: string;
  csrfToken: string;
}

/**
 * Planos FICTÍCIOS de dois clientes da mesma célula: números pequenos, para os testes chegarem ao limite, sem relação
 * com o que a Verax vende.
 */
const PLAN_A: TenantPlan = {
  planId: 'plataforma',
  limits: { maxCloudAccounts: 1, maxUsers: 2, monthlyGib: null, historyDays: 30 },
  franchiseGbPerDay: 7,
};
const PLAN_B: TenantPlan = {
  planId: 'enterprise',
  limits: { maxCloudAccounts: 2, maxUsers: 4, monthlyGib: 40, historyDays: 365 },
  franchiseGbPerDay: null,
};

const awsAccountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const gcpProject = () => `vx-${randomInt(1_000_000, 9_999_999)}-celula`;
const cloudflareAccount = () => randomBytes(16).toString('hex');

describe('plano por cliente na célula (CE-02, NODE_MODE=cell)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  async function adminOf(tenantId: string, slug: string): Promise<CellSession> {
    const user = await createSignedInUserOnHost(app, slug, { role: 'admin_cliente', tenantId });
    const { cookie, token } = await csrfOnHost(app, slug, user.cookie);
    return { slug, cookie, csrfToken: token };
  }

  const call = (session: CellSession) => {
    const server = request(app.getHttpServer());
    const write = (method: 'post' | 'delete', path: string) =>
      server[method](path)
        .set('Host', apiHostOf(session.slug))
        .set('Cookie', session.cookie)
        .set('Origin', panelOf(session.slug))
        .set('X-CSRF-Token', session.csrfToken);
    return {
      get: (path: string) =>
        server.get(path).set('Host', apiHostOf(session.slug)).set('Cookie', session.cookie),
      post: (path: string, body: object) => write('post', path).send(body),
      delete: (path: string) => write('delete', path),
    };
  };

  /** Uma conta de cada provedor, em rodízio: todas ocupam vaga. */
  const newAccount = (index: number): object =>
    [
      { provider: 'aws', accountId: awsAccountId(), regions: ['sa-east-1'] },
      { provider: 'gcp', accountId: gcpProject() },
      { provider: 'cloudflare', accountId: cloudflareAccount() },
    ][index % 3] as object;

  const newUser = () => ({
    name: 'Pessoa de teste',
    email: `celula-${randomUUID()}@cliente.example`,
    role: 'leitura',
  });

  /** Um cliente da célula com o plano dado (gravado como o comando do plano de controle grava), e o administrador. */
  async function tenantWith(plan: TenantPlan | null, _name: string) {
    const slug = uniqueSlug('plano');
    const tenantId = await createCellTenant(app, slug, plan);
    return { tenantId, admin: await adminOf(tenantId, slug) };
  }

  beforeAll(async () => {
    app = await createApp({ cell: testCell() });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('A/B: cada cliente tem os próprios limites de contas cloud', async () => {
    const a = await tenantWith(PLAN_A, 'Cliente Demo A');
    const b = await tenantWith(PLAN_B, 'Cliente Demo B');

    await call(a.admin).post('/v1/cloud-accounts', newAccount(0)).expect(201);
    const refusedA = await call(a.admin).post('/v1/cloud-accounts', newAccount(1)).expect(409);
    expect(refusedA.body).toMatchObject({
      code: PLAN_LIMIT_REACHED_CODE,
      message: planLimitMessage('cloudAccounts', 1),
    });

    // O limite de A não vale para B, que tem duas vagas.
    await call(b.admin).post('/v1/cloud-accounts', newAccount(1)).expect(201);
    await call(b.admin).post('/v1/cloud-accounts', newAccount(2)).expect(201);
    const refusedB = await call(b.admin).post('/v1/cloud-accounts', newAccount(0)).expect(409);
    expect(refusedB.body).toMatchObject({ message: planLimitMessage('cloudAccounts', 2) });

    expect(await prisma.cloudAccount.count({ where: { tenantId: a.tenantId } })).toBe(1);
    expect(await prisma.cloudAccount.count({ where: { tenantId: b.tenantId } })).toBe(2);
  });

  it('A/B: cada cliente tem os próprios limites de usuários', async () => {
    const a = await tenantWith(PLAN_A, 'Cliente Demo A');
    const b = await tenantWith(PLAN_B, 'Cliente Demo B');
    // O administrador já ocupa uma vaga: A tem mais uma; B, mais três.
    await call(a.admin).post('/v1/users', newUser()).expect(201);
    const refused = await call(a.admin).post('/v1/users', newUser()).expect(409);
    expect(refused.body).toMatchObject({ message: planLimitMessage('users', 2) });
    for (let count = 1; count < 4; count += 1) await call(b.admin).post('/v1/users', newUser()).expect(201);
    await call(b.admin).post('/v1/users', newUser()).expect(409);
  });

  it('"Plano e uso" e o histórico mostram o plano de cada cliente', async () => {
    const a = await tenantWith(PLAN_A, 'Cliente Demo A');
    const b = await tenantWith(PLAN_B, 'Cliente Demo B');

    const usageA = planUsageSchema.parse((await call(a.admin).get('/v1/plan').expect(200)).body);
    expect(usageA.plan).toEqual({ id: 'plataforma', label: 'Plataforma', limits: PLAN_A.limits });
    const usageB = planUsageSchema.parse((await call(b.admin).get('/v1/plan').expect(200)).body);
    expect(usageB.plan).toEqual({ id: 'enterprise', label: 'Enterprise', limits: PLAN_B.limits });

    expect((await call(a.admin).get('/v1/plan/history').expect(200)).body).toEqual({ historyDays: 30 });
    expect((await call(b.admin).get('/v1/plan/history').expect(200)).body).toEqual({ historyDays: 365 });

    // O filtro de 90 dias passa do histórico de A (30 dias) e cabe no de B.
    const refused = await call(a.admin).get('/v1/findings?period=90d').expect(400);
    expect(refused.body).toMatchObject({ code: PERIOD_BEYOND_HISTORY_CODE });
    await call(b.admin).get('/v1/findings?period=90d').expect(200);
  });

  it('o plano novo gravado pelo sistema vale na hora, e a célula nunca semeia o plano do ambiente', async () => {
    const b = await tenantWith(PLAN_B, 'Cliente Demo B');
    await call(b.admin).post('/v1/cloud-accounts', newAccount(0)).expect(201);
    await call(b.admin).post('/v1/cloud-accounts', newAccount(1)).expect(201);
    await call(b.admin).post('/v1/cloud-accounts', newAccount(2)).expect(409);

    await writeTenantPlan(
      prisma,
      b.tenantId,
      { ...PLAN_B, limits: { ...PLAN_B.limits, maxCloudAccounts: 3 } },
      'control_plane',
    );
    await call(b.admin).post('/v1/cloud-accounts', newAccount(2)).expect(201);
    expect(await prisma.tenantPlan.findUniqueOrThrow({ where: { tenantId: b.tenantId } })).toMatchObject({
      maxCloudAccounts: 3,
      source: 'control_plane',
    });
  });

  it('cliente ainda sem plano: nenhuma vaga (409), o histórico no piso, a desativação passa e nada é semeado', async () => {
    const c = await tenantWith(null, 'Cliente Demo C');

    const refused = await call(c.admin).post('/v1/cloud-accounts', newAccount(0)).expect(409);
    expect(refused.body).toMatchObject({ code: TENANT_PLAN_MISSING_CODE });
    expect(await prisma.cloudAccount.count({ where: { tenantId: c.tenantId } })).toBe(0);
    await call(c.admin).post('/v1/users', newUser()).expect(409);
    await call(c.admin).get('/v1/plan').expect(409);
    expect((await call(c.admin).get('/v1/plan/history').expect(200)).body).toEqual({
      historyDays: PLAN_LIMIT_BOUNDS.historyDays.min,
    });

    // A desativação libera vaga: passa mesmo sem plano.
    const existing = await prisma.cloudAccount.create({
      data: { tenantId: c.tenantId, provider: 'aws', accountId: awsAccountId(), regions: ['sa-east-1'] },
    });
    await call(c.admin).delete(`/v1/cloud-accounts/${existing.id}`).expect(204);

    expect(await prisma.tenantPlan.findUnique({ where: { tenantId: c.tenantId } })).toBeNull();
  });

  it('o resolvedor da célula lê só a linha do cliente, e o histórico sem cliente é o menor dos planos', async () => {
    const a = await tenantWith(PLAN_A, 'Cliente Demo A');
    const c = await tenantWith(null, 'Cliente Demo C');
    // O plano do ambiente nunca vale na célula, mesmo que fosse passado.
    const resolver = new TenantPlanResolver(prisma, 'cell', resolvePlan('profissional'));
    expect(await resolver.planOf(a.tenantId)).toEqual({
      id: 'plataforma',
      label: 'Plataforma',
      limits: PLAN_A.limits,
    });
    expect(await resolver.planOf(c.tenantId)).toBeNull();
    // Os testes dividem o banco: o menor histórico entre todas as linhas é no máximo o de A.
    expect(await resolver.historyDaysWithoutTenant()).toBeLessThanOrEqual(30);
  });
});
