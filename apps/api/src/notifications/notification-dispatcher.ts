import { randomUUID } from 'node:crypto';
import {
  ESCALATION_CONFIRM_PATH,
  ESCALATION_CONFIRMATION_TTL_HOURS,
  ESCALATION_UNSUBSCRIBE_PATH,
  INCIDENT_NOTICE_ROLES,
  NOTICE_CATCH_UP_HOURS,
  NOTICE_DIGEST_ITEMS,
  NOTICE_HOURLY_LIMIT,
} from '@verax/shared';
import { SyncLease } from '../alerts/finding-store.js';
import type { CaseNoticeContents, CaseNoticeMail } from '../cases/case-notice-mail.js';
import { CASE_SKIP, caseNoticeType } from '../cases/case-notice-policy.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import { lastConfirmationSentAt, nextConfirmationAt } from '../escalation/escalation-contact-store.js';
import {
  discardEscalationTokens,
  escalationLink,
  mintEscalationTokens,
} from '../escalation/escalation-tokens.js';
import type {
  EscalationDelivery,
  NotificationKind,
  NotificationStatus,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import type { MailTransport } from '../mail/mail.types.js';
import {
  type DigestItem,
  digestMail,
  escalationConfirmationMail,
  type EscalationNotice,
  escalationNoticeMail,
  type NoticeMail,
  noticeMail,
} from '../mail/templates.js';
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
/** Avisos que pedem e-mail por execução, por prioridade (`NOTICE_LANES`), e outros tantos resumos. */
export const NOTIFICATION_BATCH = 20;
/**
 * Avisos que só entram em resumo (todos que recebem já passaram do limite da hora, ou o aviso está velho) por execução.
 * Não pedem e-mail nenhum: com eles fora dos 20 acima, uma rajada de milhares sai da fila em minutos, e não em horas. É
 * também o que limita o crescimento de um resumo: 60 mil avisos numa hora (60 execuções), uns 2 MB de ids.
 */
export const NOTIFICATION_FOLD_BATCH = 1_000;
/** Avisos reunidos numa transação só: o resumo de cada pessoa é regravado uma vez por lote, e não uma vez por aviso. */
export const NOTIFICATION_FOLD_CHUNK = 500;
/** Avisos lidos por consulta ao montar o e-mail de um resumo: a memória guarda um lote, os 10 da lista e a contagem. */
export const NOTIFICATION_DIGEST_READ_CHUNK = 1_000;
/**
 * Tempo de envio de um aviso numa execução (as cinco do lote cabem no orçamento de 5 min da tarefa). Passado o prazo,
 * quem falta fica para a próxima tentativa, com o recuo de sempre, e o lote segue para o aviso seguinte: um aviso com
 * muitas pessoas ou um servidor lento não segura os outros.
 */
export const NOTIFICATION_DELIVERY_BUDGET_MS = 60_000;
/** Aviso com isto ou mais na fila não sai sozinho: entra no resumo de retomada (fase 2, PR-17'). */
export const NOTICE_CATCH_UP_MS = NOTICE_CATCH_UP_HOURS * 3_600_000;
const HOUR_MS = 3_600_000;
/** Tempo de um lote de avisos reunidos no banco. */
const FOLD_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Quem recebe cada tipo de aviso, entre as pessoas do cliente (decisão D8 da fase 2): administradores e analistas
 * recebem os de incidente e de achado; o volume do plano e a coleta parada, só quem administra o cliente (é quem fala
 * com a Verax sobre o plano e quem mexe em Contas cloud). `leitura` não recebe; a equipe da Verax não é do cliente.
 */
export const NOTICE_RECIPIENT_ROLES: Readonly<Record<NotificationKind, readonly UserRole[]>> = {
  incident_opened: INCIDENT_NOTICE_ROLES,
  incident_escalated: INCIDENT_NOTICE_ROLES,
  critical_finding: INCIDENT_NOTICE_ROLES,
  high_finding: INCIDENT_NOTICE_ROLES,
  aws_ingestion_stalled: ['admin_cliente'],
  plan_usage: ['admin_cliente'],
  // O pedido de confirmação vai só ao contato de escalonamento, que não é pessoa do cliente.
  escalation_confirmation: [],
};

/**
 * Os tipos que a preferência da pessoa controla (`incidentEmails`, fase 2, PR-17'). Os do plano e da coleta da AWS vão
 * sempre para quem administra: sem eles, ninguém do cliente saberia que a coleta parou ou que o plano encheu.
 */
export const INCIDENT_NOTICE_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  'incident_opened',
  'incident_escalated',
  'critical_finding',
  'high_finding',
]);

/** De onde o aviso vem, para a ordem da entrega. Um tipo novo não compila sem dizer o seu. */
type NoticeOrigin = 'incident' | 'alert' | 'operation';
const NOTICE_ORIGIN: Readonly<Record<NotificationKind, NoticeOrigin>> = {
  incident_opened: 'incident',
  incident_escalated: 'incident',
  critical_finding: 'alert',
  high_finding: 'alert',
  aws_ingestion_stalled: 'operation',
  plan_usage: 'operation',
  escalation_confirmation: 'operation',
};
const kindsFrom = (origin: NoticeOrigin): NotificationKind[] =>
  (Object.keys(NOTICE_ORIGIN) as NotificationKind[]).filter((kind) => NOTICE_ORIGIN[kind] === origin);

/**
 * As faixas da fila, da primeira a sair para a última: a severidade manda e, na mesma severidade, o incidente confirmado
 * vem antes do alerta; dentro da faixa, por idade (`nextAttemptAt`: a nova tentativa vai para o fim). Os incidentes
 * abaixo de alto (confirmados por uma pessoa) e os avisos de operação (coleta parada, volume do plano, pedido de
 * confirmação) são poucos por natureza e passam na frente dos alertas altos, que chegam aos milhares. Cada aviso está em
 * exatamente uma faixa, e nenhuma fica sem vez (`laneAllowance`).
 */
export const NOTICE_LANES: readonly Prisma.NotificationWhereInput[] = [
  { kind: { in: kindsFrom('incident') }, severity: 'critical' },
  { kind: { in: kindsFrom('alert') }, severity: 'critical' },
  { kind: { in: kindsFrom('incident') }, severity: 'high' },
  {
    OR: [
      { kind: { in: kindsFrom('operation') } },
      {
        kind: { in: kindsFrom('incident') },
        OR: [{ severity: null }, { severity: { notIn: ['critical', 'high'] } }],
      },
    ],
  },
  { kind: { in: kindsFrom('alert') }, OR: [{ severity: null }, { severity: { not: 'critical' } }] },
];

/**
 * Quanto uma faixa pode usar do que resta da execução: tudo, menos a parte guardada (um décimo do total, no mínimo 1)
 * para cada faixa seguinte que tem aviso vencido. Assim a rajada de uma faixa nunca deixa as de baixo esperando para
 * sempre, e o que as de baixo não usam é da primeira.
 */
export function laneAllowance(remaining: number, total: number, waitingBelow: number): number {
  if (remaining <= 0) return 0;
  const share = Math.max(1, Math.floor(total / 10));
  return Math.max(1, remaining - share * waitingBelow);
}

/** Os papéis que recebem algum dos avisos que vão para resumo. */
const FOLD_ROLES: readonly UserRole[] = [
  ...new Set([...INCIDENT_NOTICE_KINDS].flatMap((kind) => NOTICE_RECIPIENT_ROLES[kind])),
];

