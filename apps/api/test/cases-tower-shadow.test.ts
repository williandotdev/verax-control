import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  caseDetailSchema,
  REPORT_KINDS,
  reportSchemas,
  ROLES,
  triageAuthorsSchema,
  towerSummarySchema,
} from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { RequestAuth } from '../src/common/auth/request-auth.js';
import { requestContext } from '../src/common/context/request-context.js';
import { TowerService } from '../src/tower/tower.service.js';
import { createTenant } from './support/auth-helpers.js';
import { expectedTowerCases, expectedValidation, seedWorld, type World } from './support/case-world.js';
import { cleanCases, insertOperation } from './support/cases.js';
import { createApp } from './support/create-app.js';
import { caseWith, type Operator, operatorFor, read } from './support/triage.js';

const CUSTOMERS = ['admin_cliente', 'analista_cliente', 'leitura'] as const;

/** Com `CASES_MODE=shadow` (a medição), só a equipe da Verax vê os casos na Torre e nos relatórios, e ninguém opera. */
describe('Torre e relatórios em medição (CASES_MODE=shadow)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let world: World;
  let verax: Operator;

  beforeAll(async () => {
    app = await createApp({ casesMode: 'shadow' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo (Torre, casos em medição)');
    world = await seedWorld(prisma, tenantId, { seed: 91, now: new Date(), cases: 24 });
    verax = await operatorFor(app, tenantId, 'admin_verax');
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantId]);
    await app.close();
  }, 60_000);

  it.each(CUSTOMERS)('%s: a mesma resposta, byte a byte, com e sem o pedido', async (role) => {
    const tower = app.get(TowerService);
    const auth = { role, userId: 'demo', scopeTenantId: tenantId } as unknown as RequestAuth;
    const now = new Date();
    const summary = (query: { cases?: 'true' }) =>
      requestContext.run({ auth }, () => tower.summary(auth, query, now));
    const plain = JSON.stringify(await summary({}));
    expect(JSON.stringify(await summary({ cases: 'true' }))).toBe(plain);
    const who = await operatorFor(app, tenantId, role);
    for (const path of [
      '/v1/tower?cases=true',
      ...REPORT_KINDS.map((kind) => `/v1/reports/${kind}?period=30d&cases=true`),
    ]) {
      const { text } = await read(app, who, path).expect(200);
      expect(text, path).not.toContain('"cases"');
      expect(text, path).not.toContain('untriaged_case');
    }
  });

  it('a equipe da Verax: os casos aparecem, e as decisões continuam contando alertas', async () => {
    const seen = towerSummarySchema.parse((await read(app, verax, '/v1/tower?cases=true').expect(200)).body);
    expect(seen.cases).toEqual(expectedTowerCases(world));
    expect(seen.radar?.cases?.total).toBeGreaterThan(0);
    expect(seen.mitre.tactics.every((tactic) => tactic.cases !== undefined)).toBe(true);
    expect(seen.pendingDecisions.filter(({ kind }) => kind.startsWith('untriaged'))).toEqual([
      { kind: 'untriaged_finding', count: expectedValidation(world).total },
    ]);
    const plain = (await read(app, verax, '/v1/tower').expect(200)).text;
    expect(plain).not.toContain('"cases"');
    const summary = reportSchemas.summary.parse(
      (await read(app, verax, '/v1/reports/summary?period=30d&cases=true').expect(200)).body,
    );
    expect(summary.cases?.opened).toBeGreaterThan(0);
  });

  it('o detalhe do caso não oferece nada a ninguém, nem as operações dele', async () => {
    const operationId = await insertOperation(prisma, tenantId, {
      state: 'done',
      changed: 1,
      matched: 1,
      undoUntil: new Date(Date.now() + 3_600_000),
    });
    const { caseId } = await caseWith(prisma, tenantId, [{ triageOpId: operationId }, {}]);
    const detail = caseDetailSchema.parse((await read(app, verax, `/v1/cases/${caseId}`).expect(200)).body);
    expect(detail.can).toEqual({ triage: false, promote: false });
    expect(detail.operations).toMatchObject([
      { id: operationId, can: { cancel: false, continue: false, undo: false } },
    ]);
  });

  it('os autores das operações: só a equipe da Verax', async () => {
    for (const role of ROLES) {
      const who = role === 'admin_verax' ? verax : await operatorFor(app, tenantId, role);
      const response = await read(app, who, '/v1/triage-operations/authors');
      expect(response.status, role).toBe(role === 'admin_verax' ? 200 : 404);
      if (role === 'admin_verax') triageAuthorsSchema.parse(response.body);
    }
  });
});
