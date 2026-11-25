import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { REPORT_KINDS, ROLES, towerSummarySchema } from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestAuth } from '../src/common/auth/request-auth.js';
import { requestContext } from '../src/common/context/request-context.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TowerService } from '../src/tower/tower.service.js';
import { createTenant } from './support/auth-helpers.js';
import { seedWorld } from './support/case-world.js';
import { cleanCases } from './support/cases.js';
import { createApp } from './support/create-app.js';
import { operatorFor, read } from './support/triage.js';

/** Com os casos desligados (o padrão), pedir os campos deles não muda nada, para papel nenhum, mesmo com casos no banco. */
describe('Torre e relatórios com os casos desligados (CASES_MODE=off)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;

  beforeAll(async () => {
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo (Torre, casos desligados)');
    await seedWorld(prisma, tenantId, { seed: 77, now: new Date(), cases: 20 });
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantId]);
    await app.close();
  }, 60_000);

  it.each(ROLES)('%s: a mesma resposta, byte a byte, com e sem o pedido', async (role) => {
    const tower = app.get(TowerService);
    const auth = { role, userId: 'demo', scopeTenantId: tenantId } as unknown as RequestAuth;
    const now = new Date();
    const summary = (query: { cases?: 'true' }) =>
      requestContext.run({ auth }, () => tower.summary(auth, query, now));
    const plain = JSON.stringify(await summary({}));
    expect(JSON.stringify(await summary({ cases: 'true' }))).toBe(plain);
    expect(plain).not.toContain('"cases"');
    expect(plain).not.toContain('untriaged_case');
  });

  it('nem pela rota: nenhum campo dos casos na Torre e em relatório nenhum', async () => {
    const who = await operatorFor(app, tenantId, 'admin_cliente');
    const body = (await read(app, who, '/v1/tower?cases=true').expect(200)).text;
    expect(towerSummarySchema.parse(JSON.parse(body)).pendingDecisions.map(({ kind }) => kind)).toContain(
      'untriaged_finding',
    );
    expect(body).not.toContain('"cases"');
    for (const kind of REPORT_KINDS) {
      const report = (await read(app, who, `/v1/reports/${kind}?period=30d&cases=true`).expect(200)).text;
      expect(report, kind).not.toContain('"cases"');
    }
  });

  it('e nenhum comando dos casos vai ao banco', async () => {
    const tower = app.get(TowerService);
    // Outro cliente: o resumo MITRE deste não está guardado.
    const scopeTenantId = await createTenant(app, 'Cliente Demo (Torre, comandos)');
    const auth = { role: 'admin_verax', userId: 'demo', scopeTenantId } as unknown as RequestAuth;
    const db = prisma.db.bind(prisma);
    const commands: string[] = [];
    vi.spyOn(prisma, 'db').mockImplementation(() => {
      const real = db();
      return new Proxy(real, {
        get(target, key) {
          if (key !== '$queryRaw') return Reflect.get(target, key) as unknown;
          return (sql: TemplateStringsArray, ...values: unknown[]) => {
            commands.push(sql.join(''));
            return target.$queryRaw(sql, ...values);
          };
        },
      });
    });
    await requestContext.run({ auth }, () => tower.summary(auth, { cases: 'true' }));
    vi.restoreAllMocks();
    // O MITRE passa por aqui; nenhum outro.
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).not.toContain('AlertCase');
  });
});