/** Uma pessoa do cliente, do ponto de vista do aviso: o papel e a preferência (sem linha, recebe). */
export interface NoticePerson {
  role: UserRole;
  incidentEmails: boolean;
}

/**
 * Os avisos que também vão ao contato de escalonamento confirmado (D8): só os críticos, de incidente (confirmado ou que
 * subiu para crítico) e de alerta crítico. O volume do plano, a coleta parada e os avisos altos ou abaixo, nunca.
 */
export function reachesEscalationContact(row: { kind: NotificationKind; severity: string | null }): boolean {
  return INCIDENT_NOTICE_KINDS.has(row.kind) && row.severity === 'critical';
}

/** E-mails ao contato de escalonamento numa hora cheia. Ele não recebe resumo: o que passa disso ele não recebe. */
export const ESCALATION_HOURLY_LIMIT = NOTICE_HOURLY_LIMIT;

/** A pessoa recebe o tipo: o papel que ele pede e, nos de incidente, a preferência ligada. */
export function receives(kind: NotificationKind, person: NoticePerson): boolean {
  return (
    NOTICE_RECIPIENT_ROLES[kind].includes(person.role) &&
    (!INCIDENT_NOTICE_KINDS.has(kind) || person.incidentEmails)
  );
}

/** Começo da hora cheia (UTC; Brasília, em UTC-3 o ano todo, tem as mesmas horas). */
export function hourStartOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** Contagens dos resumos de uma execução. */
export interface DigestReport {
  /** Resumos vencidos lidos nesta execução. */
  due: number;
  sent: number;
  retrying: number;
  failed: number;
  skipped: number;
}

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente nem endereço). */
export interface NotificationReport {
  status: 'done' | 'locked';
  /** Avisos de volume do plano que entraram na fila nesta execução. */
  usageNotices: number;
  /** Avisos vencidos tratados nesta execução (os que pediram e-mail e os que só entraram em resumo). */
  due: number;
  sent: number;
  /** Falhou e volta depois do recuo. */
  retrying: number;
  /** Falhou na última tentativa. */
  failed: number;
  /** Não sai: nó sem e-mail ou ninguém para receber. */
  skipped: number;
  /**
   * Pedidos de confirmação ao contato de escalonamento adiados no envio: outro e-mail de confirmação do mesmo cliente
   * saiu há menos de `ESCALATION_CONFIRMATION_INTERVAL_MINUTES` (o pedido volta para a fila, sem gastar tentativa).
   */
  postponed: number;
  /** Entregas (uma por pessoa e aviso) que foram para o resumo da hora ou para o de retomada, em vez do e-mail avulso. */
  folded: number;
  digests: DigestReport;
  /**
   * O contato de escalonamento nos avisos críticos (D8): e-mails que saíram, avisos que ele não recebeu por passar do
   * limite da hora e avisos com 24 h ou mais na fila (ele não recebe resumo nem retomada).
   */
  escalation: { sent: number; limited: number; stale: number };
  /** Tipo do erro do cálculo do volume do plano, quando ele falhou (a entrega seguiu). */
  usageError?: string;
  /** Os avisos por caso desta execução, ou a devolução deles ao aviso por alerta. Sem os casos, nada. */
  cases?: object;
  /** Tipo do erro dos avisos por caso, quando eles falharam (a entrega seguiu). */
  casesError?: string;
}

/** O que os casos fazem no começo de cada execução: os avisos por caso, ou a devolução deles ao aviso por alerta. */
export interface CaseNoticeSource {
  check(now: Date, signal?: AbortSignal): Promise<CaseNoticeOutcome | null>;
}

/** As contagens de uma execução dos avisos por caso. */
export interface CaseNoticeOutcome {
  /** Clientes cujos avisos falharam (os outros seguem): a tarefa não conta como bem-sucedida. */
  failedTenants: number;
}

/** O erro da tarefa quando os avisos por caso falham só para alguns clientes (o detalhe vai para o log). */
export const CASE_NOTICES_FAILED = 'CaseNoticesFailed';

/** O e-mail ligado: o transporte (`mailTransport`, a mesma fábrica da API) e a origem do painel para os links. */
export interface NoticeMailer {
  transport: MailTransport;
  webOrigin: string;
}

export interface NotificationDispatcherOptions {
  /** Avisos do volume do plano, calculados no começo de cada execução. Sem ele, nada é calculado. */
  usage?: UsageNotices | null;
  /** Os avisos por caso (`CASES_MODE=on`), ou a volta deles ao aviso por alerta nos outros modos. */
  cases?: CaseNoticeSource | null;
  /**
   * O conteúdo dos avisos de caso (`CASES_MODE=on`); nos outros modos, só o dos agregados que sobraram na fila. Sem ele, um
   * aviso de caso que sobrou na fila sai como o do alerta dele (o mesmo que a versão anterior do nó faz).
   */
  caseMail?: CaseNoticeMail | null;
  now?: () => Date;
  owner?: string;
  leaseMs?: number;
  batch?: number;
  /** Avisos que só entram em resumo por execução (`NOTIFICATION_FOLD_BATCH`). */
  foldBatch?: number;
  /** Tempo de envio de um aviso numa execução (`NOTIFICATION_DELIVERY_BUDGET_MS`). */
  deliveryBudgetMs?: number;
}

const TARGET_SELECT = {
  kind: true,
  severity: true,
  incidentId: true,
  findingId: true,
  usageMonth: true,
  usagePercent: true,
} as const satisfies Prisma.NotificationSelect;
/** O que o texto e o link de um aviso usam. */
type NoticeTarget = Prisma.NotificationGetPayload<{ select: typeof TARGET_SELECT }>;

/** O que diz se o aviso é de um caso (`caseNoticeType`). */
const CASE_SELECT = { caseId: true, dedupeKey: true } as const satisfies Prisma.NotificationSelect;

const DUE_SELECT = {
  id: true,
  tenantId: true,
  ...TARGET_SELECT,
  ...CASE_SELECT,
  attempts: true,
  deliveredUserIds: true,
  digestedUserIds: true,
  escalationGeneration: true,
  escalationDelivery: true,
  createdAt: true,
} as const satisfies Prisma.NotificationSelect;
type DueNotice = Prisma.NotificationGetPayload<{ select: typeof DUE_SELECT }>;

const DIGEST_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  hourStart: true,
  catchUp: true,
  attempts: true,
} as const satisfies Prisma.NotificationDigestSelect;
type DueDigest = Prisma.NotificationDigestGetPayload<{ select: typeof DIGEST_SELECT }>;

/**
 * Quem pode receber avisos do cliente: ativo, com MFA, sem troca de senha pendente, com o cliente ativo. O papel e a
 * preferência dependem do tipo (`receives`).
 */
const ACTIVE_PERSON = {
  status: 'active',
  twoFactorEnabled: true,
  mustChangePassword: false,
  tenant: { is: { status: 'active' } },
} as const satisfies Prisma.UserWhereInput;

const PERSON_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  notificationPreference: { select: { incidentEmails: true } },
} as const satisfies Prisma.UserSelect;
type PersonRow = Prisma.UserGetPayload<{ select: typeof PERSON_SELECT }>;

const asNoticePerson = (row: PersonRow): NoticePerson => ({
  role: row.role,
  incidentEmails: row.notificationPreference?.incidentEmails ?? true,
});

/** O contato de escalonamento no cadastro do cliente, lido na hora do envio (o endereço nunca vai para a fila). */
const ESCALATION_CONTACT_SELECT = {
  status: true,
  escalationName: true,
  escalationEmail: true,
  escalationState: true,
  escalationGeneration: true,
} as const satisfies Prisma.TenantSelect;

