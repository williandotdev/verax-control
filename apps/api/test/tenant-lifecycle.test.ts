import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { TENANT_STATUSES, type TenantStatus, tenantUpdateSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AwsCheck } from '../src/aws/aws-check.js';
import type { AwsCheckOutcome, AwsConnectionChecker } from '../src/aws/aws-connection-check.js';
import { findWazuhSourceRows } from '../src/aws/wazuh-sources.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import {
  LIFECYCLE_TRANSITIONS,
  setTenantLifecycleStatus,
  type TenantLifecycleTarget,
  TenantTransitionRefused,
} from '../src/tenants/tenant-lifecycle.js';
import { TENANT_STATUS_MANAGED_CODE } from '../src/tenants/tenants.service.js';
import {
  cookieHeader,
  createSignedInUser,
  createTenant,
  createUser,
  hasSessionCookie,
  signIn,
  signInRequest,
  withCsrf,
} from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';

/** A conferência da AWS falsa: só conta as chamadas. */
class CountingChecker implements AwsConnectionChecker {
  calls = 0;
  check(): Promise<AwsCheckOutcome> {
    this.calls += 1;
    return Promise.resolve({ ok: true, warnings: [] });
  }
}

describe('estados do ciclo de vida do cliente (CE-02)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Um cliente novo no estado pedido, levado pelas transições do sistema. */
  async function tenantIn(status: TenantStatus, name = 'Cliente Demo A'): Promise<string> {
    const tenantId = await createTenant(app, `${name} (ciclo ${randomUUID().slice(0, 8)})`);
    const path: Partial<Record<TenantStatus, TenantStatus[]>> = {
      active: [],
      suspended: ['suspended'],
      canceled: ['canceled'],
      purging: ['canceled', 'purging'],
    };
    for (const step of path[status] ?? [])
      await setTenantLifecycleStatus(prisma, tenantId, step as TenantLifecycleTarget);
    if (status === 'inactive') await prisma.tenant.update({ where: { id: tenantId }, data: { status } });
    return tenantId;
  }

  const lifecycleTrail = (tenantId: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, action: { startsWith: 'tenant.lifecycle_' } },
      orderBy: { occurredAt: 'asc' },
      select: { action: true, actorType: true, actorId: true, before: true, after: true },
    });

  describe('transições', () => {
    it('a tabela cobre todos os estados, e o `inactive` do cadastro fica fora do ciclo de vida', () => {
      expect(Object.keys(LIFECYCLE_TRANSITIONS).sort()).toEqual([...TENANT_STATUSES].sort());
      expect(LIFECYCLE_TRANSITIONS.inactive).toEqual([]);
      expect(LIFECYCLE_TRANSITIONS.purging).toEqual([]);
    });

    it('suspender e reativar: a trilha do cliente registra as duas, com o ator sistema', async () => {
      const tenantId = await tenantIn('active');
      expect(
        await setTenantLifecycleStatus(prisma, tenantId, 'suspended', { actorId: 'control-plane' }),
      ).toEqual({ from: 'active', to: 'suspended', changed: true });
      // Repetir o estado não grava nada.
      expect(await setTenantLifecycleStatus(prisma, tenantId, 'suspended')).toEqual({
        from: 'suspended',
        to: 'suspended',
        changed: false,
      });
      await setTenantLifecycleStatus(prisma, tenantId, 'active', { actorId: 'control-plane' });
      expect(await lifecycleTrail(tenantId)).toEqual([
        {
          action: 'tenant.lifecycle_suspend',
          actorType: 'system',
          actorId: 'control-plane',
          before: { status: 'active' },
          after: { status: 'suspended' },
        },
        {
          action: 'tenant.lifecycle_reactivate',
          actorType: 'system',
          actorId: 'control-plane',
          before: { status: 'suspended' },
          after: { status: 'active' },
        },
      ]);
    });

    it.each([
      ['canceled', 'active'],
      ['canceled', 'suspended'],
      ['purging', 'active'],
      ['purging', 'canceled'],
      ['active', 'purging'],
      ['suspended', 'purging'],
      ['inactive', 'suspended'],
      ['inactive', 'active'],
    ] as const)('de %s para %s é recusado, sem gravar nada', async (from, to) => {
      const tenantId = await tenantIn(from);
      const before = await lifecycleTrail(tenantId);
      await expect(setTenantLifecycleStatus(prisma, tenantId, to)).rejects.toBeInstanceOf(
        TenantTransitionRefused,
      );
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe(from);
      expect(await lifecycleTrail(tenantId)).toEqual(before);
    });

    it('cancelar e depois expurgar', async () => {
      const tenantId = await tenantIn('active');
      await setTenantLifecycleStatus(prisma, tenantId, 'canceled');
      await setTenantLifecycleStatus(prisma, tenantId, 'purging');
      expect((await lifecycleTrail(tenantId)).map((entry) => entry.action)).toEqual([
        'tenant.lifecycle_cancel',
        'tenant.lifecycle_purge_start',
      ]);
    });
  });

  describe('login e sessões', () => {
    async function wrongPasswordBody(): Promise<unknown> {
      const other = await createUser(app);
      return (await signInRequest(app, other.email, 'senha-errada-mas-longa').expect(401)).body;
    }

    it('cliente suspenso: a senha certa ouve a mensagem do pagamento, sem sessão; a errada, a resposta de sempre', async () => {
      const tenantId = await tenantIn('suspended');
      const user = await createUser(app, { role: 'admin_cliente', tenantId });

      const response = await signInRequest(app, user.email, user.password).expect(401);
      expect(response.body).toMatchObject({ code: 'TENANT_SUSPENDED' });
      expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

      const wrong = await signInRequest(app, user.email, 'senha-errada-mas-longa').expect(401);
      expect(wrong.body).toEqual(await wrongPasswordBody());
    });

    it('cliente suspenso com MFA: a recusa vem já na senha, antes do código', async () => {
      const tenantId = await tenantIn('active');
      const user = await createSignedInUser(app, { role: 'leitura', tenantId });
      await setTenantLifecycleStatus(prisma, tenantId, 'suspended');
      const response = await signInRequest(app, user.email, user.password).expect(401);
      expect(response.body).toMatchObject({ code: 'TENANT_SUSPENDED' });
    });

    it.each(['canceled', 'purging'] as const)(
      'cliente %s: o login tem a resposta da senha errada (nada revela o estado)',
      async (status) => {
        const tenantId = await tenantIn(status);
        const user = await createUser(app, { role: 'admin_cliente', tenantId });
        const response = await signInRequest(app, user.email, user.password).expect(401);
        expect(response.body).toEqual(await wrongPasswordBody());
        expect(hasSessionCookie(cookieHeader(response.headers['set-cookie']))).toBe(false);
      },
    );

    it.each(['suspended', 'canceled'] as const)(
      'ao ir para %s, as sessões abertas caem e a seleção da equipe da Verax é limpa',
      async (status) => {
        const tenantId = await tenantIn('active');
        const member = await createUser(app, { role: 'leitura', tenantId });
        const cookie = await signIn(app, member.email, member.password);
        await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(200);

        const verax = await createSignedInUser(app, { role: 'admin_verax' });
        const session = await withCsrf(app, verax.cookie);
        await request(app.getHttpServer())
          .post('/v1/session/tenant')
          .set('Cookie', session.cookie)
          .set('Origin', TEST_WEB_ORIGIN)
          .set('X-CSRF-Token', session.token)
          .send({ tenantId })
          .expect(200);

        await setTenantLifecycleStatus(prisma, tenantId, status);

        expect(await prisma.session.count({ where: { userId: member.id } })).toBe(0);
        await request(app.getHttpServer()).get('/v1/me').set('Cookie', cookie).expect(401);
        expect(await prisma.session.count({ where: { activeTenantId: tenantId } })).toBe(0);
        const me = await request(app.getHttpServer()).get('/v1/me').set('Cookie', session.cookie).expect(200);
        expect(me.body).toMatchObject({ activeTenantId: null });
      },
    );

    it('reativado, o cliente entra de novo', async () => {
      const tenantId = await tenantIn('suspended');
      const user = await createUser(app, { role: 'admin_cliente', tenantId });
      await signInRequest(app, user.email, user.password).expect(401);
      await setTenantLifecycleStatus(prisma, tenantId, 'active');
      await signInRequest(app, user.email, user.password).expect(200);
    });
  });

  describe('o cadastro de clientes da API não mexe no ciclo de vida', () => {
    async function veraxAdmin() {
      const verax = await createSignedInUser(app, { role: 'admin_verax' });
      const { cookie, token } = await withCsrf(app, verax.cookie);
      const send = (method: 'patch' | 'delete', path: string) => {
        const server = request(app.getHttpServer());
        return server[method](path)
          .set('Cookie', cookie)
          .set('Origin', TEST_WEB_ORIGIN)
          .set('X-CSRF-Token', token);
      };
      return send;
    }

    it('reativar ou desativar um cliente suspenso é recusado (409); o estado do ciclo de vida não entra no corpo', async () => {
      const send = await veraxAdmin();
      const tenantId = await tenantIn('suspended');

      const reactivate = await send('patch', `/v1/tenants/${tenantId}`)
        .send({ status: 'active' })
        .expect(409);
      expect(reactivate.body).toMatchObject({ code: TENANT_STATUS_MANAGED_CODE });
      await send('patch', `/v1/tenants/${tenantId}`).send({ status: 'inactive' }).expect(409);
      await send('delete', `/v1/tenants/${tenantId}`).expect(409);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe('suspended');

      // O resto do cadastro continua editável.
      await send('patch', `/v1/tenants/${tenantId}`).send({ name: 'Cliente Demo A (renomeado)' }).expect(200);

      // E ninguém leva um cliente ativo a um estado do ciclo de vida pela API.
      const active = await tenantIn('active', 'Cliente Demo B');
      await send('patch', `/v1/tenants/${active}`).send({ status: 'suspended' }).expect(400);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: active } })).status).toBe('active');
    });
  });

  describe('só o sistema grava o estado do ciclo de vida', () => {
    it('o cadastro de clientes da API não aceita os estados do ciclo de vida', () => {
      expect(tenantUpdateSchema.safeParse({ status: 'inactive' }).success).toBe(true);
      for (const status of ['suspended', 'canceled', 'purging']) {
        expect(tenantUpdateSchema.safeParse({ status }).success).toBe(false);
      }
    });

    it('o escopo do cliente recusa gravar o estado do próprio cadastro', async () => {
      const tenantId = await tenantIn('active');
      expect(() =>
        prisma.forTenant(tenantId).tenant.update({ where: { id: tenantId }, data: { status: 'suspended' } }),
      ).toThrow(TenantScopeViolation);
    });
  });

  describe('a coleta só lê cliente ativo', () => {
    async function verifiedAwsAccount(tenantId: string, data: { checkRequestedAt?: Date } = {}) {
      return prisma.cloudAccount.create({
        data: {
          tenantId,
          provider: 'aws',
          accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
          regions: ['sa-east-1'],
          cloudtrailBucket: `trilha-${randomInt(1_000_000, 9_999_999)}`,
          connection: 'connected',
          ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
          ...data,
        },
      });
    }

    it('o suspenso sai da lista do Wazuh e volta ao reativar', async () => {
      const active = await tenantIn('active');
      const suspended = await tenantIn('active', 'Cliente Demo B');
      const kept = await verifiedAwsAccount(active);
      await verifiedAwsAccount(suspended);
      await setTenantLifecycleStatus(prisma, suspended, 'suspended');

      const rows = await findWazuhSourceRows(prisma, [active, suspended]);
      expect(rows.map((row) => row.accountId)).toEqual([kept.accountId]);

      await setTenantLifecycleStatus(prisma, suspended, 'active');
      expect(await findWazuhSourceRows(prisma, [active, suspended])).toHaveLength(2);
    });

    it.each(['suspended', 'canceled', 'inactive'] as const)(
      'a conferência da AWS não chama a conta de cliente %s (nem o pedido, nem a periódica)',
      async (status) => {
        const tenantId = await tenantIn(status);
        await verifiedAwsAccount(tenantId, { checkRequestedAt: new Date() });
        await verifiedAwsAccount(tenantId);
        const checker = new CountingChecker();
        const task = new AwsCheck(prisma, checker, { tenantIds: [tenantId] });
        expect(await task.runOnce()).toMatchObject({ pending: 0 });
        expect(await task.recheck()).toMatchObject({ accounts: 0 });
        expect(checker.calls).toBe(0);
      },
    );
  });
});
