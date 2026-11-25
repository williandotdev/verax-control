import { randomBytes, randomUUID } from 'node:crypto';
import type { FindingDraft } from '../../src/alerts/finding-draft.js';
import { FindingStore } from '../../src/alerts/finding-store.js';
import { CaseAssignJob } from '../../src/cases/case-assign-job.js';
import { CaseNoticeMail } from '../../src/cases/case-notice-mail.js';
import { CaseAlertNotices, CaseNoticeRegime } from '../../src/cases/case-notice-regime.js';
import {
  CaseNotices,
  type CaseNoticesOptions,
  type CaseNoticesReport,
} from '../../src/cases/case-notices.js';
import type { PrismaService } from '../../src/common/prisma/prisma.service.js';
import type { Notification, Prisma, UserRole } from '../../src/generated/prisma/client.js';
import type { MailTransport } from '../../src/mail/mail.types.js';
import {
  NotificationDispatcher,
  type NotificationDispatcherOptions,
  type NotificationReport,
} from '../../src/notifications/notification-dispatcher.js';
import { CASE_ACCOUNT, insertFinding } from './cases.js';
import { TEST_WEB_ORIGIN } from './create-app.js';

/** Apoio dos testes dos avisos por caso: o worker com os casos ligados, com o relógio do teste, sem o agendador. */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** 10:00 de Brasília de uma quarta-feira: depois das 09:00. */
export const T0 = new Date('2026-12-02T13:00:00.000Z');
/** Um instante a partir de T0. */
export const at = (milliseconds: number): Date => new Date(T0.getTime() + milliseconds);

/** O evento de um coletor (um alerta do CloudTrail, alto e com ator). */
export function draft(tenantId: string, overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    tenantId,
    accountId: CASE_ACCOUNT,
    source: 'wazuh',
    sourceEventId: `aviso-${randomUUID()}`,
    occurredAt: T0.toISOString(),
    severity: 'high',
    ruleId: '100305',
    ruleLevel: 10,
    title: 'Permissão de administrador concedida',
    logSource: 'cloudtrail',
    eventName: 'AttachUserPolicy',
    region: 'sa-east-1',
    resource: null,
    actorUser: `arn:aws:iam::${CASE_ACCOUNT}:user/maria`,
    actorType: null,
    accessKeyId: null,
    sourceIp: null,
    mitreTactics: [],
    mitreTechniques: [],
    ...overrides,
  };
}

export interface NoticeWorld {
  prisma: PrismaService;
  /** O relógio do worker. */
  clock: { now: Date };
  regime: CaseNoticeRegime;
  notices: CaseNotices;
  /** Os coletores com os avisos por caso. */
  store: FindingStore;
  /** A virada gravada agora. */
  activate: () => Promise<void>;
  /** A atribuição, com tudo o que há na fila. */
  assign: () => Promise<void>;
  /** Os avisos por caso, uma execução. */
  check: () => Promise<CaseNoticesReport>;
  /** A atribuição e os avisos. */
  step: () => Promise<CaseNoticesReport>;
  /** Uma execução da tarefa `notifications` com os casos ligados. */
  deliver: (
    transport: MailTransport | null,
    options?: NotificationDispatcherOptions,
  ) => Promise<NotificationReport>;
}

