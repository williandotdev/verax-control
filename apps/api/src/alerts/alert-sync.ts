import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { AlertCursor, AlertSearch } from '../indexer/alert-queries.js';
import type { AlertHit } from '../indexer/indexer.client.js';
import { isAgentAlert } from './agent-alert.js';
import { AccountDirectory, type RegisteredAwsAccount, resolveAlertOwner } from './alert-owner.js';
import { awsAlertTitle } from './aws-rule-titles.js';
import { type ActiveException, matchingException } from './exception-match.js';
import { toFindingDraft } from './finding-draft.js';
import { FindingStore, LastEvents, SyncLease, type UnownedRecord } from './finding-store.js';
import {
  cursorFromSort,
  DEFAULT_SYNC_SETTINGS,
  type SyncSettings,
  syncPage,
  syncWindowStart,
} from './sync-query.js';
import { IncidentGrouping } from '../incidents/incident-grouping.js';
import { parseWazuhAlert, type WazuhAwsAlert } from './wazuh-alert.js';

/** Quem busca os alertas: o `IndexerClient` em produção, um dublê nos testes. */
export interface AlertSearchClient {
  search(request: AlertSearch): Promise<AlertHit[]>;
}

export const ALERT_SYNC = 'alerts';

export interface AlertSyncOptions {
  /** Nome do estado gravado em `SyncState` (os testes usam um por caso). */
  name?: string;
  settings?: SyncSettings;
  /** Validade da concessão; renovada a cada página. */
  leaseMs?: number;
  /** Páginas por execução: um atraso grande é lido em várias execuções, sem segurar a concessão. */
  maxPages?: number;
  /** Identifica este worker na concessão. */
  owner?: string;
  /** Janela de agrupamento de incidentes (T5.6), em minutos. */
  groupingWindowMinutes?: number;
  /** Agrupamento usado (os testes trocam por um que falha, para provar que nada fica pela metade). */
  grouping?: IncidentGrouping;
}

export interface SyncReport {
  status: 'done' | 'locked';
  /** Alertas lidos do indexer, inclusive os inválidos. */
  read: number;
  created: number;
  /** Já gravados por uma execução anterior (a janela de sobreposição relê). */
  duplicates: number;
  unowned: number;
  /** Achados que já nasceram esperados por uma exceção. */
  excepted: number;
  /** Incidentes abertos e achados que entraram num incidente existente (T5.6). */
  incidentsOpened: number;
  incidentsJoined: number;
  /** Alertas de agente nas instâncias do cliente (`agent.id` diferente de 000): são do sync dos agentes. */
  skipped: number;
  lastProcessedAt: string | null;
}

const MAX_EVENT_ID = 128;

/** O ID que identifica um alerta inválido na fila: o do próprio alerta ou, se nem isso houver, o do indexer. */
export function eventIdOf(id: string | null, hit: AlertHit): string {
  return (id ?? `indexer:${hit.id}`).slice(0, MAX_EVENT_ID);
}

/** O alerta sem dono como a fila guarda: o motivo e o mínimo para a triagem, nunca o evento bruto. */
function unownedRecord(
  sourceEventId: string,
  reason: UnownedRecord['reason'],
  accounts: string[],
  alert: WazuhAwsAlert | null,
): UnownedRecord {
  return {
    source: 'wazuh',
    sourceEventId,
    reason,
    accounts,
    occurredAt: alert ? new Date(alert.timestamp) : null,
    ruleId: alert?.rule.id ?? null,
    ruleLevel: alert?.rule.level ?? null,
    title: alert ? awsAlertTitle(alert.rule) : null,
  };
}

/**
 * Sync de alertas para achados (T5.3). Cada execução:
 * 1. pega a concessão (só um worker por vez; ela vence sozinha se o worker morrer);
 * 2. monta o cadastro de contas e buckets e as exceções em vigor;
 * 3. lê o indexer a partir do último alerta processado, menos a sobreposição, página a página pelo cursor;
 * 4. decide o dono de cada alerta (T5.2). Com dono, grava o achado, sem duplicar e já aplicando a exceção. Sem dono,
 *    o alerta vai para a fila que só `admin_verax` vê;
 * 5. grava o último evento de cada conta e até onde leu.
 *
 * Nada do evento bruto é gravado: o achado guarda os campos já validados, e o detalhe busca o evento no indexer.
 */
