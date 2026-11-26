import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  alertExceptionBatchResultSchema,
  caseExceptionDraftSchema,
  scopedExceptionPreviewSchema,
  scopedExceptionSchema,
} from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore } from '../src/alerts/finding-store.js';
import { ScopedExceptionSource } from '../src/alerts/scoped-exception-match.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { createTenant } from './support/auth-helpers.js';
import { cleanCases, insertFinding } from './support/cases.js';
import { createApp } from './support/create-app.js';
import { caseWith, type Operator, operatorFor, patch, post, read, trail } from './support/triage.js';

/**
 * Exceções amplas a partir de um caso (casos, PR-9): a API (prévia, criar, listar, revogar, o rascunho do caso e o lote de
 * exceções de usuário, IP ou recurso), só com `CASES_MODE=on`, só administradores, isolada por cliente e auditada; e a
 * comparação na coleta (`FindingStore` com `ScopedExceptionSource`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT = '111111111111';
const OTHER_ACCOUNT = '222222222222';
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

const target = {
  ruleId: '990511',
  logSource: 'inspector',
  accountId: ACCOUNT,
  eventName: 'CVE-2026-0001',
};
const createBody = (overrides: object = {}) => ({
  ...target,
  reason: 'Pacote sem correção do fornecedor',
  expiresAt: inDays(30),
  ...overrides,
});
const query = (values: Record<string, string>) => `?${new URLSearchParams(values).toString()}`;

describe('exceções amplas (CASES_MODE=on)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenants: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let adminA: Operator;
  let analystA: Operator;
  let readerA: Operator;
  let adminB: Operator;

  beforeAll(async () => {
    app = await createApp({ casesMode: 'on' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (amplas)');
    tenantB = await createTenant(app, 'Cliente Demo B (amplas)');
    tenants.push(tenantA, tenantB);
    adminA = await operatorFor(app, tenantA, 'admin_cliente');
    analystA = await operatorFor(app, tenantA, 'analista_cliente');
    readerA = await operatorFor(app, tenantA, 'leitura');
    adminB = await operatorFor(app, tenantB, 'admin_cliente');
  }, 120_000);

  afterAll(async () => {
    await cleanCases(prisma, tenants);
    // O alerta resolvido pela exceção ao ser criada tem o comentário dela, que não sai (só pelo expurgo): fica.
    await prisma.finding.deleteMany({ where: { tenantId: { in: tenants }, comments: { none: {} } } });
    await prisma.scopedException.deleteMany({ where: { tenantId: { in: tenants } } });
    await app.close();
  }, 60_000);

  const create = async (who: Operator, body: object, status = 201) => {
    const response = await post(app, who, '/v1/scoped-exceptions', body);
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    return response;
  };

  it('o administrador cria; a criação vai para a trilha do cliente; todos os papéis que leem exceções listam', async () => {
    const created = scopedExceptionSchema.parse((await create(adminA, createBody())).body);
    expect(created).toMatchObject({
      ...target,
      maxSeverity: 'medium',
      active: true,
      matchedCount: 0,
      revokedAt: null,
    });
    expect(created.createdBy.id).toBe(adminA.userId);
    const [entry] = await trail(prisma, tenantA, 'alert_exception.scoped_create');
    expect(entry).toMatchObject({ outcome: 'success', resourceId: created.id });
    for (const who of [analystA, readerA]) {
      const list = (await read(app, who, '/v1/scoped-exceptions').expect(200)).body as {
        items: { id: string }[];
      };
      expect(list.items.map((item) => item.id)).toContain(created.id);
    }
  });

  it('analista e leitura não pedem prévia, não criam nem revogam (403); a escrita recusada fica na trilha', async () => {
    const before = (await trail(prisma, tenantA, 'alert_exception.scoped_create')).length;
    const body = (await create(adminA, createBody({ eventName: 'CVE-2026-0002' }))).body as unknown;
    await create(analystA, createBody(), 403);
    await create(readerA, createBody(), 403);
    await read(app, analystA, `/v1/scoped-exceptions/preview${query(target)}`).expect(403);
    const revoke = await post(app, analystA, `/v1/scoped-exceptions/${(body as { id: string }).id}/revoke`);
    expect(revoke.status).toBe(403);
    const denied = await prisma.auditLog.findMany({
      where: { tenantId: tenantA, outcome: 'denied', actorId: analystA.userId },
    });
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect((await trail(prisma, tenantA, 'alert_exception.scoped_create')).length).toBe(before + 1);
  });

  it('recusa crítico, validade acima de 90 dias ou sem validade, regra bloqueada, regra de classe sem evento e campo a mais', async () => {
    const { expiresAt: _, ...noExpiry } = createBody();
    const { eventName: __, ...noEvent } = createBody();
    for (const body of [
      createBody({ maxSeverity: 'critical' }),
      createBody({ expiresAt: inDays(91) }),
      noExpiry,
      createBody({ ruleId: '100310', eventName: undefined }),
      createBody({ ruleId: '990406' }),
      noEvent,
      createBody({ ruleId: '80303', logSource: 'guardduty', eventName: undefined }),
      createBody({ tenantId: tenantB }),
      createBody({ accountId: '' }),
    ]) {
      await create(adminA, body, 400);
    }
    // A validade no limite passa.
    await create(adminA, createBody({ eventName: 'CVE-2026-0003', expiresAt: inDays(89.9) }));
  });

  it('a prévia conta os alertas dos últimos 30 dias que ela marcaria, e quantos altos', async () => {
    const tenantId = await createTenant(app, 'Cliente Demo A (prévia)');
    tenants.push(tenantId);
    const admin = await operatorFor(app, tenantId, 'admin_cliente');
    const base = {
      ...target,
      source: 'aws',
      ruleLevel: 7,
      resource: 'arn:aws:ecr:us-east-1:111111111111:repository/app_web/sha256:1',
    };
    const recent = new Date(Date.now() - DAY_MS);
    for (const severity of ['low', 'medium', 'medium', 'high', 'critical'] as const) {
      await insertFinding(prisma, tenantId, { ...base, severity, createdAt: recent });
    }
    await insertFinding(prisma, tenantId, {
      ...base,
      severity: 'medium',
      accountId: OTHER_ACCOUNT,
      createdAt: recent,
    });
    await insertFinding(prisma, tenantId, {
      ...base,
      severity: 'medium',
      eventName: 'CVE-2026-9999',
      createdAt: recent,
    });
    await insertFinding(prisma, tenantId, {
      ...base,
      severity: 'medium',
      createdAt: new Date(Date.now() - 31 * DAY_MS),
    });
    const preview = async (values: Record<string, string>) =>
      scopedExceptionPreviewSchema.parse(
        (
          await read(app, admin, `/v1/scoped-exceptions/preview${query({ ...target, ...values })}`).expect(
            200,
          )
        ).body,
      );
    expect(await preview({})).toEqual({ days: 30, matched: 3, high: 0 });
    expect(await preview({ maxSeverity: 'high' })).toEqual({ days: 30, matched: 4, high: 1 });
    expect(
      (await preview({ resourcePrefix: 'arn:aws:ecr:us-east-1:111111111111:repository/app_web/' })).matched,
    ).toBe(3);
    // `_` e `%` no prefixo são texto, não curinga.
    expect(
      (await preview({ resourcePrefix: 'arn:aws:ecr:us-east-1:111111111111:repository/app%' })).matched,
    ).toBe(0);
    expect(
      (await preview({ resourcePrefix: 'arn:aws:ecr:us-east-1:111111111111:repository/app_' })).matched,
    ).toBe(3);
    expect(
      (await preview({ resourcePrefix: 'arn:aws:ecr:us-east-1:111111111111:repository/appXweb' })).matched,
    ).toBe(0);
    // O outro cliente não vê os alertas deste.
    const other = scopedExceptionPreviewSchema.parse(
      (await read(app, adminB, `/v1/scoped-exceptions/preview${query(target)}`).expect(200)).body,
    );
    expect(other.matched).toBe(0);
  });

  it('revogar: para de valer, fica listada com quem revogou, vai para a trilha; a segunda vez é 409', async () => {
    const body = (await create(adminA, createBody({ eventName: 'CVE-2026-0004' }))).body as unknown;
    const id = (body as { id: string }).id;
    const revoked = scopedExceptionSchema.parse(
      (await post(app, adminA, `/v1/scoped-exceptions/${id}/revoke`).expect(200)).body,
    );
    expect(revoked).toMatchObject({ id, active: false, revokedBy: { id: adminA.userId } });
    expect((await post(app, adminA, `/v1/scoped-exceptions/${id}/revoke`)).status).toBe(409);
    const [entry] = await trail(prisma, tenantA, 'alert_exception.scoped_revoke');
    expect(entry).toMatchObject({ resourceId: id, outcome: 'success' });
    const inactive = (await read(app, adminA, '/v1/scoped-exceptions?active=false').expect(200)).body as {
      items: { id: string }[];
    };
    expect(inactive.items.map((item) => item.id)).toContain(id);
  });

  it('isolamento: o cliente B não lista, não revoga e não lê o caso do cliente A (404)', async () => {
    const body = (await create(adminA, createBody({ eventName: 'CVE-2026-0005' }))).body as unknown;
    const id = (body as { id: string }).id;
    const listB = (await read(app, adminB, '/v1/scoped-exceptions').expect(200)).body as {
      items: { id: string }[];
    };
    expect(listB.items.map((item) => item.id)).not.toContain(id);
    expect((await post(app, adminB, `/v1/scoped-exceptions/${id}/revoke`)).status).toBe(404);
    expect((await prisma.scopedException.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
    const { caseId } = await caseWith(prisma, tenantA, [{ sourceIp: '198.51.100.1' }]);
    await read(app, adminB, `/v1/cases/${caseId}/exception-draft`).expect(404);
    const batch = await post(app, adminB, `/v1/cases/${caseId}/alert-exceptions`, {
      ruleId: '100305',
      field: 'ip',
      values: ['198.51.100.1'],
      reason: 'Teste',
    });
    expect(batch.status).toBe(404);
    expect(await prisma.alertException.count({ where: { tenantId: tenantB } })).toBe(0);
  });

  it('o rascunho do caso diz o que é constante; o lote cria até 20 exceções de uma vez, e a repetida fica como estava', async () => {
    const { caseId } = await caseWith(prisma, tenantA, [
      { ruleId: '100510', sourceIp: '198.51.100.10', actorUser: 'svc-backup', severity: 'medium' },
      { ruleId: '100510', sourceIp: '198.51.100.11', actorUser: 'svc-backup', severity: 'high' },
    ]);
    const draft = caseExceptionDraftSchema.parse(
      (await read(app, analystA, `/v1/cases/${caseId}/exception-draft`).expect(200)).body,
    );
    expect(draft.targets).toEqual([
      {
        ruleId: '100510',
        logSource: 'cloudtrail',
        accountId: '111122223333',
        eventName: null,
        alerts: 2,
        severity: 'high',
      },
    ]);
    expect(draft.values.user).toEqual({ values: ['svc-backup'], complete: true });
    expect(draft.values.ip).toEqual({ values: ['198.51.100.10', '198.51.100.11'], complete: true });
    const body = { ruleId: '100510', field: 'ip', values: draft.values.ip.values, reason: 'Backup noturno' };
    const first = alertExceptionBatchResultSchema.parse(
      (await post(app, analystA, `/v1/cases/${caseId}/alert-exceptions`, body).expect(201)).body,
    );
    expect(first).toEqual({ created: 2, existing: 0 });
    const again = alertExceptionBatchResultSchema.parse(
      (await post(app, analystA, `/v1/cases/${caseId}/alert-exceptions`, body).expect(201)).body,
    );
    expect(again).toEqual({ created: 0, existing: 2 });
    const many = Array.from({ length: 21 }, (_, index) => `198.51.100.${index + 20}`);
    expect(
      (await post(app, analystA, `/v1/cases/${caseId}/alert-exceptions`, { ...body, values: many })).status,
    ).toBe(400);
    const entries = await trail(prisma, tenantA, 'alert_exception.create_batch');
    expect(entries.length).toBe(2);
    // Leitura não opera exceções.
    await read(app, readerA, `/v1/cases/${caseId}/exception-draft`).expect(403);
  });

  describe('na coleta (FindingStore)', () => {
    let store: FindingStore;
    let author: string;

    beforeAll(() => {
      store = new FindingStore(prisma, undefined, {
        scopedExceptions: new ScopedExceptionSource(prisma, { ttlMs: 60_000 }),
      });
      author = adminA.userId;
    });

    function draft(tenantId: string, overrides: Partial<FindingDraft> = {}): FindingDraft {
      return {
        tenantId,
        accountId: ACCOUNT,
        source: 'aws',
        sourceEventId: `amplas-${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        severity: 'medium',
        ruleId: '990511',
        ruleLevel: 7,
        title: 'Vulnerabilidade de pacote',
        logSource: 'inspector',
        eventName: 'CVE-2026-1000',
        region: 'us-east-1',
        resource: 'arn:aws:ecr:us-east-1:111111111111:repository/api/sha256:abc',
        actorUser: null,
        actorType: null,
        accessKeyId: null,
        sourceIp: null,
        mitreTactics: [],
        mitreTechniques: [],
        ...overrides,
      };
    }

    async function exception(tenantId: string, data: object = {}): Promise<string> {
      const { id } = await prisma.scopedException.create({
        data: {
          tenantId,
          ruleId: '990511',
          logSource: 'inspector',
          accountId: ACCOUNT,
          eventName: 'CVE-2026-1000',
          reason: 'Teste',
          expiresAt: new Date(Date.now() + 10 * DAY_MS),
          createdById: author,
          ...data,
        },
        select: { id: true },
      });
      return id;
    }

    const row = (tenantId: string, sourceEventId: string) =>
      prisma.finding.findFirstOrThrow({
        where: { tenantId, sourceEventId },
        select: { id: true, status: true, scopedExceptionId: true, severity: true },
      });

    it('marca como legítimo só o alerta novo que casa; crítico, outra conta, outro evento e outro cliente entram na fila', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (coleta)');
      tenants.push(tenantId);
      const id = await exception(tenantId, {
        resourcePrefix: 'arn:aws:ecr:us-east-1:111111111111:repository/api/',
      });
      const now = new Date();
      const matched = draft(tenantId);
      expect(await store.persist(matched, null, now)).toBe('excepted');
      expect(await row(tenantId, matched.sourceEventId)).toMatchObject({
        status: 'legitimate',
        scopedExceptionId: id,
      });
      const misses = [
        draft(tenantId, { severity: 'critical' }),
        draft(tenantId, { severity: 'high' }),
        draft(tenantId, { accountId: OTHER_ACCOUNT }),
        draft(tenantId, { eventName: 'CVE-2026-2000' }),
        draft(tenantId, { resource: 'arn:aws:ecr:us-east-1:111111111111:repository/web/sha256:abc' }),
        draft(tenantId, { logSource: 'security_hub' }),
        draft(tenantB),
      ];
      for (const miss of misses) {
        expect(await store.persist(miss, null, now)).toBe('created');
        expect((await row(miss.tenantId, miss.sourceEventId)).status).toBe('new');
      }
      const counted = await prisma.scopedException.findUniqueOrThrow({ where: { id } });
      expect(counted.matchedCount).toBe(1);
      expect(counted.lastMatchedAt).not.toBeNull();
    });

    it('regra bloqueada nunca casa, mesmo com a linha gravada direto no banco', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (bloqueada)');
      tenants.push(tenantId);
      await exception(tenantId, { ruleId: '100310', logSource: 'cloudtrail', eventName: null });
      const blocked = draft(tenantId, {
        ruleId: '100310',
        logSource: 'cloudtrail',
        eventName: 'AttachUserPolicy',
      });
      expect(await store.persist(blocked, null, new Date())).toBe('created');
    });

    it('revogada vale na hora, mesmo com a lista guardada; o alerta que já existe nunca é tocado', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (revogada)');
      tenants.push(tenantId);
      const old = draft(tenantId, { revision: { lastSeenAt: new Date(Date.now() - 60_000).toISOString() } });
      expect(await store.persist(old, null, new Date())).toBe('created');
      const id = await exception(tenantId);
      // A versão nova do alerta que já existia continua na fila.
      expect(
        await store.persist({ ...old, revision: { lastSeenAt: new Date().toISOString() } }, null, new Date()),
      ).toBe('duplicate');
      expect((await row(tenantId, old.sourceEventId)).status).toBe('new');
      // A lista guardada antes de a exceção existir vale até o fim do prazo dela; outra fonte já a lê.
      const fresh = new FindingStore(prisma, undefined, {
        scopedExceptions: new ScopedExceptionSource(prisma, { ttlMs: 60_000 }),
      });
      expect(await store.persist(draft(tenantId), null, new Date())).toBe('created');
      expect(await fresh.persist(draft(tenantId), null, new Date())).toBe('excepted');
      await prisma.scopedException.update({
        where: { id },
        data: { revokedAt: new Date(), revokedById: author },
      });
      expect(await fresh.persist(draft(tenantId), null, new Date())).toBe('created');
    });

    it('a exceção de usuário, IP ou recurso vence; nunca as duas no mesmo alerta', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (as duas)');
      tenants.push(tenantId);
      await exception(tenantId);
      const plain = await prisma.alertException.create({
        data: {
          tenantId,
          ruleId: '990511',
          field: 'resource',
          value: draft(tenantId).resource ?? '',
          reason: 'Teste',
          createdById: author,
        },
      });
      const both = draft(tenantId);
      expect(await store.persist(both, { ...plain, field: 'resource' }, new Date())).toBe('excepted');
      const found = await prisma.finding.findFirstOrThrow({
        where: { tenantId, sourceEventId: both.sourceEventId },
      });
      expect(found).toMatchObject({ exceptionId: plain.id, scopedExceptionId: null });
    });

    it('a severidade que sobe acima da máxima devolve o alerta para a fila e avisa; a que fica dentro, não', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (subiu)');
      tenants.push(tenantId);
      await exception(tenantId);
      const at = (ms: number) => new Date(Date.now() - ms).toISOString();
      const first = draft(tenantId, { severity: 'low', revision: { lastSeenAt: at(30_000) } });
      expect(await store.persist(first, null, new Date())).toBe('excepted');
      await store.persist(
        { ...first, severity: 'medium', revision: { lastSeenAt: at(20_000) } },
        null,
        new Date(),
      );
      expect(await row(tenantId, first.sourceEventId)).toMatchObject({
        status: 'legitimate',
        severity: 'medium',
      });
      await store.persist(
        { ...first, severity: 'high', revision: { lastSeenAt: at(10_000) } },
        null,
        new Date(),
      );
      const reopened = await row(tenantId, first.sourceEventId);
      expect(reopened).toMatchObject({ status: 'new', severity: 'high', scopedExceptionId: null });
      expect(await prisma.notification.count({ where: { tenantId, findingId: reopened.id } })).toBe(1);
    });

    it('o que uma pessoa decidiu não é desfeito quando a severidade passa da máxima', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (decidiu)');
      tenants.push(tenantId);
      await exception(tenantId);
      const admin = await operatorFor(app, tenantId, 'admin_cliente');
      const at = (ms: number) => new Date(Date.now() - ms).toISOString();
      const first = draft(tenantId, { severity: 'low', revision: { lastSeenAt: at(30_000) } });
      expect(await store.persist(first, null, new Date())).toBe('excepted');
      const { id } = await row(tenantId, first.sourceEventId);
      await patch(app, admin, `/v1/findings/${id}/status`, { status: 'investigating' }).expect(200);
      await patch(app, admin, `/v1/findings/${id}/status`, { status: 'legitimate' }).expect(200);
      await store.persist(
        { ...first, severity: 'high', revision: { lastSeenAt: at(10_000) } },
        null,
        new Date(),
      );
      expect(await row(tenantId, first.sourceEventId)).toMatchObject({
        status: 'legitimate',
        severity: 'high',
        scopedExceptionId: null,
      });
    });

    it('a que vence no meio da execução deixa de marcar, mesmo com o relógio do começo dela', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (venceu)');
      tenants.push(tenantId);
      const now = Date.now();
      await exception(tenantId, { createdAt: new Date(now - DAY_MS), expiresAt: new Date(now - 60_000) });
      const started = new Date(now - 120_000);
      const late = draft(tenantId);
      expect(await store.persist(late, null, started)).toBe('created');
      expect(await row(tenantId, late.sourceEventId)).toMatchObject({
        status: 'new',
        scopedExceptionId: null,
      });
    });

    it('o recurso que não cabe numa exceção não é oferecido pelo rascunho do caso', async () => {
      const { caseId } = await caseWith(prisma, tenantA, [
        { resource: 's3:relatorios-demo' },
        { resource: `arn:aws:demo:${'x'.repeat(300)}` },
      ]);
      const response = await read(app, analystA, `/v1/cases/${caseId}/exception-draft`).expect(200);
      const draftOf = caseExceptionDraftSchema.parse(response.body);
      expect(draftOf.values.resource).toEqual({ values: ['s3:relatorios-demo'], complete: false });
    });

    it('a leitura que falha não para a coleta: o alerta entra na fila', async () => {
      const tenantId = await createTenant(app, 'Cliente Demo A (falha)');
      tenants.push(tenantId);
      await exception(tenantId);
      const broken = {
        forTenant: () => {
          throw new Error('banco fora');
        },
      } as unknown as PrismaService;
      const warnings: object[] = [];
      const failing = new FindingStore(prisma, undefined, {
        scopedExceptions: new ScopedExceptionSource(broken, {
          logger: { warn: (fields) => warnings.push(fields) },
        }),
      });
      const alert = draft(tenantId);
      expect(await failing.persist(alert, null, new Date())).toBe('created');
      expect((await row(tenantId, alert.sourceEventId)).status).toBe('new');
      expect(warnings).toEqual([{ err: 'Error' }]);
    });
  });
});

describe('exceções amplas com os casos desligados', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantId: string;

  beforeAll(async () => {
    app = await createApp({ casesMode: 'off' });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    tenantId = await createTenant(app, 'Cliente Demo A (desligados)');
  }, 60_000);

  afterAll(async () => {
    await cleanCases(prisma, [tenantId]);
    await app.close();
  });

  it('todas as rotas são 404, também para o administrador; nada é gravado', async () => {
    const admin = await operatorFor(app, tenantId, 'admin_cliente');
    await read(app, admin, '/v1/scoped-exceptions').expect(404);
    await read(app, admin, `/v1/scoped-exceptions/preview${query(target)}`).expect(404);
    expect((await post(app, admin, '/v1/scoped-exceptions', createBody())).status).toBe(404);
    expect((await post(app, admin, `/v1/scoped-exceptions/${randomUUID()}/revoke`)).status).toBe(404);
    const { caseId } = await caseWith(prisma, tenantId, [{}]);
    await read(app, admin, `/v1/cases/${caseId}/exception-draft`).expect(404);
    expect(await prisma.scopedException.count({ where: { tenantId } })).toBe(0);
  });
});
