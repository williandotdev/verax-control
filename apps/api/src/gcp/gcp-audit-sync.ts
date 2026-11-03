import { randomUUID } from 'node:crypto';
import { type ActiveException, matchingException } from '../alerts/exception-match.js';
import { FindingStore, LastEvents, SyncLease, type UnownedRecord } from '../alerts/finding-store.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { IncidentGrouping } from '../incidents/incident-grouping.js';
import { parseLogMessage } from './gcp-log-entry.js';
import { detect, gcpEventId, type GcpRule, toGcpFindingDraft } from './gcp-rules.js';
import type { PubsubMessage, PubsubReader } from './pubsub.client.js';

export const GCP_AUDIT_SYNC = 'gcp-audit';

export interface GcpAuditSyncOptions {
  /** Nome do estado gravado em `SyncState` (os testes usam um por caso). */
  name?: string;
  leaseMs?: number;
  owner?: string;
  /** Mensagens por leitura (o Pub/Sub entrega até esse tanto). */
  pullSize?: number;
  /** Leituras por assinatura em cada execução: um atraso grande é lido em várias execuções. */
  maxPulls?: number;
  groupingWindowMinutes?: number;
  grouping?: IncidentGrouping;
}

export interface GcpSyncReport {
  status: 'done' | 'locked';
  subscriptions: number;
  /** Assinaturas que falharam nesta execução (as outras seguem; a mensagem não confirmada volta depois). */
  failedSubscriptions: number;
  read: number;
  created: number;
  duplicates: number;
  unowned: number;
  excepted: number;
  /** Eventos válidos do próprio projeto que nenhuma regra considerou suspeitos. */
  ignored: number;
  incidentsOpened: number;
  incidentsJoined: number;
}

interface GcpAccount {
  tenantId: string;
  accountId: string;
  pubsubSubscription: string;
}

interface RunContext {
  exceptions: ReadonlyMap<string, ActiveException[]>;
  protectedItems: ReadonlyMap<string, ReadonlySet<string>>;
  lastEvents: LastEvents;
  now: Date;
  report: GcpSyncReport;
  newest: Date | null;
}

function unownedRecord(
  sourceEventId: string,
  reason: UnownedRecord['reason'],
  accounts: string[],
  occurredAt: Date | null,
  rule: GcpRule | null,
  method: string | null,
): UnownedRecord {
  return {
    source: 'gcp',
    sourceEventId,
    reason,
    accounts,
    occurredAt,
    ruleId: rule?.id ?? null,
    ruleLevel: rule?.level ?? null,
    title: rule?.title ?? method,
  };
}

/**
 * Sync da auditoria da GCP para achados (nó da Verax, sem Wazuh). Cada conta GCP cadastrada tem a própria assinatura
 * do Pub/Sub, e é ela que diz de qual cliente é o evento. Cada execução, para cada assinatura:
 * 1. lê as mensagens em lotes;
 * 2. confere que o evento é do projeto da conta (outro projeto, sem projeto ou mensagem inválida vão para a fila sem
 *    dono: na dúvida, o evento não é de ninguém);
 * 3. aplica as regras; o evento suspeito vira achado, com a exceção e o incidente, na mesma transação;
 * 4. só depois confirma (ack) o lote. Se algo falhar antes, o Pub/Sub entrega de novo, e a chave única do achado
 *    impede duplicar.
 *
 * Nada do evento bruto é gravado: o achado guarda os campos já validados.
 */
