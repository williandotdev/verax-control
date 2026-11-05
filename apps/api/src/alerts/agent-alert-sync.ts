import { randomUUID } from 'node:crypto';
import { wazuhAgentRef } from '@verax/shared';
import { AGENTS_SYNC_STATE } from '../agents/agents-sync.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { IncidentGrouping } from '../incidents/incident-grouping.js';
import type { AlertCursor } from '../indexer/alert-queries.js';
import type { AlertHit } from '../indexer/indexer.client.js';
import { isAgentAlert, parseAgentAlert, type WazuhAgentAlert } from './agent-alert.js';
import { AgentDirectory, resolveAgentAlertOwner } from './agent-owner.js';
import { type AlertSearchClient, type AlertSyncOptions, eventIdOf } from './alert-sync.js';
import { type ActiveException, matchingException } from './exception-match.js';
import { toAgentFindingDraft } from './finding-draft.js';
import { FindingStore, SyncLease, type UnownedRecord } from './finding-store.js';
import {
  agentSyncPage,
  cursorFromSort,
  DEFAULT_AGENT_SYNC_SETTINGS,
  type SyncSettings,
  syncWindowStart,
} from './sync-query.js';

/** Nome do estado em `SyncState`: leitura, cursor e concessão próprios, separados dos da AWS. */
export const AGENT_ALERT_SYNC = 'wazuh-agent-alerts';

export interface AgentSyncReport {
  status: 'done' | 'locked';
  /** Alertas lidos do indexer, inclusive os inválidos. */
  read: number;
  created: number;
  /** Já gravados por uma execução anterior (a janela de sobreposição relê). */
  duplicates: number;
  unowned: number;
  /** Achados que já nasceram esperados por uma exceção. */
  excepted: number;
  incidentsOpened: number;
  incidentsJoined: number;
  /** Alertas recentes de um agente que a lista ainda não conhece: a próxima execução os relê (`AGENT_LIST_GRACE_MS`). */
  deferred: number;
  /** Alertas do próprio manager (`agent.id` 000): são do sync da AWS. */
  skipped: number;
  /**
   * Alertas abaixo do nível mínimo dos agentes (`AGENT_MIN_LEVEL`): a consulta já os deixa de fora, e a regra se
   * repete em cada alerta lido, como a do manager. Não viram achado nem vão para a fila.
   */
  belowLevel: number;
  lastProcessedAt: string | null;
}

/** O alerta de agente sem dono como a fila guarda: o motivo, o agente e as contas, e o mínimo para a triagem. */
function unownedRecord(
  sourceEventId: string,
  reason: UnownedRecord['reason'],
  accounts: string[],
  alert: WazuhAgentAlert | null,
): UnownedRecord {
  return {
    source: 'wazuh',
    sourceEventId,
    reason,
    accounts,
    occurredAt: alert ? new Date(alert.timestamp) : null,
    ruleId: alert?.rule.id ?? null,
    ruleLevel: alert?.rule.level ?? null,
    title: alert?.rule.description ?? null,
  };
}

/**
 * Sync dos alertas dos agentes do Wazuh nas instâncias do cliente (tarefa `wazuh-agent-alerts` do worker, ao lado do
 * sync da AWS). Cada execução:
 * 1. pega a concessão própria (um worker por vez; ela vence sozinha se o worker morrer);
 * 2. monta a lista dos agentes do cliente do nó, as contas AWS cadastradas, as exceções e a lista de proteção;
 * 3. lê o indexer a partir do último alerta processado, menos a sobreposição, página a página pelo cursor, só os
 *    alertas que não vieram do manager, do nível 7 para cima (`agentSyncPage`, `AGENT_MIN_LEVEL`);
 * 4. decide o dono de cada alerta (`resolveAgentAlertOwner`). Com dono, grava o achado do cliente do nó, sem duplicar
 *    e já aplicando a exceção e o agrupamento (`FindingStore`, o mesmo da AWS). Sem dono, o alerta vai para a fila que
 *    só `admin_verax` vê. O alerta recente de um agente que a lista ainda não conhece fica para a próxima execução;
 * 5. grava até onde leu.
 *
 * Corre separado do sync da AWS, com estado e concessão próprios: uma instância barulhenta não atrasa os achados das
 * contas, e o caminho da AWS não muda. Roda mesmo com os agentes desligados no worker (`agentsTenantId` null): um
 * alerta de agente, nesse caso, vai para a fila (`agents_disabled`), em vez de sumir. Nada do evento bruto é gravado.
 */