/** O worker com `CASES_MODE=on`, preso aos clientes dados (todos, sem eles). */
export function noticeWorld(
  prisma: PrismaService,
  tenantIds: readonly string[] | undefined,
  start: Date,
  options: Partial<CaseNoticesOptions> = {},
): NoticeWorld {
  const clock = { now: start };
  const now = () => clock.now;
  const name = options.name ?? `aviso-${randomBytes(6).toString('hex')}`;
  const regime = options.regime ?? new CaseNoticeRegime(prisma, { name });
  const notices = new CaseNotices(prisma, {
    regime,
    name,
    now,
    workMs: 10 * MINUTE_MS,
    ...(tenantIds !== undefined && { tenantIds }),
    ...options,
  });
  const world: NoticeWorld = {
    prisma,
    clock,
    regime,
    notices,
    store: new FindingStore(prisma, new CaseAlertNotices(regime)),
    activate: async () => {
      await regime.activate(clock.now);
    },
    assign: async () => {
      const job = new CaseAssignJob(prisma, {
        name: `caso-${randomBytes(6).toString('hex')}`,
        caseNotices: true,
        workMs: 10 * MINUTE_MS,
        now,
        ...(tenantIds !== undefined && { tenantIds }),
      });
      const report = await job.runOnce();
      if (report.status !== 'done' || report.failedTenants > 0)
        throw new Error(`atribuição: ${JSON.stringify(report)}`);
    },
    check: async () => {
      const report = await notices.check(clock.now);
      if (report.failedTenants > 0) throw new Error(`avisos: ${JSON.stringify(report)}`);
      return report;
    },
    step: async () => {
      await world.assign();
      return world.check();
    },
    deliver: (transport, dispatcherOptions = {}) =>
      new NotificationDispatcher(
        prisma,
        transport === null ? null : { transport, webOrigin: TEST_WEB_ORIGIN },
        {
          now,
          cases: notices,
          caseMail: new CaseNoticeMail(prisma),
          ...dispatcherOptions,
        },
      ).runOnce(),
  };
  return world;
}

/** O worker de antes (ou com `off` e `shadow`): o aviso alerta por alerta, e a devolução no começo de cada execução. */
export function plainDispatcher(
  prisma: PrismaService,
  transport: MailTransport | null,
  now: () => Date,
  options: NotificationDispatcherOptions = {},
): NotificationDispatcher {
  return new NotificationDispatcher(
    prisma,
    transport === null ? null : { transport, webOrigin: TEST_WEB_ORIGIN },
    { now, ...options },
  );
}

export const noticesOf = (
  prisma: PrismaService,
  tenantId: string,
  where: Prisma.NotificationWhereInput = {},
): Promise<Notification[]> =>
  prisma.notification.findMany({
    where: { ...where, tenantId },
    orderBy: [{ createdAt: 'asc' }, { dedupeKey: 'asc' }],
  });

export const keysOf = async (prisma: PrismaService, tenantId: string): Promise<string[]> =>
  (await noticesOf(prisma, tenantId)).map((row) => row.dedupeKey);

/** Os avisos resolvidos: o que já saiu da fila não volta a contar. */
export const markSent = (
  prisma: PrismaService,
  tenantId: string,
  when: Date,
  where: Prisma.NotificationWhereInput = {},
) =>
  prisma.notification.updateMany({
    where: { ...where, tenantId, status: 'pending' },
    data: { status: 'sent', attempts: 1, sentAt: when, deliveredUserIds: ['alguem'] },
  });

/** Um alerta de vulnerabilidade (Inspector), crítico. */
export const insertVulnerability = (
  prisma: PrismaService,
  tenantId: string,
  overrides: Partial<Prisma.FindingUncheckedCreateInput> = {},
): Promise<string> =>
  insertFinding(prisma, tenantId, {
    logSource: 'inspector',
    ruleId: '990511',
    severity: 'critical',
    title: 'CVE-2026-0001 - openssl',
    eventName: 'CVE-2026-0001',
    resource: `arn:aws:ec2:sa-east-1:${CASE_ACCOUNT}:instance/i-${randomBytes(6).toString('hex')}`,
    actorUser: null,
    caseGroup: 'openssl',
    ...overrides,
  });

/** Pessoa do cliente gravada direto no banco (o despachante só lê a tabela de usuários). */
export async function member(
  prisma: PrismaService,
  tenantId: string,
  role: UserRole = 'admin_cliente',
): Promise<{ id: string; email: string }> {
  return prisma.user.create({
    data: {
      id: randomUUID(),
      name: 'Pessoa de teste',
      email: `avisos-${randomUUID()}@cliente.example`,
      role,
      tenantId,
      status: 'active',
      twoFactorEnabled: true,
      mustChangePassword: false,
    },
    select: { id: true, email: true },
  });
}

export async function customer(prisma: PrismaService, name = 'Cliente Demo A'): Promise<string> {
  const { id } = await prisma.tenant.create({ data: { name }, select: { id: true } });
  return id;
}
