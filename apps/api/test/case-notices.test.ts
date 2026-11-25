import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockTenantFindings } from '../src/alerts/finding-store.js';
import { caseKeyOf } from '../src/cases/case-key.js';
import {
  CASE_GROWTH_MIN_ALERTS,
  CASE_NOTICE_REARM_MS,
  caseGrowthKey,
  caseNoticeKey,
  caseWaveKey,
  criticalCasesKey,
  dailyCasesKey,
} from '../src/cases/case-notice-policy.js';
import { CaseNoticeMail } from '../src/cases/case-notice-mail.js';
import { CaseNotices, type CaseNoticesOptions } from '../src/cases/case-notices.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { FindingSeverity, Prisma } from '../src/generated/prisma/client.js';
import {
  at,
  customer,
  DAY_MS,
  HOUR_MS,
  insertVulnerability,
  keysOf,
  markSent,
  MINUTE_MS,
  noticesOf,
  noticeWorld,
  T0,
} from './support/case-notices.js';
import {
  casesOf,
  findingData,
  insertCase,
  insertFinding,
  insertIncident,
  insertOperation,
} from './support/cases.js';
import { createOwnDatabase, type OwnDatabase } from './support/own-database.js';

/**
 * Os avisos por caso (`CASES_MODE=on`): quando um caso avisa, uma vez só, e o que nunca pode ficar calado. Num banco só
 * deste arquivo, com o relógio do teste. A entrega está em `case-notices-delivery.test.ts`, e a virada, em
 * `case-notices-cutover.test.ts`.
 */
