import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type Role, type TriageOperationDetail, triageOperationDetailSchema } from '@verax/shared';
import request from 'supertest';
import { expect } from 'vitest';
import { CaseReconcileJob } from '../../src/cases/case-reconcile-job.js';
import type { CaseLogger } from '../../src/cases/case-assign-job.js';
import { TriageOpsJob, type TriageOpsOptions, type TriageOpsReport } from '../../src/cases/triage-ops-job.js';
import type { PrismaService } from '../../src/common/prisma/prisma.service.js';
import type { AlertCase, Finding, Prisma } from '../../src/generated/prisma/client.js';
import { createSignedInUser, withCsrf } from './auth-helpers.js';
import { insertCase, insertFinding, SEVERITIES } from './cases.js';
import { TEST_WEB_ORIGIN } from './create-app.js';

/** Apoio dos testes da triagem em massa: sessões, pedidos, casos com alertas e a tarefa presa aos clientes do teste. */

export interface Operator {
  userId: string;
  role: Role;
  cookie: string;
  csrfToken: string;
}

/** Uma pessoa com sessão aberta no cliente (a equipe da Verax, com o cliente escolhido). */
export async function operatorFor(
  app: NestExpressApplication,
  tenantId: string,
  role: Role,
): Promise<Operator> {
  const user = await createSignedInUser(app, { role, tenantId: role === 'admin_verax' ? null : tenantId });
  const { cookie, token } = await withCsrf(app, user.cookie);
  if (role === 'admin_verax') {
    await request(app.getHttpServer())
      .post('/v1/session/tenant')
      .set('Cookie', cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', token)
      .send({ tenantId })
      .expect(200);
  }
  return { userId: user.id, role, cookie, csrfToken: token };
}

export const post = (app: NestExpressApplication, who: Operator, path: string, body?: object) => {
  const call = request(app.getHttpServer())
    .post(path)
    .set('Cookie', who.cookie)
    .set('Origin', TEST_WEB_ORIGIN)
    .set('X-CSRF-Token', who.csrfToken);
  return body === undefined ? call : call.send(body);
};

export const patch = (app: NestExpressApplication, who: Operator, path: string, body: object) =>
  request(app.getHttpServer())
    .patch(path)
    .set('Cookie', who.cookie)
    .set('Origin', TEST_WEB_ORIGIN)
    .set('X-CSRF-Token', who.csrfToken)
    .send(body);

export const read = (app: NestExpressApplication, who: Operator, path: string) =>
  request(app.getHttpServer()).get(path).set('Cookie', who.cookie);

/** Um pedido de mudar o status: resolvido, com motivo e o número que se espera. */
export function statusRequest(
  target: object,
  expectedCount: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId: randomUUID(),
    action: 'status',
    status: 'resolved',
    target,
    expectedCount,
    reason: 'Manutenção programada',
    ...overrides,
  };
}

/** Pede uma operação e confere o contrato da resposta. */
export async function operate(
  app: NestExpressApplication,
  who: Operator,
  body: object,
  status = 201,
): Promise<TriageOperationDetail> {
  const response = await post(app, who, '/v1/triage-operations', body);
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return triageOperationDetailSchema.parse(response.body);
}

