import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { AlertCursor } from '../indexer/alert-queries.js';
import type { AlertHit } from '../indexer/indexer.client.js';
import { COLLECTING_TENANT } from '../tenants/tenant-status.js';
import { type AlertSearchClient, type AlertSyncOptions, eventIdOf } from './alert-sync.js';
import {
  type CloudWatchAlertOwner,
  type CloudWatchSourceOwner,
  parseCloudWatchAlert,
  resolveCloudWatchOwner,
  type WazuhCloudWatchAlert,
} from './cloudwatch-alert.js';
import { type ActiveException, matchingException } from './exception-match.js';
import { toCloudWatchFindingDraft } from './finding-draft.js';
import { FindingStore, LastEvents, SyncLease, type UnownedRecord } from './finding-store.js';
import {
  cloudWatchSyncPage,
  cursorFromSort,
  DEFAULT_CLOUDWATCH_SYNC_SETTINGS,
  type SyncSettings,
  syncWindowStart,
} from './sync-query.js';

/** Nome do estado em `SyncState`: leitura, cursor e concessão próprios, separados dos da AWS e dos agentes. */
export const CLOUDWATCH_ALERT_SYNC = 'wazuh-cloudwatch-alerts';

export interface CloudWatchSyncReport {
  status: 'done' | 'locked';
  /** Alertas lidos do indexer, inclusive os inválidos. */
  read: number;
  created: number;
  /** Já gravados por uma execução anterior (a janela de sobreposição relê). */
  duplicates: number;
  unowned: number;
  /** Achados que já nasceram esperados por uma exceção. */
  excepted: number;
  /** Alertas que não são do CloudWatch Logs (a consulta já os deixa de fora; conferido de novo em cada um). */
  skipped: number;
  /** Alertas abaixo do nível mínimo (idem). */
  belowLevel: number;
  lastProcessedAt: string | null;
}