export class AlertSync {
  private readonly name: string;
  private readonly settings: SyncSettings;
  private readonly maxPages: number;
  private readonly store: FindingStore;
  private readonly lease: SyncLease;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: AlertSearchClient,
    options: AlertSyncOptions = {},
  ) {
    this.name = options.name ?? ALERT_SYNC;
    this.settings = options.settings ?? DEFAULT_SYNC_SETTINGS;
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

  async runOnce(now: Date = new Date()): Promise<SyncReport> {
    const report: SyncReport = {
      status: 'done',
      read: 0,
      created: 0,
      duplicates: 0,
      unowned: 0,
      excepted: 0,
      incidentsOpened: 0,
      incidentsJoined: 0,
      skipped: 0,
      lastProcessedAt: null,
    };
    if (!(await this.lease.acquire(now))) return { ...report, status: 'locked' };
    try {
      const state = await this.prisma.syncState.findUniqueOrThrow({ where: { name: this.name } });
      const directory = AccountDirectory.from(await this.registeredAccounts());
      const exceptions = await this.store.activeExceptions(now);
      const protectedItems = await this.store.protectedItems();
      const lastEvents = new LastEvents();
      let lastProcessedAt = state.lastProcessedAt;
      // Uma execução anterior que bateu o limite de páginas deixou a continuação: segue dela. Sem isso, reler a
      // sobreposição poderia ocupar todo o limite a cada execução, e a leitura não avançaria.
      let cursor: AlertCursor | null =
        state.cursorTimestamp && state.cursorId
          ? { timestamp: state.cursorTimestamp.toISOString(), id: state.cursorId }
          : null;
      const windowStart =
        cursor?.timestamp ?? syncWindowStart(lastProcessedAt?.toISOString() ?? null, now, this.settings);

      let capped = true;
      for (let page = 0; page < this.maxPages; page += 1) {
        const hits = await this.indexer.search(syncPage(windowStart, cursor, this.settings));
        for (const hit of hits) {
          report.read += 1;
          await this.process(hit, directory, exceptions, protectedItems, now, report, lastEvents);
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
    directory: AccountDirectory,
    exceptions: ReadonlyMap<string, ActiveException[]>,
    protectedItems: ReadonlyMap<string, ReadonlySet<string>>,
    now: Date,
    report: SyncReport,
    lastEvents: LastEvents,
  ): Promise<void> {
    // A página só traz alertas do manager (`syncPage`); o de um agente que chegasse até aqui é do sync dos agentes, e
    // nunca é atribuído por este caminho.
    if (isAgentAlert(hit.source)) {
      report.skipped += 1;
      return;
    }
    const parsed = parseWazuhAlert(hit.source);
    if (!parsed.ok) {
      await this.store.recordUnowned(unownedRecord(eventIdOf(parsed.id, hit), parsed.reason, [], null));
      report.unowned += 1;
      return;
    }
    const alert = parsed.alert;
    const owner = resolveAlertOwner(alert, directory);
    if (!owner.owned) {
      await this.store.recordUnowned(unownedRecord(alert.id, owner.reason, owner.accounts, alert));
      report.unowned += 1;
      return;
    }

    const draft = toFindingDraft(alert, owner);
    const exception = matchingException(draft, exceptions.get(owner.tenantId) ?? [], now);

    // O último evento da conta conta também os duplicados: depois de uma execução que falhou no meio, os achados já
    // gravados voltam como duplicados, e é aqui que o `lastEventAt` deles é gravado.
    lastEvents.see(owner.tenantId, owner.accountId, new Date(draft.occurredAt));

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

  /** Contas AWS ativas com os buckets de log: o cadastro que decide o dono de cada alerta. */
  private async registeredAccounts(): Promise<RegisteredAwsAccount[]> {
    const rows = await this.prisma.cloudAccount.findMany({
      where: { provider: 'aws', status: 'active' },
      select: {
        tenantId: true,
        accountId: true,
        cloudtrailBucket: true,
        guarddutyBucket: true,
        wafBucket: true,
      },
    });
    return rows.map((row) => ({
      tenantId: row.tenantId,
      accountId: row.accountId,
      buckets: {
        ...(row.cloudtrailBucket && { cloudtrail: row.cloudtrailBucket }),
        ...(row.guarddutyBucket && { guardduty: row.guarddutyBucket }),
        ...(row.wafBucket && { waf: row.wafBucket }),
      },
    }));
  }
}