export async function undo(
  app: NestExpressApplication,
  who: Operator,
  id: string,
  status = 201,
  body: object = {},
): Promise<TriageOperationDetail> {
  const response = await post(app, who, `/v1/triage-operations/${id}/undo`, {
    requestId: randomUUID(),
    ...body,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  return triageOperationDetailSchema.parse(response.body);
}

export async function operation(
  app: NestExpressApplication,
  who: Operator,
  id: string,
): Promise<TriageOperationDetail> {
  const response = await read(app, who, `/v1/triage-operations/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return triageOperationDetailSchema.parse(response.body);
}

/** Um caso aberto com alertas, um por um (o caso dele é o primeiro argumento; o resto vale para cada alerta). */
export async function caseWith(
  prisma: PrismaService,
  tenantId: string,
  findings: readonly Partial<Prisma.FindingUncheckedCreateInput>[],
  overrides: Partial<Prisma.AlertCaseUncheckedCreateInput> = {},
): Promise<{ caseId: string; ids: string[] }> {
  const caseId = await insertCase(prisma, tenantId, overrides);
  const ids: string[] = [];
  for (const finding of findings) {
    ids.push(await insertFinding(prisma, tenantId, { caseId, createdAt: earlier(), ...finding }));
  }
  return { caseId, ids };
}

/** Muitos alertas de uma vez num caso, sem crítico, da chegada mais antiga para a mais nova. */
export async function manyFindings(
  prisma: PrismaService,
  tenantId: string,
  caseId: string,
  count: number,
  overrides: Partial<Prisma.FindingUncheckedCreateInput> = {},
): Promise<string[]> {
  const start = Date.now() - 60_000 - count;
  await prisma.finding.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      tenantId,
      accountId: '111122223333',
      source: 'wazuh',
      sourceEventId: `lote-${randomUUID()}`,
      logSource: 'cloudtrail',
      occurredAt: new Date(start + index),
      createdAt: new Date(start + index),
      severity: SEVERITIES[1 + (index % 3)] as 'high' | 'medium' | 'low',
      ruleId: '100305',
      ruleLevel: 10,
      title: 'Alerta de teste',
      actorUser: `pessoa-${index % 7}`,
      mitreTactics: [],
      mitreTechniques: [],
      caseId,
      ...overrides,
    })),
  });
  const rows = await prisma.finding.findMany({
    where: { tenantId, caseId },
    select: { id: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => row.id);
}

/** Um instante um pouco antes: o alerta que chegou agora mesmo pode passar do corte do pedido, em outro relógio. */
export const earlier = (milliseconds = 60_000): Date => new Date(Date.now() - milliseconds);

/** A tarefa presa aos clientes do teste, com a linha dela no `SyncState` (outra por teste). */
export function triageJob(
  prisma: PrismaService,
  tenantIds: readonly string[],
  options: Partial<TriageOpsOptions> = {},
): TriageOpsJob {
  return new TriageOpsJob(prisma, {
    name: `lote-${randomBytes(6).toString('hex')}`,
    tenantIds,
    pauseMs: 0,
    ...options,
  });
}

/** Roda a fila inteira dos clientes. */
export async function drain(
  prisma: PrismaService,
  tenantIds: readonly string[],
  options: Partial<TriageOpsOptions> = {},
): Promise<TriageOpsReport> {
  const report = await triageJob(prisma, tenantIds, options).runOnce();
  expect(report).toMatchObject({ status: 'done', stalled: 0 });
  return report;
}

export const findingsById = async (
  prisma: PrismaService,
  ids: readonly string[],
): Promise<Map<string, Finding>> => {
  const rows = await prisma.finding.findMany({ where: { id: { in: [...ids] } } });
  return new Map(rows.map((row) => [row.id, row]));
};

/** Quantos alertas há em cada status. */
export async function statusCounts(prisma: PrismaService, tenantId: string): Promise<Record<string, number>> {
  const rows = await prisma.finding.groupBy({ by: ['status'], where: { tenantId }, _count: true });
  return Object.fromEntries(rows.map((row) => [row.status, row._count]));
}

export const caseRow = (prisma: PrismaService, id: string): Promise<AlertCase> =>
  prisma.alertCase.findUniqueOrThrow({ where: { id } });

/** A conferência das contagens de todos os casos dos clientes não acha nenhuma errada. */
export async function expectNoDrift(prisma: PrismaService, tenantIds: readonly string[]): Promise<void> {
  const report = await new CaseReconcileJob(prisma, {
    name: `conf-${randomBytes(6).toString('hex')}`,
    tenantIds,
  }).runOnce();
  expect(report).toMatchObject({ status: 'done', drifted: 0, failed: 0 });
}

/** Os registros da trilha do cliente com estas ações, do mais antigo para o mais novo. */
export function trail(prisma: PrismaService, tenantId: string, ...actions: string[]) {
  return prisma.auditLog.findMany({
    where: { tenantId, action: { in: actions } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
}

/** Um logger que guarda o que a tarefa registra. */
export function memoryLogger(): { lines: Record<string, unknown>[]; logger: CaseLogger } {
  const lines: Record<string, unknown>[] = [];
  const keep = (fields: object, message: string) => void lines.push({ ...fields, message });
  return { lines, logger: { warn: keep, error: keep } };
}
