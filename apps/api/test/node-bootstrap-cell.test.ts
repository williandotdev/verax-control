import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { resolvePlan } from '@verax/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// O leitor do plano de controle (CP-05): o mesmo código que revela a senha confere o que a célula grava.
import { parseBootstrapPayload } from '../../control-plane/src/access/bootstrap-secrets.js';
import { AUTH } from '../src/auth/auth.constants.js';
import type { Auth } from '../src/auth/auth.factory.js';
import {
  adoptCellTenant,
  bootstrapModeSchema,
  runCellAdopt,
  runCellTenantBootstrap,
} from '../src/cli/node-bootstrap.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { readTenantPlan } from '../src/plan/tenant-plan.js';
import { assignTenantHost } from '../src/tenants/tenant-host.js';
import { setTenantLifecycleStatus } from '../src/tenants/tenant-lifecycle.js';
import { createTenant, createUser } from './support/auth-helpers.js';
import { createCellTenant, signInOnHost, TEST_CELL_PLAN, testCell, uniqueSlug } from './support/cell.js';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

/** O formato da senha temporária (quatro grupos de cinco, sem 0/O, 1/l/I): procurado em tudo que sai. */
const TEMPORARY_PASSWORD_PATTERN =
  /[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}/;

interface Run {
  code: number;
  out: string[];
  err: string[];
}

/**
 * Os modos da célula do bootstrap do nó (CE-04): `cell-tenant`, o primeiro administrador de um cliente da célula, com a
 * senha só no arquivo que o host grava no cofre do cliente; e `cell-adopt`, o cliente do nó dedicado que vira célula
 * (o SOC da Verax), pelos escritores do sistema e sem mudar um plano já gravado.
 */
