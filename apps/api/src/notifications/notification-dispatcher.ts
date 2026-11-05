import { randomUUID } from 'node:crypto';
import { SyncLease } from '../alerts/finding-store.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { NotificationKind, Prisma, UserRole } from '../generated/prisma/client.js';
import type { MailTransport } from '../mail/mail.types.js';
import { type NoticeMail, noticeMail } from '../mail/templates.js';
import type { UsageNotices } from './usage-notices.js';

/** Nome da tarefa do agendador e da concessão no banco (`SyncState`). */
export const NOTIFICATIONS_TASK = 'notifications';
/** A cada 60 s: o aviso sai em até 2 min depois do achado. */
export const NOTIFICATIONS_INTERVAL_MS = 60_000;
/** Recuo entre as tentativas: 1, 5, 15 e 60 min. A quinta tentativa que falha deixa o aviso `failed`. */
export const NOTIFICATION_RETRY_DELAYS_MS: readonly number[] = [1, 5, 15, 60].map(
  (minutes) => minutes * 60_000,
);
export const NOTIFICATION_MAX_ATTEMPTS = NOTIFICATION_RETRY_DELAYS_MS.length + 1;
/** Avisos por execução, os mais antigos primeiro. */
export const NOTIFICATION_BATCH = 20;
/**
 * Tempo de envio de um aviso numa execução (as cinco do lote cabem no orçamento de 5 min da tarefa). Passado o prazo,
 * quem falta fica para a próxima tentativa, com o recuo de sempre, e o lote segue para o aviso seguinte: um aviso com
 * muitas pessoas ou um servidor lento não segura os outros.
 */
export const NOTIFICATION_DELIVERY_BUDGET_MS = 60_000;

/**
 * Quem recebe cada tipo de aviso, entre as pessoas do cliente (decisão D8 da fase 2): administradores e analistas
 * recebem os de incidente e de achado; o volume do plano e a coleta parada, só quem administra o cliente (é quem fala
 * com a Verax sobre o plano e quem mexe em Contas cloud). `leitura` não recebe; a equipe da Verax não é do cliente.
 */
export const NOTICE_RECIPIENT_ROLES: Readonly<Record<NotificationKind, readonly UserRole[]>> = {
  incident_opened: ['admin_cliente', 'analista_cliente'],
  incident_escalated: ['admin_cliente', 'analista_cliente'],
  critical_finding: ['admin_cliente', 'analista_cliente'],
  aws_ingestion_stalled: ['admin_cliente'],
  plan_usage: ['admin_cliente'],
};

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente nem endereço). */
export interface NotificationReport {
  status: 'done' | 'locked';
  /** Avisos de volume do plano que entraram na fila nesta execução. */
  usageNotices: number;
  /** Avisos vencidos lidos nesta execução. */
  due: number;
  sent: number;
  /** Falhou e volta depois do recuo. */
  retrying: number;
  /** Falhou na última tentativa. */
  failed: number;
  /** Não sai: nó sem e-mail ou ninguém para receber. */
  skipped: number;
  /** Tipo do erro do cálculo do volume do plano, quando ele falhou (a entrega seguiu). */
  usageError?: string;
}

/** O e-mail ligado: o transporte (`mailTransport`, a mesma fábrica da API) e a origem do painel para os links. */
export interface NoticeMailer {
  transport: MailTransport;
  webOrigin: string;
}

export interface NotificationDispatcherOptions {
  /** Avisos do volume do plano, calculados no começo de cada execução. Sem ele, nada é calculado. */
  usage?: UsageNotices | null;
  now?: () => Date;
  owner?: string;
  leaseMs?: number;
  batch?: number;
  /** Tempo de envio de um aviso numa execução (`NOTIFICATION_DELIVERY_BUDGET_MS`). */
  deliveryBudgetMs?: number;
}

const DUE_SELECT = {
  id: true,
  tenantId: true,
  kind: true,
  severity: true,
  incidentId: true,
  findingId: true,
  usageMonth: true,
  usagePercent: true,
  attempts: true,
  deliveredUserIds: true,
} as const satisfies Prisma.NotificationSelect;
type DueNotice = Prisma.NotificationGetPayload<{ select: typeof DUE_SELECT }>;

type Outcome = 'sent' | 'retrying' | 'failed' | 'skipped';