/** O que aconteceu com o contato num aviso: a decisão gravada, ou o tipo do erro do envio (nova tentativa). */
type ContactOutcome = EscalationDelivery | { error: string };

/** O contato confirmado, que recebe os avisos críticos. */
interface EscalationRecipient {
  name: string;
  email: string;
  generation: number;
}

/** A hora de um cliente, para quem só reúne avisos: lida uma vez e usada para todos os avisos dele. */
interface TenantHour {
  hourStart: Date;
  people: PersonRow[];
  /** A contagem de cada pessoa na hora (sem linha, nenhum e-mail ainda). */
  hours: ReadonlyMap<string, { individualSent: number; status: NotificationStatus | null }>;
  contact: EscalationRecipient | null;
  /** O contato já recebeu os e-mails da hora. */
  contactLimited: boolean;
}

/** Um aviso que não pede e-mail: entra no resumo da hora de cada pessoa (e, no crítico, o contato fica de fora). */
interface Fold {
  row: DueNotice;
  userIds: string[];
  hourStart: Date;
  /** O aviso tem 24 h ou mais na fila: o resumo vira de retomada. */
  stale: boolean;
  contact: Extract<EscalationDelivery, 'limited' | 'stale'> | null;
  decidedAt: Date;
}

/** O resumo fechou entre a decisão e a gravação: o lote inteiro volta para a fila. */
class DigestClosed extends Error {}

type Outcome = 'sent' | 'retrying' | 'failed' | 'skipped';
/** O fim de um aviso numa execução: os de sempre e o pedido de confirmação adiado pelo intervalo. */
type NoticeOutcome = Outcome | 'postponed';

/** Quem é contato e também pessoa do cliente que recebe o aviso não recebe o mesmo e-mail duas vezes. */
function isRecipient(contact: EscalationRecipient, recipients: readonly PersonRow[]): boolean {
  return recipients.some(
    (person) => person.email.trim().toLowerCase() === contact.email.trim().toLowerCase(),
  );
}

/** O fim de uma tentativa (do aviso ou do resumo): `sent`, o recuo, ou `failed` na quinta. */
function attemptResult(
  previousAttempts: number,
  firstError: string | null,
  now: Date,
): {
  outcome: Exclude<Outcome, 'skipped'>;
  data: {
    status?: 'sent' | 'failed';
    attempts: number;
    sentAt?: Date;
    nextAttemptAt?: Date;
    lastError: string | null;
  };
} {
  const attempts = previousAttempts + 1;
  if (firstError === null) {
    return { outcome: 'sent', data: { status: 'sent', attempts, sentAt: now, lastError: null } };
  }
  const delay = NOTIFICATION_RETRY_DELAYS_MS[attempts - 1];
  if (attempts >= NOTIFICATION_MAX_ATTEMPTS || delay === undefined) {
    return { outcome: 'failed', data: { status: 'failed', attempts, lastError: firstError } };
  }
  return {
    outcome: 'retrying',
    data: { attempts, nextAttemptAt: new Date(now.getTime() + delay), lastError: firstError },
  };
}

/**
 * O conteúdo do e-mail de um aviso, com o link no painel (a tela Detecções com o item aberto). O banco garante o alvo de
 * cada tipo (CHECK da migration), menos o incidente que saiu depois do aviso (expurgo): esse não tem e-mail.
 */
export function noticeOf(row: NoticeTarget, webOrigin: string): NoticeMail {
  const link = (path: string) => new URL(path, webOrigin).href;
  switch (row.kind) {
    case 'incident_opened':
      if (row.incidentId === null || row.severity === null) break;
      return { kind: row.kind, severity: row.severity, link: link(`/?incidente=${row.incidentId}`) };
    case 'incident_escalated':
      if (row.incidentId === null || (row.severity !== 'high' && row.severity !== 'critical')) break;
      return { kind: row.kind, severity: row.severity, link: link(`/?incidente=${row.incidentId}`) };
    case 'critical_finding':
    case 'high_finding':
      if (row.findingId === null) break;
      return { kind: row.kind, link: link(`/?alerta=${row.findingId}`) };
    case 'aws_ingestion_stalled':
      return { kind: row.kind, link: link('/cadastros/contas') };
    case 'plan_usage':
      if (row.usageMonth === null || (row.usagePercent !== 80 && row.usagePercent !== 100)) break;
      return {
        kind: row.kind,
        percent: row.usagePercent,
        month: row.usageMonth,
        link: link('/cadastros/plano'),
      };
  }
  throw new RangeError('aviso sem o alvo do tipo');
}

/** Um aviso reunido num resumo. */
type DigestRow = NoticeTarget & { id: string; createdAt: Date; caseId: string | null; dedupeKey: string };
/** O item do resumo e a linha de onde ele veio. */
interface DigestEntry {
  row: DigestRow;
  item: DigestItem;
}

/**
 * Os itens das linhas dadas. Um aviso sem o alvo do tipo (o CHECK já impede) fica de fora, e o de caso (`contents`) que não
 * tem mais o que dizer também.
 */
function digestEntries(
  rows: readonly DigestRow[],
  webOrigin: string,
  contents: CaseNoticeContents = new Map(),
): DigestEntry[] {
  return rows.flatMap((row) => {
    const content = contents.get(row.id);
    if (content === null) return [];
    try {
      return [{ row, item: { notice: content ?? noticeOf(row, webOrigin), at: row.createdAt } }];
    } catch {
      return [];
    }
  });
}

