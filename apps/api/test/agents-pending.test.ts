import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { agentInstallSchema, WAZUH_AGENTS_DEFAULT_MAX } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createSignedInUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const CA = readFileSync(new URL('./fixtures/agents-ca.crt', import.meta.url), 'utf8');
const enrollment = randomBytes(16).toString('hex');

/**
 * Agentes ligados no nó, mas sem faixa de IP liberada no firewall (`wazuh_agents_sources` vazio): o painel pede ao
 * cliente os IPs de saída dele, e a senha de registro não sai (a porta ainda está fechada). Sem WAZUH_AGENTS_MAX, o
 * limite é o padrão.
 */
describe('agentes do Wazuh com a liberação no firewall pendente', () => {
  let app: NestExpressApplication;
  const tenant = randomUUID();

  beforeAll(async () => {
    app = await createApp({
      wazuhAgents: {
        WAZUH_AGENTS_ADDRESS: '203.0.113.10',
        WAZUH_AGENTS_TENANT: tenant,
        WAZUH_AGENTS_CA: Buffer.from(CA).toString('base64'),
        WAZUH_AGENTS_ENROLLMENT_PASSWORD: enrollment,
      },
    });
    await app.get(PrismaService).tenant.create({ data: { id: tenant, name: 'Cliente Demo P (agentes)' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('o administrador vê o endereço e a CA, sem a senha, e a trilha registra a consulta', async () => {
    const admin = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenant });
    const response = await request(app.getHttpServer())
      .get('/v1/agents/install')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(agentInstallSchema.parse(response.body)).toMatchObject({
      status: 'allowlist_pending',
      managerAddress: '203.0.113.10',
      allowedSources: [],
      enrollmentPassword: null,
      canEnroll: true,
      maxAgents: WAZUH_AGENTS_DEFAULT_MAX,
    });
    const entries = await app.get(PrismaService).auditLog.findMany({
      where: { actorId: admin.id, action: 'agents.install_instructions.view' },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tenantId: tenant, after: { status: 'allowlist_pending' } });
    expect(JSON.stringify(entries)).not.toContain(enrollment);
  });
});
