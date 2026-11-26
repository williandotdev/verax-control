import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  alertExceptionBatchCreatedSchema,
  alertExceptionCreatedSchema,
  alertExceptionSchema,
  EXCEPTION_OPEN_RESOLVE_MAX,
  exceptionOpenPreviewSchema,
  exceptionOpenResolutionSchema,
  scopedExceptionCreatedSchema,
  scopedExceptionSchema,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { createTenant } from './support/auth-helpers.js';
import { cleanCases, insertCase, insertFinding, insertIncident } from './support/cases.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { caseWith, type Operator, operatorFor, post, read, trail } from './support/triage.js';

/**
 * Exceção nova resolve os alertas em aberto que cobre (decisão do dono de 26/11/2026): pela regra da chegada, só os em
 * aberto, nunca os de incidente ou de caso promovido, com o vínculo, o comentário, a contagem e um registro na trilha, em
 * lotes, idempotente e isolado por cliente. As de usuário, IP e recurso e as amplas (`CASES_MODE=on`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT = '111111111111';
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
const query = (values: Record<string, string>) => `?${new URLSearchParams(values).toString()}`;

describe('exceção nova resolve os alertas em aberto', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let adminA: Operator;
  let analystA: Operator;
  let readerA: Operator;
  let adminB: Operator;
  let rule = 120_000;
  const nextRule = () => String((rule += 1));

  beforeAll(async () => {
    app = await createApp({ casesMode: 'on' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (em aberto)');
    tenantB = await createTenant(app, 'Cliente Demo B (em aberto)');
    tenants.push(tenantA, tenantB);
    adminA = await operatorFor(app, tenantA, 'admin_cliente');
    analystA = await operatorFor(app, tenantA, 'analista_cliente');
    readerA = await operatorFor(app, tenantA, 'leitura');
    adminB = await operatorFor(app, tenantB, 'admin_cliente');
  }, 120_000);

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    await prisma.findingComment.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => undefined);
    await app.close();
  }, 60_000);

  const finding = (tenantId: string, overrides: Partial<Prisma.FindingUncheckedCreateInput>) =>
    insertFinding(prisma, tenantId, { accountId: ACCOUNT, severity: 'medium', ...overrides });

  const statusOf = async (ids: readonly string[]) =>
    Object.fromEntries(
      (
        await prisma.finding.findMany({
          where: { id: { in: [...ids] } },
          select: { id: true, status: true },
        })
      ).map((row) => [row.id, row.status]),
    );

  /** O mundo de uma exceção de usuário: o que ela resolve, o que fica e o que ela nem vê. */
  async function userWorld(ruleId: string, user: string) {
    const incidentId = await insertIncident(prisma, tenantA);
    const promotedCase = await insertCase(prisma, tenantA, { incidentId });
    const openCase = await insertCase(prisma, tenantA);
    const base = { ruleId, actorUser: user };
    const resolves = [
      await finding(tenantA, { ...base }),
      await finding(tenantA, { ...base, severity: 'critical' }),
      await finding(tenantA, { ...base, status: 'investigating', triagedAt: new Date(Date.now() - DAY_MS) }),
      await finding(tenantA, { ...base, caseId: openCase }),
    ];
    const kept = [
      await finding(tenantA, { ...base, incidentId }),
      await finding(tenantA, { ...base, caseId: promotedCase }),
    ];
    const untouched = [
      await finding(tenantA, { ...base, status: 'legitimate' }),
      await finding(tenantA, { ...base, status: 'resolved' }),
      await finding(tenantA, { ruleId, actorUser: 'outra-pessoa' }),
      await finding(tenantA, { ruleId: nextRule(), actorUser: user }),
    ];
    const otherTenant = await finding(tenantB, { ...base });
    return { resolves, kept, untouched, otherTenant, openCase };
  }

  it('a de usuário: prévia, criação com a contagem, vínculo, comentário, contagem da exceção, trilha e o filtro', async () => {
    const ruleId = nextRule();
    const world = await userWorld(ruleId, 'automacao-noturna');
    const target = { ruleId, field: 'user', value: 'automacao-noturna' };

    const preview = exceptionOpenPreviewSchema.parse(
      (await read(app, analystA, `/v1/alert-exceptions/open-alerts${query(target)}`).expect(200)).body,
    );
    expect(preview).toEqual({ resolve: 4, keptInIncident: 2, complete: true });
    // Prévia não grava nada.
    expect(Object.values(await statusOf(world.resolves))).not.toContain('legitimate');
    await read(app, readerA, `/v1/alert-exceptions/open-alerts${query(target)}`).expect(403);

    const before = await prisma.finding.findUniqueOrThrow({ where: { id: world.resolves[3] ?? '' } });
    const response = await post(app, analystA, '/v1/alert-exceptions?openAlerts=true', {
      ...target,
      reason: 'Job noturno de backup',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = alertExceptionCreatedSchema.parse(response.body);
    expect(created.openAlerts).toEqual({ resolved: 4, keptInIncident: 2, more: false });
    expect(created.matchedCount).toBe(4);
    expect(created.lastMatchedAt).not.toBeNull();

    const resolved = await prisma.finding.findMany({
      where: { id: { in: world.resolves } },
      select: { status: true, exceptionId: true, scopedExceptionId: true, triagedAt: true, triageOpId: true },
    });
    for (const row of resolved) {
      expect(row).toMatchObject({ status: 'legitimate', exceptionId: created.id, scopedExceptionId: null });
      expect(row.triagedAt).not.toBeNull();
    }
    // A data da primeira triagem do que já estava em análise não muda.
    const investigating = await prisma.finding.findUniqueOrThrow({ where: { id: world.resolves[2] ?? '' } });
    expect(investigating.triagedAt?.getTime()).toBeLessThan(Date.now() - DAY_MS / 2);
    expect(before.status).toBe('new');

    expect(await statusOf(world.kept)).toEqual(Object.fromEntries(world.kept.map((id) => [id, 'new'])));
    const untouched = await statusOf(world.untouched);
    expect(Object.values(untouched)).toEqual(['legitimate', 'resolved', 'new', 'new']);
    expect(
      await prisma.finding.findMany({
        where: { id: { in: world.untouched } },
        select: { exceptionId: true },
      }),
    ).toEqual(world.untouched.map(() => ({ exceptionId: null })));
    // Outro cliente: nem lido.
    expect((await statusOf([world.otherTenant]))[world.otherTenant]).toBe('new');

    const comments = await prisma.findingComment.findMany({
      where: { findingId: { in: [...world.resolves, ...world.kept, ...world.untouched] } },
      select: { findingId: true, authorId: true, body: true, tenantId: true },
    });
    expect(comments.map((comment) => comment.findingId).sort()).toEqual([...world.resolves].sort());
    for (const comment of comments) {
      expect(comment.authorId).toBe(analystA.userId);
      expect(comment.tenantId).toBe(tenantA);
      expect(comment.body).toContain('Resolvido automaticamente pela exceção de usuário "automacao-noturna"');
      expect(comment.body).toContain(created.id);
      expect(comment.body).toContain('criada por');
    }

    const entries = await trail(prisma, tenantA, 'alert_exception.resolve_open');
    const mine = entries.filter((entry) => entry.resourceId === created.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.after).toMatchObject({
      exceptionId: created.id,
      resolved: 4,
      keptInIncident: 2,
      more: false,
    });
    expect(await trail(prisma, tenantB, 'alert_exception.resolve_open')).toHaveLength(0);

    // O caso aberto acompanha (contagens dos gatilhos): o alerta saiu de pendente.
    const openCase = await prisma.alertCase.findUniqueOrThrow({ where: { id: world.openCase } });
    expect(openCase).toMatchObject({ newCount: 0, legitimateCount: 1, pending: false });

    // O filtro da lista de alertas pela exceção.
    const listed = (await read(app, readerA, `/v1/findings?exception=${created.id}`).expect(200)).body as {
      items: { id: string; status: string }[];
    };
    expect(listed.items.map((item) => item.id).sort()).toEqual([...world.resolves].sort());
    const elsewhere = (await read(app, adminB, `/v1/findings?exception=${created.id}`).expect(200)).body as {
      items: unknown[];
    };
    expect(elsewhere.items).toHaveLength(0);
  });

  it('sem o pedido, a resposta é a de sempre (painel de antes), e os alertas em aberto são resolvidos igual', async () => {
    const ruleId = nextRule();
    const id = await finding(tenantA, { ruleId, resource: 'arn:aws:s3:::bucket-de-teste' });
    const response = await post(app, analystA, '/v1/alert-exceptions', {
      ruleId,
      field: 'resource',
      value: 'arn:aws:s3:::bucket-de-teste',
      reason: 'Bucket público de propósito',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    // O contrato estrito de antes aceita a resposta: nada a mais.
    const created = alertExceptionSchema.parse(response.body);
    expect(created.matchedCount).toBe(1);
    expect((await statusOf([id]))[id]).toBe('legitimate');
  });

  it('IP por faixa: a mesma regra da chegada decide; o que está fora da faixa fica', async () => {
    const ruleId = nextRule();
    const inside = await finding(tenantA, { ruleId, sourceIp: '203.0.113.9', actorUser: null });
    const outside = await finding(tenantA, { ruleId, sourceIp: '198.51.100.1', actorUser: null });
    const noIp = await finding(tenantA, { ruleId, sourceIp: null, actorUser: null });
    const target = { ruleId, field: 'ip', value: '203.0.113.0/24' };
    expect(
      (await read(app, analystA, `/v1/alert-exceptions/open-alerts${query(target)}`).expect(200)).body,
    ).toEqual({ resolve: 1, keptInIncident: 0, complete: true });
    await read(app, analystA, `/v1/alert-exceptions/open-alerts${query({ ...target, value: 'x' })}`).expect(
      400,
    );
    const created = alertExceptionCreatedSchema.parse(
      (
        await post(app, analystA, '/v1/alert-exceptions?openAlerts=true', {
          ...target,
          reason: 'Varredura autorizada',
        }).expect(201)
      ).body,
    );
    expect(created.openAlerts).toEqual({ resolved: 1, keptInIncident: 0, more: false });
    expect(await statusOf([inside, outside, noIp])).toEqual({
      [inside]: 'legitimate',
      [outside]: 'new',
      [noIp]: 'new',
    });
  });

  it('em lotes, com teto por requisição; "resolver os próximos" continua, e repetir não muda nada (idempotente)', async () => {
    const ruleId = nextRule();
    const total = EXCEPTION_OPEN_RESOLVE_MAX + 150;
    const start = Date.now() - 60_000;
    await prisma.finding.createMany({
      data: Array.from({ length: total }, (_, index) => ({
        tenantId: tenantA,
        accountId: ACCOUNT,
        source: 'wazuh',
        sourceEventId: `aberto-${randomUUID()}`,
        logSource: 'cloudtrail',
        occurredAt: new Date(start + index),
        severity: 'low' as const,
        ruleId,
        ruleLevel: 3,
        title: 'Alerta de teste',
        actorUser: 'robo-de-deploy',
        mitreTactics: [],
        mitreTechniques: [],
      })),
    });
    const started = Date.now();
    const response = await post(app, analystA, '/v1/alert-exceptions?openAlerts=true', {
      ruleId,
      field: 'user',
      value: 'robo-de-deploy',
      reason: 'Deploy automatizado',
    });
    const elapsed = Date.now() - started;
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = alertExceptionCreatedSchema.parse(response.body);
    expect(created.openAlerts).toEqual({
      resolved: EXCEPTION_OPEN_RESOLVE_MAX,
      keptInIncident: 0,
      more: true,
    });
    // Bem abaixo do prazo da transação da requisição (15 s).
    expect(elapsed).toBeLessThan(12_000);

    const again = exceptionOpenResolutionSchema.parse(
      (await post(app, analystA, `/v1/alert-exceptions/${created.id}/resolve-open`).expect(200)).body,
    );
    expect(again).toEqual({ resolved: 150, keptInIncident: 0, more: false });
    const twice = exceptionOpenResolutionSchema.parse(
      (await post(app, analystA, `/v1/alert-exceptions/${created.id}/resolve-open`).expect(200)).body,
    );
    expect(twice).toEqual({ resolved: 0, keptInIncident: 0, more: false });

    const exception = await prisma.alertException.findUniqueOrThrow({ where: { id: created.id } });
    expect(exception.matchedCount).toBe(total);
    expect(await prisma.finding.count({ where: { tenantId: tenantA, ruleId, status: 'legitimate' } })).toBe(
      total,
    );
    expect(
      await prisma.findingComment.count({ where: { tenantId: tenantA, finding: { is: { ruleId } } } }),
    ).toBe(total);
    // Um registro por pedido: a criação e cada "resolver os próximos" (o último, sem nada, com zero).
    const entries = (await trail(prisma, tenantA, 'alert_exception.resolve_open')).filter(
      (entry) => entry.resourceId === created.id,
    );
    expect(entries.map((entry) => (entry.after as { resolved: number }).resolved)).toEqual([
      EXCEPTION_OPEN_RESOLVE_MAX,
      150,
      0,
    ]);

    // O leitor não pede; outro cliente não alcança (404, como a que não existe).
    expect((await post(app, readerA, `/v1/alert-exceptions/${created.id}/resolve-open`)).status).toBe(403);
    expect((await post(app, adminB, `/v1/alert-exceptions/${created.id}/resolve-open`)).status).toBe(404);
  }, 120_000);

  it('a exceção vencida não resolve mais nada (409); vencer ou apagar não reabre o que ela resolveu', async () => {
    const ruleId = nextRule();
    const first = await finding(tenantA, { ruleId, actorUser: 'pessoa-x' });
    const created = alertExceptionSchema.parse(
      (
        await post(app, analystA, '/v1/alert-exceptions', {
          ruleId,
          field: 'user',
          value: 'pessoa-x',
          reason: 'Teste',
        }).expect(201)
      ).body,
    );
    await prisma.alertException.update({
      where: { id: created.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await finding(tenantA, { ruleId, actorUser: 'pessoa-x' });
    expect((await post(app, analystA, `/v1/alert-exceptions/${created.id}/resolve-open`)).status).toBe(409);
    expect(await statusOf([first, late])).toEqual({ [first]: 'legitimate', [late]: 'new' });
    // Apagar desfaz só o vínculo (a chave estrangeira de sempre); o status e o comentário, com o id dela, ficam.
    await request(app.getHttpServer())
      .delete(`/v1/alert-exceptions/${created.id}`)
      .set('Cookie', analystA.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', analystA.csrfToken)
      .expect(204);
    const after = await prisma.finding.findUniqueOrThrow({ where: { id: first } });
    expect(after).toMatchObject({ status: 'legitimate', exceptionId: null });
    const comment = await prisma.findingComment.findFirstOrThrow({ where: { findingId: first } });
    expect(comment.body).toContain(created.id);
  });

  it('ampla: as travas valem (crítico nunca, severidade máxima, evento); revogar não reabre e o filtro continua', async () => {
    const ruleId = '990511';
    const accountId = '222222222222';
    const base = { ruleId, logSource: 'inspector', accountId, eventName: 'CVE-2026-1234' };
    const medium = await finding(tenantA, { ...base, severity: 'medium', resource: 'arn:aws:ecr:repo/app' });
    const low = await finding(tenantA, { ...base, severity: 'low', resource: 'arn:aws:ecr:repo/app' });
    const high = await finding(tenantA, { ...base, severity: 'high', resource: 'arn:aws:ecr:repo/app' });
    const critical = await finding(tenantA, {
      ...base,
      severity: 'critical',
      resource: 'arn:aws:ecr:repo/app',
    });
    const otherEvent = await finding(tenantA, { ...base, eventName: 'CVE-2026-9999' });
    const otherPrefix = await finding(tenantA, { ...base, resource: 'arn:aws:ecr:outro/app' });
    const incidentId = await insertIncident(prisma, tenantA);
    const inIncident = await finding(tenantA, { ...base, resource: 'arn:aws:ecr:repo/app', incidentId });
    const closed = await finding(tenantA, { ...base, resource: 'arn:aws:ecr:repo/app', status: 'resolved' });
    const otherTenant = await finding(tenantB, { ...base, resource: 'arn:aws:ecr:repo/app' });
    const target = { ...base, resourcePrefix: 'arn:aws:ecr:repo/' };

    await read(app, analystA, `/v1/scoped-exceptions/open-alerts${query(target)}`).expect(403);
    expect(
      (await read(app, adminA, `/v1/scoped-exceptions/open-alerts${query(target)}`).expect(200)).body,
    ).toEqual({ resolve: 2, keptInIncident: 1, complete: true });
    // Com a máxima "alto", o alto entra; o crítico, nunca.
    expect(
      (
        await read(
          app,
          adminA,
          `/v1/scoped-exceptions/open-alerts${query({ ...target, maxSeverity: 'high' })}`,
        ).expect(200)
      ).body,
    ).toEqual({ resolve: 3, keptInIncident: 1, complete: true });

    const response = await post(app, adminA, '/v1/scoped-exceptions?openAlerts=true', {
      ...target,
      reason: 'Imagem sem correção do fornecedor',
      expiresAt: inDays(30),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = scopedExceptionCreatedSchema.parse(response.body);
    expect(created.openAlerts).toEqual({ resolved: 2, keptInIncident: 1, more: false });
    expect(created.matchedCount).toBe(2);
    expect(
      await statusOf([medium, low, high, critical, otherEvent, otherPrefix, inIncident, closed]),
    ).toEqual({
      [medium]: 'legitimate',
      [low]: 'legitimate',
      [high]: 'new',
      [critical]: 'new',
      [otherEvent]: 'new',
      [otherPrefix]: 'new',
      [inIncident]: 'new',
      [closed]: 'resolved',
    });
    expect((await statusOf([otherTenant]))[otherTenant]).toBe('new');
    const linked = await prisma.finding.findMany({
      where: { id: { in: [medium, low] } },
      select: { scopedExceptionId: true, exceptionId: true },
    });
    expect(linked).toEqual([
      { scopedExceptionId: created.id, exceptionId: null },
      { scopedExceptionId: created.id, exceptionId: null },
    ]);

    // Sem o pedido: a resposta estrita de sempre.
    const plain = await post(app, adminA, '/v1/scoped-exceptions', {
      ...base,
      eventName: 'CVE-2026-9999',
      reason: 'Outro CVE',
      expiresAt: inDays(10),
    });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    scopedExceptionSchema.parse(plain.body);
    expect((await statusOf([otherEvent]))[otherEvent]).toBe('legitimate');

    // Revogar não reabre, e o filtro pela exceção continua.
    await post(app, adminA, `/v1/scoped-exceptions/${created.id}/revoke`).expect(200);
    expect(await statusOf([medium, low])).toEqual({ [medium]: 'legitimate', [low]: 'legitimate' });
    const listed = (await read(app, readerA, `/v1/findings?exception=${created.id}`).expect(200)).body as {
      items: { id: string }[];
    };
    expect(listed.items.map((item) => item.id).sort()).toEqual([medium, low].sort());
    expect((await post(app, adminA, `/v1/scoped-exceptions/${created.id}/resolve-open`)).status).toBe(409);
    expect((await post(app, adminB, `/v1/scoped-exceptions/${created.id}/resolve-open`)).status).toBe(404);
  });

  it('o lote a partir de um caso resolve os em aberto das exceções criadas agora, com um registro na trilha', async () => {
    const ruleId = nextRule();
    const { caseId, ids } = await caseWith(prisma, tenantA, [
      { ruleId, actorUser: 'conta-a', accountId: ACCOUNT, severity: 'low' },
      { ruleId, actorUser: 'conta-b', accountId: ACCOUNT, severity: 'low' },
      { ruleId, actorUser: 'conta-c', accountId: ACCOUNT, severity: 'low' },
    ]);
    const response = await post(app, analystA, `/v1/cases/${caseId}/alert-exceptions?openAlerts=true`, {
      ruleId,
      field: 'user',
      values: ['conta-a', 'conta-b'],
      reason: 'Contas de serviço',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(alertExceptionBatchCreatedSchema.parse(response.body)).toEqual({
      created: 2,
      existing: 0,
      openAlerts: { resolved: 2, keptInIncident: 0, more: false },
    });
    expect(await statusOf(ids)).toEqual({
      [ids[0] ?? '']: 'legitimate',
      [ids[1] ?? '']: 'legitimate',
      [ids[2] ?? '']: 'new',
    });
    const entries = (await trail(prisma, tenantA, 'alert_exception.resolve_open')).filter(
      (entry) => entry.resourceId === caseId,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.after).toMatchObject({ caseId, resolved: 2 });
    const exceptions = await prisma.alertException.findMany({
      where: { tenantId: tenantA, ruleId },
      select: { matchedCount: true },
    });
    expect(exceptions).toEqual([{ matchedCount: 1 }, { matchedCount: 1 }]);
  });
});