/** A ordem do resumo: os críticos primeiro e, em cada grupo, na ordem em que entraram na fila. */
function digestOrder({ row: a }: DigestEntry, { row: b }: DigestEntry): number {
  const rank = (row: DigestRow) => (row.severity === 'critical' ? 0 : 1);
  return (
    rank(a) - rank(b) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Os itens do resumo, os críticos primeiro (o incidente crítico e o achado crítico) e, em cada grupo, na ordem em que
 * entraram na fila. Um aviso sem o alvo do tipo (o CHECK já impede) fica de fora.
 */
export function digestItems(rows: readonly DigestRow[], webOrigin: string): DigestItem[] {
  return digestEntries(rows, webOrigin)
    .sort(digestOrder)
    .map(({ item }) => item);
}

/**
 * Tarefa `notifications` do worker (fase 2, PR-16 e PR-17'): entrega os avisos da fila de saída (`Notification`) por
 * e-mail.
 *
 * - A cada 60 s, com a concessão `notifications` no banco (um worker por vez). Começa pelos avisos de volume do plano
 *   (`UsageNotices`), depois os resumos das horas que fecharam e, por fim, os avisos `pending` vencidos, por faixa
 *   (`NOTICE_LANES`: a severidade, o incidente antes do alerta) e, em cada uma, os mais antigos primeiro (buscas de
 *   sistema, entre todos os clientes); cada gravação vai pelo escopo do cliente da linha. Um crítico não espera uma
 *   fila de altos, e cada faixa com aviso vencido tem a sua parte da execução (`laneAllowance`).
 * - Só conta para os 20 da execução o aviso que pede e-mail. O que só entra em resumo (todos que recebem já passaram do
 *   limite da hora, ou ele está velho) é reunido em lotes de até 500, numa transação por lote: até mil por execução.
 * - Os destinatários são resolvidos no envio, pelo escopo do cliente do aviso: pessoas ativas, com MFA, sem troca de
 *   senha pendente, do papel que o tipo pede (`NOTICE_RECIPIENT_ROLES`), com o cliente ativo e, nos avisos de
 *   incidente, com a preferência ligada (`incidentEmails`, padrão sim). Um e-mail por pessoa; o id de quem recebeu
 *   fica no aviso, e a nova tentativa não repete o e-mail para ela.
 * - Resumo por hora (PR-17'): cada pessoa recebe até 5 e-mails avulsos por hora cheia. Do 6º aviso da hora em diante, o
 *   aviso entra no resumo dela (`NotificationDigest`), que sai uma vez, quando a hora fecha, com até 10 itens e "e mais
 *   N". O aviso com 24 h ou mais na fila nunca sai avulso: entra no resumo da hora, que vira de retomada. O resumo tem
 *   as mesmas tentativas, o mesmo recuo e o mesmo `failed` do aviso, e a pessoa é conferida de novo no envio. A hora
 *   é a do relógio em cada decisão, não a do começo da execução, e o e-mail avulso conta na hora em que terminou de
 *   sair: uma execução que atravessa a virada não passa de 5 avulsos por pessoa na hora nova.
 * - Falha do envio: nova tentativa depois de 1, 5, 15 e 60 min; a quinta que falha deixa o aviso `failed`. Só o tipo
 *   do erro fica gravado (a mensagem do servidor pode citar o endereço).
 * - A tentativa que não chega a todos também conta, com o mesmo recuo, e quem já recebeu fica guardado: o prazo de
 *   envio de um aviso esgotado (`delivery_timeout`, e o lote segue) ou a execução interrompida no meio (o orçamento da
 *   tarefa ou a parada do worker: a tentativa é gravada antes de a interrupção subir). Assim, um aviso preso volta
 *   para o fim da fila, não reenvia para ninguém e chega ao `failed` na quinta, sem segurar os avisos seguintes.
 * - Sem e-mail no nó (`MAIL_TRANSPORT=none`), ou sem ninguém para receber, o aviso fica `skipped`: ligar o e-mail
 *   depois não dispara os avisos antigos.
 * - Com os casos ligados (`CASES_MODE=on`), a execução começa pelos avisos por caso (`CaseNotices`), e o conteúdo deles sai do
 *   caso na hora do envio (`CaseNoticeMail`): o do caso já tratado, promovido a incidente ou que saiu na retenção não sai.
 * - Nada aqui vai para o log, além das contagens que o agendador registra.
 */
export class NotificationDispatcher {
  private readonly usage: UsageNotices | null;
  private readonly cases: CaseNoticeSource | null;
  private readonly caseMail: CaseNoticeMail | null;
  private readonly now: () => Date;
  private readonly lease: SyncLease;
  private readonly batch: number;
  private readonly foldBatch: number;
  private readonly deliveryBudgetMs: number;
  /** O tipo do primeiro erro dos avisos por caso nesta execução. */
  private casesError: string | null = null;
  /** A hora de cada cliente nesta execução; sai depois de cada e-mail dele, que muda a contagem. */
  private readonly tenantHours = new Map<string, TenantHour>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: NoticeMailer | null,
    {
      usage = null,
      cases = null,
      caseMail = null,
      now = () => new Date(),
      owner = `worker-${randomUUID()}`,
      leaseMs = 5 * 60 * 1000,
      batch = NOTIFICATION_BATCH,
      foldBatch = NOTIFICATION_FOLD_BATCH,
      deliveryBudgetMs = NOTIFICATION_DELIVERY_BUDGET_MS,
    }: NotificationDispatcherOptions = {},
  ) {
    if (!Number.isInteger(batch) || batch < 1 || !Number.isInteger(foldBatch) || foldBatch < 1)
      throw new Error('o lote dos avisos precisa ser um inteiro positivo');
    if (!(deliveryBudgetMs >= 0)) throw new Error('o prazo de envio de um aviso não pode ser negativo');
    this.usage = usage;
    this.cases = cases;
    this.caseMail = caseMail;
    this.deliveryBudgetMs = deliveryBudgetMs;
    this.now = now;
    this.lease = new SyncLease(prisma, NOTIFICATIONS_TASK, owner, leaseMs);
    this.batch = batch;
    this.foldBatch = foldBatch;
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
      postponed: 0,
      folded: 0,
      digests: { due: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 },
      escalation: { sent: 0, limited: 0, stale: 0 },
    };
    const startedAt = this.now();
    if (!(await this.lease.acquire(startedAt))) return { ...report, status: 'locked' };
    // Uma falha no cálculo do volume (ou dos avisos por caso) não segura os avisos de incidente: vai para o estado da
    // tarefa, e a entrega segue.
    let usageError: string | null = null;
    this.casesError = null;
    try {
      try {
        report.usageNotices = (await this.usage?.check(startedAt)) ?? 0;
      } catch (error) {
        signal?.throwIfAborted();
        usageError = errorKind(error);
      }
      try {
        const cases = (await this.cases?.check(startedAt, signal)) ?? null;
        if (cases !== null) report.cases = cases;
        if (cases !== null && cases.failedTenants > 0) this.casesError = CASE_NOTICES_FAILED;
      } catch (error) {
        signal?.throwIfAborted();
        this.casesError = errorKind(error);
      }
      // Os resumos das horas que fecharam vão antes dos avisos novos: o que eles reúnem é mais antigo.
      if (await this.deliverDigests(startedAt, report.digests, signal)) {
        await this.deliverNotices(startedAt, report, signal);
      }
      const { casesError } = this;
      await this.prisma.syncState.update({
        where: { name: NOTIFICATIONS_TASK },
        data: {
          lastRunAt: startedAt,
          ...(usageError === null && casesError === null && { lastSuccessAt: this.now() }),
          lastError: usageError ?? casesError,
        },
      });
      return {
        ...report,
        ...(usageError !== null && { usageError }),
        ...(casesError !== null && { casesError }),
      };
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

  /**
   * Os avisos vencidos, faixa a faixa (`NOTICE_LANES`). Cada faixa lê o bastante para os dois limites da execução (os
   * que pedem e-mail e os que só entram em resumo); quem passa do limite fica para a execução seguinte, na mesma ordem.
   */
  private async deliverNotices(
    startedAt: Date,
    report: NotificationReport,
    signal?: AbortSignal,
  ): Promise<void> {
    this.tenantHours.clear();
    // Os de caso que deixaram de valer saem antes, de uma vez: não ocupam a vez dos que vão sair.
    const stale = await this.skipStale(signal);
    report.due += stale.sent + stale.skipped;
    report.sent += stale.sent;
    report.skipped += stale.skipped;
    const lanes: DueNotice[][] = [];
    for (const lane of NOTICE_LANES) {
      const rows = await this.prisma.notification.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: startedAt }, AND: [lane] },
        select: DUE_SELECT,
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: this.batch + this.foldBatch,
      });
      if (rows.length > 0) lanes.push(rows);
    }
    let mailsLeft = this.batch;
    let foldsLeft = this.foldBatch;
    const folds: Fold[] = [];
    for (const [index, rows] of lanes.entries()) {
      const waitingBelow = lanes.length - 1 - index;
      let mails = laneAllowance(mailsLeft, this.batch, waitingBelow);
      let foldable = laneAllowance(foldsLeft, this.foldBatch, waitingBelow);
      for (const row of rows) {
        if (mails === 0 && foldable === 0) break;
        signal?.throwIfAborted();
        const fold = await this.foldOf(row);
        if (fold !== null) {
          if (foldable === 0) continue;
          foldable -= 1;
          foldsLeft -= 1;
          report.due += 1;
          folds.push(fold);
          // A concessão venceu e outra réplica a tomou: os avisos que faltam são dela (sem isso, sairiam duas vezes).
          if (folds.length >= NOTIFICATION_FOLD_CHUNK && !(await this.flushFolds(folds, report))) return;
          continue;
        }
        if (mails === 0) continue;
        mails -= 1;
        mailsLeft -= 1;
        report.due += 1;
        // O que já foi decidido é gravado antes de um e-mail que pode demorar (ou estourar o orçamento da tarefa).
        if (folds.length > 0 && !(await this.flushFolds(folds, report))) return;
        // O e-mail muda a contagem da hora do cliente: a próxima decisão dele lê de novo.
        this.tenantHours.delete(row.tenantId);
        report[await this.deliver(row, report, signal)] += 1;
        if (!(await this.lease.renew())) return;
      }
    }
    if (folds.length > 0) await this.flushFolds(folds, report);
  }

  /**
   * O aviso que não pede e-mail nenhum: um de incidente ou de alerta, ainda sem nenhuma entrega, em que cada pessoa que
   * recebe vai para o resumo da hora (passou do limite, ou o aviso está velho) e o contato de escalonamento, se o aviso
   * é dele, fica de fora pelas mesmas regras (`deliverToContact`). Nulo: segue pelo caminho de um aviso por vez.
   */
  private async foldOf(row: DueNotice): Promise<Fold | null> {
    if (
      this.mailer === null ||
      !INCIDENT_NOTICE_KINDS.has(row.kind) ||
      row.attempts > 0 ||
      row.deliveredUserIds.length > 0 ||
      row.digestedUserIds.length > 0 ||
      row.escalationDelivery !== null
    ) {
      return null;
    }
    try {
      noticeOf(row, this.mailer.webOrigin);
    } catch {
      return null;
    }
    const decidedAt = this.now();
    const hour = await this.tenantHour(row.tenantId, hourStartOf(decidedAt));
    const recipients = hour.people.filter((person) => receives(row.kind, asNoticePerson(person)));
    if (recipients.length === 0) return null;
    const stale = decidedAt.getTime() - row.createdAt.getTime() >= NOTICE_CATCH_UP_MS;
    for (const recipient of recipients) {
      const own = hour.hours.get(recipient.id);
      const open = own === undefined || own.status === null || own.status === 'pending';
      if (!open || (!stale && (own?.individualSent ?? 0) < NOTICE_HOURLY_LIMIT)) return null;
    }
    let contact: Fold['contact'] = null;
    if (reachesEscalationContact(row) && hour.contact !== null && !isRecipient(hour.contact, recipients)) {
      if (!stale && !hour.contactLimited) return null;
      contact = stale ? 'stale' : 'limited';
    }
    return {
      row,
      userIds: recipients.map((recipient) => recipient.id),
      hourStart: hour.hourStart,
      stale,
      contact,
      decidedAt,
    };
  }

  /** As pessoas do cliente, a contagem de cada uma na hora e o contato, lidos uma vez por hora e execução. */
  private async tenantHour(tenantId: string, hourStart: Date): Promise<TenantHour> {
    const known = this.tenantHours.get(tenantId);
    if (known?.hourStart.getTime() === hourStart.getTime()) return known;
    const db = this.prisma.forTenant(tenantId);
    const people = await db.user.findMany({
      where: { role: { in: [...FOLD_ROLES] }, ...ACTIVE_PERSON },
      select: PERSON_SELECT,
      orderBy: { id: 'asc' },
    });
    const rows = await db.notificationDigest.findMany({
      where: { hourStart, userId: { in: people.map((person) => person.id) } },
      select: { userId: true, individualSent: true, status: true },
    });
    const contact = await this.confirmedContact(tenantId);
    const hour: TenantHour = {
      hourStart,
      people,
      hours: new Map(rows.map(({ userId, individualSent, status }) => [userId, { individualSent, status }])),
      contact,
      contactLimited:
        contact !== null && (await this.contactMailsIn(tenantId, hourStart)) >= ESCALATION_HOURLY_LIMIT,
    };
    this.tenantHours.set(tenantId, hour);
    return hour;
  }

  /**
   * Grava os avisos reunidos, em lotes de mesmo cliente, hora e pessoas, e esvazia a lista. False se a concessão foi
   * perdida: o que não foi gravado segue na fila, para quem a tomou.
   */
  private async flushFolds(folds: Fold[], report: NotificationReport): Promise<boolean> {
    const groups = new Map<string, Fold[]>();
    for (const fold of folds.splice(0)) {
      const key = JSON.stringify([
        fold.row.tenantId,
        fold.hourStart.getTime(),
        fold.stale,
        fold.contact,
        fold.userIds,
      ]);
      const group = groups.get(key);
      if (group) group.push(fold);
      else groups.set(key, [fold]);
    }
    for (const group of groups.values()) {
      const [first] = group as [Fold];
      const folded = await this.foldTogether(group);
      report.sent += folded;
      report.folded += folded * first.userIds.length;
      if (first.contact !== null) report.escalation[first.contact] += folded;
      if (!(await this.lease.renew())) return false;
    }
    return true;
  }

  /**
   * Um lote de avisos do mesmo cliente entra no resumo da hora de cada pessoa e fecha como enviado, tudo numa transação:
   * só os que ainda estão intactos na fila (uma tentativa de outro worker deixa o aviso com ela), e só se o resumo ainda
   * está aberto (o fechado não recebe mais nada: o lote volta para a fila). Devolve quantos entraram.
   */
  private async foldTogether(group: readonly Fold[]): Promise<number> {
    const { row, userIds, hourStart, stale, contact, decidedAt } = group[0] as Fold;
    const { tenantId } = row;
    const ids = group.map((fold) => fold.row.id);
    const hourEnd = new Date(hourStart.getTime() + HOUR_MS);
    const transaction = async (tx: Prisma.TransactionClient): Promise<number> => {
      const db = scopeToTenant(tx, tenantId);
      const claimed = await db.notification.updateManyAndReturn({
        where: {
          id: { in: ids },
          status: 'pending',
          attempts: 0,
          deliveredUserIds: { isEmpty: true },
          digestedUserIds: { isEmpty: true },
          escalationDelivery: null,
        },
        data: {
          ...attemptResult(0, null, this.now()).data,
          digestedUserIds: userIds,
          ...(contact !== null && { escalationDelivery: contact, escalationDeliveredAt: decidedAt }),
        },
        select: { id: true },
      });
      if (claimed.length === 0) return 0;
      const taken = new Set(claimed.map(({ id }) => id));
      // Na ordem em que saíram da fila.
      const noticeIds = ids.filter((id) => taken.has(id));
      const where = { hourStart, userId: { in: userIds } };
      const known = await db.notificationDigest.findMany({ where, select: { userId: true } });
      const existing = new Set(known.map(({ userId }) => userId));
      const append = { noticeIds: { push: noticeIds }, ...(stale && { catchUp: true }) };
      const open = await db.notificationDigest.updateMany({
        where: { ...where, status: 'pending' },
        data: append,
      });
      // Só com a contagem até aqui: o primeiro aviso reunido abre o resumo, que sai quando a hora fecha.
      const opened = await db.notificationDigest.updateMany({
        where: { ...where, status: null },
        data: { ...append, status: 'pending', nextAttemptAt: hourEnd },
      });
      if (open.count + opened.count !== existing.size) throw new DigestClosed();
      await db.notificationDigest.createMany({
        data: userIds
          .filter((userId) => !existing.has(userId))
          .map((userId) => ({
            tenantId,
            userId,
            hourStart,
            noticeIds,
            catchUp: stale,
            status: 'pending' as const,
            nextAttemptAt: hourEnd,
          })),
      });
      return noticeIds.length;
    };
    try {
      return await this.prisma.$transaction(transaction, { timeout: FOLD_TRANSACTION_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof DigestClosed)) throw error;
      this.tenantHours.delete(tenantId);
      return 0;
    }
  }

  /** Uma tentativa de um aviso. */
  private async deliver(
    row: DueNotice,
    report: Pick<NotificationReport, 'folded' | 'escalation'>,
    signal?: AbortSignal,
  ): Promise<NoticeOutcome> {
    const db = this.prisma.forTenant(row.tenantId);
    if (this.mailer === null) return this.skip(row, 'mail_disabled');
    if (row.kind === 'escalation_confirmation') return this.deliverConfirmation(row, this.mailer, signal);
    // O incidente saiu depois do aviso (expurgo): o aviso fica no histórico, sem e-mail.
    if ((row.kind === 'incident_opened' || row.kind === 'incident_escalated') && row.incidentId === null) {
      return this.skip(row, 'incident_gone');
    }
    if (this.caseMail !== null && caseNoticeType(row) !== null) {
      // De novo, agora: alguém pode ter tratado o caso desde o começo da execução.
      const stale = await this.skipStale(signal, row.id);
      if (stale.sent + stale.skipped > 0) return stale.sent > 0 ? 'sent' : 'skipped';
    }
    const people = await db.user.findMany({
      where: { role: { in: [...NOTICE_RECIPIENT_ROLES[row.kind]] }, ...ACTIVE_PERSON },
      select: PERSON_SELECT,
      orderBy: { id: 'asc' },
    });
    const recipients = people.filter((person) => receives(row.kind, asNoticePerson(person)));
    // Quem já recebeu, avulso ou no resumo, numa tentativa anterior conta como entregue (abaixo, `sent`).
    const handled = new Set([...row.deliveredUserIds, ...row.digestedUserIds]);
    // O contato de escalonamento ainda sem decisão neste aviso (só nos críticos, confirmado, com o cliente ativo).
    const contact = row.escalationDelivery === null ? await this.escalationContactFor(row) : null;
    if (
      recipients.length === 0 &&
      handled.size === 0 &&
      row.escalationDelivery === null &&
      contact === null
    ) {
      // Havia quem recebesse, mas todos desligaram os avisos de incidente.
      return this.skip(row, people.length > 0 ? 'opted_out' : 'no_recipients');
    }

    const content = (await this.caseContents(row.tenantId, [row], this.mailer.webOrigin, signal)).get(row.id);
    if (content === null) {
      // Nada mais a dizer: tudo foi tratado. Quem já recebeu numa tentativa anterior conta como avisado.
      return handled.size > 0 || row.escalationDelivery === 'sent'
        ? this.finishAttempt(row, null)
        : this.close(row, 'skipped', CASE_SKIP.treated);
    }
    let notice: NoticeMail;
    try {
      notice = content ?? noticeOf(row, this.mailer.webOrigin);
    } catch {
      // Não acontece com o CHECK da migration; se acontecer, o aviso não trava a fila.
      return this.close(row, 'failed', 'invalid_notice');
    }
    const startedSending = performance.now();
    let firstError: string | null = null;
    let attempted = 0;
    let timedOut = false;
    const pastBudget = () => attempted > 0 && performance.now() - startedSending >= this.deliveryBudgetMs;
    for (const recipient of recipients) {
      if (handled.has(recipient.id)) continue;
      // Interrompida no meio (orçamento da tarefa, parada do worker): a tentativa é gravada com o recuo e a interrupção
      // sobe depois. Sem isso, quem falta recomeçaria do zero a cada execução, sem recuo e sem chegar ao `failed`, e o
      // aviso, sempre o mais antigo, seguraria os outros.
      if (signal?.aborted) {
        await this.finishAttempt(row, errorKind(signal.reason));
        signal.throwIfAborted();
      }
      // A hora de agora, a cada decisão (uma execução pode atravessar a virada da hora), e a contagem da pessoa nela,
      // relida do banco: quantos avulsos já saíram nesta hora e se o resumo dela ainda aceita avisos.
      const decidedAt = this.now();
      const hourStart = hourStartOf(decidedAt);
      const stale = decidedAt.getTime() - row.createdAt.getTime() >= NOTICE_CATCH_UP_MS;
      const hour = await db.notificationDigest.findUnique({
        where: { tenantId_userId_hourStart: { tenantId: row.tenantId, userId: recipient.id, hourStart } },
        select: { individualSent: true, status: true },
      });
      // O resumo da hora já saiu só se o relógio voltou: nesse caso raro, o aviso sai avulso.
      const digestOpen = hour === null || hour.status === null || hour.status === 'pending';
      if (digestOpen && (stale || (hour?.individualSent ?? 0) >= NOTICE_HOURLY_LIMIT)) {
        await this.fold(row, recipient.id, hourStart, stale);
        report.folded += 1;
        continue;
      }
      if (pastBudget()) {
        firstError ??= 'delivery_timeout';
        timedOut = true;
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
      // Conta na hora em que o e-mail saiu de fato: o envio que começou às 13:59 e terminou às 14:00 é da hora das 14h.
      await this.recordSent(row, recipient.id, hourStartOf(this.now()));
    }
    // O contato de escalonamento vem depois das pessoas, com o mesmo prazo e a mesma interrupção.
    if (contact !== null && !timedOut) {
      if (!isRecipient(contact, recipients)) {
        if (signal?.aborted) {
          await this.finishAttempt(row, errorKind(signal.reason));
          signal.throwIfAborted();
        }
        const outcome = await this.deliverToContact(row, contact, notice as EscalationNotice, pastBudget());
        if (typeof outcome === 'string') report.escalation[outcome] += 1;
        else firstError ??= outcome.error;
        // Só o contato receberia, e ele ficou de fora (limite da hora ou aviso velho): o aviso não sai para ninguém.
        if (
          (outcome === 'limited' || outcome === 'stale') &&
          firstError === null &&
          recipients.length === 0 &&
          handled.size === 0
        ) {
          return this.close(row, 'skipped', `escalation_${outcome}`);
        }
      }
    }
    return this.finishAttempt(row, firstError);
  }

  /**
   * Fecha os avisos de caso que deixaram de valer (todos, ou só um). Uma falha aqui não segura a entrega: o aviso sai, e o
   * erro fica no estado da tarefa.
   */
  private async skipStale(signal?: AbortSignal, id?: string): Promise<{ sent: number; skipped: number }> {
    const none = { sent: 0, skipped: 0 };
    try {
      return (await this.caseMail?.skipStale(this.now(), id === undefined ? null : [id])) ?? none;
    } catch (error) {
      signal?.throwIfAborted();
      this.casesError ??= errorKind(error);
      return none;
    }
  }

  /**
   * O conteúdo dos avisos de caso entre estes. Vazio sem os casos, e também se a leitura deles falha: o aviso sai como o do
   * alerta dele, em vez de ficar calado.
   */
  private async caseContents(
    tenantId: string,
    rows: readonly DigestRow[],
    webOrigin: string,
    signal?: AbortSignal,
  ): Promise<CaseNoticeContents> {
    try {
      return (await this.caseMail?.contents(tenantId, rows, webOrigin)) ?? new Map();
    } catch (error) {
      signal?.throwIfAborted();
      this.casesError ??= errorKind(error);
      return new Map();
    }
  }

  /**
   * O contato de escalonamento deste aviso, lido do cadastro na hora do envio: só nos avisos críticos, com o contato
   * confirmado e o cliente ativo. Quem aguarda a confirmação ou se descadastrou não recebe nada.
   */
  private async escalationContactFor(row: DueNotice): Promise<EscalationRecipient | null> {
    return reachesEscalationContact(row) ? this.confirmedContact(row.tenantId) : null;
  }

  private async confirmedContact(tenantId: string): Promise<EscalationRecipient | null> {
    const tenant = await this.prisma.forTenant(tenantId).tenant.findUnique({
      where: { id: tenantId },
      select: ESCALATION_CONTACT_SELECT,
    });
    if (
      tenant?.status !== 'active' ||
      tenant.escalationState !== 'confirmed' ||
      tenant.escalationEmail === null ||
      tenant.escalationName === null
    ) {
      return null;
    }
    return {
      name: tenant.escalationName,
      email: tenant.escalationEmail,
      generation: tenant.escalationGeneration,
    };
  }

  /**
   * O aviso crítico para o contato de escalonamento (D8). Ele não recebe resumo: o aviso com 24 h ou mais na fila fica
   * de fora (`stale`, as pessoas recebem a retomada), e do 6º e-mail da hora em diante também (`limited`). Cada e-mail
   * leva um link de descadastro novo (só o hash fica no banco). A decisão fica no aviso, e a nova tentativa não repete o
   * e-mail para ele. Devolve o que aconteceu ou o erro (o do envio, ou `delivery_timeout` quando o prazo do aviso acabou).
   */
  private async deliverToContact(
    row: DueNotice,
    contact: EscalationRecipient,
    notice: EscalationNotice,
    pastBudget: boolean,
  ): Promise<ContactOutcome> {
    const mailer = this.mailer as NoticeMailer;
    const db = this.prisma.forTenant(row.tenantId);
    const decidedAt = this.now();
    if (decidedAt.getTime() - row.createdAt.getTime() >= NOTICE_CATCH_UP_MS) {
      await this.markContact(row, 'stale', decidedAt);
      return 'stale';
    }
    const sentThisHour = await this.contactMailsIn(row.tenantId, hourStartOf(decidedAt));
    if (sentThisHour >= ESCALATION_HOURLY_LIMIT) {
      await this.markContact(row, 'limited', decidedAt);
      return 'limited';
    }
    if (pastBudget) return { error: 'delivery_timeout' };
    const { unsubscribe } = await mintEscalationTokens(
      db,
      row.tenantId,
      contact.generation,
      ['unsubscribe'],
      decidedAt,
    );
    try {
      await mailer.transport.send(
        escalationNoticeMail(
          contact.email,
          contact.name,
          notice,
          escalationLink(mailer.webOrigin, ESCALATION_UNSUBSCRIBE_PATH, unsubscribe),
        ),
      );
    } catch (error) {
      await discardEscalationTokens(db, [unsubscribe]);
      // Só o tipo: a mensagem do servidor de e-mail pode citar o endereço.
      return { error: errorKind(error) };
    }
    await this.markContact(row, 'sent', this.now());
    return 'sent';
  }

  /** E-mails ao contato do cliente na hora (pelo índice do cliente e da hora da entrega). */
  private contactMailsIn(tenantId: string, hourStart: Date): Promise<number> {
    return this.prisma.forTenant(tenantId).notification.count({
      where: {
        escalationDelivery: 'sent',
        escalationDeliveredAt: { gte: hourStart, lt: new Date(hourStart.getTime() + HOUR_MS) },
      },
    });
  }

  /** O que aconteceu com o contato neste aviso, e quando: a nova tentativa não decide de novo. */
  private async markContact(row: DueNotice, delivery: EscalationDelivery, at: Date): Promise<void> {
    await this.prisma.forTenant(row.tenantId).notification.update({
      where: { id: row.id },
      data: { escalationDelivery: delivery, escalationDeliveredAt: at },
      select: { id: true },
    });
  }

  /**
   * O pedido de confirmação ao contato de escalonamento (D8). O endereço vem do cadastro na hora do envio, e o pedido só
   * sai se ainda é o da geração atual, com o contato aguardando e o cliente ativo (senão, `superseded` ou
   * `tenant_inactive`). O intervalo entre dois e-mails de confirmação do cliente é conferido de novo aqui, contra o
   * último que saiu de fato: dentro dele, o pedido é adiado até o fim do intervalo (`postponed`), sem gastar tentativa e
   * sem ser descartado. Os links (confirmar, de uso único, e descadastrar) nascem aqui, só com o hash no banco; se o
   * e-mail não sai, eles saem também. Mesmas tentativas, recuo e `failed` dos avisos.
   */
  private async deliverConfirmation(
    row: DueNotice,
    mailer: NoticeMailer,
    signal?: AbortSignal,
  ): Promise<NoticeOutcome> {
    const db = this.prisma.forTenant(row.tenantId);
    const tenant = await db.tenant.findUnique({
      where: { id: row.tenantId },
      select: ESCALATION_CONTACT_SELECT,
    });
    if (tenant?.status !== 'active') return this.close(row, 'skipped', 'tenant_inactive');
    if (
      tenant.escalationState !== 'pending' ||
      tenant.escalationGeneration !== row.escalationGeneration ||
      tenant.escalationEmail === null ||
      tenant.escalationName === null
    ) {
      return this.close(row, 'skipped', 'superseded');
    }
    // Outro e-mail de confirmação do cliente saiu há pouco (um pedido entregue com atraso, ou dois que se cruzaram):
    // este espera o fim do intervalo, na fila.
    const now = this.now();
    const allowedAt = nextConfirmationAt(await lastConfirmationSentAt(db, row.id), now);
    if (allowedAt > now) {
      await db.notification.update({
        where: { id: row.id },
        data: { nextAttemptAt: allowedAt },
        select: { id: true },
      });
      return 'postponed';
    }
    if (signal?.aborted) {
      await this.finishAttempt(row, errorKind(signal.reason));
      signal.throwIfAborted();
    }
    const tokens = await mintEscalationTokens(
      db,
      row.tenantId,
      tenant.escalationGeneration,
      ['confirm', 'unsubscribe'],
      this.now(),
    );
    try {
      await mailer.transport.send(
        escalationConfirmationMail(tenant.escalationEmail, tenant.escalationName, {
          confirmLink: escalationLink(mailer.webOrigin, ESCALATION_CONFIRM_PATH, tokens.confirm),
          unsubscribeLink: escalationLink(mailer.webOrigin, ESCALATION_UNSUBSCRIBE_PATH, tokens.unsubscribe),
          validHours: ESCALATION_CONFIRMATION_TTL_HOURS,
        }),
      );
    } catch (error) {
      await discardEscalationTokens(db, [tokens.confirm, tokens.unsubscribe]);
      // Só o tipo: a mensagem do servidor de e-mail pode citar o endereço.
      return this.finishAttempt(row, errorKind(error));
    }
    return this.finishAttempt(row, null);
  }

  /** O e-mail avulso saiu: a pessoa fica no aviso e conta na hora dela, juntos. */
  private async recordSent(row: DueNotice, userId: string, hourStart: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const db = scopeToTenant(tx, row.tenantId);
      await db.notification.update({
        where: { id: row.id },
        data: { deliveredUserIds: { push: userId } },
        select: { id: true },
      });
      await db.notificationDigest.upsert({
        where: { tenantId_userId_hourStart: { tenantId: row.tenantId, userId, hourStart } },
        create: { tenantId: row.tenantId, userId, hourStart, individualSent: 1 },
        update: { individualSent: { increment: 1 } },
        select: { id: true },
      });
    });
  }

  /**
   * O aviso entra no resumo da hora da pessoa (o de retomada, se ele está velho), e a pessoa fica no aviso como
   * atendida, juntos. O resumo sai quando a hora fecha.
   */
  private async fold(row: DueNotice, userId: string, hourStart: Date, catchUp: boolean): Promise<void> {
    const hourEnd = new Date(hourStart.getTime() + HOUR_MS);
    await this.prisma.$transaction(async (tx) => {
      const db = scopeToTenant(tx, row.tenantId);
      const key = { tenantId_userId_hourStart: { tenantId: row.tenantId, userId, hourStart } };
      const hour = await db.notificationDigest.findUnique({ where: key, select: { id: true, status: true } });
      if (hour === null) {
        await db.notificationDigest.create({
          data: {
            tenantId: row.tenantId,
            userId,
            hourStart,
            noticeIds: [row.id],
            catchUp,
            status: 'pending',
            nextAttemptAt: hourEnd,
          },
          select: { id: true },
        });
      } else {
        await db.notificationDigest.update({
          where: { id: hour.id },
          data: {
            noticeIds: { push: row.id },
            ...(catchUp && { catchUp: true }),
            // O primeiro aviso reunido abre o resumo, que sai quando a hora fecha.
            ...(hour.status === null && { status: 'pending', nextAttemptAt: hourEnd }),
          },
          select: { id: true },
        });
      }
      await db.notification.update({
        where: { id: row.id },
        data: { digestedUserIds: { push: userId } },
        select: { id: true },
      });
    });
  }

  /**
   * Fecha uma tentativa: `sent` sem erro; com erro, a próxima depois do recuo, ou `failed` na quinta. Quem já recebeu
   * fica no aviso (gravado a cada envio).
   */
  private async finishAttempt(row: DueNotice, firstError: string | null): Promise<Outcome> {
    const { outcome, data } = attemptResult(row.attempts, firstError, this.now());
    await this.prisma.forTenant(row.tenantId).notification.update({
      where: { id: row.id },
      data,
      select: { id: true },
    });
    return outcome;
  }

  private skip(
    row: DueNotice,
    reason: 'mail_disabled' | 'no_recipients' | 'opted_out' | 'incident_gone',
  ): Promise<'skipped'> {
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

  /**
   * Os resumos vencidos (a hora fechou, ou chegou a hora da nova tentativa), os mais antigos primeiro. False se a
   * concessão foi perdida no meio: o resto da execução fica para quem a tomou.
   */
  private async deliverDigests(
    startedAt: Date,
    report: DigestReport,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const due = await this.prisma.notificationDigest.findMany({
      where: { status: 'pending', nextAttemptAt: { lte: startedAt } },
      select: DIGEST_SELECT,
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: this.batch,
    });
    report.due = due.length;
    for (const digest of due) {
      signal?.throwIfAborted();
      report[await this.deliverDigest(digest)] += 1;
      if (!(await this.lease.renew())) return false;
    }
    return true;
  }

  /**
   * Uma tentativa de um resumo. A pessoa é conferida de novo (ativa, com MFA, do cliente ativo), e só entram os avisos
   * que ela ainda recebe (o papel e a preferência de agora). Um e-mail só.
   */
  private async deliverDigest(row: DueDigest): Promise<Outcome> {
    if (this.mailer === null) return this.closeDigest(row, 'mail_disabled');
    const db = this.prisma.forTenant(row.tenantId);
    const person = await db.user.findFirst({
      where: { id: row.userId, ...ACTIVE_PERSON },
      select: PERSON_SELECT,
    });
    if (person === null) return this.closeDigest(row, 'no_recipients');
    const { items, total, unsaid } = await this.digestContent(
      row,
      asNoticePerson(person),
      this.mailer.webOrigin,
    );
    // Nada que a pessoa ainda receba: desligou os avisos de incidente, mudou de papel, ou os avisos saíram no expurgo (ou
    // os casos deles já foram tratados).
    if (total === 0) {
      await this.caseMail?.dropUnsaid(row.tenantId, unsaid);
      return this.closeDigest(row, 'no_items');
    }
    let firstError: string | null = null;
    try {
      await this.mailer.transport.send(
        digestMail(person.email, person.name, {
          catchUp: row.catchUp,
          hourStart: row.hourStart,
          items,
          total,
          panelLink: new URL('/', this.mailer.webOrigin).href,
        }),
      );
    } catch (error) {
      // Só o tipo: a mensagem do servidor de e-mail pode citar o endereço de quem recebe.
      firstError = errorKind(error);
    }
    const { outcome, data } = attemptResult(row.attempts, firstError, this.now());
    await db.notificationDigest.update({ where: { id: row.id }, data, select: { id: true } });
    if (outcome === 'sent') await this.caseMail?.dropUnsaid(row.tenantId, unsaid);
    return outcome;
  }

  /**
   * Os itens da lista do resumo (até `NOTICE_DIGEST_ITEMS`) e o total que a pessoa ainda recebe, lendo os avisos em
   * lotes: num resumo de milhares, a memória guarda os ids, um lote, os da lista e a contagem. O aviso de caso sem mais o que
   * dizer (tratado) fica de fora, e o id dele volta em `unsaid`.
   */
  private async digestContent(
    row: DueDigest,
    person: NoticePerson,
    webOrigin: string,
  ): Promise<{ items: DigestItem[]; total: number; unsaid: string[] }> {
    const db = this.prisma.forTenant(row.tenantId);
    const digest = await db.notificationDigest.findUnique({
      where: { id: row.id },
      select: { noticeIds: true },
    });
    const ids = [...new Set(digest?.noticeIds ?? [])];
    let total = 0;
    let top: DigestEntry[] = [];
    const unsaid: string[] = [];
    for (let start = 0; start < ids.length; start += NOTIFICATION_DIGEST_READ_CHUNK) {
      const rows = await db.notification.findMany({
        where: { id: { in: ids.slice(start, start + NOTIFICATION_DIGEST_READ_CHUNK) } },
        select: { id: true, createdAt: true, ...TARGET_SELECT, ...CASE_SELECT },
      });
      const received = rows.filter((notice) => receives(notice.kind, person));
      const contents = await this.caseContents(row.tenantId, received, webOrigin);
      for (const [id, content] of contents) if (content === null) unsaid.push(id);
      const entries = digestEntries(received, webOrigin, contents);
      total += entries.length;
      top = [...top, ...entries].sort(digestOrder).slice(0, NOTICE_DIGEST_ITEMS);
    }
    return { items: top.map(({ item }) => item), total, unsaid };
  }

  /** Encerra o resumo sem envio, com o motivo. */
  private async closeDigest(
    row: DueDigest,
    reason: 'mail_disabled' | 'no_recipients' | 'no_items',
  ): Promise<'skipped'> {
    await this.prisma.forTenant(row.tenantId).notificationDigest.update({
      where: { id: row.id },
      data: { status: 'skipped', lastError: reason },
      select: { id: true },
    });
    return 'skipped';
  }
}
