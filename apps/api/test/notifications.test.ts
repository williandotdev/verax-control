import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FindingDraft } from '../src/alerts/finding-draft.js';
import { FindingStore, SyncLease } from '../src/alerts/finding-store.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import type { UserRole, UserStatus } from '../src/generated/prisma/client.js';
import { IncidentGrouping } from '../src/incidents/incident-grouping.js';
import type { MailMessage, MailTransport } from '../src/mail/mail.types.js';
import {
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
});
