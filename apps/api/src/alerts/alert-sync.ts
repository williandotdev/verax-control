import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { UnownedReason as DbUnownedReason } from '../generated/prisma/client.js';
import type { AlertSearch } from '../indexer/alert-queries.js';
import type { AlertHit } from '../indexer/indexer.client.js';
import { AccountDirectory, type RegisteredAwsAccount, resolveAlertOwner } from './alert-owner.js';
import { type ActiveException, matchingException } from './exception-match.js';
import { type FindingDraft, toFindingDraft } from './finding-draft.js';
import {
  cursorFromSort,
  DEFAULT_SYNC_SETTINGS,
  type SyncSettings,
  syncPage,
  syncWindowStart,
} from './sync-query.js';
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
  lastProcessedAt: string | null;
}

const MAX_EVENT_ID = 128;

/** O ID que identifica um alerta inválido na fila: o do próprio alerta ou, se nem isso houver, o do indexer. */
function eventIdOf(id: string | null, hit: AlertHit): string {
  return (id ?? `indexer:${hit.id}`).slice(0, MAX_EVENT_ID);
}

function findingRow(draft: FindingDraft, exception: ActiveException | null) {
  return {
    tenantId: draft.tenantId,
    accountId: draft.accountId,
    source: draft.source,
    sourceEventId: draft.sourceEventId,
    logSource: draft.awsSource,
    occurredAt: new Date(draft.occurredAt),
    severity: draft.severity,
    // A exceção marca o achado como esperado já na chegada: ele não entra na fila de triagem.
    status: exception ? ('legitimate' as const) : ('new' as const),
    ruleId: draft.ruleId,
    ruleLevel: draft.ruleLevel,
    title: draft.title.slice(0, 500),
    eventName: draft.eventName?.slice(0, 256) ?? null,
    region: draft.region,
    resource: draft.resource?.slice(0, 2048) ?? null,
    actorUser: draft.actorUser?.slice(0, 512) ?? null,
    actorType: draft.actorType?.slice(0, 64) ?? null,
    accessKeyId: draft.accessKeyId,
    sourceIp: draft.sourceIp,
    mitreTactics: draft.mitreTactics,
    mitreTechniques: draft.mitreTechniques,
    exceptionId: exception?.id ?? null,
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
  private readonly leaseMs: number;
  private readonly maxPages: number;
  private readonly owner: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: AlertSearchClient,
    options: AlertSyncOptions = {},
  ) {
    this.name = options.name ?? ALERT_SYNC;
    this.settings = options.settings ?? DEFAULT_SYNC_SETTINGS;
    this.leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.maxPages = options.maxPages ?? 100;
    this.owner = options.owner ?? `worker-${randomUUID()}`;
  }

  async runOnce(now: Date = new Date()): Promise<SyncReport> {
    const report: SyncReport = {
      status: 'done',
      read: 0,
      created: 0,
      duplicates: 0,
      unowned: 0,
      excepted: 0,
      lastProcessedAt: null,
    };
    if (!(await this.acquireLease(now))) return { ...report, status: 'locked' };
    try {
      const state = await this.prisma.syncState.findUniqueOrThrow({ where: { name: this.name } });
      const directory = AccountDirectory.from(await this.registeredAccounts());
      const exceptions = await this.activeExceptions(now);
      const lastEvents = new Map<string, { tenantId: string; accountId: string; at: Date }>();
      let lastProcessedAt = state.lastProcessedAt;
      const windowStart = syncWindowStart(lastProcessedAt?.toISOString() ?? null, now, this.settings);

      let cursor = null;
      for (let page = 0; page < this.maxPages; page += 1) {
        const hits = await this.indexer.search(syncPage(windowStart, cursor, this.settings));
        for (const hit of hits) {
          report.read += 1;
          await this.process(hit, directory, exceptions, now, report, lastEvents);
        }
        const last = hits.at(-1);
        if (last) {
          cursor = cursorFromSort(last.sort);
          const at = new Date(cursor.timestamp);
          if (lastProcessedAt === null || at > lastProcessedAt) lastProcessedAt = at;
        }
        if (hits.length < this.settings.pageSize) break;
        await this.renewLease();
      }

      for (const { tenantId, accountId, at } of lastEvents.values()) {
        await this.prisma.forTenant(tenantId).cloudAccount.updateMany({
          where: { provider: 'aws', accountId, OR: [{ lastEventAt: null }, { lastEventAt: { lt: at } }] },
          data: { lastEventAt: at },
        });
      }
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: { lastProcessedAt, lastRunAt: now, lastSuccessAt: new Date(), lastError: null },
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
      await this.releaseLease();
    }
  }

  private async process(
    hit: AlertHit,
    directory: AccountDirectory,
    exceptions: ReadonlyMap<string, ActiveException[]>,
    now: Date,
    report: SyncReport,
    lastEvents: Map<string, { tenantId: string; accountId: string; at: Date }>,
  ): Promise<void> {
    const parsed = parseWazuhAlert(hit.source);
    if (!parsed.ok) {
      await this.recordUnowned(eventIdOf(parsed.id, hit), parsed.reason, [], null);
      report.unowned += 1;
      return;
    }
    const alert = parsed.alert;
    const owner = resolveAlertOwner(alert, directory);
    if (!owner.owned) {
      await this.recordUnowned(alert.id, owner.reason, owner.accounts, alert);
      report.unowned += 1;
      return;
    }

    const draft = toFindingDraft(alert, owner);
    const exception = matchingException(draft, exceptions.get(owner.tenantId) ?? [], now);
    const db = this.prisma.forTenant(owner.tenantId);
    const { count } = await db.finding.createMany({
      data: [findingRow(draft, exception)],
      skipDuplicates: true,
    });
    if (count === 0) {
      report.duplicates += 1;
      return;
    }
    report.created += 1;
    if (exception) {
      report.excepted += 1;
      await db.alertException.update({
        where: { id: exception.id },
        data: { matchedCount: { increment: 1 }, lastMatchedAt: now },
      });
    }
    const key = `${owner.tenantId}:${owner.accountId}`;
    const at = new Date(draft.occurredAt);
    const known = lastEvents.get(key);
    if (!known || at > known.at)
      lastEvents.set(key, { tenantId: owner.tenantId, accountId: owner.accountId, at });
  }

  /** Na dúvida, o alerta não é de ninguém (T5.2): a fila guarda o motivo e o mínimo para a triagem. */
  private async recordUnowned(
    sourceEventId: string,
    reason: DbUnownedReason,
    accounts: string[],
    alert: WazuhAwsAlert | null,
  ): Promise<void> {
    await this.prisma.unownedAlert.createMany({
      data: [
        {
          source: 'wazuh',
          sourceEventId,
          reason,
          accounts,
          occurredAt: alert ? new Date(alert.timestamp) : null,
          ruleId: alert?.rule.id ?? null,
          ruleLevel: alert?.rule.level ?? null,
          title: alert?.rule.description.slice(0, 500) ?? null,
        },
      ],
      skipDuplicates: true,
    });
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

  /** Exceções em vigor, por cliente, na ordem de criação. */
  private async activeExceptions(now: Date): Promise<Map<string, ActiveException[]>> {
    const rows = await this.prisma.alertException.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { id: true, tenantId: true, ruleId: true, field: true, value: true, expiresAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const byTenant = new Map<string, ActiveException[]>();
    for (const { tenantId, ...exception } of rows) {
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), exception]);
    }
    return byTenant;
  }

  private async acquireLease(now: Date): Promise<boolean> {
    await this.prisma.syncState.createMany({ data: [{ name: this.name }], skipDuplicates: true });
    const { count } = await this.prisma.syncState.updateMany({
      where: {
        name: this.name,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseOwner: this.owner }],
      },
      data: { leaseOwner: this.owner, leaseUntil: new Date(now.getTime() + this.leaseMs) },
    });
    return count === 1;
  }

  private async renewLease(): Promise<void> {
    await this.prisma.syncState.updateMany({
      where: { name: this.name, leaseOwner: this.owner },
      data: { leaseUntil: new Date(Date.now() + this.leaseMs) },
    });
  }

  private async releaseLease(): Promise<void> {
    await this.prisma.syncState.updateMany({
      where: { name: this.name, leaseOwner: this.owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}
