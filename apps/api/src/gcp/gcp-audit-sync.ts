import { randomUUID } from 'node:crypto';
import { type ActiveException, matchingException } from '../alerts/exception-match.js';
import { FindingStore, LastEvents, SyncLease, type UnownedRecord } from '../alerts/finding-store.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { IncidentGrouping } from '../incidents/incident-grouping.js';
import { COLLECTING_TENANT } from '../tenants/tenant-status.js';
import { base64Bytes, UsageMeter } from '../usage/usage-meter.js';
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

/**
 * Falha da própria fonte: o `pull` ou o `acknowledge` do Pub/Sub. É a única que vira erro de conexão das contas,
 * com o tipo do erro original (`cause`). Um erro interno (banco, concessão, gravação do achado) não diz nada sobre a
 * conta do cliente.
 */
export class SourceReadError extends Error {
  override name = 'SourceReadError';

  constructor(cause: unknown) {
    // Sem dado na mensagem: o detalhe fica só no erro original.
    super('falha na leitura do Pub/Sub', { cause });
  }
}

async function fromSource<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new SourceReadError(error);
  }
}

interface RunContext {
  exceptions: ReadonlyMap<string, ActiveException[]>;
  protectedItems: ReadonlyMap<string, ReadonlySet<string>>;
  lastEvents: LastEvents;
  now: Date;
  report: GcpSyncReport;
  newest: Date | null;
}

