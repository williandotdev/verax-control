import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseTenantPlan, planUsageSchema, resolvePlan, tenantPlanSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRouteInputKeys } from '../src/common/http/route-contracts.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import { writeTenantPlan } from '../src/plan/tenant-plan.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

/** O nó destes testes é dedicado, no Essencial: o plano do cliente é o do ambiente, semeado no `TenantPlan`. */
const ESSENCIAL = resolvePlan('essencial');

/**
 * Os campos do plano do cliente (`TenantPlan`), que só o sistema grava. Nenhuma rota pode aceitar nenhum deles, em
 * nenhuma profundidade do corpo, da query ou dos parâmetros.
 */
const SYSTEM_ONLY_FIELDS = Object.keys({
  ...tenantPlanSchema.shape,
  ...tenantPlanSchema.shape.limits.shape,
}).sort();

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

/** Os arquivos `.ts` de `src`, sem o client gerado do Prisma e sem os testes. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('plano por cliente no nó dedicado e o que só o sistema grava (CE-02)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  async function adminOf(tenantId: string) {
    const user = await createSignedInUser(app, { role: 'admin_cliente', tenantId });
    return withCsrf(app, user.cookie);
  }

  beforeAll(async () => {
    app = await createApp({ plan: { PLAN: 'essencial' } });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('o node.conf semeia o plano do cliente', () => {
    it('a primeira leitura grava o TenantPlan do cliente com o plano do ambiente', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (semeadura)');
      const admin = await adminOf(tenantId);
      const usage = planUsageSchema.parse(
        (await request(app.getHttpServer()).get('/v1/plan').set('Cookie', admin.cookie).expect(200)).body,
      );
      expect(usage.plan).toEqual(ESSENCIAL);
      expect(await prisma.tenantPlan.findUniqueOrThrow({ where: { tenantId } })).toMatchObject({
        planId: 'essencial',
        ...ESSENCIAL.limits,
        franchiseGbPerDay: null,
        source: 'env',
      });
    });

    it('uma linha diferente do ambiente é regravada: no nó dedicado, quem vale é o node.conf', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo B (linha antiga)');
      await writeTenantPlan(
        prisma,
        tenantId,
        {
          planId: 'plataforma',
          limits: { maxCloudAccounts: 50, maxUsers: 50, monthlyGib: null, historyDays: 365 },
          franchiseGbPerDay: 9,
        },
        'control_plane',
      );
      const admin = await adminOf(tenantId);
      const history = await request(app.getHttpServer())
        .get('/v1/plan/history')
        .set('Cookie', admin.cookie)
        .expect(200);
      expect(history.body).toEqual({ historyDays: ESSENCIAL.limits.historyDays });
      expect(await prisma.tenantPlan.findUniqueOrThrow({ where: { tenantId } })).toMatchObject({
        planId: 'essencial',
        franchiseGbPerDay: null,
        source: 'env',
      });
    });

    it('o cliente cadastrado pela API já nasce com o plano, na mesma transação', async () => {
      const verax = await createSignedInUser(app, { role: 'admin_verax' });
      const session = await withCsrf(app, verax.cookie);
      const created = await request(app.getHttpServer())
        .post('/v1/tenants')
        .set('Cookie', session.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', session.token)
        .send({
          name: 'Cliente Demo C (cadastro)',
          cnpj: randomCnpj(),
          plan: 'Essencial',
          escalationContact: { name: 'Contato', email: 'contato@cliente.example' },
          firstAdmin: { name: 'Administrador', email: `admin-${randomUUID()}@cliente.example` },
        })
        .expect(201);
      const tenantId = (created.body as { tenant: { id: string } }).tenant.id;
      expect(await prisma.tenantPlan.findUnique({ where: { tenantId } })).toMatchObject({
        planId: 'essencial',
        source: 'env',
      });
    });
  });

  describe('o plano do cliente só é gravado pelo sistema', () => {
    it('nenhuma rota aceita um campo do plano do cliente, em nenhuma profundidade', () => {
      expect(SYSTEM_ONLY_FIELDS).toEqual(
        [
          'franchiseGbPerDay',
          'historyDays',
          'limits',
          'maxCloudAccounts',
          'maxUsers',
          'monthlyGib',
          'planId',
        ].sort(),
      );
      const offenders = listRouteInputKeys(app).flatMap(({ route, keys }) =>
        keys.filter((key) => SYSTEM_ONLY_FIELDS.includes(key)).map((key) => `${route}: ${key}`),
      );
      expect(offenders).toEqual([]);
      // A sonda pega o que deve: ao menos uma rota tem corpo com chaves (senão a lista acima não provaria nada).
      expect(listRouteInputKeys(app).some(({ keys }) => keys.includes('accountId'))).toBe(true);
    });

    it('só o módulo do plano grava o TenantPlan (busca no código-fonte)', () => {
      const writes =
        /\btenantPlan\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/;
      const writers = sourceFiles(srcDir)
        .filter((file) => writes.test(readFileSync(file, 'utf8')))
        .map((file) => relative(srcDir, file).replaceAll('\\', '/'));
      expect(writers).toEqual(['plan/tenant-plan.ts']);
    });

    it('o escopo do cliente lê o plano dele, mas recusa gravá-lo (e o estado do expurgo)', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo D (escopo)');
      await writeTenantPlan(
        prisma,
        tenantId,
        parseTenantPlan({ ...tenantPlanOf(), planId: 'essencial' }),
        'env',
      );
      const scoped = prisma.forTenant(tenantId);
      expect(await scoped.tenantPlan.findUnique({ where: { tenantId } })).toMatchObject({
        planId: 'essencial',
      });
      expect(() =>
        scoped.tenantPlan.update({ where: { tenantId }, data: { maxCloudAccounts: 1000 } }),
      ).toThrow(TenantScopeViolation);
      expect(() =>
        scoped.tenantPlan.upsert({
          where: { tenantId },
          create: { tenantId, planId: 'interno', source: 'env' },
          update: {},
        }),
      ).toThrow(TenantScopeViolation);
      expect(() => scoped.tenantRetentionState.deleteMany({})).toThrow(TenantScopeViolation);
    });

    it('o banco recusa o plano que não vale (a mesma regra do schema)', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo E (CHECK)');
      // A Plataforma sem franquia: o schema recusa antes do banco...
      expect(() =>
        parseTenantPlan({
          planId: 'plataforma',
          limits: { maxCloudAccounts: 1, maxUsers: 1, monthlyGib: null, historyDays: 30 },
          franchiseGbPerDay: null,
        }),
      ).toThrow('franchiseGbPerDay');
      // ... e o CHECK recusa a mesma linha gravada por fora.
      await expect(
        prisma.$executeRaw`INSERT INTO "TenantPlan" ("tenantId", "planId", "maxCloudAccounts", "maxUsers",
          "historyDays", "source", "updatedAt")
          VALUES (${tenantId}::uuid, 'plataforma', 1, 1, 30, 'env', now())`,
      ).rejects.toThrow(/TenantPlan_combination_check/);
      await expect(
        prisma.$executeRaw`INSERT INTO "TenantPlan" ("tenantId", "planId", "maxCloudAccounts", "maxUsers",
          "monthlyGib", "historyDays", "source", "updatedAt")
          VALUES (${tenantId}::uuid, 'essencial', 1, 1, 1, 7, 'env', now())`,
      ).rejects.toThrow(/TenantPlan_limits_range_check/);
    });
  });
});

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

/** Um plano do cliente qualquer que vale (os quatro limites do Essencial, sem franquia). */
function tenantPlanOf() {
  return { planId: 'essencial', limits: { ...ESSENCIAL.limits }, franchiseGbPerDay: null };
}
