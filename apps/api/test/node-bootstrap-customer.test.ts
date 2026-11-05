import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type ResolvedPlan, resolvePlan, userSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
// O leitor do plano de controle (CP-05): o mesmo código que revela a senha ao cliente confere o que o nó grava.
import { parseBootstrapPayload } from '../../control-plane/src/access/bootstrap-secrets.js';
import { AUTH } from '../src/auth/auth.constants.js';
import type { Auth } from '../src/auth/auth.factory.js';
import { provisionUser } from '../src/auth/user-provisioning.js';
import {
  bootstrapModeSchema,
  type BootstrapResult,
  CUSTOMER_PAYLOADS,
  customerBootstrapLines,
  customerBootstrapPayload,
  type PayloadSink,
  runCustomerBootstrap,
  veraxBootstrapLines,
} from '../src/cli/node-bootstrap.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { authPost, createUser, enrollMfa, signIn, signInRequest } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

/** O formato da senha temporária (quatro grupos de cinco, sem 0/O, 1/l/I): procurado em tudo que sai. */
const TEMPORARY_PASSWORD_PATTERN =
  /[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}/;
const NEW_PASSWORD = 'uma senha longa e única 4821';

interface Payload {
  email: string;
  password: string;
  expiresAt: string;
}

describe('bootstrap do nó de cliente (modo customer, fase 3, CP-10)', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let auth: Auth;
  const dirs: string[] = [];

  /** Tudo que o processo imprimiu durante uma execução (console e escrita direta), além da saída do CLI. */
  interface Run {
    code: number;
    out: string[];
    err: string[];
    printed: string;
    dir: string;
  }

  const newDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'verax-customer-bootstrap-'));
    dirs.push(dir);
    return dir;
  };

  const customerEnv = (overrides: Record<string, string> = {}) => ({
    BOOTSTRAP_MODE: 'customer',
    BOOTSTRAP_ADMIN_EMAIL: `Admin-${randomUUID()}@Cliente-Demo-A.example`,
    BOOTSTRAP_TENANT_NAME: `Cliente Demo A (${randomUUID().slice(0, 8)})`,
    BOOTSTRAP_SUPPORT_EMAIL: `suporte-${randomUUID()}@verax.example`,
    ...overrides,
  });

  async function run(
    env: Record<string, string>,
    {
      dir = newDir(),
      plan = resolvePlan('essencial'),
      sink,
    }: { dir?: string; plan?: ResolvedPlan; sink?: PayloadSink } = {},
  ): Promise<Run> {
    const out: string[] = [];
    const err: string[] = [];
    const printed: string[] = [];
    const record = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    };
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(record),
      vi.spyOn(console, 'info').mockImplementation(record),
      vi.spyOn(console, 'warn').mockImplementation(record),
      vi.spyOn(console, 'error').mockImplementation(record),
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        record(chunk);
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        record(chunk);
        return true;
      }),
    ];
    try {
      const code = await runCustomerBootstrap(
        { BOOTSTRAP_OUTPUT_DIR: dir, ...env },
        prisma,
        auth,
        plan,
        { out: (line) => out.push(line), err: (line) => err.push(line) },
        sink,
      );
      return { code, out, err, printed: printed.join('\n'), dir };
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  /** Lê e apaga o arquivo, como o host faz depois de gravar a versão no Secret Manager. */
  function take(dir: string, name: (typeof CUSTOMER_PAYLOADS)[number]): Payload {
    const path = join(dir, `${name}.json`);
    const content = readFileSync(path, 'utf8');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(path);
    return JSON.parse(content) as Payload;
  }

  const files = (dir: string) => readdirSync(dir).sort();

  /** Nada que saiu (CLI, console, log da aplicação) traz a senha nem o formato dela. */
  function expectNoPasswordAnywhere(result: Run, passwords: string[]): void {
    const everything = [...result.out, ...result.err, result.printed, capture.text].join('\n');
    for (const password of passwords) expect(everything).not.toContain(password);
    expect(everything).not.toMatch(TEMPORARY_PASSWORD_PATTERN);
    expect(everything).not.toContain('VERAX_SENHA_TEMPORARIA');
  }

  beforeAll(async () => {
    app = await createApp({ capture });
    prisma = app.get(PrismaService);
    auth = app.get<Auth>(AUTH);
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await app.close();
  });

  it('cria o cliente, o admin_cliente e o admin_verax de suporte; cada senha só no arquivo, no formato do contrato', async () => {
    const env = customerEnv({ BOOTSTRAP_ADMIN_NAME: 'Pessoa Admin' });
    const adminEmail = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    const supportEmail = env.BOOTSTRAP_SUPPORT_EMAIL.toLowerCase();
    const result = await run(env);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.out).toEqual([
      'Cliente do nó: created.',
      'Plano do nó: Essencial (set).',
      'Conta do administrador do cliente: criada com senha temporária.',
      'Conta de suporte da Verax: criada com senha temporária.',
      'Senhas para o Secret Manager: admin-bootstrap, support-bootstrap.',
    ]);
    expect(files(result.dir)).toEqual(['admin-bootstrap.json', 'support-bootstrap.json']);

    const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: env.BOOTSTRAP_TENANT_NAME } });
    expect(tenant.plan).toBe('Essencial');
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
    expect(admin).toMatchObject({
      role: 'admin_cliente',
      tenantId: tenant.id,
      status: 'active',
      name: 'Pessoa Admin',
      mustChangePassword: true,
    });
    const support = await prisma.user.findUniqueOrThrow({ where: { email: supportEmail } });
    expect(support).toMatchObject({
      role: 'admin_verax',
      tenantId: null,
      status: 'active',
      name: 'Suporte Verax',
      mustChangePassword: true,
    });

    // O contrato: exatamente três campos, aceitos pelo leitor do plano de controle como estão.
    const adminRaw = readFileSync(join(result.dir, 'admin-bootstrap.json'), 'utf8');
    expect(Object.keys(JSON.parse(adminRaw) as object)).toEqual(['email', 'password', 'expiresAt']);
    const adminPayload = take(result.dir, 'admin-bootstrap');
    const supportPayload = take(result.dir, 'support-bootstrap');
    const parsed = parseBootstrapPayload(adminRaw);
    expect(parsed).toEqual({
      email: adminEmail,
      password: adminPayload.password,
      expiresAt: admin.temporaryPasswordExpiresAt,
    });
    expect(parseBootstrapPayload(JSON.stringify(supportPayload)).email).toBe(supportEmail);
    expect(adminPayload.password).not.toBe(supportPayload.password);

    // Cada senha abre o primeiro login (troca de senha e MFA), como qualquer conta nova.
    const adminCookie = await signIn(app, adminEmail, adminPayload.password);
    const me = (await request(app.getHttpServer()).get('/v1/me').set('Cookie', adminCookie).expect(200))
      .body as { mustChangePassword: boolean; role: string; tenantId: string };
    expect(me).toMatchObject({ mustChangePassword: true, role: 'admin_cliente', tenantId: tenant.id });
    await signIn(app, supportEmail, supportPayload.password);

    // Auditoria de sistema: o cliente e o admin na trilha do cliente; a conta de suporte (da Verax) fora dela.
    const audits = await prisma.auditLog.findMany({
      where: { resourceId: { in: [tenant.id, admin.id, support.id] } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      audits.map((entry) => [entry.action, entry.resourceId, entry.actorType, entry.tenantId, entry.outcome]),
    ).toEqual([
      ['tenant.create', tenant.id, 'system', tenant.id, 'success'],
      ['user.create', admin.id, 'system', tenant.id, 'success'],
      ['user.create', support.id, 'system', null, 'success'],
    ]);
    expect(JSON.stringify(audits)).not.toContain(adminPayload.password);
    expect(JSON.stringify(audits)).not.toContain(supportPayload.password);
    expectNoPasswordAnywhere(result, [adminPayload.password, supportPayload.password]);
    // Nem o e-mail nem o nome do cliente vão para a saída.
    const output = [...result.out, result.printed].join('\n');
    expect(output).not.toContain(adminEmail);
    expect(output).not.toContain(supportEmail);
    expect(output).not.toContain(env.BOOTSTRAP_TENANT_NAME);
  });

  it('de novo: nada criado e nenhuma senha nova, mesmo antes do primeiro login (a senha está no cofre)', async () => {
    const env = customerEnv();
    const dir = newDir();
    expect((await run(env, { dir })).code).toBe(0);
    const first = take(dir, 'admin-bootstrap');
    take(dir, 'support-bootstrap');

    const second = await run(env, { dir });
    expect(second.code).toBe(0);
    expect(second.out).toEqual([
      'Cliente do nó: exists.',
      'Plano do nó: Essencial (unchanged).',
      'Conta do administrador do cliente: já existe: nada alterado.',
      'Conta de suporte da Verax: já existe: nada alterado.',
      'Nenhuma senha nova: nada para gravar no Secret Manager.',
    ]);
    expect(files(dir)).toEqual([]);
    expect(await prisma.tenant.count({ where: { name: env.BOOTSTRAP_TENANT_NAME } })).toBe(1);
    expect(await prisma.user.count({ where: { email: env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() } })).toBe(1);
    // Nenhum registro novo: só os três da primeira execução (o cliente e as duas contas).
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: env.BOOTSTRAP_TENANT_NAME } });
    const users = await prisma.user.findMany({
      where: {
        email: { in: [env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(), env.BOOTSTRAP_SUPPORT_EMAIL.toLowerCase()] },
      },
      select: { id: true },
    });
    expect(
      await prisma.auditLog.count({
        where: { resourceId: { in: [tenant.id, ...users.map((user) => user.id)] } },
      }),
    ).toBe(3);
    // A primeira senha continua valendo.
    await signIn(app, env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(), first.password);
  });

  it('o PLAN mudou: o rótulo acompanha, sem senha nova', async () => {
    const env = customerEnv();
    const dir = newDir();
    await run(env, { dir });
    take(dir, 'admin-bootstrap');
    take(dir, 'support-bootstrap');
    const result = await run(env, { dir, plan: resolvePlan('profissional') });
    expect(result.out.slice(0, 2)).toEqual(['Cliente do nó: exists.', 'Plano do nó: Profissional (set).']);
    expect(files(dir)).toEqual([]);
  });

  it('arquivo de uma execução anterior ainda na pasta: recusa antes de gerar qualquer senha', async () => {
    const env = customerEnv();
    const dir = newDir();
    writeFileSync(join(dir, 'admin-bootstrap.json'), '{"pendente":true}');
    const result = await run(env, { dir });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('ainda não gravada no Secret Manager');
    expect(await prisma.tenant.count({ where: { name: env.BOOTSTRAP_TENANT_NAME } })).toBe(0);
    expect(await prisma.user.count({ where: { email: env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() } })).toBe(0);
    expect(files(dir)).toEqual(['admin-bootstrap.json']);
  });

  it('pasta de saída que não existe: recusa sem tocar no banco', async () => {
    const env = customerEnv();
    const result = await run(env, { dir: join(newDir(), 'nao-existe') });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('não existe ou não abre');
    expect(await prisma.tenant.count({ where: { name: env.BOOTSTRAP_TENANT_NAME } })).toBe(0);
  });

  it('pedido explícito: senha nova só da conta pedida; a anterior e as sessões deixam de valer', async () => {
    const env = customerEnv();
    const dir = newDir();
    await run(env, { dir });
    const firstAdmin = take(dir, 'admin-bootstrap');
    const firstSupport = take(dir, 'support-bootstrap');
    const adminEmail = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();

    const renewed = await run({ ...env, BOOTSTRAP_RENEW_ADMIN_PASSWORD: 'true' }, { dir });
    expect(renewed.code).toBe(0);
    expect(renewed.out).toContain(
      'Conta do administrador do cliente: senha temporária nova, a pedido (a anterior e as sessões abertas deixaram de valer; o MFA continua).',
    );
    expect(renewed.out).toContain('Conta de suporte da Verax: já existe: nada alterado.');
    expect(files(dir)).toEqual(['admin-bootstrap.json']);
    const secondAdmin = take(dir, 'admin-bootstrap');
    expect(secondAdmin.password).not.toBe(firstAdmin.password);
    await signInRequest(app, adminEmail, firstAdmin.password).expect(401);
    await signIn(app, adminEmail, secondAdmin.password);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
    expect(
      await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.temporary_password', resourceId: admin.id },
      }),
    ).toMatchObject({ actorType: 'system', tenantId: admin.tenantId, outcome: 'success' });
    expectNoPasswordAnywhere(renewed, [firstAdmin.password, secondAdmin.password]);

    const support = await run({ ...env, BOOTSTRAP_RENEW_SUPPORT_PASSWORD: 'true' }, { dir });
    expect(files(dir)).toEqual(['support-bootstrap.json']);
    const secondSupport = take(dir, 'support-bootstrap');
    expect(secondSupport.password).not.toBe(firstSupport.password);
    await signInRequest(app, env.BOOTSTRAP_SUPPORT_EMAIL.toLowerCase(), firstSupport.password).expect(401);
    expectNoPasswordAnywhere(support, [firstSupport.password, secondSupport.password]);
  });

  it('execução anterior que parou entre criar a conta e gravar a senha: a próxima gera a primeira senha', async () => {
    const env = customerEnv();
    const dir = newDir();
    await run(env, { dir });
    take(dir, 'admin-bootstrap');
    take(dir, 'support-bootstrap');
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: env.BOOTSTRAP_TENANT_NAME } });
    // Outra conta de suporte, criada sem senha (o que sobra se o processo cair no meio).
    const supportEmail = `suporte-${randomUUID()}@verax.example`;
    await provisionUser(auth, {
      email: supportEmail,
      name: 'Suporte Verax',
      role: 'admin_verax',
      tenantId: null,
      status: 'invited',
    });
    const result = await run({ ...env, BOOTSTRAP_SUPPORT_EMAIL: supportEmail }, { dir });
    expect(result.out).toContain('Conta de suporte da Verax: existia sem senha: senha temporária gerada.');
    expect(result.out).toContain('Conta do administrador do cliente: já existe: nada alterado.');
    const payload = take(dir, 'support-bootstrap');
    await signIn(app, supportEmail, payload.password);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: supportEmail } })).status).toBe('active');
    expect(await prisma.tenant.count({ where: { id: tenant.id } })).toBe(1);
  });

  describe('A/B: o administrador do cliente só alcança o próprio cliente', () => {
    it('e-mail que já é de outro cliente (ou de outro papel): recusa antes de qualquer escrita, sem citar o outro', async () => {
      const otherTenant = await prisma.tenant.create({
        data: { name: `Cliente Demo B (${randomUUID().slice(0, 8)})` },
        select: { id: true },
      });
      const otherAdmin = await createUser(app, { role: 'admin_cliente', tenantId: otherTenant.id });
      const verax = await createUser(app, { role: 'admin_verax' });

      const cases: [Record<string, string>, string][] = [
        [{ BOOTSTRAP_ADMIN_EMAIL: otherAdmin.email }, 'já pertence a outro cliente'],
        [{ BOOTSTRAP_ADMIN_EMAIL: verax.email }, 'com outro papel'],
        [{ BOOTSTRAP_SUPPORT_EMAIL: otherAdmin.email }, 'com outro papel'],
      ];
      for (const [overrides, message] of cases) {
        const env = customerEnv(overrides);
        const result = await run(env);
        expect(result.code).toBe(1);
        expect(result.err.join('\n')).toContain(message);
        expect(result.err.join('\n')).not.toContain(otherTenant.id);
        expect(result.err.join('\n')).not.toContain(otherAdmin.email);
        expect(files(result.dir)).toEqual([]);
        expect(await prisma.tenant.count({ where: { name: env.BOOTSTRAP_TENANT_NAME } })).toBe(0);
      }
      // As contas existentes ficam como estavam (a senha de antes continua valendo).
      expect(await prisma.user.findUniqueOrThrow({ where: { id: otherAdmin.id } })).toMatchObject({
        role: 'admin_cliente',
        tenantId: otherTenant.id,
        mustChangePassword: false,
      });
      await signIn(app, otherAdmin.email, otherAdmin.password);
    });

    it('com senha própria e MFA, o administrador novo lista só a si mesmo e não lê usuário do outro cliente', async () => {
      const otherTenant = await prisma.tenant.create({
        data: { name: `Cliente Demo B (${randomUUID().slice(0, 8)})` },
        select: { id: true },
      });
      const otherAdmin = await createUser(app, { role: 'admin_cliente', tenantId: otherTenant.id });
      const env = customerEnv();
      const dir = newDir();
      expect((await run(env, { dir })).code).toBe(0);
      const { email, password } = take(dir, 'admin-bootstrap');
      take(dir, 'support-bootstrap');

      const cookie = await signIn(app, email, password);
      await authPost(app, '/change-password', cookie, {
        currentPassword: password,
        newPassword: NEW_PASSWORD,
      }).expect(200);
      const fresh = await signIn(app, email, NEW_PASSWORD);
      const { cookie: full } = await enrollMfa(app, fresh, NEW_PASSWORD);
      const server = () => request(app.getHttpServer());
      const users = await server().get('/v1/users?pageSize=100').set('Cookie', full).expect(200);
      const items = (users.body as { items: unknown[] }).items.map((item) => userSchema.parse(item));
      expect(items.map((item) => item.email)).toEqual([email]);
      await server().get(`/v1/users/${otherAdmin.id}`).set('Cookie', full).expect(404);
      await server().get('/v1/tenants').set('Cookie', full).expect(403);
    });
  });

  it('conta desativada: o pedido de senha nova é recusado antes de qualquer escrita', async () => {
    const env = customerEnv();
    const dir = newDir();
    await run(env, { dir });
    take(dir, 'admin-bootstrap');
    take(dir, 'support-bootstrap');
    const email = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    await prisma.user.update({ where: { email }, data: { status: 'disabled' } });
    const result = await run({ ...env, BOOTSTRAP_RENEW_ADMIN_PASSWORD: 'true' }, { dir });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('está desativada');
    expect(files(dir)).toEqual([]);
    // Sem o pedido, segue sem mexer na conta.
    expect((await run(env, { dir })).code).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).status).toBe('disabled');
  });

  it.each([
    [{ BOOTSTRAP_ADMIN_EMAIL: 'não é e-mail' }, 'BOOTSTRAP_ADMIN_EMAIL'],
    [{ BOOTSTRAP_SUPPORT_EMAIL: '' }, 'BOOTSTRAP_SUPPORT_EMAIL'],
    [{ BOOTSTRAP_TENANT_NAME: '   ' }, 'BOOTSTRAP_TENANT_NAME'],
    [{ BOOTSTRAP_RENEW_ADMIN_PASSWORD: 'sim' }, 'BOOTSTRAP_RENEW_ADMIN_PASSWORD'],
    [{ BOOTSTRAP_OUTPUT_DIR: 'relativo/pasta' }, 'BOOTSTRAP_OUTPUT_DIR'],
  ])(
    'entrada inválida é recusada antes de tocar no banco, sem repetir o valor: %o',
    async (overrides, name) => {
      const env = customerEnv(overrides);
      const result = await run(env);
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain(`${name}:`);
      for (const value of Object.values(overrides).filter((value) => value.trim().length > 3)) {
        expect(result.err.join('\n')).not.toContain(value);
      }
      expect(await prisma.tenant.count({ where: { name: env.BOOTSTRAP_TENANT_NAME } })).toBe(0);
    },
  );

  it('o mesmo e-mail para o administrador e o suporte é recusado', async () => {
    const email = `mesmo-${randomUUID()}@verax.example`;
    const result = await run(
      customerEnv({ BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_SUPPORT_EMAIL: email.toUpperCase() }),
    );
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toContain('BOOTSTRAP_SUPPORT_EMAIL: deve ser diferente');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('falha inesperada depois de gerar a senha: só o tipo do erro sai, nunca a senha', async () => {
    const sink: PayloadSink = {
      pending: () => Promise.resolve([]),
      write: () => Promise.reject(new TypeError('falha simulada na escrita')),
    };
    const env = customerEnv();
    const result = await run(env, { sink });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      'Falha no bootstrap do nó de cliente (TypeError). O que já foi feito fica; rode de novo.',
    ]);
    expectNoPasswordAnywhere(result, []);
  });

  it('a saída do modo verax (o nó da Verax) continua a mesma, linha a linha', () => {
    const result: BootstrapResult = {
      admin: 'created',
      temporaryPassword: {
        temporaryPassword: 'abcde-fghij-kmnop-qrstu',
        expiresAt: '2026-11-07T12:00:00.000Z',
      },
      tenant: 'created',
      plan: 'set',
      accounts: [{ project: 'projeto-demo-a', outcome: 'created' }],
    };
    expect(veraxBootstrapLines(result, 'Interno')).toEqual([
      'Administrador criado com senha temporária.',
      'VERAX_SENHA_TEMPORARIA=abcde-fghij-kmnop-qrstu',
      'VERAX_SENHA_TEMPORARIA_VALE_ATE=2026-11-07T12:00:00.000Z',
      'Cliente do nó: created.',
      'Plano do nó: Interno (set).',
      'Conta GCP projeto-demo-a: created.',
    ]);
    expect(veraxBootstrapLines({ admin: 'exists', tenant: 'skipped', accounts: [] }, 'Interno')).toEqual([
      'Administrador já definiu a própria senha: nada alterado (para gerar outra, use BOOTSTRAP_RENEW_ADMIN_PASSWORD=true).',
      'Cliente do nó: skipped.',
    ]);
    // O modo cliente nunca escreve as linhas marcadas.
    const lines = customerBootstrapLines(
      { tenant: 'created', plan: 'set', admin: 'created', support: 'reset', written: ['admin-bootstrap'] },
      'Essencial',
    );
    expect(lines.join('\n')).not.toContain('VERAX_SENHA_TEMPORARIA');
  });

  it('modo: sem a variável (ou vazia), verax; customer só com o valor exato', () => {
    expect(bootstrapModeSchema.parse(undefined)).toBe('verax');
    expect(bootstrapModeSchema.parse('')).toBe('verax');
    expect(bootstrapModeSchema.parse('customer')).toBe('customer');
    expect(bootstrapModeSchema.safeParse('Customer').success).toBe(false);
  });

  it('contrato com o plano de controle: o leitor de lá aceita o JSON daqui, e o JSON tem só os três campos', () => {
    const payload = customerBootstrapPayload('admin@cliente-demo-a.example', {
      temporaryPassword: 'abcde-fghij-kmnop-qrstu',
      expiresAt: '2026-11-07T12:00:00.000Z',
    });
    expect(payload).toBe(
      '{"email":"admin@cliente-demo-a.example","password":"abcde-fghij-kmnop-qrstu","expiresAt":"2026-11-07T12:00:00.000Z"}',
    );
    expect(parseBootstrapPayload(Buffer.from(payload, 'utf8'))).toEqual({
      email: 'admin@cliente-demo-a.example',
      password: 'abcde-fghij-kmnop-qrstu',
      expiresAt: new Date('2026-11-07T12:00:00.000Z'),
    });
  });
});
