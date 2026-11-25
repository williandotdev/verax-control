import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CaseNoticeMail } from '../src/cases/case-notice-mail.js';
import { caseNoticeKey, criticalCasesKey } from '../src/cases/case-notice-policy.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { MailMessage, MailTransport } from '../src/mail/mail.types.js';
import {
  hourStartOf,
  NOTIFICATION_RETRY_DELAYS_MS,
  NOTIFICATIONS_TASK,
  NotificationDispatcher,
} from '../src/notifications/notification-dispatcher.js';
import { enqueueNotices, incidentNotices } from '../src/notifications/finding-notices.js';
import {
  at,
  customer,
  DAY_MS,
  HOUR_MS,
  insertVulnerability,
  member,
  MINUTE_MS,
  noticesOf,
  noticeWorld,
  T0,
} from './support/case-notices.js';
import { casesOf, findingData, insertFinding, insertIncident } from './support/cases.js';
import { TEST_WEB_ORIGIN } from './support/create-app.js';
import { MemoryMailTransport } from './support/memory-mail.js';
import { createOwnDatabase, type OwnDatabase } from './support/own-database.js';

/**
 * A entrega dos avisos por caso: o e-mail, o resumo da hora, o contato de escalonamento, os limites, o que não sai porque
 * deixou de valer e os números da primeira vez ligada. Num banco só deste arquivo: o despachante lê a fila inteira.
 */
