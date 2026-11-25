import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { caseNoticeKey } from '../src/cases/case-notice-policy.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { RetentionJob } from '../src/retention/retention-job.js';
import { createTenant } from './support/auth-helpers.js';
import {
  DAY_MS,
  member,
  MINUTE_MS,
  noticesOf,
  type NoticeWorld,
  noticeWorld,
} from './support/case-notices.js';
import { casesOf, insertFinding, onlyTenantPhases } from './support/cases.js';
import { createApp } from './support/create-app.js';
import { MemoryMailTransport } from './support/memory-mail.js';
import { createOwnDatabase, type OwnDatabase } from './support/own-database.js';
import { operate, operatorFor, type Operator, patch, post, statusRequest, undo } from './support/triage.js';

/**
 * Os avisos por caso com a triagem em massa, o desfazer, a divisão, os incidentes e o expurgo, pela API de verdade
 * (`CASES_MODE=on`), num banco só deste arquivo.
 */
describe('avisos por caso e a triagem', () => {
  let database: OwnDatabase;
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    database = await createOwnDatabase('avisos_triagem');
    app = await createApp({ casesMode: 'on', databaseUrl: database.url });
    prisma = app.get(PrismaService);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  beforeEach(async () => {
    await prisma.notification.deleteMany({});
    await prisma.notificationDigest.deleteMany({});
  });

  interface Setting extends NoticeWorld {
    tenantId: string;
    admin: Operator;
    person: { id: string; email: string };
    mail: MemoryMailTransport;
    alert: (ruleId?: string, severity?: 'critical' | 'high', count?: number) => Promise<string[]>;
    /** Uns minutos depois. */
    later: (minutes: number) => void;
  }

  async function setting(): Promise<Setting> {
    const tenantId = await createTenant(app, 'Cliente Demo A');
    const admin = await operatorFor(app, tenantId, 'admin_cliente');
    // A sessão tem a própria pessoa; o e-mail dela também recebe.
    const person = await member(prisma, tenantId, 'analista_cliente');
    // O relógio de verdade, uns minutos atrás: a triagem e os incidentes são gravados com ele.
    const made = noticeWorld(prisma, [tenantId], new Date(Date.now() - 5 * MINUTE_MS));
    await made.activate();
    const mail = new MemoryMailTransport();
    return {
      ...made,
      tenantId,
      admin,
      person,
      mail,
      alert: async (ruleId = '100305', severity = 'critical', count = 1) => {
        const ids: string[] = [];
        for (let i = 0; i < count; i += 1)
          ids.push(await insertFinding(prisma, tenantId, { createdAt: made.clock.now, ruleId, severity }));
        return ids;
      },
      later: (minutes) => {
        made.clock.now = new Date(made.clock.now.getTime() + minutes * MINUTE_MS);
      },
    };
  }
  const caseId = async (tenantId: string, ruleId = '100305') => {
    const row = (await casesOf(prisma, tenantId)).find((candidate) => candidate.ruleIds.includes(ruleId));
    if (row === undefined) throw new Error('caso não encontrado');
    return row.id;
  };
  const resolveCase = async ({ tenantId, admin }: Setting, count: number, overrides = {}) =>
    operate(
      app,
      admin,
      statusRequest({ caseIds: [await caseId(tenantId)] }, count, { includeCritical: true, ...overrides }),
    );
  const subjectsTo = (mail: MemoryMailTransport, email: string) =>
    mail.to(email).map((message) => message.subject);

  it('tratado em massa antes de o aviso sair: nenhum e-mail; desfeito, avisa, porque ninguém tinha recebido', async () => {
    const made = await setting();
    const { tenantId, admin, person, mail, alert, step, deliver, later, clock } = made;
    await alert('100305', 'critical', 3);
    await step();
    const operation = await resolveCase(made, 3);
    clock.now = new Date();
    expect(await deliver(mail)).toMatchObject({ skipped: 1, sent: 0 });
    expect(mail.messages).toEqual([]);
    later(1);
    await undo(app, admin, operation.id);
    expect(await deliver(mail)).toMatchObject({ cases: { opened: 1 }, sent: 1 });
    expect(subjectsTo(mail, person.email)).toEqual(['Caso de severidade crítica no Verax Control']);
    expect(await noticesOf(prisma, tenantId)).toHaveLength(2);
  });

  it('já avisado: tratar em massa e desfazer não avisa de novo; nem duas vezes, nem com alerta a mais no meio', async () => {
    const made = await setting();
    const { tenantId, admin, person, mail, alert, assign, deliver, later, clock } = made;
    await alert('100305', 'critical', 3);
    await assign();
    await deliver(mail);
    expect(subjectsTo(mail, person.email)).toHaveLength(1);
    const first = await resolveCase(made, 3);
    clock.now = new Date();
    await deliver(mail);
    await undo(app, admin, first.id);
    later(1);
    expect(await deliver(mail)).toMatchObject({ cases: { opened: 0, marked: 0 }, sent: 0 });
    // Um alerta a mais no caso avisado, tudo tratado e desfeito outra vez.
    await alert();
    await assign();
    await deliver(mail);
    const second = await resolveCase(made, 4);
    await undo(app, admin, second.id);
    later(1);
    expect(await deliver(mail)).toMatchObject({ cases: { opened: 0 }, sent: 0 });
    expect(subjectsTo(mail, person.email)).toHaveLength(1);
    expect(await noticesOf(prisma, tenantId)).toHaveLength(1);
  });

  it('o caso tratado e selado pelo alerta seguinte: o novo avisa; desfeita a operação, o antigo não', async () => {
    const made = await setting();
    const { tenantId, admin, person, mail, alert, assign, deliver, clock, later } = made;
    await alert('100305', 'critical', 2);
    await assign();
    await deliver(mail);
    const operation = await resolveCase(made, 2);
    clock.now = new Date();
    await alert();
    await assign();
    await deliver(mail);
    expect(await casesOf(prisma, tenantId)).toHaveLength(2);
    expect(subjectsTo(mail, person.email)).toHaveLength(2);
    await undo(app, admin, operation.id);
    later(1);
    expect(await deliver(mail)).toMatchObject({ cases: { opened: 0, marked: 0 }, sent: 0 });
    expect(subjectsTo(mail, person.email)).toHaveLength(2);
  });

  it('promovido antes de o aviso sair: só o do incidente; desfeito o promover, o caso não avisa', async () => {
    const made = await setting();
    const { tenantId, admin, person, mail, alert, step, deliver, later, clock } = made;
    await alert('100305', 'critical', 3);
    await step();
    const promoted = await operate(app, admin, {
      requestId: randomUUID(),
      action: 'promote',
      target: { caseIds: [await caseId(tenantId)] },
      expectedCount: 3,
      includeCritical: true,
    });
    clock.now = new Date(Date.now() + MINUTE_MS);
    expect(await deliver(mail)).toMatchObject({ skipped: 1, sent: 1 });
    expect(subjectsTo(mail, person.email)).toEqual([
      'Incidente de severidade crítica confirmado no Verax Control',
    ]);
    await undo(app, admin, promoted.id);
    later(1);
    expect(await deliver(mail)).toMatchObject({ cases: { opened: 0 }, sent: 0 });
    expect(subjectsTo(mail, person.email)).toHaveLength(1);
  });

  it('promovido antes mesmo de o caso ter aviso, e desfeito: o incidente já tinha avisado', async () => {
    const made = await setting();
    const { tenantId, admin, person, mail, alert, assign, deliver, later, clock } = made;
    await alert('100305', 'critical', 3);
    await assign();
    const promoted = await operate(app, admin, {
      requestId: randomUUID(),
      action: 'promote',
      target: { caseIds: [await caseId(tenantId)] },
      expectedCount: 3,
      includeCritical: true,
    });
    clock.now = new Date(Date.now() + MINUTE_MS);
    await deliver(mail);
    await undo(app, admin, promoted.id);
    later(1);
    await deliver(mail);
    // O alerta que abriu o incidente fica nele; os outros voltam ao caso, sem outro e-mail.
    expect(subjectsTo(mail, person.email)).toEqual([
      'Incidente de severidade crítica confirmado no Verax Control',
    ]);
    expect(await prisma.finding.count({ where: { tenantId, incidentId: null, status: 'new' } })).toBe(2);
  });

  it('a divisão de um caso avisado não avisa, em nenhum dos dois; a de um que ainda não saiu, sai uma vez por caso', async () => {
    const made = await setting();
    const { tenantId, admin, person, mail, alert, assign, step, deliver, later } = made;
    const ids = await alert('100305', 'critical', 4);
    await assign();
    await deliver(mail);
    const original = await caseId(tenantId);
    const response = await post(app, admin, `/v1/cases/${original}/split`, { findingIds: ids.slice(0, 2) });
    expect(response.status).toBe(201);
    later(1);
    expect(await deliver(mail)).toMatchObject({ cases: { opened: 0, marked: 0 }, sent: 0 });
    expect(subjectsTo(mail, person.email)).toHaveLength(1);
    // Dividir o dividido também não.
    const part = (response.body as { caseId: string }).caseId;
    const again = await post(app, admin, `/v1/cases/${part}/split`, { findingIds: ids.slice(0, 1) });
    expect(again.status).toBe(201);
    later(1);
    expect(await deliver(mail)).toMatchObject({ cases: { opened: 0, marked: 0 }, sent: 0 });

    // Com o aviso ainda na fila: o original sai, e o dividido herda o aviso.
    const pending = await alert('100306', 'critical', 4);
    await step();
    const second = await caseId(tenantId, '100306');
    expect(
      (await post(app, admin, `/v1/cases/${second}/split`, { findingIds: pending.slice(0, 2) })).status,
    ).toBe(201);
    later(1);
    expect(await deliver(mail)).toMatchObject({ cases: { opened: 0 }, sent: 1 });
    expect(subjectsTo(mail, person.email)).toHaveLength(2);
  });

  it('dividido com o aviso na fila, e o original ficou sem crítico: o aviso dele não sai, e o do dividido sai', async () => {
    const made = await setting();
    const { tenantId, admin, person, mail, alert, step, deliver, later } = made;
    const critical = await alert('100305', 'critical');
    await alert('100305', 'high', 2);
    await step();
    const original = await caseId(tenantId);
    const response = await post(app, admin, `/v1/cases/${original}/split`, { findingIds: critical });
    expect(response.status).toBe(201);
    later(1);
    await deliver(mail);
    later(1);
    await deliver(mail);
    const part = (response.body as { caseId: string }).caseId;
    const sent = await noticesOf(prisma, tenantId, { status: 'sent' });
    expect(sent.map((row) => [row.caseId, row.severity]).sort()).toEqual(
      [
        [part, 'critical'],
        [original, 'high'],
      ].sort(),
    );
    expect(subjectsTo(mail, person.email).sort()).toEqual([
      'Caso de severidade alta no Verax Control',
      'Caso de severidade crítica no Verax Control',
    ]);
  });

  it('um alerta posto em análise ou tratado à mão não avisa; o reaberto à mão, já avisado, também não', async () => {
    const made = await setting();
    const { tenantId, admin, person, mail, alert, assign, deliver, clock } = made;
    const [first, second] = (await alert('100305', 'critical', 2)) as [string, string];
    await assign();
    await deliver(mail);
    for (const [id, status] of [
      [first, 'investigating'],
      [second, 'resolved'],
      [second, 'new'],
      [first, 'resolved'],
      [second, 'resolved'],
      [first, 'new'],
    ] as const) {
      const response = await patch(app, admin, `/v1/findings/${id}/status`, { status });
      expect(response.status).toBe(200);
      clock.now = new Date(Math.max(Date.now(), clock.now.getTime() + 1));
      expect(await deliver(mail)).toMatchObject({ cases: { opened: 0, growth: 0 }, sent: 0 });
    }
    expect(subjectsTo(mail, person.email)).toHaveLength(1);
    expect(await noticesOf(prisma, tenantId)).toHaveLength(1);
  });

  it('o expurgo leva os casos e os avisos antigos, e a fila segue: nenhum aviso quebra a entrega', async () => {
    const made = await setting();
    const { tenantId, person, mail, alert, assign, step, deliver, later } = made;
    const old = await alert('100305', 'critical', 2);
    await step();
    const gone = await caseId(tenantId);
    // Um aviso do mesmo caso preso a um alerta que fica: o caso sai, e o aviso não.
    const [kept] = (await alert('100306', 'critical')) as [string];
    await prisma.notification.create({
      data: {
        tenantId,
        kind: 'critical_finding',
        severity: 'critical',
        findingId: kept,
        caseId: gone,
        dedupeKey: `case:${gone}:critical:1`,
        nextAttemptAt: made.clock.now,
      },
    });
    const past = new Date(Date.now() - 500 * DAY_MS);
    await prisma.finding.updateMany({
      where: { id: { in: old } },
      data: { createdAt: past, occurredAt: past, updatedAt: past },
    });
    await prisma.alertCase.updateMany({
      where: { tenantId },
      data: { lastAlertAt: past, openedAt: past, firstSeenAt: past, lastSeenAt: past },
    });
    await new RetentionJob(onlyTenantPhases(prisma), {
      historyDays: 90,
      name: `avisos-${randomBytes(6).toString('hex')}`,
      pauseMs: 0,
      tenantIds: [tenantId],
    }).maybeRun(new Date(new Date().setUTCHours(23, 59, 0, 0)));
    expect(await casesOf(prisma, tenantId)).toEqual([]);
    // O aviso do alerta que saiu foi junto; o outro ficou na fila, sem caso.
    expect((await noticesOf(prisma, tenantId)).map((row) => [row.caseId, row.status])).toEqual([
      [gone, 'pending'],
    ]);
    later(1);
    await assign();
    expect(await deliver(mail)).toMatchObject({ skipped: 1, sent: 1, cases: { opened: 1 } });
    expect((await noticesOf(prisma, tenantId, { caseId: gone }))[0]).toMatchObject({
      status: 'skipped',
      lastError: 'case_gone',
    });
    expect(subjectsTo(mail, person.email)).toEqual(['Caso de severidade crítica no Verax Control']);
  });

  it('isolamento: o desfazer e a divisão de um cliente não fazem o outro avisar', async () => {
    const a = await setting();
    const b = await setting();
    const both = noticeWorld(prisma, [a.tenantId, b.tenantId], a.clock.now, { regime: a.regime });
    for (const made of [a, b]) await made.alert('100305', 'critical', 3);
    both.clock.now = new Date(b.clock.now.getTime() + 1_000);
    await both.assign();
    const mail = new MemoryMailTransport();
    await both.deliver(mail);
    const operation = await resolveCase(a, 3);
    both.clock.now = new Date();
    await undo(app, a.admin, operation.id);
    await post(app, a.admin, `/v1/cases/${await caseId(a.tenantId)}/split`, {
      findingIds: [(await prisma.finding.findFirstOrThrow({ where: { tenantId: a.tenantId } })).id],
    });
    both.clock.now = new Date(Date.now() + MINUTE_MS);
    await both.deliver(mail);
    for (const made of [a, b]) {
      expect(subjectsTo(mail, made.person.email)).toHaveLength(1);
      expect((await noticesOf(prisma, made.tenantId)).map((row) => row.dedupeKey)).toEqual([
        caseNoticeKey(await originalCase(made.tenantId), 'critical'),
      ]);
    }
  });

  const originalCase = async (tenantId: string) =>
    (await prisma.alertCase.findFirstOrThrow({ where: { tenantId, sealReason: null } })).id;
});