describe('bootstrap do nó: modos da célula (CE-04)', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let auth: Auth;
  const dirs: string[] = [];

  const newDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'verax-cell-bootstrap-'));
    dirs.push(dir);
    return dir;
  };

  async function cellTenant(
    env: Record<string, string>,
    { dir = newDir(), mode = 'cell' as const }: { dir?: string; mode?: 'cell' | 'dedicated' } = {},
  ): Promise<Run & { dir: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCellTenantBootstrap({ BOOTSTRAP_OUTPUT_DIR: dir, ...env }, prisma, auth, mode, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out, err, dir };
  }

  async function adopt(
    env: Record<string, string>,
    mode: 'cell' | 'dedicated' = 'cell',
    plan = resolvePlan('interno'),
  ): Promise<Run> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCellAdopt(env, prisma, mode, plan, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out, err };
  }

  const tenantEnv = (tenantId: string, slug: string, overrides: Record<string, string> = {}) => ({
    BOOTSTRAP_TENANT_ID: tenantId,
    BOOTSTRAP_TENANT_SLUG: slug,
    BOOTSTRAP_ADMIN_EMAIL: `Admin-${randomUUID()}@Cliente-Celula.example`,
    ...overrides,
  });

  beforeAll(async () => {
    app = await createApp({ cell: testCell(), capture });
    prisma = app.get(PrismaService);
    auth = app.get<Auth>(AUTH);
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await app.close();
  });

  it('aceita os modos novos e mantém verax como padrão', () => {
    expect(bootstrapModeSchema.parse(undefined)).toBe('verax');
    expect(bootstrapModeSchema.parse('cell-tenant')).toBe('cell-tenant');
    expect(bootstrapModeSchema.parse('cell-adopt')).toBe('cell-adopt');
    expect(bootstrapModeSchema.safeParse('cell').success).toBe(false);
  });

  describe('cell-tenant', () => {
    it('cria o admin_cliente no cliente do pedido; a senha só no arquivo, no formato do contrato, e entra no endereço do cliente', async () => {
      const slug = uniqueSlug('ct');
      const tenantId = await createCellTenant(app, slug);
      const env = tenantEnv(tenantId, slug);
      const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
      const result = await cellTenant(env);
      expect(result.err).toEqual([]);
      expect(result.code).toBe(0);
      expect(result.out).toEqual([
        'Conta do administrador do cliente: criada com senha temporária.',
        'Senhas para o Secret Manager: admin-bootstrap.',
      ]);
      expect(readdirSync(result.dir)).toEqual(['admin-bootstrap.json']);
      const raw = readFileSync(join(result.dir, 'admin-bootstrap.json'), 'utf8');
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user).toMatchObject({
        role: 'admin_cliente',
        tenantId,
        status: 'active',
        mustChangePassword: true,
      });
      const payload = parseBootstrapPayload(raw);
      expect(payload).toEqual({
        email,
        password: expect.any(String) as string,
        expiresAt: user.temporaryPasswordExpiresAt,
      });
      // A senha abre o primeiro login no endereço do cliente.
      const signIn = await signInOnHost(app, slug, email, payload.password);
      expect(signIn.status).toBe(200);
      // Nada que saiu traz a senha nem o e-mail.
      const everything = [...result.out, ...result.err, capture.text].join('\n');
      expect(everything).not.toContain(payload.password);
      expect(everything).not.toMatch(TEMPORARY_PASSWORD_PATTERN);
      expect([...result.out, ...result.err].join('\n')).not.toContain(email);
      // Auditoria na trilha do cliente, como sistema.
      const audits = await prisma.auditLog.findMany({ where: { resourceId: user.id } });
      expect(audits.map((entry) => [entry.action, entry.actorType, entry.tenantId])).toEqual([
        ['user.create', 'system', tenantId],
      ]);
    });

    it('de novo: nada novo; a pedido, senha nova para a mesma conta', async () => {
      const slug = uniqueSlug('cu');
      const tenantId = await createCellTenant(app, slug);
      const env = tenantEnv(tenantId, slug);
      const dir = newDir();
      expect((await cellTenant(env, { dir })).code).toBe(0);
      rmSync(join(dir, 'admin-bootstrap.json'));
      const again = await cellTenant(env, { dir });
      expect(again.code).toBe(0);
      expect(again.out).toEqual([
        'Conta do administrador do cliente: já existe: nada alterado.',
        'Nenhuma senha nova: nada para gravar no Secret Manager.',
      ]);
      expect(readdirSync(dir)).toEqual([]);
      const renewed = await cellTenant({ ...env, BOOTSTRAP_RENEW_ADMIN_PASSWORD: 'true' }, { dir });
      expect(renewed.code).toBe(0);
      expect(renewed.out[0]).toContain('senha temporária nova, a pedido');
      expect(readdirSync(dir)).toEqual(['admin-bootstrap.json']);
    });

    it('recusa sem gravar nada: fora da célula, cliente que não existe, inativo, subdomínio de outro e sem plano', async () => {
      const slug = uniqueSlug('cr');
      const tenantId = await createCellTenant(app, slug);
      const other = uniqueSlug('co');
      await createCellTenant(app, other);
      const noPlanSlug = uniqueSlug('cn');
      const noPlan = await createCellTenant(app, noPlanSlug, null);
      const suspendedSlug = uniqueSlug('cs');
      const suspended = await createCellTenant(app, suspendedSlug);
      await setTenantLifecycleStatus(prisma, suspended, 'suspended');

      const cases: [string, Record<string, string>, 'cell' | 'dedicated', string][] = [
        ['dedicado', tenantEnv(tenantId, slug), 'dedicated', 'só existe na célula'],
        ['cliente que não existe', tenantEnv(randomUUID(), slug), 'cell', 'não existe nesta célula'],
        ['subdomínio de outro cliente', tenantEnv(tenantId, other), 'cell', 'não é o endereço gravado'],
        ['sem plano', tenantEnv(noPlan, noPlanSlug), 'cell', 'plano do cliente ainda não chegou'],
        ['suspenso', tenantEnv(suspended, suspendedSlug), 'cell', 'não está ativo'],
      ];
      for (const [, env, mode, message] of cases) {
        const result = await cellTenant(env, { mode });
        expect(result.code).toBe(1);
        expect(result.err.join('\n')).toContain(message);
        expect(readdirSync(result.dir)).toEqual([]);
        expect(await prisma.user.count({ where: { email: env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase() } })).toBe(
          0,
        );
      }
    });

    it('recusa o e-mail de uma conta de outro cliente ou de outro papel, sem citar o outro', async () => {
      const slug = uniqueSlug('ce');
      const tenantId = await createCellTenant(app, slug);
      const otherTenant = await createTenant(app, `Outro ${randomUUID().slice(0, 8)}`);
      const foreign = await createUser(app, { role: 'admin_cliente', tenantId: otherTenant });
      const staff = await createUser(app, { role: 'admin_verax', tenantId: null });
      for (const email of [foreign.email, staff.email]) {
        const result = await cellTenant(tenantEnv(tenantId, slug, { BOOTSTRAP_ADMIN_EMAIL: email }));
        expect(result.code).toBe(1);
        expect(result.err.join('\n')).toMatch(/use outro e-mail/);
        expect(result.err.join('\n')).not.toContain(otherTenant);
        expect(readdirSync(result.dir)).toEqual([]);
      }
    });

    it('recusa a entrada fora do formato, sem imprimir valor', async () => {
      const result = await cellTenant({
        BOOTSTRAP_TENANT_ID: 'nao-e-uuid',
        BOOTSTRAP_TENANT_SLUG: 'X',
        BOOTSTRAP_ADMIN_EMAIL: 'sem-arroba',
      });
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('BOOTSTRAP_TENANT_ID');
      expect(result.err.join('\n')).toContain('BOOTSTRAP_TENANT_SLUG');
      expect(result.err.join('\n')).not.toContain('sem-arroba');
    });
  });

  describe('cell-adopt', () => {
    it('com o endereço já gravado: grava o plano interno só se faltar, e de novo não muda nada', async () => {
      const slug = uniqueSlug('ad');
      const tenantId = await createTenant(app, `Verax ${slug}`);
      await assignTenantHost(prisma, tenantId, slug);
      const first = await adopt({ BOOTSTRAP_TENANT_SLUG: slug });
      expect(first).toEqual({
        code: 0,
        out: ['Endereço do cliente: já estava gravado.', 'Plano do cliente: interno, gravado.'],
        err: [],
      });
      const plan = await readTenantPlan(prisma, tenantId);
      expect(plan?.planId).toBe('interno');
      const row = await prisma.tenantPlan.findUniqueOrThrow({ where: { tenantId } });
      expect(row.source).toBe('env');
      const second = await adopt({ BOOTSTRAP_TENANT_SLUG: slug });
      expect(second.out).toEqual([
        'Endereço do cliente: já estava gravado.',
        'Plano do cliente: já estava gravado: nada alterado.',
      ]);
      const audits = await prisma.auditLog.findMany({
        where: { resourceId: tenantId, action: 'tenant.cell_adopt' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorType: 'system', tenantId, outcome: 'success' });
    });

    it('um plano já gravado (o do plano de controle) fica como está', async () => {
      const slug = uniqueSlug('ap');
      const tenantId = await createCellTenant(app, slug, TEST_CELL_PLAN);
      const result = await adopt({ BOOTSTRAP_TENANT_SLUG: slug });
      expect(result.code).toBe(0);
      expect(await readTenantPlan(prisma, tenantId)).toEqual(TEST_CELL_PLAN);
      expect((await prisma.tenantPlan.findUniqueOrThrow({ where: { tenantId } })).source).toBe(
        'control_plane',
      );
    });

    it('sem o endereço, num nó com mais de um cliente: recusa sem gravar nada', async () => {
      await createTenant(app, `Um ${randomUUID().slice(0, 8)}`);
      await createTenant(app, `Dois ${randomUUID().slice(0, 8)}`);
      const slug = uniqueSlug('am');
      const result = await adopt({ BOOTSTRAP_TENANT_SLUG: slug });
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('um cliente só');
      expect(await prisma.tenantHost.count({ where: { slug } })).toBe(0);
    });

    it('no nó dedicado, só com o plano interno', async () => {
      const slug = uniqueSlug('ae');
      const result = await adopt({ BOOTSTRAP_TENANT_SLUG: slug }, 'dedicated', resolvePlan('essencial'));
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('PLAN=interno');
    });

    it('recusa o subdomínio fora do formato', async () => {
      const result = await adopt({ BOOTSTRAP_TENANT_SLUG: 'Verax!' });
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('BOOTSTRAP_TENANT_SLUG');
    });
  });
});

