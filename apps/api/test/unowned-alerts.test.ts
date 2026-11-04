import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { paginatedSchema, unownedAccountsSchema, unownedAlertSchema } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 3_600_000;
const pageSchema = paginatedSchema(unownedAlertSchema);
const awsAccount = () => String(randomInt(100_000_000_000, 999_999_999_999));

describe('fila de alertas sem dono', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let veraxCookie: string;
  let tenantA: string;
  // Contas próprias deste teste: a fila é global, e outras suítes também gravam nela.
  const missing = awsAccount();
  const registered = awsAccount();
  const sourceEventIds: string[] = [];
  let oldInvalid: string;

  async function insert(data: Partial<Prisma.UnownedAlertCreateInput> & { createdAt?: Date }) {
    const sourceEventId = `teste-fila-${randomUUID()}`;
    sourceEventIds.push(sourceEventId);
    return prisma.unownedAlert.create({
      data: { source: 'wazuh', sourceEventId, reason: 'unknown_account', accounts: [], ...data },
      select: { id: true },
    });
  }

  const get = (path: string, cookie = veraxCookie) =>
    request(app.getHttpServer()).get(path).set('Cookie', cookie);

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente A (fila sem dono)');
    veraxCookie = (await createSignedInUser(app, { role: 'admin_verax' })).cookie;
    await prisma.cloudAccount.create({
      data: { tenantId: tenantA, accountId: registered, regions: ['sa-east-1'] },
    });
    // A conta que falta cadastrar aparece em muitos alertas: fica no topo do resumo.
    for (let index = 0; index < 60; index += 1) {
      await insert({
        accounts: [missing],
        occurredAt: new Date(Date.now() - (index + 1) * 60_000),
        ruleId: '80202',
        ruleLevel: 12,
        title: 'Trilha do CloudTrail desligada',
      });
    }
    await insert({
      reason: 'source_mismatch',
      accounts: [registered],
      createdAt: new Date(Date.now() - HOUR),
    });
    await insert({ reason: 'conflicting_accounts', accounts: [missing, registered] });
    oldInvalid = (
      await insert({
        reason: 'invalid_alert',
        accounts: [],
        createdAt: new Date(Date.now() - 24 * 10 * HOUR),
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.unownedAlert.deleteMany({ where: { sourceEventId: { in: sourceEventIds } } });
    await app.close();
  });

  it('lista os alertas, do mais recente para trás, com os filtros de motivo, conta e período', async () => {
    const byAccount = pageSchema.parse((await get(`/v1/unowned-alerts?account=${missing}`).expect(200)).body);
    expect(byAccount.total).toBe(61);
    expect(byAccount.items).toHaveLength(25);
    expect(byAccount.items[0]).toMatchObject({
      reason: 'conflicting_accounts',
      accounts: [missing, registered],
    });
    expect(byAccount.items[1]).toMatchObject({
      reason: 'unknown_account',
      accounts: [missing],
      ruleId: '80202',
      ruleLevel: 12,
      title: 'Trilha do CloudTrail desligada',
    });

    const mismatch = pageSchema.parse(
      (await get(`/v1/unowned-alerts?account=${registered}&reason=source_mismatch`).expect(200)).body,
    );
    expect(mismatch.items).toHaveLength(1);

    // O alerta de 10 dias atrás fica fora dos últimos 7 dias e dentro dos 90.
    const week = pageSchema.parse(
      (await get('/v1/unowned-alerts?reason=invalid_alert&period=7d&pageSize=100').expect(200)).body,
    );
    expect(week.items.map((item) => item.id)).not.toContain(oldInvalid);
    const quarter = pageSchema.parse(
      (await get('/v1/unowned-alerts?reason=invalid_alert&period=90d').expect(200)).body,
    );
    expect(quarter.total).toBeGreaterThan(week.total);
  });

  it('resume as contas que mais aparecem e onde cada uma está cadastrada hoje', async () => {
    const summary = unownedAccountsSchema.parse((await get('/v1/unowned-alerts/accounts').expect(200)).body);
    expect(summary.period).toBe('30d');
    const top = summary.items.find((item) => item.account === missing);
    expect(top).toMatchObject({ alerts: 61, registeredIn: null });
    expect(summary.items[0]?.alerts).toBeGreaterThanOrEqual(61);
    expect(summary.items.find((item) => item.account === registered)).toMatchObject({
      alerts: 2,
      registeredIn: { tenantId: tenantA, tenantName: 'Cliente A (fila sem dono)', active: true },
    });
  });

  it.each(['admin_cliente', 'analista_cliente', 'leitura'] as const)(
    '%s não vê a fila (os alertas não são de cliente nenhum)',
    async (role) => {
      const user = await createSignedInUser(app, { role, tenantId: tenantA });
      await get('/v1/unowned-alerts', user.cookie).expect(403);
      await get('/v1/unowned-alerts/accounts', user.cookie).expect(403);
    },
  );

  it.each([
    '/v1/unowned-alerts?outra=1',
    '/v1/unowned-alerts?reason=qualquer',
    '/v1/unowned-alerts?pageSize=500',
    '/v1/unowned-alerts/accounts?period=1y',
    '/v1/unowned-alerts/accounts?page=2',
  ])('parâmetro inválido é recusado: %s', async (path) => {
    await get(path).expect(400);
  });
});
