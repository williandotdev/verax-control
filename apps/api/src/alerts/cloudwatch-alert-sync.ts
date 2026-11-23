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
import { CloudWatchOwnershipStore, type CloudWatchProof, cloudWatchProof } from './cloudwatch-ownership.js';
import { type ActiveException, matchingException } from './exception-match.js';
import { cloudWatchFindingKey, toCloudWatchFindingDraft } from './finding-draft.js';
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
  /** Alertas lidos do indexer e decididos nesta execução, inclusive os inválidos. */
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
  /** Alertas que já estavam na fila sem dono e ficam nela: uma releitura nunca os atribui. */
  keptUnowned: number;
  /**
   * Alertas novos demais para a prova do dono (`cloudwatch-ownership.ts`): ficam para uma execução seguinte, sem virar
   * achado nem ir para a fila.
   */
  deferred: number;
  lastProcessedAt: string | null;
}

/**
 * O que já foi decidido, numa execução anterior, sobre os alertas de uma página. A primeira decisão vale nos dois
 * sentidos: o alerta que já está na fila sem dono nunca vira achado, e o que já virou achado não ganha uma linha na
 * fila quando a sobreposição o relê sem a prova (o registro que caiu, o segundo cliente que chegou).
 */
interface Decided {
  /** IDs dos alertas que já estão na fila sem dono. */
  unowned: ReadonlySet<string>;
  /** IDs dos alertas que já são achado de uma das contas que podiam ser o dono. */
  findings: ReadonlySet<string>;
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
 * O horário do alerta: o campo `timestamp` do documento no indexer (o relógio do manager, quando o analysisd gerou o
 * alerta), pelo valor de ordenação que o indexer devolve. É o mesmo valor que pagina a leitura, e o único que decide se
 * o alerta cabe na prova do dono: um alerta fora do formato também tem o dele.
 */
const hitTime = (hit: AlertHit): number => new Date(cursorFromSort(hit.sort).timestamp).getTime();

export type CloudWatchAlertSyncOptions = AlertSyncOptions & {
  /** Só os testes, que dividem o banco: restringe o cadastro às contas destes clientes. */
  tenantIds?: readonly string[];
  /** Só os testes: a chave do registro da prova do dono (a do nó, por padrão). */
  ownershipKey?: string;
};

/**
 * Sync dos alertas do CloudWatch Logs lidos pelo Wazuh do nó (tarefa `wazuh-cloudwatch-alerts` do worker, ao lado do
 * sync da AWS e do dos agentes; onboarding self-service). Cada execução:
 * 1. pega a concessão própria (um worker por vez; ela vence sozinha se o worker morrer);
 * 2. decide de quem são os alertas do CloudWatch Logs deste nó. O evento não diz de que conta nem de que grupo veio,
 *    então são precisas duas coisas:
 *    - pelas autorizações de agora (`resolveCloudWatchOwner`), um único cliente tem grupo de logs autorizado, numa
 *      única conta;
 *    - a prova de que o manager só coletou grupos desse dono em todo o intervalo em que o alerta pode ter sido coletado
 *      (`cloudwatch-ownership.ts`, gravada pela tarefa `wazuh-config` com o sinal `applied` do host): o horário do
 *      alerta fica entre o começo provado mais a margem e a última conferência menos a espera.
 *    As autorizações de agora, sozinhas, não bastam: quando um de dois clientes tira a autorização, o manager segue
 *    coletando o grupo dele até a configuração nova ser aplicada;
 * 3. lê o indexer a partir do último alerta processado, menos a sobreposição, página a página pelo cursor: só os do
 *    manager com `location = Wazuh-AWS` que não são eventos de bucket, do nível mínimo para cima (`cloudWatchSyncPage`);
 * 4. com dono e dentro da prova, grava o achado do cliente, sem duplicar e já aplicando a exceção (`FindingStore`, o
 *    mesmo dos outros syncs). Sem dono, ou fora da prova, o alerta vai para a fila que só `admin_verax` vê, com o
 *    motivo, **e fica lá**: o alerta que já está na fila nunca vira achado numa releitura. O alerta novo demais para a
 *    prova (mais novo que a última conferência menos a espera) não é decidido ainda: a leitura para nele, e a execução
 *    seguinte o relê;
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
  private readonly ownership: CloudWatchOwnershipStore;
  private readonly tenantIds: readonly string[] | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: AlertSearchClient,
    options: CloudWatchAlertSyncOptions = {},
  ) {
    this.name = options.name ?? CLOUDWATCH_ALERT_SYNC;
    this.settings = options.settings ?? DEFAULT_CLOUDWATCH_SYNC_SETTINGS;
    this.maxPages = options.maxPages ?? 100;
    this.store = new FindingStore(prisma, options.notices);
    this.ownership = new CloudWatchOwnershipStore(prisma, options.ownershipKey);
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
      keptUnowned: 0,
      deferred: 0,
      lastProcessedAt: null,
    };
    if (!(await this.lease.acquire(now))) return { ...report, status: 'locked' };
    try {
      const state = await this.prisma.syncState.findUniqueOrThrow({ where: { name: this.name } });
      const sources = await this.authorizedSources();
      const owner = resolveCloudWatchOwner(sources);
      // Lida uma vez por execução. O registro que cair no meio dela não desfaz a prova do que já estava assentado: a
      // prova vale para o alerta mais antigo que a conferência lida, com a espera, e o que a derruba vem depois.
      const record = await this.ownership.read();
      const proof = owner.owned ? cloudWatchProof(record, owner, now) : null;
      // As contas em que um alerta destes pode já ser achado: as que têm grupo autorizado agora e a do registro.
      const accounts = [
        ...new Set([
          ...sources.map((source) => source.accountId),
          ...(record?.owner ? [record.owner.accountId] : []),
        ]),
      ];
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
        const decided = await this.alreadyDecided(hits, accounts);
        let last: AlertHit | undefined;
        let waiting = 0;
        for (const [index, hit] of hits.entries()) {
          // Novo demais para a prova, com a tarefa ainda conferindo: nem achado, nem fila. A leitura para aqui (os
          // resultados vêm em ordem de horário) e não anda além do último decidido.
          if (proof?.live === true && hitTime(hit) > proof.until.getTime()) {
            waiting = hits.length - index;
            break;
          }
          report.read += 1;
          await this.process(hit, owner, proof, decided, exceptions, now, report, lastEvents);
          last = hit;
        }
        if (last) {
          cursor = cursorFromSort(last.sort);
          const processedAt = new Date(cursor.timestamp);
          if (lastProcessedAt === null || processedAt > lastProcessedAt) lastProcessedAt = processedAt;
        }
        if (waiting > 0) {
          report.deferred = waiting;
          capped = false;
          break;
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
    proof: CloudWatchProof | null,
    decided: Decided,
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
    // Um só dono pelas autorizações de agora não basta: falta a prova de que o manager só coletou os grupos dele quando
    // este alerta pode ter sido coletado (sem registro, de outro dono, antes da margem, ou depois da última conferência
    // assentada com a tarefa parada). Na dúvida, não é de ninguém; sem as contas, como no caso de mais de um cliente.
    const occurredAt = hitTime(hit);
    const proven =
      proof !== null && occurredAt >= proof.from.getTime() && occurredAt <= proof.until.getTime();
    if (!owner.owned || !proven) {
      // O alerta que já virou achado, quando cabia na prova, fica como está: a releitura não o põe na fila.
      if (decided.findings.has(alert.id)) {
        report.duplicates += 1;
        return;
      }
      const unowned = owner.owned
        ? unownedRecord(alert.id, 'ambiguous_source', [], alert)
        : unownedRecord(alert.id, owner.reason, owner.accounts, alert);
      await this.store.recordUnowned(unowned);
      report.unowned += 1;
      return;
    }
    // A fila vence: o alerta que já foi para a fila sem dono (lido antes de a prova existir, ou com outro dono) nunca
    // vira achado numa releitura, mesmo que agora caiba na prova.
    if (decided.unowned.has(alert.id)) {
      report.keptUnowned += 1;
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
   * O que já foi decidido sobre os alertas da página: os que estão na fila sem dono (pelo ID do alerta, como o sync os
   * grava nela) e os que já são achado numa das contas dadas (pela chave do achado, que leva a conta). Duas buscas de
   * sistema, pelas chaves únicas das duas tabelas; nada do achado é lido além da chave.
   */
  private async alreadyDecided(hits: readonly AlertHit[], accounts: readonly string[]): Promise<Decided> {
    const alerts = hits.flatMap((hit) => {
      const parsed = parseCloudWatchAlert(hit.source);
      return parsed.ok ? [parsed.alert] : [];
    });
    if (alerts.length === 0) return { unowned: new Set(), findings: new Set() };
    const queued = await this.prisma.unownedAlert.findMany({
      where: { source: 'wazuh', sourceEventId: { in: alerts.map((alert) => alert.id) } },
      select: { sourceEventId: true },
    });
    const alertOfKey = new Map<string, string>();
    for (const alert of alerts) {
      for (const accountId of accounts) alertOfKey.set(cloudWatchFindingKey(alert, accountId), alert.id);
    }
    const found =
      alertOfKey.size === 0
        ? []
        : await this.prisma.finding.findMany({
            where: { source: 'wazuh', sourceEventId: { in: [...alertOfKey.keys()] } },
            select: { sourceEventId: true },
          });
    return {
      unowned: new Set(queued.map((row) => row.sourceEventId)),
      findings: new Set(found.flatMap((row) => alertOfKey.get(row.sourceEventId) ?? [])),
    };
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
