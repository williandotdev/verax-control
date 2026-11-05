import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  auditEntrySchema,
  findingSchema,
  paginatedSchema,
  type PostureOverview,
  postureOverviewSchema,
} from '@verax/shared';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { createSignedInUser, createTenant } from './auth-helpers.js';
import { createApp, type CreateAppOptions } from './create-app.js';

/**
 * Base dos testes do histórico do plano nas telas (fase 2, PR-20), um arquivo por plano (um app por arquivo): o cliente
 * A com uma conta AWS e as sessões de cada papel dele, o cliente B para o negativo, e os dados com a idade pedida.
 */

export const DAY = 24 * 3_600_000;

const findingPage = paginatedSchema(findingSchema);
const auditPage = paginatedSchema(auditEntrySchema);

export type ClientRole = 'admin_cliente' | 'analista_cliente' | 'leitura';

export interface PlanHistoryFixture {
  app: NestExpressApplication;
  prisma: PrismaService;
  tenantA: string;
  tenantB: string;
  accountId: string;
  /** GET com a sessão de cada papel do cliente A. */
  as: Record<ClientRole, (path: string) => request.Test>;
  /** GET sem sessão. */
  anonymous: (path: string) => request.Test;
  /** Achado do cliente com a idade pedida, em dias (o ID). */
  insertFinding(tenantId: string, daysAgo: number): Promise<string>;
  /** Registro de auditoria do cliente com a idade pedida, em dias (o ID). */
  insertAudit(tenantId: string, daysAgo: number): Promise<string>;
  /** Uma varredura de postura da conta do cliente A em cada idade pedida, em dias, contadas de um mesmo instante. */
  insertScans(daysAgo: readonly number[]): Promise<void>;
  /** IDs dos achados que o papel vê com o período. */
  findingIds(role: ClientRole, period: string): Promise<string[]>;
  /** IDs da trilha que o administrador do cliente A vê com o período. */
  auditIds(period: string): Promise<string[]>;
  /** A postura do cliente A, lida pela sessão de leitura. */
  posture(): Promise<PostureOverview>;
}

export async function planHistoryFixture(plan?: CreateAppOptions['plan']): Promise<PlanHistoryFixture> {
  const app = await createApp(plan ? { plan } : {});
  const prisma = app.get(PrismaService);
  const suffix = randomInt(1e6, 9e6);
  const tenantA = await createTenant(app, `Cliente A (histórico ${suffix})`);
  const tenantB = await createTenant(app, `Cliente B (histórico ${suffix})`);
  const accountId = String(randomInt(100_000_000_000, 999_999_999_999));
  await prisma.cloudAccount.create({ data: { tenantId: tenantA, accountId, regions: ['sa-east-1'] } });

  const sessions = {} as Record<ClientRole, string>;
  for (const role of ['admin_cliente', 'analista_cliente', 'leitura'] as const) {
    sessions[role] = (await createSignedInUser(app, { role, tenantId: tenantA })).cookie;
  }
  const get = (cookie: string) => (path: string) =>
    request(app.getHttpServer()).get(path).set('Cookie', cookie);
  const as = {
    admin_cliente: get(sessions.admin_cliente),
    analista_cliente: get(sessions.analista_cliente),
    leitura: get(sessions.leitura),
  };

  return {
    app,
    prisma,
    tenantA,
    tenantB,
    accountId,
    as,
    anonymous: (path) => request(app.getHttpServer()).get(path),
    async insertFinding(tenantId, daysAgo) {
      const finding = await prisma.finding.create({
        data: {
          tenantId,
          accountId,
          source: 'wazuh',
          sourceEventId: randomUUID(),
          logSource: 'cloudtrail',
          occurredAt: new Date(Date.now() - daysAgo * DAY),
          severity: 'high',
          ruleId: '80202',
          ruleLevel: 10,
          title: `Achado de ${daysAgo} dias`,
          sourceIp: '198.51.100.23',
          mitreTactics: [],
          mitreTechniques: [],
        },
        select: { id: true },
      });
      return finding.id;
    },
    async insertAudit(tenantId, daysAgo) {
      const entry = await prisma.auditLog.create({
        data: {
          occurredAt: new Date(Date.now() - daysAgo * DAY),
          actorType: 'system',
          tenantId,
          action: 'retention.purge',
          resourceType: 'tenant',
          outcome: 'success',
        },
        select: { id: true },
      });
      return entry.id;
    },
    async insertScans(daysAgo) {
      const base = Date.now();
      await prisma.postureScan.createMany({
        data: daysAgo.map((days) => ({
          tenantId: tenantA,
          accountId,
          scannedAt: new Date(base - days * DAY),
          score: 60 + (days % 30),
          weightPassed: 60,
          weightTotal: 100,
          passed: 10,
          failed: 0,
          failedCritical: 0,
          failedHigh: 0,
          failedMedium: 0,
          failedLow: 0,
          failedInformational: 0,
        })),
      });
    },
    async findingIds(role, period) {
      const response = await as[role](`/v1/findings?period=${period}&pageSize=100`).expect(200);
      return findingPage.parse(response.body).items.map((item) => item.id);
    },
    async auditIds(period) {
      const response = await as.admin_cliente(`/v1/audit?period=${period}&pageSize=100`).expect(200);
      return auditPage.parse(response.body).items.map((item) => item.id);
    },
    async posture() {
      return postureOverviewSchema.parse((await as.leitura('/v1/posture').expect(200)).body);
    },
  };
}

/** Data UTC (`AAAA-MM-DD`) de tantos dias atrás. */
export function dateDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * DAY).toISOString().slice(0, 10);
}
