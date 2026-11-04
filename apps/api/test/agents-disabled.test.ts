import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { agentInstallSchema, agentListSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

/** Nó sem os agentes (o padrão: sem WAZUH_AGENTS no ambiente): o painel diz que não estão ligados neste ambiente. */
describe('agentes do Wazuh desligados no nó (padrão)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('as instruções dizem que os agentes não estão ligados, sem endereço nem senha, e nada vai para a trilha', async () => {
    const admin = await createSignedInUser(app, { role: 'admin_cliente' });
    const get = (path: string) =>
      request(app.getHttpServer()).get(path).set('Cookie', admin.cookie).expect(200);
    expect(agentInstallSchema.parse((await get('/v1/agents/install')).body)).toMatchObject({
      status: 'disabled',
      managerAddress: null,
      caCertificate: null,
      enrollmentPassword: null,
      canEnroll: true,
      registered: 0,
    });
    expect(agentListSchema.parse((await get('/v1/agents')).body)).toMatchObject({
      items: [],
      total: 0,
      syncedAt: null,
    });
    const entries = await app.get(PrismaService).auditLog.count({
      where: { actorId: admin.id, action: 'agents.install_instructions.view' },
    });
    expect(entries).toBe(0);
  });
});