export class GcpAuditSync {
  private readonly name: string;
  private readonly pullSize: number;
  private readonly maxPulls: number;
  private readonly store: FindingStore;
  private readonly lease: SyncLease;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: PubsubReader,
    options: GcpAuditSyncOptions = {},
  ) {
    this.name = options.name ?? GCP_AUDIT_SYNC;
    this.pullSize = options.pullSize ?? 100;
    this.maxPulls = options.maxPulls ?? 20;
    this.store = new FindingStore(
      prisma,
      options.grouping ?? new IncidentGrouping(options.groupingWindowMinutes),
    );
    this.lease = new SyncLease(
      prisma,
      this.name,
      options.owner ?? `worker-${randomUUID()}`,
      options.leaseMs ?? 5 * 60 * 1000,
    );
  }

  async runOnce(now: Date = new Date()): Promise<GcpSyncReport> {
    const report: GcpSyncReport = {
      status: 'done',
      subscriptions: 0,
      failedSubscriptions: 0,
      read: 0,
      created: 0,
      duplicates: 0,
      unowned: 0,
      excepted: 0,
      ignored: 0,
      incidentsOpened: 0,
      incidentsJoined: 0,
    };
    if (!(await this.lease.acquire(now))) return { ...report, status: 'locked' };
    let firstError: string | null = null;
    try {
      const state = await this.prisma.syncState.findUniqueOrThrow({ where: { name: this.name } });
      const context: RunContext = {
        exceptions: await this.store.activeExceptions(now),
        protectedItems: await this.store.protectedItems(),
        lastEvents: new LastEvents(),
        now,
        report,
        newest: state.lastProcessedAt,
      };
      for (const account of await this.accounts()) {
        report.subscriptions += 1;
        try {
          await this.readSubscription(account, context);
        } catch (error) {
          // Uma assinatura com problema (permissão, rede) não para as outras.
          report.failedSubscriptions += 1;
          firstError ??= (error instanceof Error ? error.name : 'Error').slice(0, 64);
        }
      }
      await context.lastEvents.save(this.prisma, 'gcp');
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastProcessedAt: context.newest,
          lastRunAt: now,
          ...(firstError === null && { lastSuccessAt: new Date() }),
          lastError: firstError,
        },
      });
      return report;
    } catch (error) {
      // Só o tipo do erro: a mensagem de um erro do banco ou do Google pode carregar dado.
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: { lastRunAt: now, lastError: (error instanceof Error ? error.name : 'Error').slice(0, 64) },
      });
      throw error;
    } finally {
      await this.lease.release();
    }
  }

  /** Contas GCP ativas com assinatura: o cadastro que decide o dono de cada evento. */
  private async accounts(): Promise<GcpAccount[]> {
    const rows = await this.prisma.cloudAccount.findMany({
      where: { provider: 'gcp', status: 'active', pubsubSubscription: { not: null } },
      select: { tenantId: true, accountId: true, pubsubSubscription: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.flatMap((row) =>
      row.pubsubSubscription ? [{ ...row, pubsubSubscription: row.pubsubSubscription }] : [],
    );
  }

  private async readSubscription(account: GcpAccount, context: RunContext): Promise<void> {
    for (let pull = 0; pull < this.maxPulls; pull += 1) {
      const messages = await this.reader.pull(account.pubsubSubscription, this.pullSize);
      for (const message of messages) {
        context.report.read += 1;
        await this.process(message, account, context);
      }
      // Confirma só o que já foi gravado.
      await this.reader.acknowledge(
        account.pubsubSubscription,
        messages.map((message) => message.ackId),
      );
      await this.lease.renew();
      if (messages.length < this.pullSize) return;
    }
  }

  private async process(message: PubsubMessage, account: GcpAccount, context: RunContext): Promise<void> {
    const { report } = context;
    const parsed = parseLogMessage(message.data);
    if (!parsed.ok) {
      const eventId = gcpEventId(null, parsed.insertId ?? `pubsub:${message.messageId}`);
      await this.store.recordUnowned(unownedRecord(eventId, 'invalid_alert', [], null, null, null));
      report.unowned += 1;
      return;
    }
    const { entry, project } = parsed;
    const occurredAt = new Date(entry.timestamp);
    const rule = detect(entry.protoPayload);
    const method = entry.protoPayload?.methodName ?? null;
    if (project === null || project !== account.accountId) {
      // Log de organização (sem projeto) ou de outro projeto chegando por esta assinatura: não é desta conta.
      await this.store.recordUnowned(
        unownedRecord(
          gcpEventId(project, entry.insertId),
          project === null ? 'no_account' : 'source_mismatch',
          project === null ? [] : [project],
          occurredAt,
          rule,
          method,
        ),
      );
      report.unowned += 1;
      return;
    }

    context.lastEvents.see(account.tenantId, project, occurredAt);
    if (context.newest === null || occurredAt > context.newest) context.newest = occurredAt;
    if (!rule) {
      report.ignored += 1;
      return;
    }

    const draft = toGcpFindingDraft(entry, { tenantId: account.tenantId, project }, rule);
    const exception = matchingException(draft, context.exceptions.get(account.tenantId) ?? [], context.now);
    const outcome = await this.store.persist(
      draft,
      exception,
      context.protectedItems.get(account.tenantId) ?? new Set(),
      context.now,
    );
    if (outcome === 'duplicate') {
      report.duplicates += 1;
      return;
    }
    report.created += 1;
    if (outcome === 'excepted') report.excepted += 1;
    if (outcome === 'opened') report.incidentsOpened += 1;
    if (outcome === 'joined') report.incidentsJoined += 1;
  }
}