/** O conteúdo do e-mail de um aviso, com o link no painel. O banco garante o alvo de cada tipo (CHECK da migration). */
export function noticeOf(
  row: Omit<DueNotice, 'id' | 'tenantId' | 'attempts' | 'deliveredUserIds'>,
  webOrigin: string,
): NoticeMail {
  const link = (path: string) => new URL(path, webOrigin).href;
  switch (row.kind) {
    case 'incident_opened':
    case 'incident_escalated':
      if (row.incidentId === null || (row.severity !== 'high' && row.severity !== 'critical')) break;
      return { kind: row.kind, severity: row.severity, link: link(`/incidentes/${row.incidentId}`) };
    case 'critical_finding':
      if (row.findingId === null) break;
      return { kind: row.kind, link: link(`/achados?achado=${row.findingId}`) };
    case 'aws_ingestion_stalled':
      return { kind: row.kind, link: link('/cadastros/contas') };
    case 'plan_usage':
      if (row.usageMonth === null || (row.usagePercent !== 80 && row.usagePercent !== 100)) break;
      return { kind: row.kind, percent: row.usagePercent, month: row.usageMonth, link: link('/') };
  }
  throw new RangeError('aviso sem o alvo do tipo');
}

/**
 * Tarefa `notifications` do worker (fase 2, PR-16): entrega os avisos da fila de saída (`Notification`) por e-mail.
 *
 * - A cada 60 s, com a concessão `notifications` no banco (um worker por vez). Começa pelos avisos de volume do plano
 *   (`UsageNotices`), depois lê os avisos `pending` vencidos, os mais antigos primeiro (busca de sistema, entre todos
 *   os clientes); cada gravação vai pelo escopo do cliente do aviso.
 * - Os destinatários são resolvidos no envio, pelo escopo do cliente do aviso: pessoas ativas, com MFA, sem troca de
 *   senha pendente, do papel que o tipo pede (`NOTICE_RECIPIENT_ROLES`), com o cliente ativo. Um e-mail por pessoa; o
 *   id de quem recebeu fica no aviso, e a nova tentativa não repete o e-mail para ela.
 * - Falha do envio: nova tentativa depois de 1, 5, 15 e 60 min; a quinta que falha deixa o aviso `failed`. Só o tipo
 *   do erro fica gravado (a mensagem do servidor pode citar o endereço).
 * - A tentativa que não chega a todos também conta, com o mesmo recuo, e quem já recebeu fica guardado: o prazo de
 *   envio de um aviso esgotado (`delivery_timeout`, e o lote segue) ou a execução interrompida no meio (o orçamento da
 *   tarefa ou a parada do worker: a tentativa é gravada antes de a interrupção subir). Assim, um aviso preso volta
 *   para o fim da fila, não reenvia para ninguém e chega ao `failed` na quinta, sem segurar os avisos seguintes.
 * - Sem e-mail no nó (`MAIL_TRANSPORT=none`), ou sem ninguém para receber, o aviso fica `skipped`: ligar o e-mail
 *   depois não dispara os avisos antigos.
 * - Nada aqui vai para o log, além das contagens que o agendador registra.
 */