export class AgentAlertSync {
  private readonly name: string;
  private readonly settings: SyncSettings;
  private readonly maxPages: number;
  private readonly store: FindingStore;
  private readonly lease: SyncLease;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: AlertSearchClient,
    /** Cliente do nó (`WAZUH_AGENTS_TENANT`, com o arquivo da lista); null com os agentes desligados no worker. */
    private readonly agentsTenantId: string | null,
    options: AlertSyncOptions = {},
  ) {
    this.name = options.name ?? AGENT_ALERT_SYNC;
    this.settings = options.settings ?? DEFAULT_AGENT_SYNC_SETTINGS;
    this.maxPages = options.maxPages ?? 100;
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

  async runOnce(now: Date = new Date()): Promise<AgentSyncReport> {
    const report: AgentSyncReport = {
      status: 'done',
      read: 0,
      created: 0,
      duplicates: 0,
      unowned: 0,
      excepted: 0,
      incidentsOpened: 0,
      incidentsJoined: 0,
      deferred: 0,
      skipped: 0,
      belowLevel: 0,
      lastProcessedAt: null,
    };
    if (!(await this.lease.acquire(now))) return { ...report, status: 'locked' };
    try {
      const state = await this.prisma.syncState.findUniqueOrThrow({ where: { name: this.name } });
      const directory = await this.directory();
      const exceptions = await this.store.activeExceptions(now);
      const protectedItems = await this.store.protectedItems();
      let lastProcessedAt = state.lastProcessedAt;
      // Continuação de uma execução que bateu o limite de páginas, como no sync da AWS.
      let cursor: AlertCursor | null =
        state.cursorTimestamp && state.cursorId
          ? { timestamp: state.cursorTimestamp.toISOString(), id: state.cursorId }
          : null;
      const windowStart =
        cursor?.timestamp ?? syncWindowStart(lastProcessedAt?.toISOString() ?? null, now, this.settings);

      let capped = true;
      for (let page = 0; page < this.maxPages; page += 1) {
        const hits = await this.indexer.search(agentSyncPage(windowStart, cursor, this.settings));
        for (const hit of hits) {
          report.read += 1;
          await this.process(hit, directory, exceptions, protectedItems, now, report);
        }
        const last = hits.at(-1);
        if (last) {
          cursor = cursorFromSort(last.sort);
          const at = new Date(cursor.timestamp);
          if (lastProcessedAt === null || at > lastProcessedAt) lastProcessedAt = at;
        }
        if (hits.length < this.settings.pageSize) {
          capped = false;
          break;
        }
        await this.lease.renew();
      }
      const continuation = capped ? cursor : null;

      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastProcessedAt,
          cursorTimestamp: continuation ? new Date(continuation.timestamp) : null,
          cursorId: continuation?.id ?? null,
          lastRunAt: now,
          lastSuccessAt: new Date(),
          lastError: null,
        },
      });
      report.lastProcessedAt = lastProcessedAt?.toISOString() ?? null;
      return report;
    } catch (error) {
      // Só o tipo do erro: a mensagem de um erro do indexer ou do banco pode carregar dado.
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: { lastRunAt: now, lastError: (error instanceof Error ? error.name : 'Error').slice(0, 64) },
      });
      throw error;
    } finally {
      await this.lease.release();
    }
  }

  private async process(
    hit: AlertHit,
    directory: AgentDirectory,
    exceptions: ReadonlyMap<string, ActiveException[]>,
    protectedItems: ReadonlyMap<string, ReadonlySet<string>>,
    now: Date,
    report: AgentSyncReport,
  ): Promise<void> {
    // A página só traz alertas de agente (`agentSyncPage`); o do manager é do sync da AWS e nunca passa por aqui.
    if (!isAgentAlert(hit.source)) {
      report.skipped += 1;
      return;
    }
    const parsed = parseAgentAlert(hit.source);
    if (!parsed.ok) {
      const accounts = parsed.agentId === null ? [] : [wazuhAgentRef(parsed.agentId)];
      await this.store.recordUnowned(unownedRecord(eventIdOf(parsed.id, hit), parsed.reason, accounts, null));
      report.unowned += 1;
      return;
    }
    const alert = parsed.alert;
    // A página já pede o nível mínimo (`agentSyncPage`); conferido de novo aqui, como o `agent.id`.
    if (alert.rule.level < this.settings.minLevel) {
      report.belowLevel += 1;
      return;
    }
    const owner = resolveAgentAlertOwner(alert, directory, now);
    if (owner.status === 'deferred') {
      report.deferred += 1;
      return;
    }
    if (owner.status === 'unowned') {
      await this.store.recordUnowned(unownedRecord(alert.id, owner.reason, owner.accounts, alert));
      report.unowned += 1;
      return;
    }

    const draft = toAgentFindingDraft(alert, owner);
    const exception = matchingException(draft, exceptions.get(owner.tenantId) ?? [], now);
    const outcome = await this.store.persist(
      draft,
      exception,
      protectedItems.get(owner.tenantId) ?? new Set(),
      now,
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

  /**
   * O que decide o dono: os agentes da lista do cliente do nó (pelo escopo dele), todas as contas AWS cadastradas (de
   * qualquer cliente, ativas ou não: só servem para recusar) e a hora da última lista do manager.
   */
  private async directory(): Promise<AgentDirectory> {
    const tenantId = this.agentsTenantId;
    const agents =
      tenantId === null
        ? []
        : await this.prisma
            .forTenant(tenantId)
            .wazuhAgent.findMany({ select: { agentId: true, name: true } });
    const awsAccounts = await this.prisma.cloudAccount.findMany({
      where: { provider: 'aws' },
      select: { tenantId: true, accountId: true },
    });
    const list = await this.prisma.syncState.findUnique({
      where: { name: AGENTS_SYNC_STATE },
      select: { lastProcessedAt: true },
    });
    return AgentDirectory.from({ tenantId, agents, awsAccounts, listedAt: list?.lastProcessedAt ?? null });
  }
}
