import { randomUUID } from 'node:crypto';
import { type ActiveException, matchingException } from '../alerts/exception-match.js';
import { FindingStore, LastEvents, SyncLease, type UnownedRecord } from '../alerts/finding-store.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
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

/**
 * Uma assinatura e as contas (projetos) que a usam. O cadastro aceita a mesma assinatura em vários projetos de um
 * mesmo cliente (coletor agregado): ela é lida uma vez só, e cada evento vai para a conta do projeto dele.
 */
interface SubscriptionGroup {
  subscription: string;
  /** Projeto → cliente. Mais de um cliente na mesma assinatura é cadastro inconsistente: nenhum evento é atribuído. */
  projects: Map<string, string>;
  ambiguous: boolean;
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
 * A leitura de cada assinatura também dá o estado da conexão das contas que a usam: lida sem erro, as contas ficam
 * `connected`, com a hora da coleta, haja evento ou não; com erro, ficam `error`, com o tipo do erro.
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
      for (const group of await this.subscriptions()) {
        report.subscriptions += 1;
        try {
          await this.readSubscription(group, context);
        } catch (error) {
          // Uma assinatura com problema (permissão, rede) não para as outras.
          report.failedSubscriptions += 1;
          const kind = errorKind(error);
          firstError ??= kind;
          await this.markConnection(group, { connection: 'error', connectionError: kind });
          continue;
        }
        // Assinatura em mais de um cliente: a leitura funciona, mas nenhum evento vai para as contas.
        await this.markConnection(
          group,
          group.ambiguous
            ? { connection: 'error', connectionError: 'ambiguous_source' }
            : { connection: 'connected', connectionError: null, lastCollectedAt: now },
        );
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
        data: { lastRunAt: now, lastError: errorKind(error) },
      });
      throw error;
    } finally {
      await this.lease.release();
    }
  }

  /**
   * Estado da conexão das contas ativas que usam a assinatura, cada uma pelo escopo do próprio cliente. A coleta conta
   * a leitura, não o evento: um projeto sem atividade continua conectado.
   */
  private async markConnection(
    group: SubscriptionGroup,
    data: Pick<
      Prisma.CloudAccountUpdateManyMutationInput,
      'connection' | 'connectionError' | 'lastCollectedAt'
    >,
  ): Promise<void> {
    const projectsByTenant = new Map<string, string[]>();
    for (const [project, tenantId] of group.projects) {
      projectsByTenant.set(tenantId, [...(projectsByTenant.get(tenantId) ?? []), project]);
    }
    for (const [tenantId, projects] of projectsByTenant) {
      await this.prisma.forTenant(tenantId).cloudAccount.updateMany({
        where: {
          provider: 'gcp',
          status: 'active',
          accountId: { in: projects },
          pubsubSubscription: group.subscription,
        },
        data,
      });
    }
  }

  /** Contas GCP ativas, agrupadas pela assinatura: o cadastro que decide o dono de cada evento. */
  private async subscriptions(): Promise<SubscriptionGroup[]> {
    const rows = await this.prisma.cloudAccount.findMany({
      where: { provider: 'gcp', status: 'active', pubsubSubscription: { not: null } },
      select: { tenantId: true, accountId: true, pubsubSubscription: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const groups = new Map<string, SubscriptionGroup & { tenants: Set<string> }>();
    for (const row of rows) {
      if (!row.pubsubSubscription) continue;
      const group = groups.get(row.pubsubSubscription) ?? {
        subscription: row.pubsubSubscription,
        projects: new Map<string, string>(),
        ambiguous: false,
        tenants: new Set<string>(),
      };
      group.projects.set(row.accountId, row.tenantId);
      group.tenants.add(row.tenantId);
      group.ambiguous = group.tenants.size > 1;
      groups.set(row.pubsubSubscription, group);
    }
    return [...groups.values()];
  }

  private async readSubscription(group: SubscriptionGroup, context: RunContext): Promise<void> {
    for (let pull = 0; pull < this.maxPulls; pull += 1) {
      const messages = await this.reader.pull(group.subscription, this.pullSize);
      for (const message of messages) {
        context.report.read += 1;
        await this.process(message, group, context);
      }
      // Confirma só o que já foi gravado.
      await this.reader.acknowledge(
        group.subscription,
        messages.map((message) => message.ackId),
      );
      await this.lease.renew();
      if (messages.length < this.pullSize) return;
    }
  }

  private async process(
    message: PubsubMessage,
    group: SubscriptionGroup,
    context: RunContext,
  ): Promise<void> {
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
    const tenantId = project === null || group.ambiguous ? undefined : group.projects.get(project);
    if (project === null || tenantId === undefined) {
      // Log de organização (sem projeto), de projeto que não usa esta assinatura ou assinatura cadastrada em mais de
      // um cliente: na dúvida, o evento não é de ninguém.
      const reason =
        project === null ? 'no_account' : group.ambiguous ? 'ambiguous_source' : 'source_mismatch';
      await this.store.recordUnowned(
        unownedRecord(
          gcpEventId(project, entry.insertId),
          reason,
          project === null ? [] : [project],
          occurredAt,
          rule,
          method,
        ),
      );
      report.unowned += 1;
      return;
    }

    context.lastEvents.see(tenantId, project, occurredAt);
    if (context.newest === null || occurredAt > context.newest) context.newest = occurredAt;
    if (!rule) {
      report.ignored += 1;
      return;
    }

    const draft = toGcpFindingDraft(entry, { tenantId, project }, rule);
    const exception = matchingException(draft, context.exceptions.get(tenantId) ?? [], context.now);
    const outcome = await this.store.persist(
      draft,
      exception,
      context.protectedItems.get(tenantId) ?? new Set(),
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
