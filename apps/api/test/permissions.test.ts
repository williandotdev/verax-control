import 'reflect-metadata';
import { Controller, Get, Module, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { meSchema, type Role, ROLES } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Authenticated, RequirePermission } from '../src/auth/decorators.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

@Controller('permissions-probe')
class PermissionsProbeController {
  @Get('tenants-write')
  @RequirePermission('tenants:write')
  tenantsWrite(): { ok: true } {
    return { ok: true };
  }

  @Get('users-write')
  @RequirePermission('users:write')
  usersWrite(): { ok: true } {
    return { ok: true };
  }

  @Get('findings-triage')
  @RequirePermission('findings:triage')
  findingsTriage(): { ok: true } {
    return { ok: true };
  }

  @Get('findings-read')
  @RequirePermission('findings:read')
  findingsRead(): { ok: true } {
    return { ok: true };
  }

  @Get('authenticated')
  @Authenticated()
  anyone(): { ok: true } {
    return { ok: true };
  }

  @Get('undeclared')
  undeclared(): { ok: true } {
    return { ok: true };
  }

  @Post('tenants-write')
  @RequirePermission('tenants:write')
  createTenant(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [PermissionsProbeController] })
class PermissionsProbeModule {}

/** Status esperado de cada rota por papel. */
const MATRIX: Record<string, Record<Role, number>> = {
  'tenants-write': { admin_verax: 200, admin_cliente: 403, analista_cliente: 403, leitura: 403 },
  'users-write': { admin_verax: 200, admin_cliente: 200, analista_cliente: 403, leitura: 403 },
  'findings-triage': { admin_verax: 200, admin_cliente: 200, analista_cliente: 200, leitura: 403 },
  'findings-read': { admin_verax: 200, admin_cliente: 200, analista_cliente: 200, leitura: 200 },
  authenticated: { admin_verax: 200, admin_cliente: 200, analista_cliente: 200, leitura: 200 },
  undeclared: { admin_verax: 403, admin_cliente: 403, analista_cliente: 403, leitura: 403 },
};

describe('papéis e permissões (T2.4)', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  const cookies = new Map<Role, string>();

  beforeAll(async () => {
    app = await createApp({ capture, imports: [PermissionsProbeModule] });
    const tenantId = await createTenant(app);
    for (const role of ROLES) {
      const user = await createSignedInUser(app, {
        role,
        tenantId: role === 'admin_verax' ? null : tenantId,
      });
      cookies.set(role, user.cookie);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  for (const [route, expectations] of Object.entries(MATRIX)) {
    it.each(ROLES)(`${route}: %s`, async (role) => {
      await request(app.getHttpServer())
        .get(`/v1/permissions-probe/${route}`)
        .set('Cookie', cookies.get(role) ?? '')
        .expect(expectations[role]);
    });
  }

  it('rota sem permissão declarada é negada até para admin_verax, e o descuido vai para o log', async () => {
    await request(app.getHttpServer())
      .get('/v1/permissions-probe/undeclared')
      .set('Cookie', cookies.get('admin_verax') ?? '')
      .expect(403);
    expect(capture.text).toContain('rota sem permissão declarada');
  });

  it('sem sessão, nenhuma rota responde além de 401', async () => {
    for (const route of Object.keys(MATRIX)) {
      await request(app.getHttpServer()).get(`/v1/permissions-probe/${route}`).expect(401);
    }
  });

  it.each(ROLES)('/v1/me de %s segue o contrato compartilhado com o painel', async (role) => {
    const response = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Cookie', cookies.get(role) ?? '')
      .expect(200);
    expect(meSchema.safeParse(response.body).success).toBe(true);
  });

  it('escrita negada por permissão vai para a auditoria; sem sessão, só para o log', async () => {
    const prisma = app.get(PrismaService);
    const denied = await request(app.getHttpServer())
      .post('/v1/permissions-probe/tenants-write')
      .set('Cookie', cookies.get('leitura') ?? '')
      .set('Origin', TEST_WEB_ORIGIN)
      .expect(403);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { requestId: denied.headers['x-request-id'] },
    });
    expect(entry).toMatchObject({
      action: 'POST /v1/permissions-probe/tenants-write',
      outcome: 'denied',
      statusCode: 403,
      actorType: 'user',
    });
    expect(entry.actorId).not.toBeNull();

    const anonymous = await request(app.getHttpServer())
      .post('/v1/permissions-probe/tenants-write')
      .set('Origin', TEST_WEB_ORIGIN)
      .expect(401);
    expect(await prisma.auditLog.count({ where: { requestId: anonymous.headers['x-request-id'] } })).toBe(0);
  });

  it('/v1/me devolve as permissões do papel para o painel', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Cookie', cookies.get('leitura') ?? '')
      .expect(200);
    const { permissions } = response.body as { permissions: string[] };
    expect(permissions).toContain('findings:read');
    expect(permissions).not.toContain('findings:triage');
    expect(permissions.every((permission) => permission.endsWith(':read'))).toBe(true);
  });
});