describe('avisos por caso', () => {
  let database: OwnDatabase;
  let prisma: PrismaService;

  beforeAll(async () => {
    database = await createOwnDatabase('avisos_caso');
    prisma = new PrismaService({ DATABASE_URL: database.url });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  /** Um cliente, o worker preso a ele e a virada gravada bem antes (o passado não entra nestes testes). */
  async function world(start = T0, options: Partial<CaseNoticesOptions> = {}) {
    const tenantId = await customer(prisma);
    const made = noticeWorld(prisma, [tenantId], new Date(start.getTime() - 30 * DAY_MS), options);
    await made.activate();
    made.clock.now = start;
    const alert = (overrides: Partial<Prisma.FindingUncheckedCreateInput> = {}) =>
      insertFinding(prisma, tenantId, { createdAt: made.clock.now, ...overrides });
    return { ...made, tenantId, alert };
  }
  const only = <T>(rows: readonly T[]): T => {
    expect(rows).toHaveLength(1);
    return rows[0] as T;
  };
  const onlyCase = async (tenantId: string) => only(await casesOf(prisma, tenantId));
  /** A conferência da entrega, só nos avisos do cliente. */
  const skipStale = async (tenantId: string, when: Date) =>
    new CaseNoticeMail(prisma).skipStale(
      when,
      (await noticesOf(prisma, tenantId)).map((row) => row.id),
    );
  const resolve = (ids: readonly string[], when: Date, status: 'resolved' | 'investigating' = 'resolved') =>
    prisma.finding.updateMany({ where: { id: { in: [...ids] } }, data: { status, triagedAt: when } });

  describe('detecção: um aviso por caso e severidade', () => {
    it('o caso novo com alerta alto avisa uma vez: os tipos do alerta, o caso, a âncora e a chave', async () => {
      const { tenantId, alert, step, check } = await world();
      const anchor = await alert();
      await alert();
      expect(await step()).toMatchObject({ opened: 1, growth: 0, critical: 0, marked: 0, lagging: 0 });
      const row = await onlyCase(tenantId);
      expect(row.noticedSeverity).toBe('high');
      const notice = only(await noticesOf(prisma, tenantId));
      expect(notice).toMatchObject({
        kind: 'high_finding',
        severity: 'high',
        dedupeKey: caseNoticeKey(row.id, 'high'),
        caseId: row.id,
        findingId: anchor,
        incidentId: null,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: T0,
        createdAt: T0,
      });
      expect(await check()).toMatchObject({ opened: 0, marked: 0 });
      expect(await keysOf(prisma, tenantId)).toHaveLength(1);
    });

    it('mais alertas num caso avisado e pendente não avisam; a severidade que sobe avisa de novo, uma vez', async () => {
      const { tenantId, alert, step, clock } = await world();
      await alert();
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(HOUR_MS);
      for (let i = 0; i < 5; i += 1) await alert();
      expect(await step()).toMatchObject({ opened: 0 });
      clock.now = at(2 * HOUR_MS);
      const critical = await alert({ severity: 'critical' });
      await alert({ severity: 'critical' });
      expect(await step()).toMatchObject({ opened: 1 });
      const row = await onlyCase(tenantId);
      expect(row.noticedSeverity).toBe('critical');
      const notices = await noticesOf(prisma, tenantId);
      expect(notices.map((notice) => [notice.kind, notice.dedupeKey, notice.status])).toEqual([
        ['high_finding', caseNoticeKey(row.id, 'high'), 'sent'],
        ['critical_finding', caseNoticeKey(row.id, 'critical'), 'pending'],
      ]);
      // A âncora continua a ser o alerta que abriu o caso.
      expect(notices[1]?.findingId).toBe(row.anchorFindingId);
      expect(notices[1]?.findingId).not.toBe(critical);
      clock.now = at(3 * HOUR_MS);
      await alert();
      expect(await step()).toMatchObject({ opened: 0 });
    });

    it('o caso que já nasce crítico avisa só o crítico; médio e baixo nunca avisam', async () => {
      const { tenantId, alert, step } = await world();
      await alert({ severity: 'medium', ruleId: '100306' });
      await alert({ severity: 'low', ruleId: '100307' });
      expect(await step()).toMatchObject({ opened: 0, marked: 0 });
      expect(await noticesOf(prisma, tenantId)).toEqual([]);
      await alert();
      await alert({ severity: 'critical' });
      await step();
      const notice = only(await noticesOf(prisma, tenantId));
      expect(notice).toMatchObject({ kind: 'critical_finding', severity: 'critical' });
    });

    it('o aviso alto ainda na fila, intacto, não sai junto com o crítico; o que já começou a sair fica', async () => {
      const { tenantId, alert, step, clock } = await world();
      await alert({ ruleId: '100305' });
      await alert({ ruleId: '100306' });
      await step();
      const [first, second] = await casesOf(prisma, tenantId);
      await prisma.notification.updateMany({
        where: { caseId: second?.id ?? '' },
        data: { attempts: 1, lastError: 'SmtpError' },
      });
      clock.now = at(MINUTE_MS);
      await alert({ ruleId: '100305', severity: 'critical' });
      await alert({ ruleId: '100306', severity: 'critical' });
      expect(await step()).toMatchObject({ opened: 2 });
      const state = async (caseId: string | undefined) =>
        (await noticesOf(prisma, tenantId, { caseId: caseId ?? '' })).map((row) => [
          row.severity,
          row.status,
          row.lastError,
        ]);
      expect(await state(first?.id)).toEqual([
        ['high', 'skipped', 'superseded_by_case'],
        ['critical', 'pending', null],
      ]);
      expect(await state(second?.id)).toEqual([
        ['high', 'pending', 'SmtpError'],
        ['critical', 'pending', null],
      ]);
    });

    it('a severidade que sobe na origem (revise) avisa pelo caso, sem alerta novo', async () => {
      const { tenantId, alert, step, check, clock } = await world();
      const id = await alert();
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(HOUR_MS);
      await prisma.finding.update({ where: { id }, data: { severity: 'critical' } });
      expect(await check()).toMatchObject({ opened: 1 });
      const row = await onlyCase(tenantId);
      expect(await keysOf(prisma, tenantId)).toEqual([
        caseNoticeKey(row.id, 'high'),
        caseNoticeKey(row.id, 'critical'),
      ]);
      // E de médio para alto, num caso que nunca avisou.
      const medium = await alert({ severity: 'medium', ruleId: '100399' });
      await step();
      await prisma.finding.update({ where: { id: medium }, data: { severity: 'high' } });
      expect(await check()).toMatchObject({ opened: 1 });
    });

    it('o alerta em análise é pendente: o caso avisa; o esperado por exceção e o de incidente, não', async () => {
      const { tenantId, alert, step } = await world();
      const incidentId = await insertIncident(prisma, tenantId);
      await alert({ status: 'legitimate', ruleId: '100306' });
      await alert({ incidentId, ruleId: '100307' });
      await alert({ status: 'investigating' });
      expect(await step()).toMatchObject({ opened: 1 });
      expect(only(await noticesOf(prisma, tenantId)).caseId).toBe((await onlyCase(tenantId)).id);
    });

    it('a âncora que saiu (retenção ou divisão) dá lugar ao pior alerta pendente mais antigo', async () => {
      const { tenantId, alert, assign, check, clock } = await world();
      const anchor = await alert();
      await alert({ severity: 'medium' });
      const oldest = await alert({ createdAt: at(MINUTE_MS) });
      await alert({ createdAt: at(2 * MINUTE_MS) });
      clock.now = at(5 * MINUTE_MS);
      await assign();
      await prisma.finding.delete({ where: { id: anchor } });
      expect(await check()).toMatchObject({ opened: 1 });
      expect(only(await noticesOf(prisma, tenantId)).findingId).toBe(oldest);
    });

    it('a fila é lida em trechos, e todos os casos avisam', async () => {
      const tenantId = await customer(prisma);
      const made = noticeWorld(prisma, [tenantId], at(-30 * DAY_MS), { page: 3 });
      await made.activate();
      made.clock.now = T0;
      for (let i = 0; i < 10; i += 1)
        await insertFinding(prisma, tenantId, { createdAt: T0, ruleId: `1003${10 + i}` });
      expect(await made.step()).toMatchObject({ opened: 10, unfinishedTenants: 0 });
      expect(await made.check()).toMatchObject({ opened: 0 });
      expect(await keysOf(prisma, tenantId)).toHaveLength(10);
    });
  });

  describe('a onda seguinte, a reincidência e o que reabre', () => {
    it('tratado inteiro, o alerta seguinte abre outro caso, que avisa', async () => {
      const { tenantId, alert, step, clock } = await world();
      const id = await alert();
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(HOUR_MS);
      await resolve([id], clock.now);
      await alert();
      expect(await step()).toMatchObject({ opened: 1 });
      const [first, second] = await casesOf(prisma, tenantId);
      expect(second).toMatchObject({ previousCaseId: first?.id, recurrence: 1 });
      expect(await keysOf(prisma, tenantId)).toEqual([
        caseNoticeKey(first?.id ?? '', 'high'),
        caseNoticeKey(second?.id ?? '', 'high'),
      ]);
    });

    it('a janela passou: o caso seguinte da chave avisa, e o selado, pendente, não repete', async () => {
      const { tenantId, alert, step, clock } = await world();
      await alert();
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(2 * DAY_MS);
      await alert();
      expect(await step()).toMatchObject({ opened: 1 });
      expect(await keysOf(prisma, tenantId)).toHaveLength(2);
      expect(await step()).toMatchObject({ opened: 0 });
    });

    it('os críticos avisados foram tratados, o caso segue aberto pelos altos, e chega outro crítico: avisa de novo', async () => {
      const { tenantId, alert, step, clock } = await world();
      const critical = await alert({ severity: 'critical' });
      const high = await alert();
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(HOUR_MS);
      await resolve([critical], clock.now);
      expect(await step()).toMatchObject({ opened: 0 });
      clock.now = at(2 * HOUR_MS);
      await alert({ severity: 'critical' });
      expect(await step()).toMatchObject({ opened: 1 });
      const row = await onlyCase(tenantId);
      expect(await keysOf(prisma, tenantId)).toEqual([
        caseNoticeKey(row.id, 'critical'),
        caseWaveKey(row.id, 'critical', at(2 * HOUR_MS)),
      ]);
      // Com o crítico da onda pendente, mais um não avisa.
      clock.now = at(3 * HOUR_MS);
      await alert({ severity: 'critical' });
      expect(await step()).toMatchObject({ opened: 0 });
      // E tratados os críticos, os altos que já estavam lá não avisam.
      await prisma.finding.updateMany({
        where: { tenantId, severity: 'critical' },
        data: { status: 'resolved' },
      });
      expect(await step()).toMatchObject({ opened: 0 });
      await resolve([high], clock.now);
      clock.now = at(4 * HOUR_MS);
      await alert();
      // O caso sem pendência foi selado: o alto abre outro.
      expect(await step()).toMatchObject({ opened: 1 });
      expect(await casesOf(prisma, tenantId)).toHaveLength(2);
    });

    it('a onda passageira entre duas execuções também se vê: o tratado e o novo no mesmo intervalo', async () => {
      const { tenantId, alert, step, clock } = await world();
      const critical = await alert({ severity: 'critical' });
      await alert();
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(MINUTE_MS);
      await resolve([critical], at(10_000));
      await alert({ severity: 'critical', createdAt: at(20_000) });
      expect(await step()).toMatchObject({ opened: 1 });
      expect(await keysOf(prisma, tenantId)).toHaveLength(2);
    });

    it('o mesmo alerta que volta a pendente (reaberto à mão) não avisa de novo', async () => {
      const { tenantId, alert, step, check, clock } = await world();
      const id = await alert({ severity: 'critical' });
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(HOUR_MS);
      await resolve([id], clock.now);
      await check();
      clock.now = at(2 * HOUR_MS);
      await prisma.finding.update({ where: { id }, data: { status: 'new' } });
      expect(await check()).toMatchObject({ opened: 0 });
      expect(await keysOf(prisma, tenantId)).toHaveLength(1);
    });

    it('o aviso que ninguém recebeu porque o caso foi tratado antes não vale: o caso que volta avisa', async () => {
      const { tenantId, alert, step, check, clock } = await world();
      const id = await alert({ severity: 'critical' });
      await step();
      await resolve([id], clock.now);
      expect(await skipStale(tenantId, clock.now)).toEqual({ sent: 0, skipped: 1 });
      expect(only(await noticesOf(prisma, tenantId))).toMatchObject({
        status: 'skipped',
        lastError: 'case_treated',
      });
      expect(await check()).toMatchObject({ opened: 0 });
      clock.now = at(HOUR_MS);
      await prisma.finding.update({ where: { id }, data: { status: 'new' } });
      expect(await check()).toMatchObject({ opened: 1 });
      const row = await onlyCase(tenantId);
      expect(await keysOf(prisma, tenantId)).toEqual([
        caseNoticeKey(row.id, 'critical'),
        caseWaveKey(row.id, 'critical', at(HOUR_MS)),
      ]);
      // E de novo, tantas vezes quantas ninguém receber.
      await resolve([id], clock.now);
      await skipStale(tenantId, clock.now);
      clock.now = at(2 * HOUR_MS);
      await prisma.finding.update({ where: { id }, data: { status: 'new' } });
      expect(await check()).toMatchObject({ opened: 1 });
    });

    it('o crítico deixou de valer antes de sair: os altos que ele cobria avisam', async () => {
      const { tenantId, alert, step, check, clock } = await world();
      await alert();
      await step();
      clock.now = at(MINUTE_MS);
      const critical = await alert({ severity: 'critical' });
      await step();
      await resolve([critical], clock.now);
      expect(await skipStale(tenantId, clock.now)).toEqual({ sent: 0, skipped: 1 });
      clock.now = at(2 * MINUTE_MS);
      expect(await check()).toMatchObject({ opened: 1 });
      expect((await noticesOf(prisma, tenantId)).map((row) => [row.severity, row.status])).toEqual([
        ['high', 'skipped'],
        ['critical', 'skipped'],
        ['high', 'pending'],
      ]);
      // A severidade avisada só sobe.
      expect((await onlyCase(tenantId)).noticedSeverity).toBe('critical');
    });

    it('o aviso que falhou em todas as tentativas é refeito depois de um tempo, se o caso continua pendente', async () => {
      const { tenantId, alert, step, check, clock } = await world();
      await alert({ severity: 'critical' });
      await step();
      const fail = () =>
        prisma.$executeRaw`UPDATE "Notification" SET "status" = 'failed', "attempts" = 5, "lastError" = 'SmtpError',
          "updatedAt" = ${clock.now.toISOString()}::timestamptz WHERE "tenantId" = ${tenantId}::uuid`;
      await fail();
      clock.now = at(CASE_NOTICE_REARM_MS);
      expect(await check()).toMatchObject({ opened: 0 });
      clock.now = at(CASE_NOTICE_REARM_MS + 1);
      expect(await check()).toMatchObject({ opened: 1 });
      expect(await keysOf(prisma, tenantId)).toHaveLength(2);
      expect(await check()).toMatchObject({ opened: 0 });
    });

    it('o aviso antigo que saiu na retenção não faz o caso avisar de novo', async () => {
      const { tenantId, alert, step, check, clock } = await world();
      await alert({ severity: 'critical' });
      await step();
      clock.now = at(91 * DAY_MS);
      await prisma.notification.deleteMany({ where: { tenantId } });
      expect(await check()).toMatchObject({ opened: 0, marked: 0 });
      expect(await noticesOf(prisma, tenantId)).toEqual([]);
    });

    it('a âncora que saiu na retenção leva o aviso, e o caso de semanas atrás não avisa de novo', async () => {
      const { tenantId, alert, step, check, clock } = await world();
      const anchor = await alert({ severity: 'critical' });
      clock.now = at(6 * HOUR_MS);
      await alert({ severity: 'critical' });
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(31 * DAY_MS);
      await prisma.finding.delete({ where: { id: anchor } });
      expect(await noticesOf(prisma, tenantId)).toEqual([]);
      expect(await check()).toMatchObject({ opened: 0, marked: 0 });
    });

    it('o caso apontado para um incidente: o aviso do incidente vale pelos alertas de até ele; os seguintes são onda', async () => {
      const { tenantId, alert, assign, step, check, clock } = await world();
      await alert({ severity: 'critical' });
      // Promovido antes de avisar: a operação ainda está pondo os alertas no incidente.
      await assign();
      const row = await onlyCase(tenantId);
      const incidentId = await insertIncident(prisma, tenantId, { createdAt: at(MINUTE_MS) });
      await prisma.alertCase.update({ where: { id: row.id }, data: { incidentId } });
      clock.now = at(2 * MINUTE_MS);
      expect(await check()).toMatchObject({ opened: 0, marked: 1 });
      await prisma.finding.updateMany({ where: { tenantId }, data: { incidentId } });
      clock.now = at(HOUR_MS);
      await alert({ severity: 'critical' });
      expect(await step()).toMatchObject({ opened: 1 });
      expect(only(await noticesOf(prisma, tenantId)).dedupeKey).toBe(caseNoticeKey(row.id, 'critical'));
    });

    it('o alerta que voltou de um incidente por um desfazer não avisa: o incidente já tinha avisado', async () => {
      const { tenantId, alert, check, clock } = await world();
      const id = await alert({ severity: 'critical' });
      const promote = await insertOperation(prisma, tenantId, {
        action: 'promote',
        status: null,
        state: 'undone',
      });
      const undo = await insertOperation(prisma, tenantId, {
        action: 'undo',
        status: null,
        undoOfId: promote,
      });
      const made = noticeWorld(prisma, [tenantId], clock.now);
      await made.assign();
      await prisma.finding.update({ where: { id }, data: { triageOpId: undo } });
      expect(await check()).toMatchObject({ opened: 0, marked: 1 });
      // Desfeita uma mudança de status, o alerta nunca avisado avisa.
      const other = await alert({ severity: 'critical', ruleId: '100306' });
      const status = await insertOperation(prisma, tenantId, { state: 'undone' });
      const undone = await insertOperation(prisma, tenantId, {
        action: 'undo',
        status: null,
        undoOfId: status,
      });
      await made.assign();
      await prisma.finding.update({ where: { id: other }, data: { triageOpId: undone } });
      expect(await check()).toMatchObject({ opened: 1 });
    });
  });

  describe('os avisos que contam para um caso', () => {
    /** Dois casos gravados direto: o original, com um aviso, e o outro, que aponta para ele. */
    async function pair(overrides: Partial<Prisma.AlertCaseUncheckedCreateInput>) {
      const made = await world();
      const { tenantId } = made;
      const original = await insertCase(prisma, tenantId, { noticedSeverity: 'high', lastAlertAt: T0 });
      const first = await insertFinding(prisma, tenantId, { createdAt: T0, caseId: original });
      await prisma.notification.create({
        data: {
          tenantId,
          kind: 'high_finding',
          severity: 'high',
          findingId: first,
          caseId: original,
          dedupeKey: caseNoticeKey(original, 'high'),
          status: 'sent',
          createdAt: at(10 * MINUTE_MS),
        },
      });
      const other = await insertCase(prisma, tenantId, {
        previousCaseId: original,
        lastAlertAt: T0,
        ...overrides,
      });
      await insertFinding(prisma, tenantId, { createdAt: T0, caseId: other });
      made.clock.now = at(HOUR_MS);
      return { ...made, other };
    }

    it('o dividido herda os do original até a divisão, e não os de depois', async () => {
      const inherits = await pair({
        sealedAt: at(20 * MINUTE_MS),
        sealReason: 'split',
        noticedSeverity: 'high',
      });
      expect(await inherits.check()).toMatchObject({ opened: 0, marked: 0 });
      const before = await pair({
        sealedAt: at(5 * MINUTE_MS),
        sealReason: 'split',
        noticedSeverity: 'high',
      });
      expect(await before.check()).toMatchObject({ opened: 1 });
      expect((await keysOf(prisma, before.tenantId)).at(-1)).toBe(caseNoticeKey(before.other, 'high'));
    });

    it('o caso seguinte da chave não herda os do anterior', async () => {
      const recurring = await pair({ noticedSeverity: 'high' });
      expect(await recurring.check()).toMatchObject({ opened: 1 });
    });

    it('a âncora que está noutro caso não é o alerta do aviso', async () => {
      const { tenantId, check } = await world();
      const elsewhere = await insertFinding(prisma, tenantId, { createdAt: T0, status: 'resolved' });
      const caseId = await insertCase(prisma, tenantId, { anchorFindingId: elsewhere, lastAlertAt: T0 });
      const own = await insertFinding(prisma, tenantId, { createdAt: T0, caseId });
      expect(await check()).toMatchObject({ opened: 1 });
      expect(only(await noticesOf(prisma, tenantId)).findingId).toBe(own);
    });
  });

  describe('o caso que cresceu: no máximo um aviso por dia', () => {
    const many = async (
      tenantId: string,
      count: number,
      createdAt: Date,
      severity: FindingSeverity = 'high',
    ) => {
      await prisma.finding.createMany({
        data: Array.from({ length: count }, () => findingData(tenantId, { createdAt, severity })),
      });
    };

    it('dez vezes mais alertas em uma hora, a partir de 100; e não de novo no mesmo dia', async () => {
      const { tenantId, step, check, clock } = await world();
      await many(tenantId, 10, T0);
      await step();
      const row = await onlyCase(tenantId);
      await markSent(prisma, tenantId, clock.now);
      // Nove vezes mais, em uma hora e um minuto, não.
      clock.now = at(HOUR_MS + MINUTE_MS);
      await many(tenantId, CASE_GROWTH_MIN_ALERTS - 11, clock.now);
      expect(await step()).toMatchObject({ growth: 0 });
      await many(tenantId, 1, clock.now);
      expect(await step()).toMatchObject({ growth: 1, opened: 0 });
      const growth = only(await noticesOf(prisma, tenantId, { status: 'pending' }));
      expect(growth).toMatchObject({
        kind: 'high_finding',
        severity: 'high',
        caseId: row.id,
        findingId: row.anchorFindingId,
        dedupeKey: caseGrowthKey(row.id, clock.now),
      });
      expect(growth.dedupeKey).toBe(`case:${row.id}:growth:2026-12-02`);
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(5 * HOUR_MS);
      await many(tenantId, 1_000, clock.now);
      expect(await step()).toMatchObject({ growth: 0 });
      // Um dia depois do último, o caso que cresceu de novo avisa.
      clock.now = at(HOUR_MS + MINUTE_MS + DAY_MS);
      await prisma.finding.updateMany({
        where: { tenantId, createdAt: at(5 * HOUR_MS) },
        data: { createdAt: clock.now },
      });
      await prisma.alertCase.updateMany({ where: { tenantId }, data: { lastAlertAt: clock.now } });
      expect(await check()).toMatchObject({ growth: 1 });
      expect(await check()).toMatchObject({ growth: 0 });
    }, 60_000);

    it('o que já estava no caso quando o aviso saiu não é crescimento', async () => {
      const { tenantId, step, check, clock } = await world();
      await many(tenantId, 500, T0);
      expect(await step()).toMatchObject({ opened: 1, growth: 0 });
      clock.now = at(MINUTE_MS);
      await many(tenantId, 50, clock.now);
      expect(await step()).toMatchObject({ growth: 0 });
      expect(await check()).toMatchObject({ growth: 0 });
    });

    it('devagar, ao longo do dia, dez vezes mais não avisa: conta a última hora', async () => {
      const { tenantId, step, check, clock } = await world();
      await many(tenantId, 10, T0);
      await step();
      await markSent(prisma, tenantId, clock.now);
      for (const hours of [2, 4, 6, 8]) {
        clock.now = at(hours * HOUR_MS);
        await many(tenantId, 30, clock.now);
        expect([hours, (await step()).growth]).toEqual([hours, 0]);
      }
      expect(await check()).toMatchObject({ growth: 0 });
    });

    it('abaixo de 100 alertas, dez vezes mais não avisa', async () => {
      const { tenantId, step, clock } = await world();
      await many(tenantId, 1, T0);
      await step();
      clock.now = at(10 * MINUTE_MS);
      await many(tenantId, CASE_GROWTH_MIN_ALERTS - 2, clock.now);
      expect(await step()).toMatchObject({ growth: 0 });
    });

    it('uma tática que o caso não tinha avisa; a mesma, ou a de um alerta já tratado, não', async () => {
      const { tenantId, alert, assign, step, clock } = await world();
      await alert({ mitreTactics: ['Persistence'] });
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(HOUR_MS);
      await alert({ mitreTactics: ['Persistence'] });
      const treated = await alert({ mitreTactics: ['Impact'] });
      await assign();
      await resolve([treated], clock.now);
      expect(await step()).toMatchObject({ growth: 0 });
      await alert({ mitreTactics: ['Persistence', 'Exfiltration'] });
      expect(await step()).toMatchObject({ growth: 1 });
      expect((await keysOf(prisma, tenantId)).filter((key) => key.includes(':growth:'))).toHaveLength(1);
      clock.now = at(2 * HOUR_MS);
      await alert({ mitreTactics: ['Collection'] });
      expect(await step()).toMatchObject({ growth: 0 });
    });

    it('um crítico novo num caso em análise avisa; antes da análise, ou sem ela, não', async () => {
      const { tenantId, alert, step, clock } = await world();
      const first = await alert({ severity: 'critical' });
      await step();
      await markSent(prisma, tenantId, clock.now);
      clock.now = at(HOUR_MS);
      await alert({ severity: 'critical' });
      expect(await step()).toMatchObject({ growth: 0, opened: 0 });
      clock.now = at(90 * MINUTE_MS);
      await resolve([first], clock.now, 'investigating');
      // O crítico da hora 1 chegou antes de a análise começar.
      expect(await step()).toMatchObject({ growth: 0, opened: 0 });
      clock.now = at(2 * HOUR_MS);
      await alert();
      expect(await step()).toMatchObject({ growth: 0 });
      await alert({ severity: 'critical' });
      expect(await step()).toMatchObject({ growth: 1, opened: 0 });
      const growth = only(await noticesOf(prisma, tenantId, { status: 'pending' }));
      expect(growth).toMatchObject({ kind: 'critical_finding', severity: 'critical' });
    });

    it('não vale para vulnerabilidade, nem para o caso ainda não avisado', async () => {
      const { tenantId, check, clock } = await world();
      const resource = 'arn:aws:ec2:sa-east-1:111122223333:instance/i-0000000000000000a';
      for (let i = 0; i < 2; i += 1)
        await insertVulnerability(prisma, tenantId, { resource, severity: 'high', createdAt: T0 });
      const made = noticeWorld(prisma, [tenantId], clock.now);
      await made.assign();
      await prisma.alertCase.updateMany({ where: { tenantId }, data: { noticedSeverity: 'high' } });
      clock.now = at(MINUTE_MS);
      await insertVulnerability(prisma, tenantId, {
        resource,
        severity: 'high',
        createdAt: clock.now,
        mitreTactics: ['Impact'],
      });
      await made.assign();
      expect(await check()).toMatchObject({ growth: 0, opened: 0 });
    });
  });

  describe('vulnerabilidade e postura', () => {
    it('os casos com crítico novo vão num aviso só, e no máximo um por hora; os altos, nenhum', async () => {
      const { tenantId, step, clock } = await world();
      for (let i = 0; i < 4; i += 1) await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      await insertVulnerability(prisma, tenantId, { createdAt: T0, severity: 'high' });
      expect(await step()).toMatchObject({ critical: 1, opened: 0, marked: 0 });
      const first = only(await noticesOf(prisma, tenantId));
      expect(first).toMatchObject({
        kind: 'critical_finding',
        severity: 'critical',
        caseId: null,
        dedupeKey: criticalCasesKey(T0),
        status: 'pending',
        nextAttemptAt: T0,
      });
      const noticed = async () =>
        (await casesOf(prisma, tenantId)).filter((row) => row.noticedSeverity === 'critical').length;
      expect(await noticed()).toBe(4);

      // Outros críticos esperam o intervalo (59 min depois, e já noutra hora cheia) e vão todos juntos.
      clock.now = at(30 * MINUTE_MS);
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now });
      expect(await step()).toMatchObject({ critical: 0 });
      clock.now = at(59 * MINUTE_MS + 59_999);
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now });
      expect(await step()).toMatchObject({ critical: 0 });
      expect(await noticed()).toBe(4);
      clock.now = at(HOUR_MS);
      expect(await step()).toMatchObject({ critical: 1 });
      expect(await noticed()).toBe(6);
      expect(await keysOf(prisma, tenantId)).toEqual([criticalCasesKey(T0), criticalCasesKey(at(HOUR_MS))]);
    });

    it('o intervalo é de uma hora corrida: a virada da hora cheia não o encurta', async () => {
      const { tenantId, step, clock } = await world(at(40 * MINUTE_MS));
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now });
      expect(await step()).toMatchObject({ critical: 1 });
      clock.now = at(70 * MINUTE_MS);
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now });
      expect(await step()).toMatchObject({ critical: 0 });
      clock.now = at(100 * MINUTE_MS);
      expect(await step()).toMatchObject({ critical: 1 });
    });

    it('um crítico a mais num caso já avisado, ou um alto, não avisa; o caso que voltou depois de tratado avisa', async () => {
      const { tenantId, step, clock } = await world();
      const resource = 'arn:aws:ec2:sa-east-1:111122223333:instance/i-0000000000000000b';
      const id = await insertVulnerability(prisma, tenantId, { createdAt: T0, resource });
      await step();
      clock.now = at(2 * HOUR_MS);
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now, resource });
      expect(await step()).toMatchObject({ critical: 0 });
      await prisma.finding.updateMany({ where: { tenantId }, data: { status: 'resolved' } });
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now, resource });
      expect(await step()).toMatchObject({ critical: 1 });
      expect(await casesOf(prisma, tenantId)).toHaveLength(2);
      expect(id).not.toBe('');
    });

    it('a postura também: o controle crítico reprovado', async () => {
      const { tenantId, step } = await world();
      await insertFinding(prisma, tenantId, {
        createdAt: T0,
        logSource: 'security_hub',
        ruleId: '990501',
        eventName: 'S3.1',
        severity: 'critical',
        actorUser: null,
        resource: 'arn:aws:s3:::bucket-demo',
      });
      expect(await step()).toMatchObject({ critical: 1, opened: 0 });
      expect((await onlyCase(tenantId)).queue).toBe('posture');
    });

    it('o aviso que ninguém recebeu (tratado antes) não segura o seguinte', async () => {
      const { tenantId, step, clock } = await world(at(40 * MINUTE_MS));
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now });
      await step();
      await prisma.notification.updateMany({
        where: { tenantId },
        data: { status: 'skipped', lastError: 'case_treated' },
      });
      clock.now = at(50 * MINUTE_MS);
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now });
      // Na mesma hora cheia, a chave já existe: espera a seguinte, que não espera o intervalo.
      expect(await step()).toMatchObject({ critical: 0 });
      clock.now = at(HOUR_MS + MINUTE_MS);
      expect(await step()).toMatchObject({ critical: 1 });
      expect(await noticesOf(prisma, tenantId)).toHaveLength(2);
    });
  });

  describe('o resumo diário, às 09:00 de Brasília', () => {
    /** 2 de dezembro de 2026, 09:00 de Brasília. */
    const NINE = new Date('2026-12-02T12:00:00.000Z');
    const daily = async (tenantId: string) =>
      (await noticesOf(prisma, tenantId)).filter((row) => row.dedupeKey.startsWith('cases-daily:'));

    it('um por cliente e dia, a partir das 09:00; nada antes, e nada sem caso alto ou crítico pendente', async () => {
      const { tenantId, step, check, clock } = await world(new Date(NINE.getTime() - DAY_MS + HOUR_MS));
      await insertVulnerability(prisma, tenantId, { severity: 'high', createdAt: clock.now });
      await insertVulnerability(prisma, tenantId, { severity: 'medium', createdAt: clock.now });
      const worst = await insertVulnerability(prisma, tenantId, { createdAt: clock.now });
      await step();
      // O do dia em que o alerta chegou (depois das 09:00) não sai por causa dele.
      expect(await daily(tenantId)).toEqual([]);
      clock.now = new Date(NINE.getTime() - 1);
      expect(await check()).toMatchObject({ daily: 0 });
      clock.now = NINE;
      expect(await check()).toMatchObject({ daily: 1 });
      const row = only(await daily(tenantId));
      expect(row).toMatchObject({
        kind: 'high_finding',
        severity: 'high',
        caseId: null,
        dedupeKey: 'cases-daily:2026-12-02',
        findingId: worst,
        nextAttemptAt: NINE,
        createdAt: NINE,
      });
      for (const hours of [1, 8, 14]) {
        clock.now = new Date(NINE.getTime() + hours * HOUR_MS);
        expect(await check()).toMatchObject({ daily: 0 });
      }
      // 23:59 de Brasília ainda é o mesmo dia; 00:00, o seguinte, que só sai às 09:00.
      clock.now = new Date('2026-12-03T02:59:59.999Z');
      expect(await check()).toMatchObject({ daily: 0 });
      clock.now = new Date('2026-12-03T03:00:00.000Z');
      expect(await check()).toMatchObject({ daily: 0 });
    });

    it('sem novidade desde o último enviado, não sai; com alerta novo, sai; e depois de uma semana, lembra', async () => {
      const { tenantId, clock, assign } = await world(new Date(NINE.getTime() - HOUR_MS));
      // Cada dia, um worker que acabou de começar: a memória do processo não decide.
      const run = async (days: number) => {
        clock.now = new Date(NINE.getTime() + days * DAY_MS);
        const made = noticeWorld(prisma, [tenantId], clock.now);
        await prisma.syncState.update({
          where: { name: await nameOf(made) },
          data: { cursorTimestamp: at(-30 * DAY_MS) },
        });
        const report = await made.check();
        await markSent(prisma, tenantId, clock.now);
        return report.daily;
      };
      const nameOf = async (made: { activate(): Promise<void> }) => {
        await made.activate();
        const state = await prisma.syncState.findFirstOrThrow({
          where: { name: { startsWith: 'aviso-' } },
          orderBy: { updatedAt: 'desc' },
        });
        return state.name;
      };
      await insertVulnerability(prisma, tenantId, { severity: 'high', createdAt: clock.now });
      await assign();
      expect(await run(0)).toBe(1);
      expect(await run(1)).toBe(0);
      expect(await run(2)).toBe(0);
      // Um alerta novo, de depois do resumo enviado.
      clock.now = new Date(NINE.getTime() + 2 * DAY_MS + HOUR_MS);
      await insertVulnerability(prisma, tenantId, { severity: 'high', createdAt: clock.now });
      await assign();
      expect(await run(3)).toBe(1);
      for (const day of [4, 5, 6, 7, 8, 9]) expect([day, await run(day)]).toEqual([day, 0]);
      expect(await run(10)).toBe(1);
    });

    it('o que falhou não conta como enviado: no dia seguinte sai outro', async () => {
      const { tenantId, clock, assign, check } = await world(new Date(NINE.getTime() - HOUR_MS));
      await insertVulnerability(prisma, tenantId, { severity: 'high', createdAt: clock.now });
      await assign();
      clock.now = NINE;
      expect(await check()).toMatchObject({ daily: 1 });
      await prisma.notification.updateMany({
        where: { tenantId },
        data: { status: 'failed', attempts: 5, lastError: 'SmtpError' },
      });
      clock.now = new Date(NINE.getTime() + DAY_MS);
      expect(await check()).toMatchObject({ daily: 1 });
    });

    it('o worker parado às 09:00 manda quando volta, no mesmo dia; o alerta de depois das 09:00 não o dispara', async () => {
      const { tenantId, clock, assign, check } = await world(new Date(NINE.getTime() + 2 * HOUR_MS));
      await insertVulnerability(prisma, tenantId, { severity: 'high', createdAt: clock.now });
      await assign();
      expect(await check()).toMatchObject({ daily: 0 });
      const other = await world(new Date(NINE.getTime() + 6 * HOUR_MS));
      await insertVulnerability(prisma, other.tenantId, {
        severity: 'high',
        createdAt: new Date(NINE.getTime() - MINUTE_MS),
      });
      await other.assign();
      expect(await other.check()).toMatchObject({ daily: 1 });
    });

    it('os avisos por caso ligados depois das 09:00: o primeiro resumo é o do dia seguinte', async () => {
      const tenantId = await customer(prisma);
      const start = new Date(NINE.getTime() + MINUTE_MS);
      const made = noticeWorld(prisma, [tenantId], start);
      await made.activate();
      await insertVulnerability(prisma, tenantId, {
        severity: 'high',
        createdAt: new Date(NINE.getTime() - DAY_MS),
        updatedAt: new Date(NINE.getTime() - DAY_MS),
      });
      expect(await made.step()).toMatchObject({ daily: 0 });
      made.clock.now = new Date(NINE.getTime() + DAY_MS);
      expect(await made.check()).toMatchObject({ daily: 1 });
    });

    it('a detecção não entra no resumo', async () => {
      const { alert, clock, step, check } = await world(new Date(NINE.getTime() - HOUR_MS));
      await alert({ severity: 'critical' });
      await step();
      clock.now = NINE;
      expect(await check()).toMatchObject({ daily: 0 });
    });
  });

  describe('nunca calado: a atribuição atrasada', () => {
    it('o alerta alto ou crítico sem caso há mais de 10 min avisa sozinho, uma vez', async () => {
      const { tenantId, alert, check, clock } = await world();
      const critical = await alert({ severity: 'critical' });
      const high = await alert();
      await alert({ severity: 'medium' });
      await alert({ status: 'resolved', severity: 'critical' });
      clock.now = at(10 * MINUTE_MS - 1);
      expect(await check()).toMatchObject({ lagging: 0 });
      clock.now = at(10 * MINUTE_MS);
      expect(await check()).toMatchObject({ lagging: 2, opened: 0 });
      expect((await noticesOf(prisma, tenantId)).map((row) => [row.kind, row.dedupeKey, row.caseId])).toEqual(
        expect.arrayContaining([
          ['critical_finding', `finding:${critical}`, null],
          ['high_finding', `finding:${high}`, null],
        ]),
      );
      expect(await check()).toMatchObject({ lagging: 0 });
      expect(await noticesOf(prisma, tenantId)).toHaveLength(2);
    });

    it('o alto de vulnerabilidade e de postura sem caso espera o resumo diário; o crítico, não', async () => {
      const { tenantId, check, clock } = await world();
      const critical = await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      const high = (overrides: Partial<Prisma.FindingUncheckedCreateInput>) =>
        insertFinding(prisma, tenantId, { createdAt: T0, severity: 'high', actorUser: null, ...overrides });
      const quiet = [
        { logSource: 'inspector', ruleId: '990511', eventName: 'CVE-2026-0002' },
        { logSource: 'inspector', ruleId: '990512', eventName: 'porta' },
        { logSource: 'inspector', ruleId: '990513', eventName: 'CWE-79' },
        { logSource: 'access_analyzer', ruleId: '990521', eventName: 'Public' },
        { logSource: 'security_hub', ruleId: '990501', eventName: 'S3.1' },
      ];
      const loud = [
        { logSource: 'security_hub', ruleId: '990502', eventName: 'TTPs/Initial Access' },
        { logSource: 'wazuh_agent', ruleId: '5712', eventName: 'sshd' },
        { logSource: 'fonte-nova', ruleId: '1', eventName: null },
      ];
      for (const one of quiet) await high(one);
      const noticed = [];
      for (const one of loud) noticed.push(await high(one));
      // A conta em SQL e a chave do caso concordam.
      const queueOf = async (where: Prisma.FindingWhereInput) =>
        (await prisma.finding.findMany({ where: { tenantId, severity: 'high', ...where } })).map(
          (row) => caseKeyOf(row).queue,
        );
      expect(await queueOf({ id: { notIn: noticed } })).not.toContain('detection');
      expect(new Set(await queueOf({ id: { in: noticed } }))).toEqual(new Set(['detection']));
      clock.now = at(HOUR_MS);
      expect(await check()).toMatchObject({ lagging: 4 });
      expect((await noticesOf(prisma, tenantId)).map((row) => row.findingId).sort()).toEqual(
        [critical, ...noticed].sort(),
      );
      expect(await check()).toMatchObject({ lagging: 0 });
    });

    it('a atribuição voltou: o aviso do alerta ainda na fila dá lugar ao do caso; o já enviado marca o caso', async () => {
      const { tenantId, alert, check, step, clock } = await world();
      const sent = await alert({ ruleId: '100305' });
      const waiting = await alert({ ruleId: '100306' });
      clock.now = at(11 * MINUTE_MS);
      await check();
      await markSent(prisma, tenantId, clock.now, { findingId: sent });
      clock.now = at(20 * MINUTE_MS);
      expect(await step()).toMatchObject({ opened: 1, marked: 1, superseded: 1, lagging: 0 });
      const rows = await noticesOf(prisma, tenantId);
      const cases = await casesOf(prisma, tenantId);
      const waitingCase = cases.find((row) => row.ruleIds.includes('100306'));
      expect(rows.map((row) => [row.dedupeKey, row.status, row.lastError])).toEqual(
        expect.arrayContaining([
          [`finding:${sent}`, 'sent', null],
          [`finding:${waiting}`, 'skipped', 'superseded_by_case'],
          [caseNoticeKey(waitingCase?.id ?? '', 'high'), 'pending', null],
        ]),
      );
      expect(rows).toHaveLength(3);
      expect(cases.map((row) => row.noticedSeverity)).toEqual(['high', 'high']);
      expect(await check()).toMatchObject({ opened: 0, marked: 0, superseded: 0 });
    });

    it('uma rajada inteira parada entra em lotes, os críticos primeiro', async () => {
      const tenantId = await customer(prisma);
      const made = noticeWorld(prisma, [tenantId], at(-DAY_MS), { batch: 10 });
      await made.activate();
      await prisma.finding.createMany({
        data: Array.from({ length: 35 }, (_, index) =>
          findingData(tenantId, { createdAt: T0, severity: index % 5 === 0 ? 'critical' : 'high' }),
        ),
      });
      made.clock.now = at(HOUR_MS);
      // Só um lote cabe no tempo: todos os críticos estão nele.
      let time = 0;
      const short = new CaseNotices(prisma, {
        regime: made.regime,
        tenantIds: [tenantId],
        now: () => at(HOUR_MS),
        batch: 10,
        workMs: 2,
        elapsed: () => (time += 1),
      });
      expect(await short.check(at(HOUR_MS))).toMatchObject({ lagging: 10, unfinishedTenants: 1 });
      const rows = await noticesOf(prisma, tenantId);
      expect(rows.filter((row) => row.kind === 'critical_finding')).toHaveLength(7);
      expect(await made.check()).toMatchObject({ lagging: 25, unfinishedTenants: 0 });
      expect(await made.check()).toMatchObject({ lagging: 0 });
    });

    it('o log diz que está atrasado, sem dado de cliente além do id', async () => {
      const tenantId = await customer(prisma);
      const warnings: object[] = [];
      const made = noticeWorld(prisma, [tenantId], at(-DAY_MS), {
        logger: { warn: (fields) => void warnings.push(fields), error: () => undefined },
      });
      await made.activate();
      await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'critical' });
      made.clock.now = at(HOUR_MS);
      await made.check();
      expect(warnings).toEqual([{ tenantId, alerts: 1 }]);
    });
  });

  describe('ao mesmo tempo, e no meio de uma queda', () => {
    it('duas réplicas sem concessão nenhuma: cada caso avisa uma vez', async () => {
      const tenantId = await customer(prisma);
      const first = noticeWorld(prisma, [tenantId], at(-DAY_MS), { page: 5 });
      await first.activate();
      const regime = first.regime;
      const replicas = Array.from({ length: 4 }, () =>
        noticeWorld(prisma, [tenantId], T0, { page: 5, regime }),
      );
      for (let i = 0; i < 40; i += 1)
        await insertFinding(prisma, tenantId, {
          createdAt: T0,
          ruleId: `1003${10 + i}`,
          severity: i % 3 === 0 ? 'critical' : 'high',
        });
      for (let i = 0; i < 6; i += 1) await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      first.clock.now = T0;
      await first.assign();
      await Promise.all(replicas.map((replica) => replica.check()));
      const keys = await keysOf(prisma, tenantId);
      expect(keys.filter((key) => key.startsWith('case:'))).toHaveLength(40);
      expect(keys.filter((key) => key.startsWith('cases-critical:'))).toHaveLength(1);
      expect(new Set(keys).size).toBe(41);
      const cases = await casesOf(prisma, tenantId);
      expect(cases.every((row) => row.noticedSeverity !== null)).toBe(true);
    });

    it('com coletores, triagem e atribuição rodando: nenhum deadlock, e ninguém fica sem aviso nem avisa duas vezes', async () => {
      const { tenantId, alert, assign, notices, clock } = await world();
      let running = true;
      const failures: string[] = [];
      const loop = async (work: () => Promise<unknown>) => {
        while (running) {
          try {
            await work();
          } catch (error) {
            failures.push(String(error));
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      let next = 0;
      const loops = [
        loop(async () => {
          next += 1;
          await prisma.$transaction(async (tx) => {
            await lockTenantFindings(tx, tenantId);
            await tx.finding.create({
              data: findingData(tenantId, {
                createdAt: clock.now,
                ruleId: `1003${10 + (next % 30)}`,
                severity: next % 4 === 0 ? 'critical' : 'high',
              }),
            });
          });
        }),
        loop(assign),
        loop(() => notices.check(clock.now)),
        loop(() => notices.check(clock.now)),
        loop(async () => {
          const some = await prisma.finding.findFirst({
            where: { tenantId, status: 'new', caseId: { not: null } },
            select: { id: true },
          });
          if (some !== null)
            await prisma.finding.update({
              where: { id: some.id },
              data: { status: next % 2 === 0 ? 'resolved' : 'investigating', triagedAt: clock.now },
            });
        }),
      ];
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      running = false;
      await Promise.all(loops);
      // A espera por uma trava pode devolver o lote (o esperado sob carga); um deadlock, não.
      expect(failures.filter((failure) => failure.includes('40P01'))).toEqual([]);
      await alert({ ruleId: '100399', severity: 'critical' });
      await assign();
      await notices.check(clock.now);
      for (const row of await casesOf(prisma, tenantId)) {
        if (row.pendingCritical > 0) expect(row.noticedSeverity, row.id).toBe('critical');
        else if (row.pendingHigh > 0) expect(row.noticedSeverity, row.id).not.toBeNull();
      }
      const plain = (await keysOf(prisma, tenantId)).filter((key) =>
        /^case:[^:]+:(critical|high)$/.test(key),
      );
      expect(new Set(plain).size).toBe(plain.length);
    }, 60_000);

    it('a queda no meio de um lote não deixa aviso sem marca nem marca sem aviso; a execução seguinte avisa uma vez', async () => {
      const { tenantId, alert, assign, check, clock, regime } = await world();
      for (let i = 0; i < 5; i += 1) await alert({ ruleId: `1003${10 + i}` });
      await assign();
      const killed = new Proxy(prisma, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (property !== '$transaction') return value;
          return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
            target.$transaction(async (tx) => {
              const result = await work(tx);
              if (await tx.notification.count({ where: { tenantId } }))
                throw new Error('o processo morreu antes do fim');
              return result;
            }, options);
        },
      });
      const dying = new CaseNotices(killed, { regime, tenantIds: [tenantId], now: () => clock.now });
      const report = await dying.check(clock.now);
      expect(report).toMatchObject({ failedTenants: 1, opened: 0 });
      expect(await noticesOf(prisma, tenantId)).toEqual([]);
      expect((await casesOf(prisma, tenantId)).map((row) => row.noticedSeverity)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(await check()).toMatchObject({ opened: 5 });
      expect(await keysOf(prisma, tenantId)).toHaveLength(5);
    });

    it('a espera longa pelo lock do cliente adia só ele; os outros avisam, e ele na execução seguinte', async () => {
      const [busy, free] = [await customer(prisma, 'Ocupado'), await customer(prisma, 'Livre')];
      const made = noticeWorld(prisma, [busy, free], at(-DAY_MS));
      await made.activate();
      made.clock.now = T0;
      for (const tenantId of [busy, free]) await insertFinding(prisma, tenantId, { createdAt: T0 });
      await made.assign();
      let release = () => undefined as void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = () => undefined as void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = prisma.$transaction(
        async (tx) => {
          await lockTenantFindings(tx, busy);
          locked();
          await held;
        },
        { timeout: 30_000 },
      );
      await isLocked;
      const report = await made.notices.check(T0);
      expect(report).toMatchObject({ failedTenants: 1, opened: 1 });
      release();
      await holder;
      expect(await noticesOf(prisma, busy)).toEqual([]);
      expect(await noticesOf(prisma, free)).toHaveLength(1);
      expect(await made.check()).toMatchObject({ opened: 1, failedTenants: 0 });
    });

    it('o caso que não deixa gravar é isolado: os outros avisam, e o alerta mais novo dele avisa sozinho', async () => {
      const { tenantId, alert, assign, check, clock } = await world();
      for (let i = 0; i < 4; i += 1) await alert({ ruleId: `1003${10 + i}` });
      const bad = await alert({ ruleId: '100399', severity: 'critical' });
      await alert({ ruleId: '100399', createdAt: at(1_000) });
      await assign();
      const badCase = (await casesOf(prisma, tenantId)).find((row) => row.ruleIds.includes('100399'));
      const constraint = `aviso_teste_${randomUUID()}`;
      // Uma regra do banco que recusa só o aviso deste caso.
      await withConstraint(constraint, badCase?.id ?? '', async () => {
        expect(await check()).toMatchObject({ opened: 4, isolated: 1, lagging: 1, failedTenants: 0 });
        clock.now = at(MINUTE_MS);
        expect(await check()).toMatchObject({ opened: 0, isolated: 1, lagging: 0 });
      });
      const rows = await noticesOf(prisma, tenantId);
      expect(rows.filter((row) => row.caseId !== null)).toHaveLength(4);
      expect(rows.filter((row) => row.caseId === null).map((row) => row.dedupeKey)).toEqual([
        `finding:${bad}`,
      ]);
      // Resolvido o problema, o caso avisa, e o aviso do alerta ainda na fila dá lugar ao dele.
      expect(await check()).toMatchObject({ opened: 1, superseded: 1 });
    });

    it('o caso do passado que não deixa marcar é isolado, e não avisa alerta nenhum', async () => {
      const { tenantId, alert, assign, check } = await world();
      const old = await alert({ severity: 'critical' });
      const past = at(-60 * DAY_MS);
      await prisma.finding.update({ where: { id: old }, data: { createdAt: past, updatedAt: past } });
      await assign();
      const row = await onlyCase(tenantId);
      await withConstraint(
        `aviso_teste_${randomUUID()}`,
        row.id,
        async () => {
          expect(await check()).toMatchObject({ marked: 0, isolated: 1, lagging: 0, failedTenants: 0 });
        },
        'AlertCase',
      );
      expect(await noticesOf(prisma, tenantId)).toEqual([]);
      expect(await check()).toMatchObject({ marked: 1, isolated: 0 });
    });

    /** Um CHECK que recusa o aviso de um caso (ou a marca dele), só durante o teste: o banco é só deste arquivo. */
    async function withConstraint(
      name: string,
      caseId: string,
      work: () => Promise<void>,
      table: 'Notification' | 'AlertCase' = 'Notification',
    ): Promise<void> {
      const pg = (await import('pg')).default;
      const client = new pg.Client({ connectionString: database.url });
      await client.connect();
      const target = client.escapeIdentifier(table);
      const refused =
        table === 'Notification'
          ? `"caseId" IS DISTINCT FROM ${client.escapeLiteral(caseId)}::uuid`
          : `"id" <> ${client.escapeLiteral(caseId)}::uuid OR "noticedSeverity" IS NULL`;
      try {
        await client.query(
          `ALTER TABLE ${target} ADD CONSTRAINT ${client.escapeIdentifier(name)} CHECK (${refused}) NOT VALID`,
        );
        await work();
      } finally {
        await client.query(`ALTER TABLE ${target} DROP CONSTRAINT ${client.escapeIdentifier(name)}`);
        await client.end();
      }
    }

    it('a parada do worker interrompe entre dois lotes, e o que foi gravado fica', async () => {
      const { tenantId, alert, assign, regime, clock } = await world();
      for (let i = 0; i < 6; i += 1) await alert({ ruleId: `1003${10 + i}` });
      await assign();
      const controller = new AbortController();
      const stopping = new Proxy(prisma, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (property !== '$transaction') return value;
          return async (work: never, options: never) => {
            const result = await (target.$transaction as (a: never, b: never) => Promise<unknown>)(
              work,
              options,
            );
            if ((await prisma.notification.count({ where: { tenantId } })) > 0) controller.abort();
            return result;
          };
        },
      });
      const made = new CaseNotices(stopping, {
        regime,
        tenantIds: [tenantId],
        now: () => clock.now,
        page: 2,
      });
      await expect(made.check(clock.now, controller.signal)).rejects.toThrow();
      expect(await noticesOf(prisma, tenantId)).toHaveLength(2);
    });

    it('o prazo da execução acabou: a seguinte continua de onde parou, e todos os casos têm a sua vez', async () => {
      const { tenantId, alert, assign, regime, clock } = await world();
      for (let i = 0; i < 6; i += 1) await alert({ ruleId: `1003${10 + i}` });
      await assign();
      let time = 0;
      // Um trecho por execução; o caso já avisado continua a ser conferido a cada volta.
      const made = new CaseNotices(prisma, {
        regime,
        tenantIds: [tenantId],
        now: () => clock.now,
        page: 2,
        workMs: 2,
        elapsed: () => (time += 1),
      });
      const opened: number[] = [];
      const unfinished: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        time = 0;
        const report = await made.check(clock.now);
        opened.push(report.opened);
        unfinished.push(report.unfinishedTenants);
      }
      expect(opened).toEqual([2, 2, 2, 0, 0]);
      expect(unfinished[0]).toBe(1);
      expect(await noticesOf(prisma, tenantId)).toHaveLength(6);
    });

    it('a falha de um trecho ou de um passo não segura os outros: o resto sai com um caso preso', async () => {
      const { tenantId, alert, assign, notices, check, clock } = await world(
        new Date('2026-12-02T12:00:00.000Z'),
        { page: 1 },
      );
      for (const ruleId of ['100310', '100311', '100312']) await alert({ severity: 'critical', ruleId });
      await insertVulnerability(prisma, tenantId, { createdAt: at(-2 * HOUR_MS) });
      await assign();
      // O do meio, na ordem em que os trechos são lidos.
      const [, detection] = (await casesOf(prisma, tenantId))
        .filter((row) => row.queue === 'detection')
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      let release = () => undefined as void;
      const held = new Promise<void>((resolveHeld) => {
        release = resolveHeld;
      });
      let locked = () => undefined as void;
      const isLocked = new Promise<void>((resolveLocked) => {
        locked = resolveLocked;
      });
      // Uma triagem em curso segura a linha do caso.
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "AlertCase" WHERE "id" = ${detection?.id ?? ''}::uuid FOR UPDATE`;
          locked();
          await held;
        },
        { timeout: 30_000 },
      );
      await isLocked;
      expect(await notices.check(clock.now)).toMatchObject({
        failedTenants: 1,
        opened: 2,
        critical: 1,
        daily: 1,
      });
      release();
      await holder;
      expect(await noticesOf(prisma, tenantId, { caseId: detection?.id ?? '' })).toEqual([]);
      expect(await check()).toMatchObject({ opened: 1, critical: 0, daily: 0, failedTenants: 0 });
    });
  });

  describe('isolamento por cliente (A/B)', () => {
    it('dois clientes com os mesmos alertas: cada um avisa o seu, e o erro de um não cala o outro', async () => {
      const [a, b] = [await customer(prisma, 'Cliente Demo A'), await customer(prisma, 'Cliente Demo B')];
      const made = noticeWorld(prisma, [a, b], at(-DAY_MS));
      await made.activate();
      made.clock.now = T0;
      for (const tenantId of [a, b]) {
        await insertFinding(prisma, tenantId, { createdAt: T0, severity: 'critical' });
        await insertVulnerability(prisma, tenantId, {
          createdAt: T0,
          resource: 'arn:aws:ec2:sa-east-1:111122223333:instance/i-0000000000000000c',
        });
      }
      expect(await made.step()).toMatchObject({ opened: 2, critical: 2 });
      for (const tenantId of [a, b]) {
        const rows = await noticesOf(prisma, tenantId);
        expect(rows).toHaveLength(2);
        const cases = new Set((await casesOf(prisma, tenantId)).map((row) => row.id));
        for (const row of rows) {
          if (row.caseId !== null) expect(cases.has(row.caseId)).toBe(true);
          const finding = await prisma.finding.findUniqueOrThrow({ where: { id: row.findingId ?? '' } });
          expect(finding.tenantId).toBe(tenantId);
        }
      }
    });

    it('o aviso de B, o incidente de B e a operação de B não contam como aviso para A', async () => {
      const { tenantId, alert, step, clock } = await world();
      const other = await customer(prisma, 'Cliente Demo B');
      const id = await alert({ severity: 'critical' });
      await noticeWorld(prisma, [tenantId], clock.now).assign();
      const row = await onlyCase(tenantId);
      const foreign = await insertFinding(prisma, other, { createdAt: T0 });
      // Avisos de B com o caso e a chave de A (não acontece pelo código; a defesa é o cliente em cada consulta).
      await prisma.notification.createMany({
        data: [
          {
            tenantId: other,
            kind: 'critical_finding',
            severity: 'critical',
            findingId: foreign,
            caseId: row.id,
            dedupeKey: caseNoticeKey(row.id, 'critical'),
            status: 'sent',
            createdAt: at(MINUTE_MS),
          },
          {
            tenantId: other,
            kind: 'critical_finding',
            severity: 'critical',
            findingId: foreign,
            dedupeKey: `finding:${id}`,
            status: 'sent',
          },
          {
            tenantId: other,
            kind: 'high_finding',
            severity: 'high',
            findingId: foreign,
            dedupeKey: dailyCasesKey('2026-12-02'),
            status: 'sent',
          },
        ],
      });
      clock.now = at(2 * MINUTE_MS);
      expect(await step()).toMatchObject({ opened: 1 });
    });

    it('o caso anterior de uma divisão é só do próprio cliente', async () => {
      const { tenantId, check, clock } = await world();
      const other = await customer(prisma, 'Cliente Demo B');
      const foreignCase = await insertCase(prisma, other);
      const foreign = await insertFinding(prisma, other, { createdAt: T0, caseId: foreignCase });
      await prisma.notification.create({
        data: {
          tenantId: other,
          kind: 'high_finding',
          severity: 'high',
          findingId: foreign,
          caseId: foreignCase,
          dedupeKey: caseNoticeKey(foreignCase, 'high'),
          status: 'sent',
          createdAt: at(MINUTE_MS),
        },
      });
      const split = await insertCase(prisma, tenantId, {
        previousCaseId: foreignCase,
        sealedAt: at(HOUR_MS),
        sealReason: 'split',
        noticedSeverity: 'high',
        lastAlertAt: at(0),
      });
      await insertFinding(prisma, tenantId, { createdAt: at(0), caseId: split });
      clock.now = at(2 * HOUR_MS);
      // O aviso de B não cobre o caso de A: o dele nunca foi avisado.
      expect(await check()).toMatchObject({ opened: 1 });
    });
  });
});