/** O instante do volume por dia: o `publishTime` da mensagem; sem ele (ou fora do formato), o da leitura. */
export function publishedAt(message: Pick<PubsubMessage, 'publishTime'>, now: Date): Date {
  const at = message.publishTime === undefined ? Number.NaN : Date.parse(message.publishTime);
  return Number.isNaN(at) ? now : new Date(at);
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
 *    impede duplicar;
 * 5. depois do ack, grava o volume lido no medidor de uso (`IngestUsage`, fonte `gcp`): o `data` de toda mensagem do
 *    lote, inclusive a inválida, a sem dono e a que nenhuma regra acusa, para o cliente da assinatura. A assinatura
 *    cadastrada em mais de um cliente não conta para nenhum. O lote que falha antes do ack não conta: volta pelo
 *    Pub/Sub e é medido quando for confirmado. O mesmo volume entra no dia de Brasília do `publishTime` de cada
 *    mensagem (`IngestUsageDay`, CE-09: a franquia da Plataforma), e não no da leitura.
 *
 * A leitura de cada assinatura também dá o estado da conexão das contas que a usam:
 * - lida sem erro, todas ganham a hora da coleta e perdem o erro. Só fica `connected` a conta que já recebeu evento:
 *   a GCP entrega por evento, e uma leitura vazia não prova que os logs chegam (sink apagado, filtro errado). A
 *   conta sem evento fica `waiting`, e o primeiro evento a conecta (`LastEvents.save`, no fim da execução);
 * - com falha do Pub/Sub (`pull` ou `acknowledge`), ficam `error`, com o tipo do erro. Um erro interno (banco,
 *   concessão, gravação) conta como assinatura com falha, mas não mexe na conexão.
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
          // Uma assinatura com problema (permissão, rede, banco) não para as outras.
          report.failedSubscriptions += 1;
          const pubsubError = error instanceof SourceReadError ? error : null;
          const kind = errorKind(pubsubError ? pubsubError.cause : error);
          firstError ??= kind;
          // Só a falha do Pub/Sub é da conta; a interna fica no estado do sync.
          if (pubsubError) await this.markConnection(group, { connection: 'error', connectionError: kind });
          continue;
        }
        if (group.ambiguous) {
          // Assinatura em mais de um cliente: a leitura funciona, mas nenhum evento vai para as contas.
          await this.markConnection(group, { connection: 'error', connectionError: 'ambiguous_source' });
        } else {
          // A coleta vale para todas; "conectada" só a que já recebeu evento. A leitura vazia não é sinal de vida.
          const collected = { connectionError: null, lastCollectedAt: now };
          await this.markConnection(
            group,
            { ...collected, connection: 'connected' },
            { lastEventAt: { not: null } },
          );
          await this.markConnection(group, { ...collected, connection: 'waiting' }, { lastEventAt: null });
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
        data: { lastRunAt: now, lastError: errorKind(error) },
      });
      throw error;
    } finally {
      await this.lease.release();
    }
  }

  /**
   * Estado da conexão das contas ativas que usam a assinatura, cada uma pelo escopo do próprio cliente. `only`
   * restringe a algumas delas (as que já receberam evento, as que nunca receberam).
   */
  private async markConnection(
    group: SubscriptionGroup,
    data: Pick<
      Prisma.CloudAccountUpdateManyMutationInput,
      'connection' | 'connectionError' | 'lastCollectedAt'
    >,
    only: Pick<Prisma.CloudAccountWhereInput, 'lastEventAt'> = {},
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
          ...only,
        },
        data,
      });
    }
  }

  /**
   * Contas GCP ativas, agrupadas pela assinatura: o cadastro que decide o dono de cada evento. A dona é decidida com os
   * clientes de todas as contas cadastradas, em qualquer estado: uma assinatura em dois clientes continua ambígua (sem
   * dono e sem medição) mesmo com um deles suspenso, cancelado, em expurgo ou desativado. Só depois sai o que não se
   * coleta (CE-02): a assinatura em que nenhum cliente está `active` não é lida.
   */
  private async subscriptions(): Promise<SubscriptionGroup[]> {
    const rows = await this.prisma.cloudAccount.findMany({
      where: { provider: 'gcp', status: 'active', pubsubSubscription: { not: null } },
      select: {
        tenantId: true,
        accountId: true,
        pubsubSubscription: true,
        tenant: { select: { status: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const groups = new Map<string, SubscriptionGroup & { tenants: Set<string>; collecting: boolean }>();
    for (const row of rows) {
      if (!row.pubsubSubscription) continue;
      const group = groups.get(row.pubsubSubscription) ?? {
        subscription: row.pubsubSubscription,
        projects: new Map<string, string>(),
        ambiguous: false,
        tenants: new Set<string>(),
        collecting: false,
      };
      group.projects.set(row.accountId, row.tenantId);
      group.tenants.add(row.tenantId);
      group.ambiguous = group.tenants.size > 1;
      group.collecting ||= row.tenant.status === COLLECTING_TENANT.tenant.is.status;
      groups.set(row.pubsubSubscription, group);
    }
    return [...groups.values()].filter((group) => group.collecting);
  }

  private async readSubscription(group: SubscriptionGroup, context: RunContext): Promise<void> {
    // O volume lido é do cliente da assinatura (todos os projetos dela são dele); ambígua, não é de ninguém.
    const owner = group.ambiguous ? undefined : group.projects.values().next().value;
    for (let pull = 0; pull < this.maxPulls; pull += 1) {
      const messages = await fromSource(() => this.reader.pull(group.subscription, this.pullSize));
      const usage = new UsageMeter();
      for (const message of messages) {
        context.report.read += 1;
        if (owner) {
          const bytes = base64Bytes(message.data);
          usage.add(owner, 'gcp', bytes, 1, context.now);
          // A franquia por dia (CE-09) conta no dia em que o Pub/Sub recebeu a mensagem, não no da leitura.
          usage.addDaily(owner, 'gcp', bytes, 1, publishedAt(message, context.now));
        }
        await this.process(message, group, context);
      }
      // Confirma só o que já foi gravado.
      await fromSource(() =>
        this.reader.acknowledge(
          group.subscription,
          messages.map((message) => message.ackId),
        ),
      );
      // Mede só o que foi confirmado: uma escrita por lote.
      await usage.flush(this.prisma);
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