describe('entrega dos avisos por caso', () => {
  let database: OwnDatabase;
  let prisma: PrismaService;

  beforeAll(async () => {
    database = await createOwnDatabase('avisos_entrega');
    prisma = new PrismaService({ DATABASE_URL: database.url });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.drop();
  });

  beforeEach(async () => {
    // Cada teste começa com a fila vazia.
    await prisma.notification.deleteMany({});
    await prisma.notificationDigest.deleteMany({});
  });

  async function world(start = T0) {
    const tenantId = await customer(prisma);
    const person = await member(prisma, tenantId);
    const made = noticeWorld(prisma, [tenantId], new Date(start.getTime() - 30 * DAY_MS));
    await made.activate();
    made.clock.now = start;
    const mail = new MemoryMailTransport();
    const alert = (overrides: Partial<Prisma.FindingUncheckedCreateInput> = {}) =>
      insertFinding(prisma, tenantId, { createdAt: made.clock.now, ...overrides });
    return { ...made, tenantId, person, mail, alert };
  }
  const resolve = (tenantId: string, where: Prisma.FindingWhereInput = {}) =>
    prisma.finding.updateMany({ where: { ...where, tenantId }, data: { status: 'resolved' } });
  const confirmContact = async (tenantId: string) => {
    const email = `contato-${randomUUID()}@cliente.example`;
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        escalationName: 'Contato de teste',
        escalationEmail: email,
        escalationState: 'confirmed',
        escalationGeneration: 1,
        escalationConfirmedAt: new Date(),
      },
    });
    return email;
  };
  const failing = (kind = 'SmtpError'): MailTransport => ({
    send: () => {
      const error = new Error('550 pessoa@cliente.example recusada');
      error.name = kind;
      return Promise.reject(error);
    },
  });

  describe('o e-mail', () => {
    it('do caso, do caso que cresceu, do aviso imediato e do resumo diário, com o link do painel e nada do evento', async () => {
      const { tenantId, person, mail, alert, assign, deliver, clock } = await world();
      await alert({
        severity: 'critical',
        sourceIp: '203.0.113.9',
        resource: 'arn:aws:iam::111122223333:role/x',
      });
      await alert();
      await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      await assign();
      expect(await deliver(mail)).toMatchObject({
        status: 'done',
        due: 2,
        sent: 2,
        cases: { opened: 1, critical: 1 },
      });
      const detection = (await casesOf(prisma, tenantId)).find((row) => row.queue === 'detection');
      const other = (await casesOf(prisma, tenantId)).find((row) => row.queue === 'vulnerability');
      expect(mail.to(person.email).map((message) => message.subject)).toEqual([
        'Caso de severidade crítica no Verax Control',
        'Casos críticos novos de vulnerabilidade ou postura no Verax Control',
      ]);
      const [first, second] = mail.messages as [MailMessage, MailMessage];
      expect(first.text).toContain(`O caso "${detection?.title}" tem 1 alerta crítico e 1 alto a validar`);
      expect(first.text).toContain(`Ver o caso: ${TEST_WEB_ORIGIN}/?caso=${detection?.id}`);
      expect(second.text).toContain(
        `- ${other?.title}: 1 alerta crítico: ${TEST_WEB_ORIGIN}/?caso=${other?.id}`,
      );
      expect(second.text).toContain(`Ver a fila: ${TEST_WEB_ORIGIN}/?visao=vulnerabilidades`);
      for (const { text, html, subject } of mail.messages) {
        for (const value of ['203.0.113.9', 'arn:aws', 'maria', '111122223333', 'openssl', 'CVE-2026', 'i-'])
          expect(`${subject}${text}${html}`).not.toContain(value);
      }
      // Cresceu: um crítico novo durante a análise.
      clock.now = at(HOUR_MS);
      await prisma.finding.updateMany({
        where: { tenantId, severity: 'critical', logSource: 'cloudtrail' },
        data: { status: 'investigating', triagedAt: clock.now },
      });
      clock.now = at(2 * HOUR_MS);
      await alert({ severity: 'critical' });
      await assign();
      await deliver(mail);
      expect(mail.messages.at(-1)?.subject).toBe('Caso de severidade crítica cresceu no Verax Control');
      expect(mail.messages.at(-1)?.text).toContain('A validar agora: 2 alertas críticos e 1 alto.');
      // E o resumo do dia seguinte, às 09:00 de Brasília.
      clock.now = new Date('2026-12-03T12:00:00.000Z');
      expect(await deliver(mail)).toMatchObject({ cases: { daily: 1 }, sent: 1 });
      const daily = mail.messages.at(-1) as MailMessage;
      expect(daily.subject).toBe('Resumo diário de vulnerabilidades e postura no Verax Control');
      expect(daily.text).toContain('Vulnerabilidades: 1 caso com 1 alerta crítico.');
      expect(daily.text).not.toContain('Postura:');
      expect(daily.text).toContain(`${TEST_WEB_ORIGIN}/?caso=${other?.id}`);
    });

    it('as contagens são as da hora do envio, não as do aviso', async () => {
      const { tenantId, mail, alert, step, assign, deliver } = await world();
      await alert({ severity: 'critical' });
      await step();
      for (let i = 0; i < 4; i += 1) await alert({ severity: 'critical' });
      await assign();
      await deliver(mail);
      expect(mail.messages[0]?.text).toContain('tem 5 alertas críticos a validar');
      expect(tenantId).not.toBe('');
    });

    it('a postura sozinha: o link da fila dela', async () => {
      const { tenantId, mail, assign, deliver } = await world();
      await insertFinding(prisma, tenantId, {
        createdAt: T0,
        logSource: 'security_hub',
        ruleId: '990501',
        eventName: 'S3.1',
        severity: 'critical',
        actorUser: null,
      });
      await assign();
      await deliver(mail);
      expect(mail.messages[0]?.text).toContain(`Ver a fila: ${TEST_WEB_ORIGIN}/?visao=casos&fila=postura`);
    });

    it('resumo diário: um e-mail por pessoa que recebe avisos, uma vez; quem desligou e quem só lê, nada', async () => {
      const { tenantId, person, mail, assign, deliver, clock } = await world(
        new Date('2026-12-02T11:00:00.000Z'),
      );
      const analyst = await member(prisma, tenantId, 'analista_cliente');
      const off = await member(prisma, tenantId);
      await prisma.notificationPreference.create({
        data: { userId: off.id, tenantId, incidentEmails: false },
      });
      const reader = await member(prisma, tenantId, 'leitura');
      for (let i = 0; i < 12; i += 1)
        await insertVulnerability(prisma, tenantId, {
          createdAt: clock.now,
          severity: i === 0 ? 'critical' : 'high',
        });
      await assign();
      await deliver(mail);
      mail.messages.length = 0;
      clock.now = new Date('2026-12-02T12:00:00.000Z');
      expect(await deliver(mail)).toMatchObject({ cases: { daily: 1 } });
      clock.now = new Date('2026-12-02T12:05:00.000Z');
      await deliver(mail);
      expect(mail.messages.map((message) => message.to).sort()).toEqual([person.email, analyst.email].sort());
      const [message] = mail.messages as [MailMessage];
      expect(message.text).toContain('Vulnerabilidades: 12 casos com 1 alerta crítico e 11 altos.');
      // Só os dez piores, o crítico primeiro.
      const listed = message.text.split('\n').filter((line) => line.startsWith('- '));
      expect(listed).toHaveLength(10);
      expect(listed[0]).toContain('1 alerta crítico');
      expect(mail.to(off.email)).toEqual([]);
      expect(mail.to(reader.email)).toEqual([]);
    });
  });

  describe('os limites por pessoa', () => {
    it('cinco avulsos por hora; do sexto caso em diante, o resumo da hora, os críticos primeiro, com título e contagem', async () => {
      const { tenantId, person, mail, alert, assign, deliver, clock } = await world();
      for (let i = 0; i < 12; i += 1) await alert({ ruleId: `1003${10 + i}` });
      await alert({ ruleId: '100390', severity: 'critical' });
      await assign();
      const report = await deliver(mail);
      expect(report).toMatchObject({ due: 13, sent: 13, folded: 8, cases: { opened: 13 } });
      expect(mail.to(person.email)).toHaveLength(5);
      // O crítico vai na frente.
      expect(mail.messages[0]?.subject).toBe('Caso de severidade crítica no Verax Control');
      clock.now = at(HOUR_MS);
      expect(await deliver(mail)).toMatchObject({ digests: { sent: 1 } });
      const digest = mail.messages.at(-1) as MailMessage;
      expect(digest.subject).toBe('Resumo dos avisos da hora no Verax Control');
      expect(digest.text).toContain('8 avisos no total');
      expect(digest.text).toMatch(
        /Caso de severidade alta: .+, 1 alerta alto: http:\/\/localhost:5173\/\?caso=/,
      );
      expect(tenantId).not.toBe('');
    });

    it('o aviso imediato e o resumo diário também contam nos cinco da hora, e entram no resumo como item', async () => {
      const { tenantId, person, mail, assign, deliver, clock } = await world(
        new Date('2026-12-02T12:00:00.000Z'),
      );
      await prisma.notificationDigest.create({
        data: { tenantId, userId: person.id, hourStart: hourStartOf(clock.now), individualSent: 5 },
      });
      await insertVulnerability(prisma, tenantId, { createdAt: at(-2 * HOUR_MS) });
      await assign();
      expect(await deliver(mail)).toMatchObject({ folded: 2, cases: { critical: 1, daily: 1 } });
      expect(mail.messages).toEqual([]);
      clock.now = new Date('2026-12-02T13:00:00.000Z');
      await deliver(mail);
      const digest = mail.to(person.email).at(-1) as MailMessage;
      expect(digest.text).toContain(
        'Casos críticos novos de vulnerabilidade ou postura: 1 caso com 1 alerta crítico',
      );
      expect(digest.text).toContain(
        'Resumo diário de vulnerabilidades e postura: 1 caso com 1 alerta crítico',
      );
    });

    it('num resumo de retomada com muitos avisos imediatos, só o último deles é item: não escondem os casos', async () => {
      const { tenantId, person, mail, alert, step, deliver, clock } = await world();
      await alert({ severity: 'critical' });
      const vulnerability = await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      await step();
      await prisma.notification.createMany({
        data: Array.from({ length: 30 }, (_, hour) => ({
          tenantId,
          kind: 'critical_finding' as const,
          severity: 'critical' as const,
          findingId: vulnerability,
          dedupeKey: criticalCasesKey(at(-(hour + 1) * HOUR_MS)),
          createdAt: at(-(hour + 1) * HOUR_MS),
          nextAttemptAt: T0,
        })),
      });
      clock.now = at(25 * HOUR_MS);
      await deliver(mail);
      clock.now = at(26 * HOUR_MS);
      await deliver(mail);
      const digest = mail
        .to(person.email)
        .find((message) => message.subject.startsWith('Retomada')) as MailMessage;
      const listed = digest.text.split('\n').filter((line) => line.startsWith('- '));
      const critical = listed.filter((line) => line.includes('Casos críticos novos'));
      expect(critical).toHaveLength(1);
      // O mais novo: o das 10:00 de Brasília.
      expect(critical[0]).toContain('02/12/2026, 10:00');
      expect(listed.filter((line) => line.includes('Caso de severidade crítica'))).toHaveLength(1);
    });
  });

  describe('o contato de escalonamento', () => {
    it('recebe por caso crítico e o aviso imediato, sem título nem lista; nunca o alto, e nunca o resumo diário', async () => {
      const { tenantId, mail, alert, assign, deliver, clock } = await world(
        new Date('2026-12-02T11:30:00.000Z'),
      );
      const contact = await confirmContact(tenantId);
      await alert({ severity: 'critical', ruleId: '100305' });
      await alert({ ruleId: '100306' });
      await insertVulnerability(prisma, tenantId, { createdAt: clock.now });
      await assign();
      expect(await deliver(mail)).toMatchObject({ escalation: { sent: 2 } });
      expect(mail.to(contact).map((message) => message.subject)).toEqual([
        'Caso de severidade crítica no Verax Control',
        'Casos críticos novos de vulnerabilidade ou postura no Verax Control',
      ]);
      for (const { text, html } of mail.to(contact)) {
        for (const row of await casesOf(prisma, tenantId)) expect(`${text}${html}`).not.toContain(row.title);
        expect(text).toContain('/escalonamento/descadastrar');
      }
      clock.now = new Date('2026-12-02T12:00:00.000Z');
      mail.messages.length = 0;
      expect(await deliver(mail)).toMatchObject({ cases: { daily: 1 }, escalation: { sent: 0 } });
      expect(mail.messages.map((message) => message.subject)).toEqual([
        'Resumo diário de vulnerabilidades e postura no Verax Control',
      ]);
    });

    it('um e-mail por caso crítico, por mais alertas que ele tenha; e cinco por hora, como antes', async () => {
      const { tenantId, mail, alert, assign, deliver } = await world();
      const contact = await confirmContact(tenantId);
      for (let caseOf = 0; caseOf < 7; caseOf += 1) {
        for (let i = 0; i < 20; i += 1) await alert({ severity: 'critical', ruleId: `1003${10 + caseOf}` });
      }
      await assign();
      expect(await deliver(mail)).toMatchObject({ escalation: { sent: 5, limited: 2 } });
      expect(mail.to(contact)).toHaveLength(5);
    });
  });

  describe('o que deixou de valer não sai', () => {
    it('tratado em massa antes de sair: pulado, para todos, e nenhum e-mail', async () => {
      const { tenantId, mail, alert, step, deliver, clock } = await world();
      const contact = await confirmContact(tenantId);
      await alert({ severity: 'critical' });
      await step();
      await resolve(tenantId);
      clock.now = at(MINUTE_MS);
      expect(await deliver(mail)).toMatchObject({ due: 1, sent: 0, skipped: 1 });
      expect(mail.messages).toEqual([]);
      expect(mail.to(contact)).toEqual([]);
      expect(await noticesOf(prisma, tenantId)).toMatchObject([
        { status: 'skipped', lastError: 'case_treated' },
      ]);
    });

    it('milhares tratados de uma vez saem da fila numa execução, sem gastar a vez dos que vão sair', async () => {
      const { tenantId, mail, alert, assign, check, deliver, clock } = await world();
      await prisma.finding.createMany({
        data: Array.from({ length: 1_200 }, (_, index) =>
          findingData(tenantId, { createdAt: T0, ruleId: String(200_000 + index) }),
        ),
      });
      await assign();
      await check();
      await resolve(tenantId);
      clock.now = at(MINUTE_MS);
      await alert({ ruleId: '100305' });
      await assign();
      expect(await deliver(mail)).toMatchObject({ skipped: 1_200, sent: 1 });
      expect(mail.messages).toHaveLength(1);
    }, 60_000);

    it('tratado no meio da execução, antes da vez dele: conferido de novo no envio', async () => {
      const { tenantId, alert, step, deliver } = await world();
      await alert({ ruleId: '100305', severity: 'critical' });
      await alert({ ruleId: '100306' });
      await step();
      const sent: string[] = [];
      const treating: MailTransport = {
        send: async (message) => {
          sent.push(message.subject);
          await resolve(tenantId, { ruleId: '100306' });
        },
      };
      expect(await deliver(treating)).toMatchObject({ sent: 1, skipped: 1 });
      expect(sent).toEqual(['Caso de severidade crítica no Verax Control']);
    });

    it('promovido no meio da execução, com parte dos alertas ainda no caso: conferido de novo no envio', async () => {
      const { tenantId, alert, step, deliver } = await world();
      await alert({ ruleId: '100305', severity: 'critical' });
      await alert({ ruleId: '100306' });
      await alert({ ruleId: '100306' });
      await step();
      const second = (await casesOf(prisma, tenantId)).find((row) => row.ruleIds.includes('100306'));
      let sent = 0;
      const promoting: MailTransport = {
        send: async () => {
          sent += 1;
          const incidentId = await insertIncident(prisma, tenantId, { createdAt: at(1_000) });
          await prisma.alertCase.update({ where: { id: second?.id ?? '' }, data: { incidentId } });
        },
      };
      expect(await deliver(promoting)).toMatchObject({ sent: 1, skipped: 1 });
      expect(sent).toBe(1);
      expect((await noticesOf(prisma, tenantId, { caseId: second?.id ?? '' }))[0]?.lastError).toBe(
        'superseded_by_incident',
      );
    });

    it('os críticos tratados e os altos pendentes: o aviso crítico não sai, e o alto sai no lugar', async () => {
      const { tenantId, mail, alert, step, deliver, clock } = await world();
      await alert({ severity: 'critical' });
      await alert();
      await step();
      await resolve(tenantId, { severity: 'critical' });
      clock.now = at(MINUTE_MS);
      await deliver(mail);
      clock.now = at(2 * MINUTE_MS);
      await deliver(mail);
      expect(mail.messages.map((message) => message.subject)).toEqual([
        'Caso de severidade alta no Verax Control',
      ]);
    });

    it('promovido a incidente antes de sair: só o aviso do incidente', async () => {
      const { tenantId, mail, alert, step, deliver, clock } = await world();
      await alert({ severity: 'critical' });
      await alert({ severity: 'critical' });
      await step();
      const [row] = await casesOf(prisma, tenantId);
      const incidentId = await insertIncident(prisma, tenantId, {
        severity: 'critical',
        createdAt: at(10_000),
      });
      // A operação já abriu o incidente, e metade dos alertas ainda não foi anexada.
      await prisma.alertCase.update({ where: { id: row?.id ?? '' }, data: { incidentId } });
      await prisma.finding.updateMany({
        where: { id: row?.anchorFindingId ?? '' },
        data: { incidentId },
      });
      await enqueueNotices(
        prisma.forTenant(tenantId),
        incidentNotices(tenantId, { change: 'opened', incidentId, severity: 'critical' }),
      );
      await prisma.notification.updateMany({
        where: { incidentId },
        data: { nextAttemptAt: T0, createdAt: T0 },
      });
      clock.now = at(MINUTE_MS);
      expect(await deliver(mail)).toMatchObject({ skipped: 1, sent: 1, cases: { opened: 0 } });
      expect(mail.messages.map((message) => message.subject)).toEqual([
        'Incidente de severidade crítica confirmado no Verax Control',
      ]);
      expect((await noticesOf(prisma, tenantId, { caseId: { not: null } }))[0]).toMatchObject({
        status: 'skipped',
        lastError: 'superseded_by_incident',
      });
    });

    it('promovido alerta por alerta (sem apontar o caso), também', async () => {
      const { tenantId, mail, alert, step, deliver, clock } = await world();
      await alert({ severity: 'critical' });
      await step();
      const incidentId = await insertIncident(prisma, tenantId, { createdAt: at(10_000) });
      await prisma.finding.updateMany({ where: { tenantId }, data: { incidentId } });
      clock.now = at(MINUTE_MS);
      expect(await deliver(mail)).toMatchObject({ skipped: 1, sent: 0 });
      expect((await noticesOf(prisma, tenantId))[0]?.lastError).toBe('superseded_by_incident');
    });

    it('o aviso de depois do incidente (a onda seguinte do caso promovido) sai', async () => {
      const { tenantId, mail, alert, assign, deliver, clock } = await world();
      await alert({ severity: 'critical' });
      await assign();
      const [row] = await casesOf(prisma, tenantId);
      const incidentId = await insertIncident(prisma, tenantId, { createdAt: at(10_000) });
      await prisma.alertCase.update({ where: { id: row?.id ?? '' }, data: { incidentId } });
      await prisma.finding.updateMany({ where: { tenantId }, data: { incidentId } });
      clock.now = at(HOUR_MS);
      await alert({ severity: 'critical' });
      await assign();
      expect(await deliver(mail)).toMatchObject({ sent: 1, skipped: 0 });
      expect(mail.messages).toHaveLength(1);
    });

    it('o caso saiu na retenção: o aviso pendente fecha, e os outros saem', async () => {
      const { tenantId, mail, alert, step, deliver, clock } = await world();
      const id = await alert({ ruleId: '100305' });
      await step();
      const caseId = randomUUID();
      await prisma.notification.create({
        data: {
          tenantId,
          kind: 'high_finding',
          severity: 'high',
          findingId: id,
          caseId,
          dedupeKey: caseNoticeKey(caseId, 'high'),
          nextAttemptAt: T0,
          createdAt: T0,
        },
      });
      clock.now = at(MINUTE_MS);
      expect(await deliver(mail)).toMatchObject({ skipped: 1, sent: 1 });
      expect((await noticesOf(prisma, tenantId, { status: 'skipped' }))[0]?.lastError).toBe('case_gone');
      expect(mail.messages).toHaveLength(1);
    });

    it('o alerta da âncora saiu na retenção com o aviso na fila: o aviso vai junto, e o caso avisa de novo', async () => {
      const { tenantId, mail, alert, step, deliver, clock } = await world();
      const anchor = await alert({ severity: 'critical' });
      await alert({ severity: 'critical' });
      await step();
      await prisma.finding.delete({ where: { id: anchor } });
      expect(await noticesOf(prisma, tenantId)).toEqual([]);
      clock.now = at(MINUTE_MS);
      expect(await deliver(mail)).toMatchObject({ sent: 1, cases: { opened: 1 } });
    });

    it('o resumo da hora não leva o caso já tratado, e o que só ele reunia volta a avisar se o caso voltar', async () => {
      const { tenantId, person, mail, alert, assign, deliver, clock } = await world();
      await prisma.notificationDigest.create({
        data: { tenantId, userId: person.id, hourStart: hourStartOf(T0), individualSent: 5 },
      });
      await alert({ ruleId: '100305' });
      const back = await alert({ ruleId: '100306' });
      await assign();
      expect(await deliver(mail)).toMatchObject({ folded: 2 });
      await resolve(tenantId, { ruleId: '100306' });
      clock.now = at(HOUR_MS);
      await deliver(mail);
      expect(mail.messages).toHaveLength(1);
      expect(mail.messages[0]?.text).toContain('1 aviso no total');
      const treated = (await noticesOf(prisma, tenantId)).find((row) => row.lastError === 'case_treated');
      expect(treated).toMatchObject({ status: 'skipped', digestedUserIds: [person.id] });
      // Desfeita a triagem, ninguém tinha recebido: avisa.
      clock.now = at(HOUR_MS + MINUTE_MS);
      await prisma.finding.update({ where: { id: back }, data: { status: 'new' } });
      expect(await deliver(mail)).toMatchObject({ cases: { opened: 1 }, sent: 1 });
      expect(mail.messages).toHaveLength(2);
    });

    it('no resumo, o aviso crítico de um caso que ficou só com altos não entra', async () => {
      const { tenantId, person, mail, alert, assign, deliver, clock } = await world();
      await prisma.notificationDigest.create({
        data: { tenantId, userId: person.id, hourStart: hourStartOf(T0), individualSent: 5 },
      });
      await alert({ ruleId: '100305', severity: 'critical' });
      await alert({ ruleId: '100305' });
      await alert({ ruleId: '100306', severity: 'critical' });
      await assign();
      expect(await deliver(mail)).toMatchObject({ folded: 2 });
      await resolve(tenantId, { ruleId: '100305', severity: 'critical' });
      clock.now = at(HOUR_MS);
      await deliver(mail);
      const digest = mail.messages.find((message) => message.subject.startsWith('Resumo dos avisos'));
      expect(digest?.text).toContain('1 aviso no total');
    });

    it('uma pessoa recebeu avulso e a outra teria no resumo: tratado no meio, o aviso conta como dado', async () => {
      const { tenantId, person, mail, alert, assign, deliver, clock } = await world();
      const other = await member(prisma, tenantId);
      await prisma.notificationDigest.create({
        data: { tenantId, userId: other.id, hourStart: hourStartOf(T0), individualSent: 5 },
      });
      const id = await alert({ severity: 'critical' });
      await assign();
      await deliver(mail);
      expect(mail.messages.map((message) => message.to)).toEqual([person.email]);
      await resolve(tenantId);
      clock.now = at(HOUR_MS);
      await deliver(mail);
      expect(mail.messages).toHaveLength(1);
      expect((await noticesOf(prisma, tenantId))[0]).toMatchObject({ status: 'sent', lastError: null });
      clock.now = at(HOUR_MS + MINUTE_MS);
      await prisma.finding.update({ where: { id }, data: { status: 'new' } });
      expect(await deliver(mail)).toMatchObject({ cases: { opened: 0 }, sent: 0 });
    });

    it('um resumo só de casos tratados não sai', async () => {
      const { tenantId, person, mail, alert, assign, deliver, clock } = await world();
      await prisma.notificationDigest.create({
        data: { tenantId, userId: person.id, hourStart: hourStartOf(T0), individualSent: 5 },
      });
      await alert();
      await assign();
      await deliver(mail);
      await resolve(tenantId);
      clock.now = at(HOUR_MS);
      expect(await deliver(mail)).toMatchObject({ digests: { skipped: 1, sent: 0 } });
      expect(mail.messages).toEqual([]);
      const [digest] = await prisma.notificationDigest.findMany({ where: { status: 'skipped' } });
      expect(digest?.lastError).toBe('no_items');
      // Ninguém recebeu: o caso que volta avisa.
      clock.now = at(HOUR_MS + MINUTE_MS);
      await prisma.finding.updateMany({ where: { tenantId }, data: { status: 'new' } });
      expect(await deliver(mail)).toMatchObject({ cases: { opened: 1 }, sent: 1 });
    });

    it('o aviso imediato e o resumo diário com tudo tratado antes: pulados', async () => {
      const { tenantId, mail, assign, check, deliver, clock } = await world(
        new Date('2026-12-02T12:00:00.000Z'),
      );
      await insertVulnerability(prisma, tenantId, { createdAt: at(-2 * HOUR_MS) });
      await assign();
      expect(await check()).toMatchObject({ critical: 1, daily: 1 });
      await resolve(tenantId);
      clock.now = new Date('2026-12-02T12:01:00.000Z');
      expect(await deliver(mail)).toMatchObject({ skipped: 2, sent: 0 });
      expect(mail.messages).toEqual([]);
      expect((await noticesOf(prisma, tenantId)).map((row) => row.lastError)).toEqual([
        'case_treated',
        'case_treated',
      ]);
    });

    it('quem já recebeu numa tentativa anterior conta: tratado entre as tentativas, o aviso fecha como enviado', async () => {
      const { tenantId, person, alert, step, deliver, clock } = await world();
      const other = await member(prisma, tenantId);
      await alert({ severity: 'critical' });
      await step();
      const sentTo: string[] = [];
      const half: MailTransport = {
        send: (message) => {
          if (message.to === other.email) return Promise.reject(new Error('recusado'));
          sentTo.push(message.to);
          return Promise.resolve();
        },
      };
      expect(await deliver(half)).toMatchObject({ retrying: 1 });
      await resolve(tenantId);
      clock.now = at(10 * MINUTE_MS);
      expect(await deliver(half)).toMatchObject({ sent: 1, retrying: 0 });
      expect(sentTo).toEqual([person.email]);
      expect((await noticesOf(prisma, tenantId))[0]).toMatchObject({
        status: 'sent',
        lastError: null,
        deliveredUserIds: [person.id],
      });
    });
  });

  describe('falhas e tentativas', () => {
    it('o mesmo recuo e o mesmo failed na quinta; depois de um tempo, o caso ainda pendente avisa de novo', async () => {
      const { tenantId, person, mail, alert, assign, deliver, clock } = await world();
      await alert({ severity: 'critical' });
      await assign();
      const broken = failing();
      expect(await deliver(broken)).toMatchObject({ retrying: 1 });
      for (const delay of NOTIFICATION_RETRY_DELAYS_MS) {
        clock.now = new Date(clock.now.getTime() + delay);
        await deliver(broken);
      }
      const [row] = await noticesOf(prisma, tenantId);
      expect(row).toMatchObject({ status: 'failed', attempts: 5, lastError: 'SmtpError' });
      await prisma.$executeRaw`UPDATE "Notification" SET "updatedAt" = ${clock.now.toISOString()}::timestamptz
        WHERE "tenantId" = ${tenantId}::uuid`;
      clock.now = new Date(clock.now.getTime() + MINUTE_MS);
      expect(await deliver(mail)).toMatchObject({ sent: 0, cases: { opened: 0 } });
      clock.now = new Date(clock.now.getTime() + 6 * HOUR_MS + MINUTE_MS);
      expect(await deliver(mail)).toMatchObject({ sent: 1, cases: { opened: 1 } });
      expect(mail.to(person.email)).toHaveLength(1);
    });

    it('sem e-mail no nó: pulado, e ligar depois não dispara os antigos', async () => {
      const { tenantId, mail, alert, assign, deliver, clock } = await world();
      await alert({ severity: 'critical' });
      await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      await assign();
      expect(await deliver(null)).toMatchObject({ skipped: 2 });
      expect((await noticesOf(prisma, tenantId)).map((row) => row.lastError)).toEqual([
        'mail_disabled',
        'mail_disabled',
      ]);
      clock.now = at(HOUR_MS * 3);
      expect(await deliver(mail)).toMatchObject({ sent: 0, cases: { opened: 0, critical: 0 } });
    });

    it('uma falha nos avisos por caso não segura a entrega, e fica no estado da tarefa', async () => {
      const { tenantId, mail, alert, step, clock } = await world();
      await alert({ severity: 'critical' });
      await step();
      clock.now = at(MINUTE_MS);
      const report = await new NotificationDispatcher(
        prisma,
        { transport: mail, webOrigin: TEST_WEB_ORIGIN },
        {
          now: () => clock.now,
          cases: {
            check: () => {
              const error = new Error('detalhe que não vai para o log');
              error.name = 'CasesDown';
              return Promise.reject(error);
            },
          },
        },
      ).runOnce();
      expect(report).toMatchObject({ status: 'done', sent: 1, casesError: 'CasesDown' });
      expect(report.cases).toBeUndefined();
      expect(mail.messages).toHaveLength(1);
      const state = await prisma.syncState.findUniqueOrThrow({ where: { name: NOTIFICATIONS_TASK } });
      expect(state.lastError).toBe('CasesDown');
      expect(tenantId).not.toBe('');
    });

    it('uma falha ao ler os casos não cala o aviso: ele sai como o do alerta, avulso e no resumo, e o erro aparece', async () => {
      const { tenantId, person, mail, alert, step, notices, clock } = await world();
      for (let i = 0; i < 7; i += 1) await alert({ ruleId: `1003${10 + i}`, severity: 'critical' });
      await step();
      let unreadable = true;
      const broken = new CaseNoticeMail(
        new Proxy(prisma, {
          get(target, property) {
            if (unreadable && (property === '$queryRaw' || property === 'forTenant'))
              return () => {
                throw Object.assign(new Error('detalhe'), { name: 'CasesUnreadable' });
              };
            return Reflect.get(target, property) as unknown;
          },
        }),
      );
      const dispatcher = new NotificationDispatcher(
        prisma,
        { transport: mail, webOrigin: TEST_WEB_ORIGIN },
        { now: () => clock.now, cases: notices, caseMail: broken },
      );
      const run = () => dispatcher.runOnce();
      expect(await run()).toMatchObject({ sent: 7, folded: 2, casesError: 'CasesUnreadable' });
      expect(new Set(mail.to(person.email).map((message) => message.subject))).toEqual(
        new Set(['Alerta de severidade crítica no Verax Control']),
      );
      clock.now = at(HOUR_MS);
      expect(await run()).toMatchObject({ digests: { sent: 1 }, casesError: 'CasesUnreadable' });
      expect(mail.messages.at(-1)?.text).toContain('2 avisos no total');
      const state = await prisma.syncState.findUniqueOrThrow({ where: { name: NOTIFICATIONS_TASK } });
      expect(state.lastError).toBe('CasesUnreadable');
      // Na execução seguinte, com a leitura de volta, o erro sai.
      unreadable = false;
      expect((await run()).casesError).toBeUndefined();
      expect(
        (await prisma.syncState.findUniqueOrThrow({ where: { name: NOTIFICATIONS_TASK } })).lastError,
      ).toBeNull();
      expect(tenantId).not.toBe('');
    });

    it('a parada do worker durante os avisos por caso interrompe a execução, e nada se perde', async () => {
      const { tenantId, mail, alert, assign, deliver, clock } = await world();
      await alert({ severity: 'critical' });
      await assign();
      const controller = new AbortController();
      const dispatcher = new NotificationDispatcher(
        prisma,
        { transport: mail, webOrigin: TEST_WEB_ORIGIN },
        {
          now: () => clock.now,
          cases: {
            check: (_now, signal) => {
              controller.abort();
              signal?.throwIfAborted();
              return Promise.resolve(null);
            },
          },
        },
      );
      await expect(dispatcher.runOnce(controller.signal)).rejects.toThrow();
      expect(await deliver(mail)).toMatchObject({ sent: 1 });
      expect(await noticesOf(prisma, tenantId)).toHaveLength(1);
    });

    it('nenhum endereço, título ou id de caso no relatório que vai para o log', async () => {
      const { tenantId, person, mail, alert, assign, deliver } = await world();
      await alert({ severity: 'critical' });
      await assign();
      const report = JSON.stringify(await deliver(mail));
      const [row] = await casesOf(prisma, tenantId);
      for (const value of [person.email, person.id, tenantId, row?.id ?? '', row?.title ?? ''])
        expect(report).not.toContain(value);
    });
  });

  describe('com os casos desligados de novo (off, shadow ou a versão anterior)', () => {
    it('um aviso de caso que sobrou na fila sai como o do alerta dele, sem ler o caso', async () => {
      const { tenantId, person, mail, alert, step, clock } = await world();
      const id = await alert({ severity: 'critical' });
      await insertVulnerability(prisma, tenantId, { createdAt: T0 });
      await step();
      clock.now = at(MINUTE_MS);
      const untouchable = new Proxy(prisma, {
        get(target, property) {
          if (property === 'alertCase') throw new Error('o caso não pode ser lido');
          return Reflect.get(target, property) as unknown;
        },
      });
      const report = await new NotificationDispatcher(
        untouchable,
        { transport: mail, webOrigin: TEST_WEB_ORIGIN },
        { now: () => clock.now },
      ).runOnce();
      expect(report).toMatchObject({ sent: 2, skipped: 0 });
      expect(mail.to(person.email).map((message) => message.subject)).toEqual([
        'Alerta de severidade crítica no Verax Control',
        'Alerta de severidade crítica no Verax Control',
      ]);
      expect(mail.messages.some((message) => message.text.includes(`${TEST_WEB_ORIGIN}/?alerta=${id}`))).toBe(
        true,
      );
    });
  });

  describe('a primeira vez ligada, com 24 mil alertas em 2 mil casos', () => {
    const CASES = 2_000;
    const ALERTS = 24_000;

    /** 24 mil alertas pendentes em 2 mil casos de detecção (500 deles de críticos), chegados em `createdAt`. */
    async function flood(tenantId: string, createdAt: Date): Promise<void> {
      for (let start = 0; start < ALERTS; start += 4_000) {
        await prisma.finding.createMany({
          data: Array.from({ length: 4_000 }, (_, index) => {
            const number = start + index;
            return findingData(tenantId, {
              createdAt,
              updatedAt: createdAt,
              ruleId: String(300_000 + (number % CASES)),
              severity: number % 4 === 0 ? 'critical' : 'high',
            });
          }),
        });
      }
    }

    it('tudo já avisado alerta por alerta: nenhum e-mail, e os casos ficam marcados', async () => {
      const tenantId = await customer(prisma);
      await member(prisma, tenantId);
      const contact = await confirmContact(tenantId);
      const mail = new MemoryMailTransport();
      const past = new Date(T0.getTime() - 2 * DAY_MS);
      await flood(tenantId, past);
      await prisma.$executeRaw`
        INSERT INTO "Notification" ("id", "tenantId", "kind", "dedupeKey", "severity", "findingId", "status", "attempts",
          "createdAt", "updatedAt")
        SELECT gen_random_uuid(), f."tenantId",
          (CASE WHEN f."severity" = 'critical' THEN 'critical_finding' ELSE 'high_finding' END)::"NotificationKind",
          'finding:' || f."id"::text, f."severity", f."id", 'sent', 1, f."createdAt", f."createdAt"
        FROM "Finding" AS f WHERE f."tenantId" = ${tenantId}::uuid`;
      const made = noticeWorld(prisma, [tenantId], T0);
      await made.assign();
      for (let hour = 0; hour <= 3; hour += 1) {
        made.clock.now = at(hour * HOUR_MS);
        expect(await made.deliver(mail)).toMatchObject({ due: 0, sent: 0, cases: { opened: 0 } });
      }
      expect(mail.messages).toEqual([]);
      expect(mail.to(contact)).toEqual([]);
      const cases = await casesOf(prisma, tenantId);
      expect(cases).toHaveLength(CASES);
      expect(cases.filter((row) => row.noticedSeverity === null)).toEqual([]);
    }, 300_000);

    it('tudo ainda na fila, alerta por alerta: um aviso por caso no lugar, e no máximo cinco e-mails por pessoa na hora, e o resumo', async () => {
      const tenantId = await customer(prisma);
      const people = [await member(prisma, tenantId), await member(prisma, tenantId, 'analista_cliente')];
      const contact = await confirmContact(tenantId);
      const mail = new MemoryMailTransport();
      await flood(tenantId, T0);
      await prisma.$executeRaw`
        INSERT INTO "Notification" ("id", "tenantId", "kind", "dedupeKey", "severity", "findingId", "createdAt",
          "nextAttemptAt", "updatedAt")
        SELECT gen_random_uuid(), f."tenantId",
          (CASE WHEN f."severity" = 'critical' THEN 'critical_finding' ELSE 'high_finding' END)::"NotificationKind",
          'finding:' || f."id"::text, f."severity", f."id", f."createdAt", f."createdAt", f."createdAt"
        FROM "Finding" AS f WHERE f."tenantId" = ${tenantId}::uuid`;
      const made = noticeWorld(prisma, [tenantId], at(MINUTE_MS));
      await made.assign();
      for (let minute = 1; minute < 59; minute += 1) {
        made.clock.now = at(minute * MINUTE_MS);
        await made.deliver(mail);
        if ((await prisma.notification.count({ where: { status: 'pending' } })) === 0) break;
      }
      const count = (where: Prisma.NotificationWhereInput) =>
        prisma.notification.count({ where: { ...where, tenantId } });
      const ofAlert = { dedupeKey: { startsWith: 'finding:' } };
      const superseded = await count({ ...ofAlert, lastError: 'superseded_by_case' });
      // Com a máquina muito ocupada, um lote pode passar do prazo, e o aviso de alerta sai no lugar dele: nunca se perde.
      expect(superseded + (await count({ ...ofAlert, status: 'sent' }))).toBe(ALERTS);
      expect(superseded).toBeGreaterThan(ALERTS / 2);
      expect(await count({ status: 'pending' })).toBe(0);
      expect(await count({ caseId: { not: null } })).toBeLessThanOrEqual(CASES);
      expect((await casesOf(prisma, tenantId)).filter((row) => row.noticedSeverity === null)).toEqual([]);
      for (const person of people) expect(mail.to(person.email)).toHaveLength(5);
      expect(mail.to(contact)).toHaveLength(5);
      made.clock.now = at(HOUR_MS);
      await made.deliver(mail);
      for (const person of people) {
        expect(mail.to(person.email)).toHaveLength(6);
        expect(mail.to(person.email).at(-1)?.subject).toBe('Resumo dos avisos da hora no Verax Control');
      }
      // Nas horas seguintes, mais nada.
      for (let hour = 2; hour <= 4; hour += 1) {
        made.clock.now = at(hour * HOUR_MS);
        await made.deliver(mail);
      }
      expect(mail.messages).toHaveLength(2 * 6 + 5);
    }, 600_000);

    it('24 mil alertas novos numa hora, com os avisos por caso: os mesmos limites', async () => {
      const tenantId = await customer(prisma);
      const person = await member(prisma, tenantId);
      const contact = await confirmContact(tenantId);
      const mail = new MemoryMailTransport();
      const made = noticeWorld(prisma, [tenantId], at(-DAY_MS));
      await made.activate();
      await flood(tenantId, T0);
      made.clock.now = at(MINUTE_MS);
      await made.assign();
      for (let minute = 1; minute < 10; minute += 1) {
        made.clock.now = at(minute * MINUTE_MS);
        await made.deliver(mail);
      }
      made.clock.now = at(HOUR_MS);
      await made.deliver(mail);
      expect(mail.to(person.email)).toHaveLength(6);
      expect(mail.to(contact)).toHaveLength(5);
      expect(await prisma.notification.count({ where: { tenantId } })).toBe(CASES);
      expect((await casesOf(prisma, tenantId)).every((row) => row.noticedSeverity !== null)).toBe(true);
    }, 600_000);
  });
});