export class NotificationDispatcher {
  private readonly usage: UsageNotices | null;
  private readonly now: () => Date;
  private readonly lease: SyncLease;
  private readonly batch: number;
  private readonly deliveryBudgetMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: NoticeMailer | null,
    {
      usage = null,
      now = () => new Date(),
      owner = `worker-${randomUUID()}`,
      leaseMs = 5 * 60 * 1000,
      batch = NOTIFICATION_BATCH,
      deliveryBudgetMs = NOTIFICATION_DELIVERY_BUDGET_MS,
    }: NotificationDispatcherOptions = {},
  ) {
    if (!Number.isInteger(batch) || batch < 1)
      throw new Error('o lote dos avisos precisa ser um inteiro positivo');
    if (!(deliveryBudgetMs >= 0)) throw new Error('o prazo de envio de um aviso não pode ser negativo');
    this.usage = usage;
    this.deliveryBudgetMs = deliveryBudgetMs;
    this.now = now;
    this.lease = new SyncLease(prisma, NOTIFICATIONS_TASK, owner, leaseMs);
    this.batch = batch;
  }

  async runOnce(signal?: AbortSignal): Promise<NotificationReport> {
    const report: NotificationReport = {
      status: 'done',
      usageNotices: 0,
      due: 0,
      sent: 0,
      retrying: 0,
      failed: 0,
      skipped: 0,
    };
    const startedAt = this.now();
    if (!(await this.lease.acquire(startedAt))) return { ...report, status: 'locked' };
    // Uma falha no cálculo do volume não segura os avisos de incidente: vai para o estado da tarefa, e a entrega segue.
    let usageError: string | null = null;
    try {
      try {
        report.usageNotices = (await this.usage?.check(startedAt)) ?? 0;
      } catch (error) {
        signal?.throwIfAborted();
        usageError = errorKind(error);
      }
      const due = await this.prisma.notification.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: startedAt } },
        select: DUE_SELECT,
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: this.batch,
      });
      report.due = due.length;
      for (const row of due) {
        signal?.throwIfAborted();
        report[await this.deliver(row, signal)] += 1;
        await this.lease.renew();
      }
      await this.prisma.syncState.update({
        where: { name: NOTIFICATIONS_TASK },
        data: {
          lastRunAt: startedAt,
          ...(usageError === null && { lastSuccessAt: this.now() }),
          lastError: usageError,
        },
      });
      return usageError === null ? report : { ...report, usageError };
    } catch (error) {
      await this.prisma.syncState.update({
        where: { name: NOTIFICATIONS_TASK },
        data: { lastRunAt: startedAt, lastError: errorKind(error) },
      });
      throw error;
    } finally {
      await this.lease.release();
    }
  }

  /** Uma tentativa de um aviso. */
  private async deliver(row: DueNotice, signal?: AbortSignal): Promise<Outcome> {
    const db = this.prisma.forTenant(row.tenantId);
    if (this.mailer === null) return this.skip(row, 'mail_disabled');
    const recipients = await db.user.findMany({
      where: {
        role: { in: [...NOTICE_RECIPIENT_ROLES[row.kind]] },
        status: 'active',
        twoFactorEnabled: true,
        mustChangePassword: false,
        tenant: { is: { status: 'active' } },
      },
      select: { id: true, name: true, email: true },
      orderBy: { id: 'asc' },
    });
    // Ninguém para receber: skipped. Quem já recebeu numa tentativa anterior conta como entregue (abaixo, `sent`).
    if (recipients.length === 0 && row.deliveredUserIds.length === 0) return this.skip(row, 'no_recipients');

    let notice: NoticeMail;
    try {
      notice = noticeOf(row, this.mailer.webOrigin);
    } catch {
      // Não acontece com o CHECK da migration; se acontecer, o aviso não trava a fila.
      return this.close(row, 'failed', 'invalid_notice');
    }
    const delivered = new Set(row.deliveredUserIds);
    const startedAt = performance.now();
    let firstError: string | null = null;
    let attempted = 0;
    for (const recipient of recipients) {
      if (delivered.has(recipient.id)) continue;
      // Interrompida no meio (orçamento da tarefa, parada do worker): a tentativa é gravada com o recuo e a interrupção
      // sobe depois. Sem isso, quem falta recomeçaria do zero a cada execução, sem recuo e sem chegar ao `failed`, e o
      // aviso, sempre o mais antigo, seguraria os outros.
      if (signal?.aborted) {
        await this.finishAttempt(row, errorKind(signal.reason));
        signal.throwIfAborted();
      }
      if (attempted > 0 && performance.now() - startedAt >= this.deliveryBudgetMs) {
        firstError ??= 'delivery_timeout';
        break;
      }
      attempted += 1;
      try {
        await this.mailer.transport.send(noticeMail(recipient.email, recipient.name, notice));
      } catch (error) {
        // Só o tipo: a mensagem do servidor de e-mail pode citar o endereço de quem recebe.
        firstError ??= errorKind(error);
        continue;
      }
      await db.notification.update({
        where: { id: row.id },
        data: { deliveredUserIds: { push: recipient.id } },
        select: { id: true },
      });
    }
    return this.finishAttempt(row, firstError);
  }

  /**
   * Fecha uma tentativa: `sent` sem erro; com erro, a próxima depois do recuo, ou `failed` na quinta. Quem já recebeu
   * fica no aviso (gravado a cada envio).
   */
  private async finishAttempt(row: DueNotice, firstError: string | null): Promise<Outcome> {
    const db = this.prisma.forTenant(row.tenantId);
    const attempts = row.attempts + 1;
    const now = this.now();
    if (firstError === null) {
      await db.notification.update({
        where: { id: row.id },
        data: { status: 'sent', attempts, sentAt: now, lastError: null },
        select: { id: true },
      });
      return 'sent';
    }
    const delay = NOTIFICATION_RETRY_DELAYS_MS[attempts - 1];
    if (attempts >= NOTIFICATION_MAX_ATTEMPTS || delay === undefined) {
      await db.notification.update({
        where: { id: row.id },
        data: { status: 'failed', attempts, lastError: firstError },
        select: { id: true },
      });
      return 'failed';
    }
    await db.notification.update({
      where: { id: row.id },
      data: { attempts, nextAttemptAt: new Date(now.getTime() + delay), lastError: firstError },
      select: { id: true },
    });
    return 'retrying';
  }

  private skip(row: DueNotice, reason: 'mail_disabled' | 'no_recipients'): Promise<'skipped'> {
    return this.close(row, 'skipped', reason);
  }

  /** Encerra o aviso sem envio, com o motivo. */
  private async close<S extends 'skipped' | 'failed'>(row: DueNotice, status: S, reason: string): Promise<S> {
    await this.prisma.forTenant(row.tenantId).notification.update({
      where: { id: row.id },
      data: { status, lastError: reason },
      select: { id: true },
    });
    return status;
  }
}