/**
 * O caminho da primeira adoção (o nó com um cliente só) não cabe no banco dos testes, que tem os clientes de todas as
 * suítes: aqui, uma transação simulada com um cliente só, e o que a adoção grava por ela.
 */
describe('cell-adopt num nó com um cliente só', () => {
  function fakeDb(tenants: { id: string; status: string }[]) {
    const calls: string[] = [];
    const tx = {
      tenantHost: {
        findUnique: vi.fn(() => Promise.resolve(null)),
        createMany: vi.fn((args: { data: { tenantId: string; slug: string }[] }) => {
          calls.push(`host ${args.data[0]?.tenantId} ${args.data[0]?.slug}`);
          return Promise.resolve({ count: 1 });
        }),
      },
      tenant: { findMany: vi.fn(() => Promise.resolve(tenants)) },
      tenantPlan: {
        findUnique: vi.fn(() => Promise.resolve(null)),
        upsert: vi.fn((args: { where: { tenantId: string }; create: { planId: string; source: string } }) => {
          calls.push(`plan ${args.where.tenantId} ${args.create.planId} ${args.create.source}`);
          return Promise.resolve({});
        }),
      },
      auditLog: {
        create: vi.fn((args: { data: { action: string; tenantId: string } }) => {
          calls.push(`audit ${args.data.action} ${args.data.tenantId}`);
          return Promise.resolve({ id: 'x' });
        }),
      },
    };
    const db = {
      $transaction: (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        work(tx as unknown as Prisma.TransactionClient),
    } as unknown as PrismaService;
    return { db, calls };
  }

  it('grava o endereço, o plano interno e a auditoria do único cliente', async () => {
    const { db, calls } = fakeDb([{ id: 'c0ffee00-0000-4000-8000-000000000001', status: 'active' }]);
    await expect(
      adoptCellTenant(db, 'dedicated', resolvePlan('interno'), { BOOTSTRAP_TENANT_SLUG: 'verax' }),
    ).resolves.toEqual({ host: 'assigned', plan: 'set' });
    expect(calls).toEqual([
      'host c0ffee00-0000-4000-8000-000000000001 verax',
      'plan c0ffee00-0000-4000-8000-000000000001 interno env',
      'audit tenant.cell_adopt c0ffee00-0000-4000-8000-000000000001',
    ]);
  });

  it('o único cliente fora de active: recusa sem gravar', async () => {
    const { db, calls } = fakeDb([{ id: 'c0ffee00-0000-4000-8000-000000000002', status: 'inactive' }]);
    await expect(
      adoptCellTenant(db, 'cell', resolvePlan('interno'), { BOOTSTRAP_TENANT_SLUG: 'verax' }),
    ).rejects.toThrow('não está ativo');
    expect(calls).toEqual([]);
  });

  it('nenhum cliente: recusa', async () => {
    const { db, calls } = fakeDb([]);
    await expect(
      adoptCellTenant(db, 'cell', resolvePlan('interno'), { BOOTSTRAP_TENANT_SLUG: 'verax' }),
    ).rejects.toThrow('um cliente só');
    expect(calls).toEqual([]);
  });
});