/** O alerta sem dono como a fila guarda: o motivo e o mínimo para a triagem, nunca a linha de log. */
function unownedRecord(
  sourceEventId: string,
  reason: UnownedRecord['reason'],
  accounts: string[],
  alert: WazuhCloudWatchAlert | null,
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
 * Sync dos alertas do CloudWatch Logs lidos pelo Wazuh do nó (tarefa `wazuh-cloudwatch-alerts` do worker, ao lado do
 * sync da AWS e do dos agentes; onboarding self-service). Cada execução:
 * 1. pega a concessão própria (um worker por vez; ela vence sozinha se o worker morrer);
 * 2. decide de quem são os alertas do CloudWatch Logs deste nó (`resolveCloudWatchOwner`): só quando um único cliente
 *    tem grupo de logs autorizado, numa única conta. O evento não diz de que conta nem de que grupo veio;
 * 3. lê o indexer a partir do último alerta processado, menos a sobreposição, página a página pelo cursor: só os do
 *    manager com `location = Wazuh-AWS` que não são eventos de bucket, do nível mínimo para cima (`cloudWatchSyncPage`);
 * 4. com dono, grava o achado do cliente, sem duplicar e já aplicando a exceção (`FindingStore`, o mesmo dos outros
 *    syncs). Sem dono, o alerta vai para a fila que só `admin_verax` vê, com o motivo;
 * 5. grava o último evento da conta e até onde leu.
 *
 * Fica fora da célula compartilhada (o worker nem cria a tarefa): lá, vários clientes dividem o manager, e a coleta da
 * AWS por cliente ainda não existe. Nada do evento bruto é gravado: o detalhe do achado relê a linha no indexer.
 */
export class CloudWatchAlertSync {
  private readonly name: string;
  private readonly settings: SyncSettings;
  private readonly maxPages: number;
  private readonly store: FindingStore;
  private readonly lease: SyncLease;
  /** Só os testes, que dividem o banco: restringe o cadastro às contas destes clientes. */
  private readonly tenantIds: readonly string[] | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: AlertSearchClient,
    options: AlertSyncOptions & { tenantIds?: readonly string[] } = {},
  ) {
    this.name = options.name ?? CLOUDWATCH_ALERT_SYNC;
    this.settings = options.settings ?? DEFAULT_CLOUDWATCH_SYNC_SETTINGS;
    this.maxPages = options.maxPages ?? 100;
    this.store = new FindingStore(prisma, options.notices);
    this.tenantIds = options.tenantIds;
    this.lease = new SyncLease(
      prisma,
      this.name,
      options.owner ?? `worker-${randomUUID()}`,
      options.leaseMs ?? 5 * 60 * 1000,
    );
  }

  async runOnce(now: Date = new Date()): Promise<CloudWatchSyncReport> {
    const report: CloudWatchSyncReport = {
      status: 'done',
      read: 0,
      created: 0,
      duplicates: 0,
      unowned: 0,
      excepted: 0,
      skipped: 0,
      belowLevel: 0,
      lastProcessedAt: null,
    };
    if (!(await this.lease.acquire(now))) return { ...report, status: 'locked' };
    try {
      const state = await this.prisma.syncState.findUniqueOrThrow({ where: { name: this.name } });
      const owner = resolveCloudWatchOwner(await this.authorizedSources());
      const exceptions = await this.store.activeExceptions(now);
      const lastEvents = new LastEvents();
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
        const hits = await this.indexer.search(cloudWatchSyncPage(windowStart, cursor, this.settings));
        for (const hit of hits) {
          report.read += 1;
          await this.process(hit, owner, exceptions, now, report, lastEvents);
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

      await lastEvents.save(this.prisma, 'aws');
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
    owner: CloudWatchAlertOwner,
    exceptions: ReadonlyMap<string, ActiveException[]>,
    now: Date,
    report: CloudWatchSyncReport,
    lastEvents: LastEvents,
  ): Promise<void> {
    const parsed = parseCloudWatchAlert(hit.source);
    if (!parsed.ok) {
      // O que não é do CloudWatch Logs é de outro sync (a consulta já o deixa de fora) e nunca passa por este caminho.
      if (parsed.reason === 'not_cloudwatch') {
        report.skipped += 1;
        return;
      }
      await this.store.recordUnowned(unownedRecord(eventIdOf(parsed.id, hit), parsed.reason, [], null));
      report.unowned += 1;
      return;
    }
    const alert = parsed.alert;
    // A página já pede o nível mínimo; conferido de novo aqui.
    if (alert.rule.level < this.settings.minLevel) {
      report.belowLevel += 1;
      return;
    }
    if (!owner.owned) {
      await this.store.recordUnowned(unownedRecord(alert.id, owner.reason, owner.accounts, alert));
      report.unowned += 1;
      return;
    }

    const draft = toCloudWatchFindingDraft(alert, owner);
    const exception = matchingException(draft, exceptions.get(owner.tenantId) ?? [], now);
    lastEvents.see(owner.tenantId, owner.accountId, new Date(draft.occurredAt));
    const outcome = await this.store.persist(draft, exception, now);
    if (outcome === 'duplicate') {
      report.duplicates += 1;
      return;
    }
    report.created += 1;
    if (outcome === 'excepted') report.excepted += 1;
  }

  /**
   * As contas com grupo do CloudWatch Logs autorizado: a autorização valendo, na conta AWS ativa de um cliente ativo
   * (as mesmas condições da lista que o manager lê). Uma busca de sistema, de todos os clientes do nó: é assim que se
   * sabe se há mais de um.
   */
  private async authorizedSources(): Promise<CloudWatchSourceOwner[]> {
    const rows = await this.prisma.awsSource.findMany({
      where: {
        method: 'cloudwatch',
        authorizedAt: { not: null },
        revokedAt: null,
        cloudAccount: { provider: 'aws', status: 'active', ...COLLECTING_TENANT },
        ...(this.tenantIds !== undefined && { tenantId: { in: [...this.tenantIds] } }),
      },
      select: { tenantId: true, cloudAccount: { select: { accountId: true } } },
      distinct: ['tenantId', 'cloudAccountId'],
    });
    return rows.map((row) => ({ tenantId: row.tenantId, accountId: row.cloudAccount.accountId }));
  }
}
