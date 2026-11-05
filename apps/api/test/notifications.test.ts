import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore, SyncLease } from '../src/alerts/finding-store.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import {
  escalationContactUpdate,
  queueEscalationConfirmation,
} from '../src/escalation/escalation-contact-store.js';
import { escalationTokenHash, mintEscalationTokens } from '../src/escalation/escalation-tokens.js';
import type { UserRole, UserStatus } from '../src/generated/prisma/client.js';
import { IncidentGrouping } from '../src/incidents/incident-grouping.js';
import type { MailMessage, MailTransport } from '../src/mail/mail.types.js';
import {
  hourStartOf,
  NOTIFICATION_RETRY_DELAYS_MS,
  NOTIFICATIONS_TASK,
  NotificationDispatcher,
  type NotificationDispatcherOptions,
} from '../src/notifications/notification-dispatcher.js';
import { BYTES_PER_GIB, UsageNotices } from '../src/notifications/usage-notices.js';
import { UsageMeter } from '../src/usage/usage-meter.js';
import { Scheduler } from '../src/worker/scheduler.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { MemoryMailTransport } from './support/memory-mail.js';

/**
 * Avisos por e-mail (fase 2, PR-16): a fila de saída gravada junto com o achado e o incidente, e a tarefa
 * `notifications` que entrega. O banco de teste é o mesmo dos outros arquivos, que também gravam achados (e, agora,
 * avisos): os testes conferem só os avisos e as caixas dos próprios clientes, e o despachante lê um lote grande.
 */
