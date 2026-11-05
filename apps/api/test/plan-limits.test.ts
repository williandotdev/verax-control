import 'reflect-metadata';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  GIB_BYTES,
  PLAN_LIMIT_REACHED_CODE,
  planLimitMessage,
  planUsageSchema,
  planVolumeRatio,
  resolvePlan,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore } from '../src/alerts/finding-store.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { IncidentGrouping } from '../src/incidents/incident-grouping.js';
import { assertWithinPlan } from '../src/plan/plan-limits.js';
import { UsageMeter, usageMonth } from '../src/usage/usage-meter.js';
import { createSignedInUser, createTenant, createUser, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import type { TestSession } from './support/tenant-isolation.js';

/** O nó destes testes está no Essencial: os limites vêm da tabela de planos do repositório, nunca digitados aqui. */
const PLAN = resolvePlan('essencial');
const MAX_ACCOUNTS = PLAN.limits.maxCloudAccounts as number;
const MAX_USERS = PLAN.limits.maxUsers as number;
const MONTHLY_GIB = PLAN.limits.monthlyGib as number;

/** IDs fictícios, diferentes a cada chamada. */
const awsAccountId = () => String(randomInt(100_000_000_000, 999_999_999_999));
const gcpProject = () => `vx-${randomInt(1_000_000, 9_999_999)}-plano`;
const cloudflareAccount = () => randomBytes(16).toString('hex');

/** CNPJ fictício com os dígitos verificadores certos, diferente a cada chamada. */
function randomCnpj(): string {
  const digits = Array.from({ length: 12 }, () => randomInt(0, 10));
  for (const weights of [
    [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  ]) {
    const rest = weights.reduce((sum, weight, index) => sum + weight * (digits[index] ?? 0), 0) % 11;
    digits.push(rest < 2 ? 0 : 11 - rest);
  }
  return digits.join('');
}

/** Achado de teste de um coletor da GCP (projeto e IP fictícios). */
function findingDraft(tenantId: string): FindingDraft {
  return {
    tenantId,
    accountId: 'vx-projeto-demo',
    source: 'gcp',
    sourceEventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    severity: 'high',
    ruleId: '990106',
    ruleLevel: 10,
    title: 'Achado de teste acima do volume do plano',
    logSource: 'gcp_audit',
    eventName: null,
    region: null,
    resource: null,
    actorUser: null,
    actorType: null,
    accessKeyId: null,
    sourceIp: '198.51.100.77',
    mitreTactics: [],
    mitreTechniques: [],
  };
}

describe('limites do plano (fase 2, PR-18)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let veraxSession: TestSession & { userId: string };

  async function sessionFor(
    tenantId: string | null,
    role: 'admin_verax' | 'admin_cliente' | 'leitura' | 'analista_cliente',
  ) {
    const user = await createSignedInUser(app, { role, tenantId });
    const { cookie, token } = await withCsrf(app, user.cookie);
    return { cookie, csrfToken: token, userId: user.id };
  }

  const call = (session: TestSession) => {
    const server = request(app.getHttpServer());
    const write = (method: 'post' | 'patch' | 'delete', path: string) =>
      server[method](path)
        .set('Cookie', session.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', session.csrfToken);
    return {
      get: (path: string) => server.get(path).set('Cookie', session.cookie),
      post: (path: string, body: object) => write('post', path).send(body),
      patch: (path: string, body: object) => write('patch', path).send(body),
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
    email: `plano-${randomUUID()}@cliente.example`,
    role: 'leitura',
  });

  const entryOf = (response: request.Response) =>
    prisma.auditLog.findFirstOrThrow({ where: { requestId: response.headers['x-request-id'] } });

  /** Cliente novo com o administrador dele (que já ocupa uma vaga de usuário). */
  async function freshTenant(name = 'Cliente Demo A') {
    const tenantId = await createTenant(app, `${name} (plano ${randomUUID().slice(0, 8)})`);
    const admin = await sessionFor(tenantId, 'admin_cliente');
    return { tenantId, admin };
  }

  async function fillAccounts(session: TestSession, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const response = await call(session).post('/v1/cloud-accounts', newAccount(index)).expect(201);
      ids.push((response.body as { id: string }).id);
    }
    return ids;
  }

  beforeAll(async () => {
    app = await createApp({ plan: { PLAN: 'essencial' } });
    prisma = app.get(PrismaService);
    veraxSession = await sessionFor(null, 'admin_verax');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('contas cloud', () => {
    it('até o limite passa (AWS, GCP e Cloudflare contam); a seguinte recebe 409, nada é gravado e a recusa fica na auditoria', async () => {
      const { tenantId, admin } = await freshTenant();
      await fillAccounts(admin, MAX_ACCOUNTS);

      const refused = await call(admin).post('/v1/cloud-accounts', newAccount(0)).expect(409);
      expect(refused.body).toMatchObject({
        code: PLAN_LIMIT_REACHED_CODE,
        message: planLimitMessage('cloudAccounts', MAX_ACCOUNTS),
      });
      expect(await prisma.cloudAccount.count({ where: { tenantId } })).toBe(MAX_ACCOUNTS);
      expect(await entryOf(refused)).toMatchObject({
        action: 'cloud_account.create',
        resourceType: 'cloud_account',
        outcome: 'failure',
        statusCode: 409,
        tenantId,
        actorId: admin.userId,
      });
    });

    it('desativar libera a vaga; reativar acima do limite é recusado e auditado; alterar a conta ativa continua valendo', async () => {
      const { tenantId, admin } = await freshTenant();
      const [first = '', second = ''] = await fillAccounts(admin, MAX_ACCOUNTS);

      await call(admin).delete(`/v1/cloud-accounts/${first}`).expect(204);
      await call(admin).post('/v1/cloud-accounts', newAccount(1)).expect(201);

      const reactivation = await call(admin)
        .patch(`/v1/cloud-accounts/${first}`, { status: 'active' })
        .expect(409);
      expect(reactivation.body).toMatchObject({ code: PLAN_LIMIT_REACHED_CODE });
      expect((await prisma.cloudAccount.findUniqueOrThrow({ where: { id: first } })).status).toBe('inactive');
      expect(await entryOf(reactivation)).toMatchObject({
        action: 'cloud_account.update',
        resourceType: 'cloud_account',
        resourceId: first,
        outcome: 'failure',
        statusCode: 409,
        tenantId,
      });

      // No limite, a conta ativa continua sendo alterada: ela não pede outra vaga.
      await call(admin).patch(`/v1/cloud-accounts/${second}`, { status: 'active' }).expect(200);

      // Outra desativada abre a vaga, e a reativação passa.
      await call(admin).delete(`/v1/cloud-accounts/${second}`).expect(204);
      await call(admin).patch(`/v1/cloud-accounts/${first}`, { status: 'active' }).expect(200);
      expect(await prisma.cloudAccount.count({ where: { tenantId, status: 'active' } })).toBe(MAX_ACCOUNTS);
    });

    it('duas criações simultâneas no limite menos 1: uma passa e a outra recebe 409', async () => {
      // Algumas rodadas: sem o lock do plano, as duas transações contam antes de a outra gravar e passam juntas.
      for (let round = 0; round < 3; round += 1) {
        const { tenantId, admin } = await freshTenant();
        await fillAccounts(admin, MAX_ACCOUNTS - 1);
        const responses = await Promise.all([
          call(admin).post('/v1/cloud-accounts', newAccount(0)),
          call(admin).post('/v1/cloud-accounts', newAccount(1)),
        ]);
        expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
        expect(await prisma.cloudAccount.count({ where: { tenantId } })).toBe(MAX_ACCOUNTS);
      }
    });

    it('A/B: o cliente B no limite não tira vaga do A', async () => {
      const a = await freshTenant('Cliente Demo A');
      const b = await freshTenant('Cliente Demo B');
      await fillAccounts(b.admin, MAX_ACCOUNTS);
      await call(b.admin).post('/v1/cloud-accounts', newAccount(0)).expect(409);
      await fillAccounts(a.admin, MAX_ACCOUNTS);
      expect(await prisma.cloudAccount.count({ where: { tenantId: a.tenantId } })).toBe(MAX_ACCOUNTS);
    });
  });

  describe('usuários', () => {
    it('convidados e ativos contam até o limite; o seguinte é recusado e auditado; admin_verax e desativados não contam', async () => {
      const { tenantId, admin } = await freshTenant();
      // Um convidado (conta do antigo convite) ocupa vaga; um desativado, não.
      await createUser(app, { role: 'leitura', tenantId, status: 'invited' });
      await createUser(app, { role: 'analista_cliente', tenantId, status: 'disabled' });
      // A equipe da Verax entra no cliente e cadastra por ele, sem ocupar vaga.
      await call(veraxSession).post('/v1/session/tenant', { tenantId }).expect(200);

      // O administrador do cliente e o convidado já ocupam duas vagas.
      for (let count = 2; count < MAX_USERS; count += 1) {
        await call(count % 2 === 0 ? admin : veraxSession)
          .post('/v1/users', newUser())
          .expect(201);
      }

      const refused = await call(admin).post('/v1/users', newUser()).expect(409);
      expect(refused.body).toMatchObject({
        code: PLAN_LIMIT_REACHED_CODE,
        message: planLimitMessage('users', MAX_USERS),
      });
      expect(await entryOf(refused)).toMatchObject({
        action: 'user.create',
        resourceType: 'user',
        outcome: 'failure',
        statusCode: 409,
        tenantId,
      });

      // Pela Verax, a mesma recusa, na trilha do cliente.
      const byVerax = await call(veraxSession).post('/v1/users', newUser()).expect(409);
      expect(await entryOf(byVerax)).toMatchObject({
        action: 'user.create',
        outcome: 'failure',
        statusCode: 409,
        tenantId,
        actorId: veraxSession.userId,
      });
      expect(await prisma.user.count({ where: { tenantId, status: { in: ['invited', 'active'] } } })).toBe(
        MAX_USERS,
      );

      // O plano mostra as vagas do cliente: a Verax não entra na conta.
      const plan = await call(veraxSession).get('/v1/plan').expect(200);
      expect((plan.body as { usage: { users: number } }).usage.users).toBe(MAX_USERS);
    });

    it('desativar libera a vaga; reativar acima do limite é recusado e auditado', async () => {
      const { tenantId, admin } = await freshTenant();
      const created: string[] = [];
      for (let count = 1; count < MAX_USERS; count += 1) {
        const response = await call(admin).post('/v1/users', newUser()).expect(201);
        created.push((response.body as { user: { id: string } }).user.id);
      }
      const [first = '', second = ''] = created;

      await call(admin).delete(`/v1/users/${first}`).expect(204);
      await call(admin).post('/v1/users', newUser()).expect(201);

      const reactivation = await call(admin).patch(`/v1/users/${first}`, { status: 'active' }).expect(409);
      expect(reactivation.body).toMatchObject({ code: PLAN_LIMIT_REACHED_CODE });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: first } })).status).toBe('disabled');
      expect(await entryOf(reactivation)).toMatchObject({
        action: 'user.update',
        resourceType: 'user',
        resourceId: first,
        outcome: 'failure',
        statusCode: 409,
        tenantId,
      });

      // No limite, trocar o papel de quem já está ativo continua valendo.
      await call(admin).patch(`/v1/users/${second}`, { role: 'analista_cliente' }).expect(200);

      await call(admin).delete(`/v1/users/${second}`).expect(204);
      await call(admin).patch(`/v1/users/${first}`, { status: 'active' }).expect(200);
    });

    it('duas criações simultâneas no limite menos 1: uma passa e a outra recebe 409', async () => {
      const { tenantId, admin } = await freshTenant();
      for (let count = 1; count < MAX_USERS - 1; count += 1) {
        await call(admin).post('/v1/users', newUser()).expect(201);
      }
      const responses = await Promise.all([
        call(admin).post('/v1/users', newUser()),
        call(admin).post('/v1/users', newUser()),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(await prisma.user.count({ where: { tenantId } })).toBe(MAX_USERS);
    });

    it('o cliente novo nasce com o primeiro administrador num nó com plano', async () => {
      const response = await call(veraxSession)
        .post('/v1/tenants', {
          name: `Cliente Demo B (plano ${randomUUID().slice(0, 8)})`,
          cnpj: randomCnpj(),
          plan: PLAN.label,
          escalationContact: { name: 'Ana', email: 'ana@cliente.example' },
          firstAdmin: { name: 'Bia Admin', email: `primeiro-${randomUUID()}@cliente.example` },
        })
        .expect(201);
      const tenantId = (response.body as { tenant: { id: string } }).tenant.id;
      expect(await prisma.user.count({ where: { tenantId, role: 'admin_cliente' } })).toBe(1);
    });
  });

  describe('GET /v1/plan', () => {
    const month = usageMonth(new Date());
    const previousMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));

    it('administrador do cliente: o plano do nó e o uso do próprio cliente (A/B, mês corrente, todas as fontes)', async () => {
      const a = await freshTenant('Cliente Demo A');
      const b = await freshTenant('Cliente Demo B');
      const [inactive = ''] = await fillAccounts(a.admin, 2);
      await call(a.admin).delete(`/v1/cloud-accounts/${inactive}`).expect(204);
      await fillAccounts(b.admin, MAX_ACCOUNTS);
      await call(a.admin).post('/v1/users', newUser()).expect(201);
      await prisma.ingestUsage.createMany({
        data: [
          { tenantId: a.tenantId, month, source: 'gcp', bytes: BigInt(2 * GIB_BYTES), events: 10n },
          { tenantId: a.tenantId, month, source: 'cloudflare', bytes: BigInt(GIB_BYTES), events: 5n },
          {
            tenantId: a.tenantId,
            month: previousMonth,
            source: 'gcp',
            bytes: BigInt(9 * GIB_BYTES),
            events: 1n,
          },
          { tenantId: b.tenantId, month, source: 'gcp', bytes: BigInt(7 * GIB_BYTES), events: 1n },
        ],
      });

      const response = await call(a.admin).get('/v1/plan').expect(200);
      const body = planUsageSchema.parse(response.body);
      expect(body).toEqual({
        plan: PLAN,
        usage: {
          cloudAccounts: 1,
          users: 2,
          month: month.toISOString().slice(0, 7),
          monthlyBytes: 3 * GIB_BYTES,
        },
      });
      expect(planVolumeRatio(body)).toBeCloseTo(3 / MONTHLY_GIB);

      const other = planUsageSchema.parse((await call(b.admin).get('/v1/plan').expect(200)).body);
      expect(other.usage).toMatchObject({
        cloudAccounts: MAX_ACCOUNTS,
        users: 1,
        monthlyBytes: 7 * GIB_BYTES,
      });
    });

    it('analista e leitura não leem; a Verax lê o cliente selecionado; sem cliente, pede um; sem sessão, 401', async () => {
      const { tenantId } = await freshTenant();
      for (const role of ['analista_cliente', 'leitura'] as const) {
        await call(await sessionFor(tenantId, role))
          .get('/v1/plan')
          .expect(403);
      }
      const verax = await sessionFor(null, 'admin_verax');
      const missing = await call(verax).get('/v1/plan').expect(409);
      expect(missing.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      await call(verax).post('/v1/session/tenant', { tenantId }).expect(200);
      // O administrador, o analista e o leitor do cliente; a Verax, não.
      expect(planUsageSchema.parse((await call(verax).get('/v1/plan').expect(200)).body).usage.users).toBe(3);
      await request(app.getHttpServer()).get('/v1/plan').expect(401);
    });

    it('acima de 100% do volume, os achados continuam sendo gravados e o uso continua sendo medido', async () => {
      const { tenantId, admin } = await freshTenant();
      const over = BigInt((MONTHLY_GIB + 1) * GIB_BYTES);
      await prisma.ingestUsage.create({ data: { tenantId, month, source: 'gcp', bytes: over, events: 1n } });

      // As duas gravações de um coletor depois da leitura: o achado e o volume lido. Nenhuma consulta o plano.
      const now = new Date();
      const outcome = await new FindingStore(prisma, new IncidentGrouping()).persist(
        findingDraft(tenantId),
        null,
        new Set(),
        now,
      );
      expect(outcome).toBe('opened');
      expect(await prisma.finding.count({ where: { tenantId } })).toBe(1);
      const meter = new UsageMeter();
      meter.add(tenantId, 'gcp', 4096, 1, now);
      await meter.flush(prisma);

      const usage = await prisma.ingestUsage.findUniqueOrThrow({
        where: { tenantId_month_source: { tenantId, month, source: 'gcp' } },
      });
      expect(usage.bytes).toBe(over + 4096n);
      const body = planUsageSchema.parse((await call(admin).get('/v1/plan').expect(200)).body);
      expect(planVolumeRatio(body)).toBeGreaterThan(1);
    });
  });

  describe('assertWithinPlan', () => {
    it('sem limite (plano interno) não confere nada; com limite, exige a transação que grava', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (sem transação)');
      await expect(
        assertWithinPlan(prisma, resolvePlan('interno'), 'users', tenantId),
      ).resolves.toBeUndefined();
      await expect(assertWithinPlan(prisma, PLAN, 'users', tenantId)).rejects.toThrow('transação');
      await prisma.$transaction((tx) => assertWithinPlan(tx, PLAN, 'users', tenantId));
    });
  });
});