describe('avisos por e-mail (outbox)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let store: FindingStore;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    store = new FindingStore(prisma, new IncidentGrouping());
  });

  afterAll(async () => {
    await app.close();
  });

  /** IP numa faixa de documentação que nenhum outro teste usa: o achado só se junta aos deste arquivo. */
  const ip = () => `203.0.113.${randomInt(1, 254)}`;

  function draft(tenantId: string, overrides: Partial<FindingDraft> = {}): FindingDraft {
    return {
      tenantId,
      accountId: '111111111111',
      source: 'wazuh',
      sourceEventId: `teste-avisos/${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      severity: 'high',
      ruleId: '80202',
      ruleLevel: 10,
      title: 'Achado de teste',
      logSource: 'cloudtrail',
      eventName: 'ConsoleLogin',
      region: 'sa-east-1',
      resource: null,
      actorUser: null,
      actorType: null,
      accessKeyId: null,
      sourceIp: null,
      mitreTactics: [],
      mitreTechniques: [],
      ...overrides,
    };
  }

  const noticesOf = (tenantId: string) =>
    prisma.forTenant(tenantId).notification.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  const persist = (finding: FindingDraft) => store.persist(finding, null, new Set(), new Date());

  interface Member {
    id: string;
    email: string;
  }

  /** Pessoa do cliente gravada direto no banco (o despachante só lê a tabela de usuários). */
  async function member(
    tenantId: string | null,
    role: UserRole,
    {
      status = 'active',
      mfa = true,
      mustChangePassword = false,
      name = 'Pessoa de teste',
    }: { status?: UserStatus; mfa?: boolean; mustChangePassword?: boolean; name?: string } = {},
  ): Promise<Member> {
    const email = `avisos-${randomUUID()}@cliente.example`;
    const { id } = await prisma.user.create({
      data: {
        id: randomUUID(),
        name,
        email,
        role,
        tenantId,
        status,
        twoFactorEnabled: mfa,
        mustChangePassword,
      },
      select: { id: true },
    });
    return { id, email };
  }

  /** O e-mail ligado, com a caixa dada, o lote grande e o relógio dado (sem o volume do plano, salvo pedido). */
  const dispatcher = (
    transport: MailTransport | null,
    now: Date,
    options: NotificationDispatcherOptions = {},
  ) =>
    new NotificationDispatcher(
      prisma,
      transport === null ? null : { transport, webOrigin: TEST_WEB_ORIGIN },
      { batch: 1000, now: () => now, ...options },
    );

  /** Um minuto à frente: todo aviso já gravado está vencido, com folga para o relógio do banco. */
  const soon = () => new Date(Date.now() + 60_000);

  describe('gravação junto com o achado (todos os coletores passam por aqui)', () => {
    it('incidente alto aberto gera 1 aviso; reler o mesmo achado gera 0', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (aviso ao abrir)');
      const finding = draft(tenantId, { severity: 'high', sourceIp: ip() });
      expect(await persist(finding)).toBe('opened');
      const incident = await prisma.forTenant(tenantId).incident.findFirstOrThrow({ select: { id: true } });
      expect(await noticesOf(tenantId)).toEqual([
        expect.objectContaining({
          kind: 'incident_opened',
          dedupeKey: `incident:${incident.id}:high`,
          severity: 'high',
          incidentId: incident.id,
          findingId: null,
          status: 'pending',
          attempts: 0,
          deliveredUserIds: [],
        }),
      ]);

      expect(await persist(finding)).toBe('duplicate');
      expect(await noticesOf(tenantId)).toHaveLength(1);
    });

    it('médio que sobe para alto gera 1, alto que sobe para crítico gera mais 1; junção sem mudança gera 0', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (aviso ao subir)');
      const sourceIp = ip();
      expect(await persist(draft(tenantId, { severity: 'medium', sourceIp }))).toBe('opened');
      expect(await noticesOf(tenantId)).toEqual([]);

      expect(await persist(draft(tenantId, { severity: 'high', sourceIp }))).toBe('joined');
      const incident = await prisma.forTenant(tenantId).incident.findFirstOrThrow({ select: { id: true } });
      expect((await noticesOf(tenantId)).map(({ kind, dedupeKey }) => ({ kind, dedupeKey }))).toEqual([
        { kind: 'incident_escalated', dedupeKey: `incident:${incident.id}:high` },
      ]);

      // Junção sem mudança de severidade: outro alto, e um baixo.
      expect(await persist(draft(tenantId, { severity: 'high', sourceIp }))).toBe('joined');
      expect(await persist(draft(tenantId, { severity: 'low', sourceIp }))).toBe('joined');
      expect(await noticesOf(tenantId)).toHaveLength(1);

      expect(await persist(draft(tenantId, { severity: 'critical', sourceIp }))).toBe('joined');
      expect((await noticesOf(tenantId)).map(({ kind, severity }) => ({ kind, severity }))).toEqual([
        { kind: 'incident_escalated', severity: 'high' },
        { kind: 'incident_escalated', severity: 'critical' },
      ]);
      expect(await persist(draft(tenantId, { severity: 'critical', sourceIp }))).toBe('joined');
      expect(await noticesOf(tenantId)).toHaveLength(2);
    });

    it('crítico sem chave (fora de incidente) gera 1, pelo achado; alto sem chave gera 0', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (crítico sem chave)');
      const critical = draft(tenantId, { severity: 'critical' });
      expect(await persist(critical)).toBe('none');
      expect(await persist(draft(tenantId, { severity: 'high' }))).toBe('none');
      const finding = await prisma.forTenant(tenantId).finding.findUniqueOrThrow({
        where: { source_sourceEventId: { source: 'wazuh', sourceEventId: critical.sourceEventId } },
        select: { id: true },
      });
      expect(await noticesOf(tenantId)).toEqual([
        expect.objectContaining({
          kind: 'critical_finding',
          dedupeKey: `finding:${finding.id}`,
          severity: 'critical',
          findingId: finding.id,
          incidentId: null,
        }),
      ]);
      expect(await persist(critical)).toBe('duplicate');
      expect(await noticesOf(tenantId)).toHaveLength(1);
    });

    it('incidente crítico aberto gera 1 aviso de abertura, e não de subida', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (crítico ao abrir)');
      expect(await persist(draft(tenantId, { severity: 'critical', sourceIp: ip() }))).toBe('opened');
      expect((await noticesOf(tenantId)).map(({ kind, severity }) => ({ kind, severity }))).toEqual([
        { kind: 'incident_opened', severity: 'critical' },
      ]);
    });
  });

  describe('entrega', () => {
    it('só administradores e analistas ativos do cliente, com MFA e sem troca de senha pendente; nada de B', async () => {
      const tenantA = await createTenant(app, 'Cliente demo A (destinatários)');
      const tenantB = await createTenant(app, 'Cliente demo B (destinatários)');
      const admin = await member(tenantA, 'admin_cliente', { name: 'Ana' });
      const analyst = await member(tenantA, 'analista_cliente');
      const excluded = [
        await member(tenantA, 'leitura'),
        await member(tenantA, 'admin_cliente', { mfa: false }),
        await member(tenantA, 'analista_cliente', { status: 'disabled' }),
        await member(tenantA, 'admin_cliente', { status: 'invited' }),
        await member(tenantA, 'admin_cliente', { mustChangePassword: true }),
        await member(tenantB, 'admin_cliente'),
        await member(tenantB, 'analista_cliente'),
        await member(null, 'admin_verax'),
      ];
      const finding = draft(tenantA, {
        severity: 'high',
        sourceIp: ip(),
        actorUser: 'arn:aws:iam::111111111111:user/usuario-ficticio',
        accessKeyId: 'DEMOKEYID0000EXAMPLE',
        resource: 's3:bucket-ficticio-de-relatorios',
      });
      await persist(finding);
      const [notice] = await noticesOf(tenantA);
      if (notice === undefined) throw new Error('aviso não gravado');

      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();

      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(analyst.email)).toHaveLength(1);
      for (const person of excluded) expect(mailbox.to(person.email)).toEqual([]);

      const message = mailbox.to(admin.email)[0] as MailMessage;
      const link = `${TEST_WEB_ORIGIN}/incidentes/${notice.incidentId}`;
      expect(message.subject).toBe('Incidente de severidade alta aberto no Verax Control');
      expect(message.text).toContain('Olá, Ana.');
      expect(message.text).toContain(`Ver o incidente: ${link}`);
      expect(message.html).toContain(`<a href="${link}">Ver o incidente</a>`);
      // Nada do achado no e-mail: IP, usuário, chave, recurso, conta, título ou região.
      for (const value of [
        finding.sourceIp,
        finding.actorUser,
        finding.accessKeyId,
        finding.resource,
        finding.accountId,
        finding.title,
        finding.region,
        finding.eventName,
      ]) {
        expect(`${message.subject}\n${message.text}\n${message.html}`).not.toContain(value as string);
      }

      const sent = await prisma
        .forTenant(tenantA)
        .notification.findUniqueOrThrow({ where: { id: notice.id } });
      expect(sent).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
      expect(sent.sentAt).not.toBeNull();
      expect([...sent.deliveredUserIds].sort()).toEqual([admin.id, analyst.id].sort());

      // Outra execução: o aviso já saiu, ninguém recebe de novo.
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(analyst.email)).toHaveLength(1);
    });

    it('achado crítico: link para o achado no painel', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (link do achado)');
      const analyst = await member(tenantId, 'analista_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const [notice] = await noticesOf(tenantId);
      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();
      const [message] = mailbox.to(analyst.email);
      expect(message?.subject).toBe('Achado de severidade crítica no Verax Control');
      expect(message?.text).toContain(`Ver o achado: ${TEST_WEB_ORIGIN}/achados?achado=${notice?.findingId}`);
    });

    it('MAIL_TRANSPORT=none: o aviso fica skipped, sem nenhum envio', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (sem e-mail)');
      await member(tenantId, 'admin_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const report = await dispatcher(null, soon()).runOnce();
      expect(report.status).toBe('done');
      expect(await noticesOf(tenantId)).toEqual([
        expect.objectContaining({ status: 'skipped', lastError: 'mail_disabled', attempts: 0 }),
      ]);
    });

    it('ninguém para receber (só leitura, ou o cliente desativado): skipped', async () => {
      const onlyReaders = await createTenant(app, 'Cliente demo A (só leitura)');
      await member(onlyReaders, 'leitura');
      await persist(draft(onlyReaders, { severity: 'critical' }));
      const inactive = await createTenant(app, 'Cliente demo A (desativado)');
      const admin = await member(inactive, 'admin_cliente');
      await persist(draft(inactive, { severity: 'critical' }));
      await prisma.tenant.update({ where: { id: inactive }, data: { status: 'inactive' } });

      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(admin.email)).toEqual([]);
      for (const tenantId of [onlyReaders, inactive]) {
        expect(await noticesOf(tenantId)).toEqual([
          expect.objectContaining({ status: 'skipped', lastError: 'no_recipients' }),
        ]);
      }
    });

    it('falha do transporte: nova tentativa depois de 1, 5, 15 e 60 min, e failed na quinta; só o tipo do erro fica', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (falha do envio)');
      const admin = await member(tenantId, 'admin_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const [notice] = await noticesOf(tenantId);
      if (notice === undefined) throw new Error('aviso não gravado');

      let attemptsToAdmin = 0;
      const failing: MailTransport = {
        send: (message) => {
          if (message.to === admin.email) attemptsToAdmin += 1;
          // A mensagem do servidor cita o endereço: ela não pode ir para o banco nem para o log.
          return Promise.reject(new Error(`550 5.1.1 <${message.to}>: Recipient address rejected`));
        },
      };
      const read = () =>
        prisma.forTenant(tenantId).notification.findUniqueOrThrow({ where: { id: notice.id } });

      let at = soon();
      for (const [index, delay] of NOTIFICATION_RETRY_DELAYS_MS.entries()) {
        await dispatcher(failing, at).runOnce();
        const row = await read();
        expect(row).toMatchObject({ status: 'pending', attempts: index + 1, lastError: 'Error' });
        expect(row.nextAttemptAt.getTime()).toBe(at.getTime() + delay);
        // Antes do recuo, o aviso não é tentado de novo.
        await dispatcher(failing, new Date(row.nextAttemptAt.getTime() - 1000)).runOnce();
        expect(attemptsToAdmin).toBe(index + 1);
        at = row.nextAttemptAt;
      }
      await dispatcher(failing, at).runOnce();
      const failed = await read();
      expect(failed).toMatchObject({ status: 'failed', attempts: 5, lastError: 'Error', sentAt: null });
      expect(failed.lastError).not.toContain('@');
      expect(attemptsToAdmin).toBe(5);

      // Depois de failed, nenhuma tentativa a mais.
      await dispatcher(failing, new Date(at.getTime() + 24 * 60 * 60 * 1000)).runOnce();
      expect(attemptsToAdmin).toBe(5);
    });

    it('falha só para uma pessoa: a nova tentativa vai só para ela', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (falha parcial)');
      const admin = await member(tenantId, 'admin_cliente');
      const analyst = await member(tenantId, 'analista_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      const partial: MailTransport = {
        send: (message) =>
          message.to === analyst.email ? Promise.reject(new Error('timeout')) : mailbox.send(message),
      };
      const at = soon();
      await dispatcher(partial, at).runOnce();
      expect(await noticesOf(tenantId)).toEqual([
        expect.objectContaining({ status: 'pending', attempts: 1, deliveredUserIds: [admin.id] }),
      ]);

      await dispatcher(mailbox, new Date(at.getTime() + NOTIFICATION_RETRY_DELAYS_MS[0]!)).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(analyst.email)).toHaveLength(1);
      const [sent] = await noticesOf(tenantId);
      expect(sent).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
      expect([...(sent?.deliveredUserIds ?? [])].sort()).toEqual([admin.id, analyst.id].sort());
    });

    it('nenhum e-mail no log do worker, nem com a mensagem do servidor citando o endereço', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (log)');
      const admin = await member(tenantId, 'admin_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const lines: string[] = [];
      const capture = (level: string) => (fields: object, message: string) =>
        lines.push(JSON.stringify({ level, ...fields, message }));
      const failing: MailTransport = {
        send: (message) => Promise.reject(new Error(`550 5.1.1 <${message.to}>: Recipient address rejected`)),
      };
      const task = dispatcher(failing, soon());
      const scheduler = new Scheduler(
        [
          {
            name: NOTIFICATIONS_TASK,
            intervalMs: 3_600_000,
            budgetMs: 60_000,
            run: (signal) => task.runOnce(signal),
          },
        ],
        { info: capture('info'), warn: capture('warn'), error: capture('error') },
      );
      scheduler.start();
      await expect.poll(() => lines.length, { timeout: 20_000 }).toBeGreaterThan(0);
      await scheduler.stop();

      const log = lines.join('\n');
      expect(log).toContain('"task":"notifications"');
      expect(log).toContain('"report"');
      expect(log).not.toContain(admin.email);
      expect(log).not.toContain('@');
    });

    it('quem recebeu numa tentativa e depois saiu do cliente: o aviso termina sent, sem repetir o e-mail', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (saiu depois)');
      const admin = await member(tenantId, 'admin_cliente');
      const analyst = await member(tenantId, 'analista_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      const at = soon();
      await dispatcher(
        {
          send: (message) =>
            message.to === analyst.email ? Promise.reject(new Error('timeout')) : mailbox.send(message),
        },
        at,
      ).runOnce();
      // O analista é desativado antes da nova tentativa: não sobra ninguém a receber.
      await prisma.user.update({ where: { id: analyst.id }, data: { status: 'disabled' } });
      await prisma.user.update({ where: { id: admin.id }, data: { twoFactorEnabled: false } });
      await dispatcher(mailbox, new Date(at.getTime() + 60_000)).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(analyst.email)).toEqual([]);
      expect(await noticesOf(tenantId)).toEqual([
        expect.objectContaining({ status: 'sent', attempts: 2, deliveredUserIds: [admin.id] }),
      ]);
    });

    /** Duas pessoas do cliente, na ordem em que o despachante envia (pelo id). */
    async function twoRecipients(tenantId: string): Promise<[Member, Member]> {
      const people = [await member(tenantId, 'admin_cliente'), await member(tenantId, 'analista_cliente')];
      const [first, second] = people.sort((x, y) => (x.id < y.id ? -1 : 1));
      return [first as Member, second as Member];
    }

    const budgetExceeded = () => new DOMException('a tarefa passou do orçamento de tempo', 'TimeoutError');
    const read = (tenantId: string, id: string) =>
      prisma.forTenant(tenantId).notification.findUniqueOrThrow({ where: { id } });

    it('interrompida no meio: grava a tentativa com o recuo, guarda quem recebeu e não reenvia', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (interrompida)');
      const [first, second] = await twoRecipients(tenantId);
      await persist(draft(tenantId, { severity: 'critical' }));
      const [notice] = await noticesOf(tenantId);
      if (notice === undefined) throw new Error('aviso não gravado');
      const mailbox = new MemoryMailTransport();
      const controller = new AbortController();
      const reason = budgetExceeded();
      // O orçamento da tarefa estoura durante o envio para a primeira pessoa.
      const slow: MailTransport = {
        send: async (message) => {
          await mailbox.send(message);
          if (message.to === first.email) controller.abort(reason);
        },
      };
      const at = soon();
      await expect(dispatcher(slow, at).runOnce(controller.signal)).rejects.toBe(reason);

      const interrupted = await read(tenantId, notice.id);
      expect(interrupted).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'TimeoutError',
        deliveredUserIds: [first.id],
      });
      expect(interrupted.nextAttemptAt.getTime()).toBe(at.getTime() + NOTIFICATION_RETRY_DELAYS_MS[0]!);
      expect(mailbox.to(second.email)).toEqual([]);
      const state = await prisma.syncState.findUniqueOrThrow({ where: { name: NOTIFICATIONS_TASK } });
      expect(state).toMatchObject({ leaseOwner: null, lastError: 'TimeoutError' });

      // Antes do recuo, nada; depois dele, só quem faltava recebe.
      await dispatcher(mailbox, new Date(at.getTime() + 30_000)).runOnce();
      expect(mailbox.to(second.email)).toEqual([]);
      await dispatcher(mailbox, interrupted.nextAttemptAt).runOnce();
      expect(mailbox.to(first.email)).toHaveLength(1);
      expect(mailbox.to(second.email)).toHaveLength(1);
      expect(await read(tenantId, notice.id)).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
    });

    it('interrompida a cada execução: recua, termina failed na quinta e não segura o aviso seguinte', async () => {
      const stuckTenant = await createTenant(app, 'Cliente demo A (aviso preso)');
      const [stuck, waiting] = await twoRecipients(stuckTenant);
      await persist(draft(stuckTenant, { severity: 'critical' }));
      const [stuckNotice] = await noticesOf(stuckTenant);
      if (stuckNotice === undefined) throw new Error('aviso não gravado');
      // O aviso seguinte nasce depois: o preso é o mais antigo da fila.
      const laterTenant = await createTenant(app, 'Cliente demo B (aviso seguinte)');
      const later = await member(laterTenant, 'admin_cliente');
      await persist(draft(laterTenant, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      let attemptsToStuck = 0;
      /** Uma execução em que o envio para a primeira pessoa do aviso preso só falha depois do orçamento da tarefa. */
      const run = (at: Date) => {
        const controller = new AbortController();
        const transport: MailTransport = {
          send: (message) => {
            if (message.to !== stuck.email) return mailbox.send(message);
            attemptsToStuck += 1;
            controller.abort(budgetExceeded());
            return Promise.reject(new Error('timeout'));
          },
        };
        return dispatcher(transport, at)
          .runOnce(controller.signal)
          .catch((error: unknown) => error);
      };

      let at = soon();
      expect(await run(at)).toBeInstanceOf(DOMException);
      // Na execução seguinte, o preso está no recuo, e o aviso seguinte sai.
      await run(new Date(at.getTime() + 1000));
      expect(mailbox.to(later.email)).toHaveLength(1);

      for (const [index, delay] of NOTIFICATION_RETRY_DELAYS_MS.entries()) {
        const row = await read(stuckTenant, stuckNotice.id);
        expect(row).toMatchObject({ status: 'pending', attempts: index + 1, lastError: 'TimeoutError' });
        expect(row.nextAttemptAt.getTime()).toBe(at.getTime() + delay);
        at = row.nextAttemptAt;
        await run(at);
      }
      const failed = await read(stuckTenant, stuckNotice.id);
      expect(failed).toMatchObject({ status: 'failed', attempts: 5, deliveredUserIds: [] });
      expect(attemptsToStuck).toBe(5);
      expect(mailbox.to(waiting.email)).toEqual([]);
      await run(new Date(at.getTime() + 24 * 60 * 60 * 1000));
      expect(attemptsToStuck).toBe(5);
    });

    it('prazo de envio de um aviso esgotado: quem falta fica para a próxima tentativa, e o lote segue', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (prazo do aviso)');
      const [first, second] = await twoRecipients(tenantId);
      await persist(draft(tenantId, { severity: 'critical' }));
      const [notice] = await noticesOf(tenantId);
      if (notice === undefined) throw new Error('aviso não gravado');
      const laterTenant = await createTenant(app, 'Cliente demo B (depois do prazo)');
      const later = await member(laterTenant, 'admin_cliente');
      await persist(draft(laterTenant, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      const at = soon();
      // Prazo zero: cada aviso envia para uma pessoa só por execução.
      await dispatcher(mailbox, at, { deliveryBudgetMs: 0 }).runOnce();
      expect(mailbox.to(first.email)).toHaveLength(1);
      expect(mailbox.to(second.email)).toEqual([]);
      expect(mailbox.to(later.email)).toHaveLength(1);
      const cut = await read(tenantId, notice.id);
      expect(cut).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'delivery_timeout',
        deliveredUserIds: [first.id],
      });
      expect(cut.nextAttemptAt.getTime()).toBe(at.getTime() + NOTIFICATION_RETRY_DELAYS_MS[0]!);

      await dispatcher(mailbox, cut.nextAttemptAt).runOnce();
      expect(mailbox.to(first.email)).toHaveLength(1);
      expect(mailbox.to(second.email)).toHaveLength(1);
      expect(await read(tenantId, notice.id)).toMatchObject({ status: 'sent', attempts: 2 });
    });

    it('uma falha no cálculo do volume não segura os avisos de incidente', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (volume falhou)');
      const admin = await member(tenantId, 'admin_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const broken = {
        check: () => Promise.reject(new Error('banco caiu no meio')),
      } as unknown as UsageNotices;
      const mailbox = new MemoryMailTransport();
      const report = await dispatcher(mailbox, soon(), { usage: broken }).runOnce();
      expect(report).toMatchObject({ status: 'done', usageError: 'Error' });
      expect(mailbox.to(admin.email)).toHaveLength(1);
      const state = await prisma.syncState.findUniqueOrThrow({ where: { name: NOTIFICATIONS_TASK } });
      expect(state).toMatchObject({ lastError: 'Error', leaseOwner: null });
    });

    it('a concessão no banco deixa um worker por vez', async () => {
      const other = new SyncLease(prisma, NOTIFICATIONS_TASK, 'outro-worker', 60_000);
      const now = new Date();
      expect(await other.acquire(now)).toBe(true);
      try {
        expect((await dispatcher(new MemoryMailTransport(), now).runOnce()).status).toBe('locked');
      } finally {
        await other.release();
      }
    });

    it('concessão perdida no meio da execução: os avisos que faltam ficam para quem a tomou', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (concessão perdida)');
      const admin = await member(tenantId, 'admin_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const laterTenant = await createTenant(app, 'Cliente demo B (concessão perdida)');
      const later = await member(laterTenant, 'admin_cliente');
      await persist(draft(laterTenant, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      // Outra réplica toma a concessão (a desta venceu) enquanto o primeiro aviso sai.
      const stealing: MailTransport = {
        send: async (message) => {
          await mailbox.send(message);
          if (message.to === admin.email) {
            await prisma.syncState.update({
              where: { name: NOTIFICATIONS_TASK },
              data: { leaseOwner: 'outra-replica', leaseUntil: new Date(Date.now() + 60_000) },
            });
          }
        },
      };
      try {
        await dispatcher(stealing, soon()).runOnce();
      } finally {
        await new SyncLease(prisma, NOTIFICATIONS_TASK, 'outra-replica', 60_000).release();
      }
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(later.email)).toEqual([]);
      expect(await noticesOf(laterTenant)).toEqual([
        expect.objectContaining({ status: 'pending', attempts: 0 }),
      ]);
    });
  });

  describe('volume do plano: 80% e 100% do mês, uma vez cada, só para quem administra', () => {
    // Meses longe de qualquer outro teste: o cálculo lê o uso de todos os clientes do banco.
    const at = (month: string, day = 10) =>
      new Date(`${month}-${String(day).padStart(2, '0')}T15:00:00.000Z`);
    const gib = (value: number) => Math.round(value * Number(BYTES_PER_GIB));

    async function addUsage(tenantId: string, bytes: number, when: Date): Promise<void> {
      const meter = new UsageMeter();
      meter.add(tenantId, 'gcp', bytes, 1, when);
      await meter.flush(prisma);
    }

    const run = (mailbox: MailTransport, now: Date, monthlyGib: number | null = 1) =>
      dispatcher(mailbox, now, { usage: new UsageNotices(prisma, monthlyGib) }).runOnce();

    it('80% uma vez, depois 100% uma vez; o mês seguinte começa de novo', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (volume)');
      const admin = await member(tenantId, 'admin_cliente');
      const analyst = await member(tenantId, 'analista_cliente');
      const mailbox = new MemoryMailTransport();
      const subjects = () => mailbox.to(admin.email).map((message) => message.subject);

      await addUsage(tenantId, gib(0.5), at('2031-03'));
      await run(mailbox, at('2031-03'));
      expect(subjects()).toEqual([]);

      await addUsage(tenantId, gib(0.35), at('2031-03'));
      await run(mailbox, at('2031-03', 11));
      await run(mailbox, at('2031-03', 12));
      expect(subjects()).toEqual(['80% do volume mensal do plano no Verax Control']);
      expect(mailbox.to(admin.email)[0]?.text).toContain('março de 2031');

      await addUsage(tenantId, gib(0.3), at('2031-03', 20));
      await run(mailbox, at('2031-03', 20));
      await run(mailbox, at('2031-03', 21));
      expect(subjects()).toEqual([
        '80% do volume mensal do plano no Verax Control',
        'Volume mensal do plano atingido no Verax Control',
      ]);
      // O volume do plano vai só para quem administra o cliente.
      expect(mailbox.to(analyst.email)).toEqual([]);
      expect(
        (await noticesOf(tenantId)).map(({ dedupeKey, status, usagePercent }) => ({
          dedupeKey,
          status,
          usagePercent,
        })),
      ).toEqual([
        { dedupeKey: 'usage:2031-03:80', status: 'sent', usagePercent: 80 },
        { dedupeKey: 'usage:2031-03:100', status: 'sent', usagePercent: 100 },
      ]);

      // Abril: o mês vira às 03:00 UTC do dia 1º, e o aviso de 80% volta a valer.
      await addUsage(tenantId, gib(0.9), new Date('2031-04-01T03:00:00.000Z'));
      await run(mailbox, at('2031-04', 2));
      await run(mailbox, at('2031-04', 3));
      expect(subjects()).toHaveLength(3);
      expect(mailbox.to(admin.email)[2]?.text).toContain('abril de 2031');
    });

    it('salto direto para 100%: sai só o aviso de 100%, e o de 80% fica coberto', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (salto)');
      const admin = await member(tenantId, 'admin_cliente');
      const mailbox = new MemoryMailTransport();
      await addUsage(tenantId, gib(2), at('2031-05'));
      await run(mailbox, at('2031-05'));
      await run(mailbox, at('2031-05', 11));
      expect(mailbox.to(admin.email).map((message) => message.subject)).toEqual([
        'Volume mensal do plano atingido no Verax Control',
      ]);
      expect(
        (await noticesOf(tenantId)).map(({ dedupeKey, status, lastError }) => [dedupeKey, status, lastError]),
      ).toEqual([
        ['usage:2031-05:80', 'skipped', 'superseded'],
        ['usage:2031-05:100', 'sent', null],
      ]);
    });

    it('acima de 100%, nada deixa de ser gravado: o medidor soma e os achados entram', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (acima do limite)');
      await member(tenantId, 'admin_cliente');
      await addUsage(tenantId, gib(3), at('2031-06'));
      await run(new MemoryMailTransport(), at('2031-06'));
      await addUsage(tenantId, gib(1), at('2031-06', 11));
      const [usage] = await prisma.forTenant(tenantId).ingestUsage.findMany({ select: { bytes: true } });
      expect(usage?.bytes).toBe(BigInt(gib(4)));
      expect(await persist(draft(tenantId, { severity: 'high', sourceIp: ip() }))).toBe('opened');
      expect((await noticesOf(tenantId)).map(({ kind }) => kind).sort()).toEqual([
        'incident_opened',
        'plan_usage',
        'plan_usage',
      ]);
    });

    it('plano sem limite de volume (interno): nenhum aviso', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (interno)');
      await addUsage(tenantId, gib(500), at('2031-07'));
      expect((await run(new MemoryMailTransport(), at('2031-07'), null)).usageNotices).toBe(0);
      expect(await noticesOf(tenantId)).toEqual([]);
    });

    it('A/B: o volume de B nunca avisa A', async () => {
      const tenantA = await createTenant(app, 'Cliente demo A (volume A/B)');
      const tenantB = await createTenant(app, 'Cliente demo B (volume A/B)');
      const adminA = await member(tenantA, 'admin_cliente');
      const adminB = await member(tenantB, 'admin_cliente');
      await addUsage(tenantA, gib(0.1), at('2031-08'));
      await addUsage(tenantB, gib(0.95), at('2031-08'));
      const mailbox = new MemoryMailTransport();
      await run(mailbox, at('2031-08'));
      expect(mailbox.to(adminA.email)).toEqual([]);
      expect(mailbox.to(adminB.email)).toHaveLength(1);
      expect(await noticesOf(tenantA)).toEqual([]);
    });
  });

  describe('isolamento por cliente (A/B)', () => {
    it('o escopo de B não lê nem altera o aviso de A, e não grava aviso em A', async () => {
      const tenantA = await createTenant(app, 'Cliente demo A (escopo)');
      const tenantB = await createTenant(app, 'Cliente demo B (escopo)');
      await persist(draft(tenantA, { severity: 'critical' }));
      const [notice] = await noticesOf(tenantA);
      if (notice === undefined) throw new Error('aviso não gravado');

      const asB = prisma.forTenant(tenantB).notification;
      expect(await asB.findMany({ where: { id: notice.id } })).toEqual([]);
      expect((await asB.updateMany({ where: { id: notice.id }, data: { status: 'skipped' } })).count).toBe(0);
      expect(() =>
        asB.create({
          data: { tenantId: tenantA, kind: 'aws_ingestion_stalled', dedupeKey: `teste:${randomUUID()}` },
        }),
      ).toThrow(TenantScopeViolation);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).status).toBe(
        'pending',
      );
    });

    it('o banco recusa aviso de B apontando para o incidente ou o achado de A, e alvo fora do tipo', async () => {
      const tenantA = await createTenant(app, 'Cliente demo A (banco)');
      const tenantB = await createTenant(app, 'Cliente demo B (banco)');
      await persist(draft(tenantA, { severity: 'high', sourceIp: ip() }));
      const incident = await prisma.forTenant(tenantA).incident.findFirstOrThrow({ select: { id: true } });
      const finding = await prisma.forTenant(tenantA).finding.findFirstOrThrow({ select: { id: true } });
      const key = () => `teste:${randomUUID()}`;

      await expect(
        prisma.notification.create({
          data: {
            tenantId: tenantB,
            kind: 'incident_opened',
            dedupeKey: key(),
            severity: 'high',
            incidentId: incident.id,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.notification.create({
          data: {
            tenantId: tenantB,
            kind: 'critical_finding',
            dedupeKey: key(),
            severity: 'critical',
            findingId: finding.id,
          },
        }),
      ).rejects.toThrow();
      // Cada tipo com o alvo dele: incidente sem o incidente, médio, volume fora das faixas.
      await expect(
        prisma.notification.create({
          data: { tenantId: tenantA, kind: 'incident_opened', dedupeKey: key(), severity: 'high' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.notification.create({
          data: {
            tenantId: tenantA,
            kind: 'incident_opened',
            dedupeKey: key(),
            severity: 'medium',
            incidentId: incident.id,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.notification.create({
          data: {
            tenantId: tenantA,
            kind: 'plan_usage',
            dedupeKey: key(),
            usageMonth: new Date('2031-09-01T00:00:00.000Z'),
            usagePercent: 50,
          },
        }),
      ).rejects.toThrow();
    });

    it('apagar o incidente apaga o aviso (o expurgo não é barrado pela fila)', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (expurgo)');
      await persist(draft(tenantId, { severity: 'high', sourceIp: ip() }));
      const incident = await prisma.forTenant(tenantId).incident.findFirstOrThrow({ select: { id: true } });
      expect(await noticesOf(tenantId)).toHaveLength(1);
      await prisma.incident.delete({ where: { id: incident.id } });
      expect(await noticesOf(tenantId)).toEqual([]);
    });
  });

  describe("preferência e resumo por hora (PR-17')", () => {
    const HOUR = 3_600_000;
    /** Cinco minutos depois da próxima hora cheia: os avisos de agora estão vencidos e longe das 24 h da retomada. */
    const nextHour = () => new Date(hourStartOf(new Date()).getTime() + HOUR + 5 * 60_000);
    const digestsOf = (tenantId: string) =>
      prisma
        .forTenant(tenantId)
        .notificationDigest.findMany({ orderBy: [{ hourStart: 'asc' }, { id: 'asc' }] });
    const optOut = (tenantId: string, userId: string) =>
      prisma.forTenant(tenantId).notificationPreference.create({
        data: { tenantId, userId, incidentEmails: false },
      });
    /** Avisos de achado crítico sem chave, um por achado, na ordem. */
    async function criticals(tenantId: string, count: number): Promise<void> {
      for (let index = 0; index < count; index += 1) await persist(draft(tenantId, { severity: 'critical' }));
    }
    const noticeById = (tenantId: string, id: string) =>
      prisma.forTenant(tenantId).notification.findUniqueOrThrow({ where: { id } });
    const isDigest = (message: MailMessage) =>
      message.subject.startsWith('Resumo dos avisos') || message.subject.startsWith('Retomada dos avisos');

    it('preferência desligada: a pessoa não recebe os avisos de incidente; todos desligados dá skipped (opted_out)', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (preferência)');
      const admin = await member(tenantId, 'admin_cliente');
      const analyst = await member(tenantId, 'analista_cliente');
      await optOut(tenantId, analyst.id);
      await persist(draft(tenantId, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(analyst.email)).toEqual([]);
      expect(await noticesOf(tenantId)).toEqual([
        expect.objectContaining({ status: 'sent', deliveredUserIds: [admin.id], digestedUserIds: [] }),
      ]);

      // A preferência ligada de novo vale para o próximo aviso; o admin desliga, e só o analista recebe.
      await prisma.forTenant(tenantId).notificationPreference.update({
        where: { userId: analyst.id },
        data: { incidentEmails: true },
      });
      await optOut(tenantId, admin.id);
      await persist(draft(tenantId, { severity: 'critical' }));
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(analyst.email)).toHaveLength(1);

      // Os dois desligados: ninguém recebe, e o motivo diz por quê.
      await prisma.forTenant(tenantId).notificationPreference.update({
        where: { userId: analyst.id },
        data: { incidentEmails: false },
      });
      await persist(draft(tenantId, { severity: 'critical' }));
      await dispatcher(mailbox, soon()).runOnce();
      expect(
        mailbox.messages.filter((message) => [admin.email, analyst.email].includes(message.to)),
      ).toHaveLength(2);
      expect((await noticesOf(tenantId)).at(-1)).toMatchObject({ status: 'skipped', lastError: 'opted_out' });
    });

    it('o volume do plano chega a quem administra mesmo com os avisos de incidente desligados', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (plano com preferência)');
      const admin = await member(tenantId, 'admin_cliente');
      await optOut(tenantId, admin.id);
      await prisma.forTenant(tenantId).notification.create({
        data: {
          tenantId,
          kind: 'plan_usage',
          dedupeKey: 'usage:2026-11:80',
          usageMonth: new Date('2026-11-01T00:00:00.000Z'),
          usagePercent: 80,
        },
      });
      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(admin.email).map((message) => message.subject)).toEqual([
        '80% do volume mensal do plano no Verax Control',
      ]);
      expect(mailbox.to(admin.email)[0]?.text).not.toContain('Minha conta');
    });

    it('5 avulsos por hora; do 6º em diante, um resumo quando a hora fecha, com até 10 itens e "e mais N"', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (resumo)');
      const admin = await member(tenantId, 'admin_cliente', { name: 'Ana' });
      await criticals(tenantId, 17);
      const notices = await noticesOf(tenantId);
      const mailbox = new MemoryMailTransport();
      const at = nextHour();
      const hourStart = hourStartOf(at);

      const report = await dispatcher(mailbox, at).runOnce();
      expect(report.folded).toBeGreaterThanOrEqual(12);
      // Os 5 primeiros saem avulsos; os 12 seguintes vão para o resumo da hora.
      expect(mailbox.to(admin.email)).toHaveLength(5);
      expect(mailbox.to(admin.email).every((message) => !isDigest(message))).toBe(true);
      const after = await noticesOf(tenantId);
      expect(after.every((notice) => notice.status === 'sent')).toBe(true);
      expect(after.slice(0, 5).map((notice) => notice.deliveredUserIds)).toEqual(Array(5).fill([admin.id]));
      expect(after.slice(5).map((notice) => notice.digestedUserIds)).toEqual(Array(12).fill([admin.id]));
      expect(after.slice(5).every((notice) => notice.deliveredUserIds.length === 0)).toBe(true);
      const [digest] = await digestsOf(tenantId);
      expect(digest).toMatchObject({
        userId: admin.id,
        hourStart,
        individualSent: 5,
        noticeIds: notices.slice(5).map((notice) => notice.id),
        catchUp: false,
        status: 'pending',
        attempts: 0,
      });
      expect(digest?.nextAttemptAt?.getTime()).toBe(hourStart.getTime() + HOUR);

      // Antes de a hora fechar, nada sai.
      await dispatcher(mailbox, new Date(hourStart.getTime() + HOUR - 1000)).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(5);

      // A hora fechou: um resumo só, com 10 itens e "e mais 2".
      const closed = new Date(hourStart.getTime() + HOUR);
      const closing = await dispatcher(mailbox, closed).runOnce();
      expect(closing.digests.sent).toBeGreaterThanOrEqual(1);
      const sent = mailbox.to(admin.email).filter(isDigest);
      expect(sent).toHaveLength(1);
      const message = sent[0] as MailMessage;
      expect(message.subject).toBe('Resumo dos avisos da hora no Verax Control');
      expect(message.text).toContain('Olá, Ana.');
      expect(message.text).toContain('12 avisos no total');
      expect(message.text).toContain(
        `E mais 2 avisos neste resumo. Veja todos no painel: ${TEST_WEB_ORIGIN}/`,
      );
      expect(message.html.match(/<li>/g)).toHaveLength(10);
      // Os 10 primeiros da fila reunidos, cada um com o link do achado.
      for (const notice of notices.slice(5, 15)) {
        expect(message.text).toContain(`${TEST_WEB_ORIGIN}/achados?achado=${notice.findingId}`);
      }
      expect(message.text).not.toContain(`achado=${notices[15]?.findingId}`);
      expect((await digestsOf(tenantId))[0]).toMatchObject({ status: 'sent', attempts: 1, lastError: null });

      // Outra execução: nada sai de novo.
      await dispatcher(mailbox, new Date(closed.getTime() + 60_000)).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(6);

      // Na hora seguinte, a contagem recomeça: o próximo aviso sai avulso.
      await criticals(tenantId, 1);
      await dispatcher(mailbox, new Date(closed.getTime() + 2 * 60_000)).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(7);
      expect(isDigest(mailbox.to(admin.email)[6] as MailMessage)).toBe(false);
      expect(
        (await digestsOf(tenantId)).map(({ hourStart: hour, individualSent }) => [hour, individualSent]),
      ).toEqual([
        [hourStart, 5],
        [closed, 1],
      ]);
    });

    it('a contagem é por pessoa: quem entrou na hora com menos e-mails ainda recebe avulso', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (contagem por pessoa)');
      const admin = await member(tenantId, 'admin_cliente');
      const analyst = await member(tenantId, 'analista_cliente');
      await optOut(tenantId, analyst.id);
      const mailbox = new MemoryMailTransport();
      const at = nextHour();
      await criticals(tenantId, 5);
      await dispatcher(mailbox, at).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(5);
      expect(mailbox.to(analyst.email)).toEqual([]);

      // O analista religa: o 6º aviso da hora vai para o resumo do admin e sai avulso para o analista.
      await prisma.forTenant(tenantId).notificationPreference.update({
        where: { userId: analyst.id },
        data: { incidentEmails: true },
      });
      await criticals(tenantId, 1);
      await dispatcher(mailbox, new Date(at.getTime() + 60_000)).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(5);
      expect(mailbox.to(analyst.email)).toHaveLength(1);
      expect((await noticesOf(tenantId)).at(-1)).toMatchObject({
        status: 'sent',
        deliveredUserIds: [analyst.id],
        digestedUserIds: [admin.id],
      });
    });

    it('retomada: o aviso com mais de 24 h na fila não sai avulso; vem num resumo de retomada', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (retomada)');
      const admin = await member(tenantId, 'admin_cliente');
      await criticals(tenantId, 3);
      const mailbox = new MemoryMailTransport();
      // O worker volta 25 h depois.
      const back = new Date(Date.now() + 25 * HOUR);
      await dispatcher(mailbox, back).runOnce();
      expect(mailbox.to(admin.email)).toEqual([]);
      expect((await noticesOf(tenantId)).map((notice) => [notice.status, notice.digestedUserIds])).toEqual(
        Array(3).fill(['sent', [admin.id]]),
      );
      const [digest] = await digestsOf(tenantId);
      expect(digest).toMatchObject({ catchUp: true, individualSent: 0, status: 'pending' });
      const hourEnd = hourStartOf(back).getTime() + HOUR;
      expect(digest?.nextAttemptAt?.getTime()).toBe(hourEnd);
      // Como o resumo da hora, o de retomada sai quando a hora fecha.
      await dispatcher(mailbox, new Date(hourEnd - 1000)).runOnce();
      expect(mailbox.to(admin.email)).toEqual([]);

      await dispatcher(mailbox, new Date(hourEnd)).runOnce();
      const [message] = mailbox.to(admin.email);
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(message?.subject).toBe('Retomada dos avisos atrasados no Verax Control');
      expect(message?.text).toContain('ficou atrasado por mais de 24 horas');
      expect(message?.text).toContain('3 avisos no total');
      expect(message?.html.match(/<li>/g)).toHaveLength(3);
    });

    it('no envio do resumo, a pessoa e a preferência são conferidas de novo', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (resumo conferido)');
      const admin = await member(tenantId, 'admin_cliente');
      const analyst = await member(tenantId, 'analista_cliente');
      const mailbox = new MemoryMailTransport();
      const at = nextHour();
      await criticals(tenantId, 7);
      await dispatcher(mailbox, at).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(5);
      expect(mailbox.to(analyst.email)).toHaveLength(5);

      // Antes de a hora fechar, o analista desliga os avisos e o admin perde o MFA.
      await optOut(tenantId, analyst.id);
      await prisma.user.update({ where: { id: admin.id }, data: { twoFactorEnabled: false } });
      await dispatcher(mailbox, new Date(hourStartOf(at).getTime() + HOUR)).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(5);
      expect(mailbox.to(analyst.email)).toHaveLength(5);
      const digests = await digestsOf(tenantId);
      expect(digests.find((digest) => digest.userId === admin.id)).toMatchObject({
        status: 'skipped',
        lastError: 'no_recipients',
      });
      expect(digests.find((digest) => digest.userId === analyst.id)).toMatchObject({
        status: 'skipped',
        lastError: 'no_items',
      });
    });

    it('o resumo que falha: recuo de 1, 5, 15 e 60 min e failed na quinta; só o tipo do erro, nada no log', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (resumo com falha)');
      const admin = await member(tenantId, 'admin_cliente');
      const mailbox = new MemoryMailTransport();
      const at = nextHour();
      await criticals(tenantId, 6);
      await dispatcher(mailbox, at).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(5);

      let digestAttempts = 0;
      const failing: MailTransport = {
        send: (message) => {
          if (message.to === admin.email && isDigest(message)) digestAttempts += 1;
          return Promise.reject(new Error(`550 5.1.1 <${message.to}>: Recipient address rejected`));
        },
      };
      const read = async () => (await digestsOf(tenantId))[0];
      let when = new Date(hourStartOf(at).getTime() + HOUR);

      // A primeira tentativa vai pelo agendador: o log leva só as contagens.
      const lines: string[] = [];
      const capture = (level: string) => (fields: object, message: string) =>
        lines.push(JSON.stringify({ level, ...fields, message }));
      const task = dispatcher(failing, when);
      const scheduler = new Scheduler(
        [
          {
            name: NOTIFICATIONS_TASK,
            intervalMs: 3_600_000,
            budgetMs: 60_000,
            run: (signal) => task.runOnce(signal),
          },
        ],
        { info: capture('info'), warn: capture('warn'), error: capture('error') },
      );
      scheduler.start();
      await expect.poll(() => lines.length, { timeout: 20_000 }).toBeGreaterThan(0);
      await scheduler.stop();
      const log = lines.join('\n');
      expect(log).toContain('"digests"');
      expect(log).not.toContain(admin.email);
      expect(log).not.toContain('@');

      for (const [index, delay] of NOTIFICATION_RETRY_DELAYS_MS.entries()) {
        const row = await read();
        expect(row).toMatchObject({ status: 'pending', attempts: index + 1, lastError: 'Error' });
        expect(row?.nextAttemptAt?.getTime()).toBe(when.getTime() + delay);
        // Antes do recuo, nada.
        await dispatcher(failing, new Date((row?.nextAttemptAt?.getTime() ?? 0) - 1000)).runOnce();
        expect(digestAttempts).toBe(index + 1);
        when = row?.nextAttemptAt as Date;
        await dispatcher(failing, when).runOnce();
      }
      expect(await read()).toMatchObject({ status: 'failed', attempts: 5, lastError: 'Error', sentAt: null });
      expect(digestAttempts).toBe(5);
      await dispatcher(failing, new Date(when.getTime() + 24 * HOUR)).runOnce();
      expect(digestAttempts).toBe(5);
    });

    it('interrompida no meio: quem foi para o resumo fica guardado, a tentativa é gravada, e ninguém é reunido de novo', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (resumo interrompido)');
      // Três pessoas, na ordem em que o despachante atende (pelo id).
      const people = [
        await member(tenantId, 'analista_cliente'),
        await member(tenantId, 'analista_cliente'),
        await member(tenantId, 'analista_cliente'),
      ].sort((x, y) => (x.id < y.id ? -1 : 1));
      const [folded, sent, missing] = people as [Member, Member, Member];
      // Na primeira hora, só a primeira recebe (as outras duas desligaram): ela chega aos 5 avulsos.
      await optOut(tenantId, sent.id);
      await optOut(tenantId, missing.id);
      const mailbox = new MemoryMailTransport();
      const at = nextHour();
      await criticals(tenantId, 5);
      await dispatcher(mailbox, at).runOnce();
      expect(mailbox.to(folded.email)).toHaveLength(5);
      await prisma.forTenant(tenantId).notificationPreference.updateMany({ data: { incidentEmails: true } });

      // O 6º aviso: a primeira vai para o resumo, a segunda recebe avulso, e o orçamento estoura antes da terceira.
      await criticals(tenantId, 1);
      const sixth = (await noticesOf(tenantId)).at(-1);
      if (sixth === undefined) throw new Error('aviso não gravado');
      const controller = new AbortController();
      const reason = new DOMException('a tarefa passou do orçamento de tempo', 'TimeoutError');
      const transport: MailTransport = {
        send: async (message) => {
          await mailbox.send(message);
          if (message.to === sent.email) controller.abort(reason);
        },
      };
      const second = new Date(at.getTime() + 60_000);
      await expect(dispatcher(transport, second).runOnce(controller.signal)).rejects.toBe(reason);
      const interrupted = await noticeById(tenantId, sixth.id);
      expect(interrupted).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'TimeoutError',
        deliveredUserIds: [sent.id],
        digestedUserIds: [folded.id],
      });
      expect(mailbox.to(missing.email)).toEqual([]);

      // Depois do recuo, só quem faltava recebe; ninguém é reunido de novo no resumo.
      await dispatcher(mailbox, interrupted.nextAttemptAt).runOnce();
      expect(mailbox.to(missing.email)).toHaveLength(1);
      expect(mailbox.to(sent.email)).toHaveLength(1);
      expect(mailbox.to(folded.email)).toHaveLength(5);
      expect(await noticeById(tenantId, sixth.id)).toMatchObject({ status: 'sent', attempts: 2 });
      const digest = (await digestsOf(tenantId)).find((row) => row.userId === folded.id);
      expect(digest?.noticeIds).toEqual([sixth.id]);
    });

    it('a execução que atravessa a virada da hora não passa de 5 avulsos por pessoa na hora nova, e o resumo da hora que fechou sai', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (virada da hora)');
      const [first, second] = [
        await member(tenantId, 'admin_cliente'),
        await member(tenantId, 'analista_cliente'),
      ];
      const people = [first, second] as [Member, Member];
      const hourStart = hourStartOf(nextHour());
      const hourEnd = new Date(hourStart.getTime() + HOUR);
      const inHour = (at: Date, start: Date) =>
        at.getTime() >= start.getTime() && at.getTime() < start.getTime() + HOUR;

      // O relógio da execução e cada e-mail com a hora em que terminou de sair. A virada acontece durante o primeiro
      // envio para uma das duas pessoas, depois que a execução já começou (às 13:59:59 do exemplo da revisão).
      let current = new Date(hourStart.getTime() + 30 * 60_000);
      let crossOnSend = false;
      const sent: { to: string; digest: boolean; at: Date }[] = [];
      const transport: MailTransport = {
        send: (message) => {
          if (crossOnSend && people.some((person) => person.email === message.to)) {
            current = new Date(hourEnd.getTime() + 5_000);
            crossOnSend = false;
          }
          sent.push({ to: message.to, digest: isDigest(message), at: current });
          return Promise.resolve();
        },
      };
      const run = () => dispatcher(transport, current, { now: () => current }).runOnce();
      const individualIn = (person: Member, start: Date) =>
        sent.filter((mail) => mail.to === person.email && !mail.digest && inHour(mail.at, start)).length;

      // Na primeira hora, só a primeira pessoa recebe: 5 avulsos e o 6º no resumo dessa hora.
      await optOut(tenantId, second.id);
      await criticals(tenantId, 6);
      await run();
      expect(individualIn(first, hourStart)).toBe(5);
      await prisma.forTenant(tenantId).notificationPreference.update({
        where: { userId: second.id },
        data: { incidentEmails: true },
      });

      // Começa às 59:59 e atravessa a virada no primeiro envio.
      await criticals(tenantId, 7);
      current = new Date(hourEnd.getTime() - 1_000);
      crossOnSend = true;
      await run();
      // Mais avisos na hora nova, numa execução seguinte: a contagem da hora nova já tem o que saiu depois da virada.
      await criticals(tenantId, 3);
      current = new Date(hourEnd.getTime() + 10 * 60_000);
      await run();

      for (const person of people) expect(individualIn(person, hourEnd)).toBeLessThanOrEqual(5);
      // A segunda pessoa começou a hora nova do zero e chegou ao limite: 5 avulsos, o resto no resumo.
      expect(individualIn(second, hourEnd)).toBe(5);
      // O resumo da hora que fechou saiu na execução seguinte à virada, uma vez, para a primeira pessoa.
      const closed = await prisma.forTenant(tenantId).notificationDigest.findFirstOrThrow({
        where: { userId: first.id, hourStart },
      });
      expect(closed).toMatchObject({ individualSent: 5, status: 'sent', attempts: 1 });
      expect(sent.filter((mail) => mail.to === first.email && mail.digest)).toHaveLength(1);

      // Quando a hora nova fecha, saem os resumos dela; cada aviso chegou a cada pessoa uma vez, avulso ou no resumo.
      current = new Date(hourEnd.getTime() + HOUR);
      await run();
      const notices = await noticesOf(tenantId);
      expect(notices.every((notice) => notice.status === 'sent')).toBe(true);
      for (const person of people) {
        const handled = notices.filter(
          (notice) =>
            notice.deliveredUserIds.includes(person.id) || notice.digestedUserIds.includes(person.id),
        );
        const both = notices.filter(
          (notice) =>
            notice.deliveredUserIds.includes(person.id) && notice.digestedUserIds.includes(person.id),
        );
        expect(both).toEqual([]);
        expect(handled).toHaveLength(person === first ? 16 : 10);
      }
      const digests = await prisma.forTenant(tenantId).notificationDigest.findMany({
        where: { status: { not: null } },
      });
      expect(digests.every((digest) => digest.status === 'sent')).toBe(true);
    });

    describe('isolamento por cliente (A/B)', () => {
      it('o escopo de B não lê nem altera a hora de avisos de A; o banco recusa pessoa de outro cliente', async () => {
        const tenantA = await createTenant(app, 'Cliente demo A (resumo, escopo)');
        const tenantB = await createTenant(app, 'Cliente demo B (resumo, escopo)');
        const personA = await member(tenantA, 'admin_cliente');
        const at = nextHour();
        const hourStart = hourStartOf(at);
        await criticals(tenantA, 6);
        await dispatcher(new MemoryMailTransport(), at).runOnce();
        const [digest] = await digestsOf(tenantA);
        if (digest === undefined) throw new Error('resumo não gravado');

        const asB = prisma.forTenant(tenantB).notificationDigest;
        expect(await asB.findMany({ where: { id: digest.id } })).toEqual([]);
        expect((await asB.updateMany({ where: { id: digest.id }, data: { status: 'skipped' } })).count).toBe(
          0,
        );
        expect(() =>
          asB.create({
            data: { tenantId: tenantA, userId: personA.id, hourStart: new Date(hourStart.getTime() + HOUR) },
          }),
        ).toThrow(TenantScopeViolation);
        expect((await prisma.notificationDigest.findUniqueOrThrow({ where: { id: digest.id } })).status).toBe(
          'pending',
        );
        // Pela tabela, sem o escopo: a pessoa de A num resumo de B, ou alguém sem cliente, o banco recusa.
        await expect(
          prisma.notificationDigest.create({ data: { tenantId: tenantB, userId: personA.id, hourStart } }),
        ).rejects.toThrow();
        const verax = await member(null, 'admin_verax');
        await expect(
          prisma.notificationDigest.create({ data: { tenantId: tenantA, userId: verax.id, hourStart } }),
        ).rejects.toThrow();
        // Hora que não é cheia e resumo sem estado com aviso reunido: o banco recusa.
        await expect(
          prisma.notificationDigest.create({
            data: {
              tenantId: tenantA,
              userId: personA.id,
              hourStart: new Date(hourStart.getTime() + 60_000),
            },
          }),
        ).rejects.toThrow();
        await expect(
          prisma.notificationDigest.create({
            data: {
              tenantId: tenantA,
              userId: personA.id,
              hourStart: new Date(hourStart.getTime() + 2 * HOUR),
              noticeIds: [digest.noticeIds[0] as string],
            },
          }),
        ).rejects.toThrow();
      });
    });
  });

  describe('contato de escalonamento (D8): só os críticos, depois da confirmação, com o descadastro em todo e-mail', () => {
    const HOUR = 3_600_000;
    const nextHour = () => new Date(hourStartOf(new Date()).getTime() + HOUR + 5 * 60_000);
    const contactAddress = () => `escalonamento-${randomUUID()}@cliente.example`;
    const CONFIRM_LINK = /\/escalonamento\/confirmar#token=([A-Za-z0-9_-]{43})/;
    const UNSUBSCRIBE_LINK = /\/escalonamento\/descadastrar#token=([A-Za-z0-9_-]{43})/;
    const linkToken = (message: MailMessage | undefined, pattern: RegExp): string => {
      const found = pattern.exec(message?.text ?? '')?.[1];
      if (found === undefined) throw new Error('link não encontrado no e-mail');
      return found;
    };
    const publicLink = (path: 'confirm' | 'unsubscribe', token: string) =>
      request(app.getHttpServer())
        .post(`/v1/public/escalation-contact/${path}`)
        .set('Origin', TEST_WEB_ORIGIN)
        .send({ token });
    const tenantRow = (tenantId: string) =>
      prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { escalationState: true, escalationGeneration: true },
      });

    /** Cliente com o contato gravado direto no banco, já no estado pedido (geração 1). */
    async function contactTenant(
      name: string,
      state: 'pending' | 'confirmed' | 'unsubscribed',
      email = contactAddress(),
      contactName = 'Contato de teste',
    ): Promise<{ tenantId: string; email: string }> {
      const now = new Date();
      const { id } = await prisma.tenant.create({
        data: {
          name,
          escalationName: contactName,
          escalationEmail: email,
          escalationState: state,
          escalationGeneration: 1,
          escalationConfirmedAt: state === 'confirmed' ? now : null,
          escalationUnsubscribedAt: state === 'unsubscribed' ? now : null,
        },
        select: { id: true },
      });
      return { tenantId: id, email };
    }

    it('o pedido de confirmação sai do worker com os dois links (só o hash no banco), e confirmar liga os avisos críticos', async () => {
      const { tenantId, email } = await contactTenant(
        'Cliente demo A (confirmação)',
        'pending',
        undefined,
        '<b>Ana</b> & Cia',
      );
      const admin = await member(tenantId, 'admin_cliente');
      await queueEscalationConfirmation(prisma.forTenant(tenantId), 1, new Date());
      // Aguardando a confirmação: o aviso crítico vai para a pessoa, e nada para o contato.
      await persist(draft(tenantId, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();

      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(email).map((message) => message.subject)).toEqual([
        'Confirme o contato de escalonamento no Verax Control',
      ]);
      const request1 = mailbox.to(email)[0] as MailMessage;
      expect(request1.html).toContain('<p>Olá, &lt;b&gt;Ana&lt;/b&gt; &amp; Cia.</p>');
      const confirmToken = linkToken(request1, CONFIRM_LINK);
      const unsubscribeToken = linkToken(request1, UNSUBSCRIBE_LINK);
      expect(request1.text).toContain(`${TEST_WEB_ORIGIN}/escalonamento/confirmar#token=${confirmToken}`);
      const notices = await noticesOf(tenantId);
      expect(notices.find((notice) => notice.kind === 'escalation_confirmation')).toMatchObject({
        status: 'sent',
        escalationGeneration: 1,
        dedupeKey: 'escalation-confirmation:1',
        deliveredUserIds: [],
      });
      expect(notices.find((notice) => notice.kind === 'critical_finding')).toMatchObject({
        status: 'sent',
        deliveredUserIds: [admin.id],
        escalationDelivery: null,
      });
      // No banco, só o SHA-256 de cada link; nenhum endereço na fila.
      const tokens = await prisma.forTenant(tenantId).escalationContactToken.findMany();
      expect(
        tokens
          .map(({ tokenHash, purpose, generation }) => ({ tokenHash, purpose, generation }))
          .sort((a, b) => a.purpose.localeCompare(b.purpose)),
      ).toEqual([
        { tokenHash: escalationTokenHash(confirmToken), purpose: 'confirm', generation: 1 },
        { tokenHash: escalationTokenHash(unsubscribeToken), purpose: 'unsubscribe', generation: 1 },
      ]);
      expect(JSON.stringify(await noticesOf(tenantId))).not.toContain(email);

      await publicLink('confirm', confirmToken).expect(200, { status: 'confirmed' });
      expect(await tenantRow(tenantId)).toEqual({ escalationState: 'confirmed', escalationGeneration: 1 });
      // Uso único.
      const reused = await publicLink('confirm', confirmToken).expect(400);
      expect(reused.body).toMatchObject({
        code: 'ESCALATION_LINK_INVALID',
        message: 'Link inválido ou vencido',
      });

      // Confirmado: o próximo aviso crítico chega a ele, com um link de descadastro novo, uma vez só.
      await persist(draft(tenantId, { severity: 'critical' }));
      const report = await dispatcher(mailbox, soon()).runOnce();
      expect(report.escalation.sent).toBeGreaterThanOrEqual(1);
      const notice = mailbox.to(email)[1] as MailMessage;
      expect(notice.subject).toBe('Achado de severidade crítica no Verax Control');
      expect(notice.text).not.toContain('Minha conta');
      expect(linkToken(notice, UNSUBSCRIBE_LINK)).not.toBe(unsubscribeToken);
      expect((await noticesOf(tenantId)).at(-1)).toMatchObject({
        status: 'sent',
        escalationDelivery: 'sent',
      });
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(email)).toHaveLength(2);
    });

    it('só os avisos críticos chegam ao contato: o incidente alto, o volume do plano e a coleta parada, nunca', async () => {
      const { tenantId, email } = await contactTenant('Cliente demo A (só críticos)', 'confirmed');
      const admin = await member(tenantId, 'admin_cliente');
      const sourceIp = ip();
      const finding = draft(tenantId, {
        severity: 'high',
        sourceIp,
        actorUser: 'arn:aws:iam::111111111111:user/usuario-ficticio',
        accessKeyId: 'DEMOKEYID0000EXAMPLE',
        resource: 's3:bucket-ficticio-de-relatorios',
      });
      await persist(finding);
      await persist(
        draft(tenantId, { ...finding, sourceEventId: `teste-avisos/${randomUUID()}`, severity: 'critical' }),
      );
      await persist(draft(tenantId, { severity: 'critical', sourceIp: ip() }));
      await prisma.forTenant(tenantId).notification.createMany({
        data: [
          {
            tenantId,
            kind: 'plan_usage',
            dedupeKey: 'usage:2026-11:100',
            usageMonth: new Date('2026-11-01T00:00:00.000Z'),
            usagePercent: 100,
          },
          { tenantId, kind: 'aws_ingestion_stalled', dedupeKey: `aws-stalled:${randomUUID()}` },
        ],
      });
      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();

      expect(mailbox.to(admin.email)).toHaveLength(5);
      const received = mailbox.to(email);
      expect(received.map((message) => message.subject).sort()).toEqual([
        'Incidente de severidade crítica aberto no Verax Control',
        'Incidente subiu para severidade crítica no Verax Control',
      ]);
      for (const message of received) {
        const all = `${message.subject}\n${message.text}\n${message.html}`;
        for (const value of [
          sourceIp,
          finding.actorUser,
          finding.accessKeyId,
          finding.resource,
          finding.accountId,
          finding.title,
          finding.region,
          finding.eventName,
          admin.email,
        ]) {
          expect(all).not.toContain(value as string);
        }
        expect(message.text).toMatch(UNSUBSCRIBE_LINK);
      }
      const byKind = (await noticesOf(tenantId)).map(({ kind, severity, escalationDelivery }) => ({
        kind,
        severity,
        escalationDelivery,
      }));
      expect(byKind).toEqual(
        expect.arrayContaining([
          { kind: 'incident_opened', severity: 'high', escalationDelivery: null },
          { kind: 'incident_escalated', severity: 'critical', escalationDelivery: 'sent' },
          { kind: 'incident_opened', severity: 'critical', escalationDelivery: 'sent' },
          { kind: 'plan_usage', severity: null, escalationDelivery: null },
          { kind: 'aws_ingestion_stalled', severity: null, escalationDelivery: null },
        ]),
      );
    });

    it('aguardando ou descadastrado não recebe; o descadastro pelo link do aviso é idempotente e vale para o próximo', async () => {
      const pending = await contactTenant('Cliente demo A (aguardando)', 'pending');
      const unsubscribed = await contactTenant('Cliente demo A (descadastrado)', 'unsubscribed');
      const active = await contactTenant('Cliente demo A (descadastro pelo aviso)', 'confirmed');
      const admin = await member(active.tenantId, 'admin_cliente');
      for (const { tenantId } of [pending, unsubscribed, active]) {
        await persist(draft(tenantId, { severity: 'critical' }));
      }
      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(pending.email)).toEqual([]);
      expect(mailbox.to(unsubscribed.email)).toEqual([]);
      // Só o contato receberia: sem ele, ninguém.
      expect((await noticesOf(pending.tenantId))[0]).toMatchObject({
        status: 'skipped',
        lastError: 'no_recipients',
      });

      const token = linkToken(mailbox.to(active.email)[0], UNSUBSCRIBE_LINK);
      const first = await publicLink('unsubscribe', token).expect(200, { status: 'unsubscribed' });
      await publicLink('unsubscribe', token).expect(200, { status: 'unsubscribed' });
      expect(await tenantRow(active.tenantId)).toEqual({
        escalationState: 'unsubscribed',
        escalationGeneration: 1,
      });
      // A mudança entra uma vez na trilha do cliente, com ator anônimo; o segundo clique não grava nada.
      const trail = await prisma.auditLog.findMany({
        where: { tenantId: active.tenantId, action: 'escalation_contact.unsubscribe' },
      });
      expect(trail).toEqual([
        expect.objectContaining({
          actorType: 'anonymous',
          outcome: 'success',
          resourceType: 'tenant',
          resourceId: active.tenantId,
          requestId: first.headers['x-request-id'],
          before: { status: 'confirmed' },
          after: { status: 'unsubscribed' },
        }),
      ]);
      expect(JSON.stringify(trail)).not.toContain(token);

      await persist(draft(active.tenantId, { severity: 'critical' }));
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(active.email)).toHaveLength(1);
      expect(mailbox.to(admin.email)).toHaveLength(2);
    });

    it('o contato não recebe resumo: 5 e-mails por hora, do 6º em diante nada (limited), e o aviso velho fica de fora (stale)', async () => {
      const { tenantId, email } = await contactTenant('Cliente demo A (limite do contato)', 'confirmed');
      const admin = await member(tenantId, 'admin_cliente');
      for (let index = 0; index < 7; index += 1) await persist(draft(tenantId, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      const at = nextHour();
      const hourStart = hourStartOf(at);
      const report = await dispatcher(mailbox, at).runOnce();
      expect(report.escalation.limited).toBeGreaterThanOrEqual(2);
      expect(mailbox.to(email)).toHaveLength(5);
      expect(mailbox.to(admin.email)).toHaveLength(5);
      expect((await noticesOf(tenantId)).map((notice) => notice.escalationDelivery)).toEqual([
        'sent',
        'sent',
        'sent',
        'sent',
        'sent',
        'limited',
        'limited',
      ]);
      // A hora fecha: o resumo vai só para a pessoa.
      await dispatcher(mailbox, new Date(hourStart.getTime() + HOUR)).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(6);
      expect(mailbox.to(email)).toHaveLength(5);
      const digests = await prisma.forTenant(tenantId).notificationDigest.findMany();
      expect(digests.map((digest) => digest.userId)).toEqual([admin.id]);

      // Só o contato, acima do limite: o aviso não sai para ninguém. Com 24 h ou mais na fila, também não.
      const only = await contactTenant('Cliente demo A (só o contato)', 'confirmed');
      for (let index = 0; index < 6; index += 1)
        await persist(draft(only.tenantId, { severity: 'critical' }));
      await dispatcher(mailbox, at).runOnce();
      expect(mailbox.to(only.email)).toHaveLength(5);
      expect((await noticesOf(only.tenantId)).at(-1)).toMatchObject({
        status: 'skipped',
        lastError: 'escalation_limited',
        escalationDelivery: 'limited',
      });
      const old = await contactTenant('Cliente demo A (aviso velho)', 'confirmed');
      await persist(draft(old.tenantId, { severity: 'critical' }));
      await prisma
        .forTenant(old.tenantId)
        .notification.updateMany({ data: { createdAt: new Date(Date.now() - 25 * HOUR) } });
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(old.email)).toEqual([]);
      expect((await noticesOf(old.tenantId))[0]).toMatchObject({
        status: 'skipped',
        lastError: 'escalation_stale',
        escalationDelivery: 'stale',
      });
    });

    it('contato que também é pessoa do cliente que recebe o aviso: um e-mail só', async () => {
      const tenantId = await createTenant(app, 'Cliente demo A (contato e pessoa)');
      const admin = await member(tenantId, 'admin_cliente');
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          escalationName: 'Contato',
          escalationEmail: admin.email.toUpperCase(),
          escalationState: 'confirmed',
          escalationGeneration: 1,
          escalationConfirmedAt: new Date(),
        },
      });
      await persist(draft(tenantId, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect(mailbox.to(admin.email.toUpperCase())).toEqual([]);
      expect((await noticesOf(tenantId))[0]).toMatchObject({ status: 'sent', escalationDelivery: null });
    });

    it('falha do envio ao contato: recua, a nova tentativa vai só para ele, e o link do e-mail que falhou sai do banco', async () => {
      const { tenantId, email } = await contactTenant('Cliente demo A (falha do contato)', 'confirmed');
      const admin = await member(tenantId, 'admin_cliente');
      await persist(draft(tenantId, { severity: 'critical' }));
      const mailbox = new MemoryMailTransport();
      const failingForContact: MailTransport = {
        send: (message) =>
          message.to === email ? Promise.reject(new Error(`550 <${email}>`)) : mailbox.send(message),
      };
      const start = soon();
      await dispatcher(failingForContact, start).runOnce();
      const [retrying] = await noticesOf(tenantId);
      expect(retrying).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'Error',
        deliveredUserIds: [admin.id],
        escalationDelivery: null,
      });
      expect(retrying?.nextAttemptAt.getTime()).toBe(start.getTime() + NOTIFICATION_RETRY_DELAYS_MS[0]!);
      expect(await prisma.forTenant(tenantId).escalationContactToken.count()).toBe(0);

      await dispatcher(mailbox, new Date(start.getTime() + 61_000)).runOnce();
      expect(mailbox.to(email)).toHaveLength(1);
      expect(mailbox.to(admin.email)).toHaveLength(1);
      expect((await noticesOf(tenantId))[0]).toMatchObject({
        status: 'sent',
        attempts: 2,
        escalationDelivery: 'sent',
      });
      expect(await prisma.forTenant(tenantId).escalationContactToken.count()).toBe(1);
    });

    it('pedido de confirmação: o endereço trocado antes do envio sai como superseded, e sem e-mail no nó fica mail_disabled', async () => {
      const { tenantId, email } = await contactTenant('Cliente demo A (troca antes do envio)', 'pending');
      const db = prisma.forTenant(tenantId);
      await queueEscalationConfirmation(db, 1, new Date(Date.now() - 10 * 60_000));
      const replacement = contactAddress();
      const { data } = escalationContactUpdate(
        { escalationEmail: email, escalationState: 'pending' },
        { name: 'Contato novo', email: replacement },
      );
      const row = await db.tenant.update({
        where: { id: tenantId },
        data,
        select: { escalationGeneration: true },
      });
      expect(row.escalationGeneration).toBe(2);
      await queueEscalationConfirmation(db, 2, new Date());
      const mailbox = new MemoryMailTransport();
      await dispatcher(mailbox, soon()).runOnce();
      expect(mailbox.to(email)).toEqual([]);
      expect(mailbox.to(replacement).map((message) => message.subject)).toEqual([
        'Confirme o contato de escalonamento no Verax Control',
      ]);
      expect(
        (await noticesOf(tenantId)).map(({ escalationGeneration, status, lastError }) => ({
          escalationGeneration,
          status,
          lastError,
        })),
      ).toEqual([
        { escalationGeneration: 1, status: 'skipped', lastError: 'superseded' },
        { escalationGeneration: 2, status: 'sent', lastError: null },
      ]);
      // O link da geração anterior não vale; o da atual confirma.
      const stale = await mintEscalationTokens(db, tenantId, 1, ['confirm'], new Date());
      await publicLink('confirm', stale.confirm).expect(400);
      await publicLink('confirm', linkToken(mailbox.to(replacement)[0], CONFIRM_LINK)).expect(200);

      const quiet = await contactTenant('Cliente demo A (pedido sem e-mail)', 'pending');
      await queueEscalationConfirmation(prisma.forTenant(quiet.tenantId), 1, new Date());
      await dispatcher(null, soon()).runOnce();
      expect(await noticesOf(quiet.tenantId)).toEqual([
        expect.objectContaining({ status: 'skipped', lastError: 'mail_disabled' }),
      ]);
      expect(await prisma.forTenant(quiet.tenantId).escalationContactToken.count()).toBe(0);
    });

    it('nenhum endereço do contato nem link no log do worker, nem com a mensagem do servidor citando o endereço', async () => {
      const { tenantId, email } = await contactTenant('Cliente demo A (log do contato)', 'confirmed');
      await persist(draft(tenantId, { severity: 'critical' }));
      const pending = await contactTenant('Cliente demo A (log da confirmação)', 'pending');
      await queueEscalationConfirmation(prisma.forTenant(pending.tenantId), 1, new Date());
      const lines: string[] = [];
      const capture = (level: string) => (fields: object, message: string) =>
        lines.push(JSON.stringify({ level, ...fields, message }));
      const failing: MailTransport = {
        send: (message) =>
          Promise.reject(new Error(`550 5.1.1 <${message.to}>: Recipient address rejected ${message.text}`)),
      };
      const task = dispatcher(failing, soon());
      const scheduler = new Scheduler(
        [
          {
            name: NOTIFICATIONS_TASK,
            intervalMs: 3_600_000,
            budgetMs: 60_000,
            run: (signal) => task.runOnce(signal),
          },
        ],
        { info: capture('info'), warn: capture('warn'), error: capture('error') },
      );
      scheduler.start();
      await expect.poll(() => lines.length, { timeout: 20_000 }).toBeGreaterThan(0);
      await scheduler.stop();
      const log = lines.join('\n');
      expect(log).toContain('"escalation"');
      expect(log).not.toContain(email);
      expect(log).not.toContain(pending.email);
      expect(log).not.toContain('@');
      expect(log).not.toContain('#token=');
      expect((await noticesOf(tenantId))[0]).toMatchObject({ status: 'pending', lastError: 'Error' });
    });

    describe('isolamento por cliente (A/B)', () => {
      it('o contato de A não recebe os avisos de B, o link de B não mexe em A, e o escopo de B não alcança os links de A', async () => {
        const a = await contactTenant('Cliente demo A (contato A/B)', 'confirmed');
        const b = await contactTenant('Cliente demo B (contato A/B)', 'confirmed');
        await persist(draft(b.tenantId, { severity: 'critical' }));
        const mailbox = new MemoryMailTransport();
        await dispatcher(mailbox, soon()).runOnce();
        expect(mailbox.to(a.email)).toEqual([]);
        expect(mailbox.to(b.email)).toHaveLength(1);

        await publicLink('unsubscribe', linkToken(mailbox.to(b.email)[0], UNSUBSCRIBE_LINK)).expect(200);
        expect((await tenantRow(b.tenantId)).escalationState).toBe('unsubscribed');
        expect((await tenantRow(a.tenantId)).escalationState).toBe('confirmed');

        const { confirm } = await mintEscalationTokens(
          prisma.forTenant(a.tenantId),
          a.tenantId,
          1,
          ['confirm'],
          new Date(),
        );
        const asB = prisma.forTenant(b.tenantId).escalationContactToken;
        expect(await asB.findMany({ where: { tokenHash: escalationTokenHash(confirm) } })).toEqual([]);
        expect((await asB.deleteMany({ where: { tokenHash: escalationTokenHash(confirm) } })).count).toBe(0);
        expect(() =>
          asB.create({
            data: {
              tenantId: a.tenantId,
              tokenHash: escalationTokenHash(randomUUID()),
              purpose: 'unsubscribe',
              generation: 1,
              expiresAt: new Date(Date.now() + HOUR),
            },
          }),
        ).toThrow(TenantScopeViolation);
        expect(
          await prisma.escalationContactToken.count({ where: { tokenHash: escalationTokenHash(confirm) } }),
        ).toBe(1);
        // O banco recusa o que o Prisma não descreve: estado sem endereço, geração zero no link, hash fora do formato.
        await expect(
          prisma.tenant.create({
            data: { name: 'Cliente demo A (sem endereço)', escalationState: 'pending' },
          }),
        ).rejects.toThrow();
        await expect(
          prisma.escalationContactToken.create({
            data: {
              tenantId: a.tenantId,
              tokenHash: escalationTokenHash(randomUUID()),
              purpose: 'confirm',
              generation: 0,
              expiresAt: new Date(Date.now() + HOUR),
            },
          }),
        ).rejects.toThrow();
        await expect(
          prisma.escalationContactToken.create({
            data: {
              tenantId: a.tenantId,
              tokenHash: 'Z'.repeat(64),
              purpose: 'confirm',
              generation: 1,
              expiresAt: new Date(Date.now() + HOUR),
            },
          }),
        ).rejects.toThrow();
        await expect(
          prisma.forTenant(a.tenantId).notification.create({
            data: {
              tenantId: a.tenantId,
              kind: 'plan_usage',
              dedupeKey: `usage:2026-10:80:${randomUUID()}`,
              usageMonth: new Date('2026-10-01T00:00:00.000Z'),
              usagePercent: 80,
              escalationDelivery: 'sent',
              escalationDeliveredAt: new Date(),
            },
          }),
        ).rejects.toThrow();
      });
    });
  });
});
