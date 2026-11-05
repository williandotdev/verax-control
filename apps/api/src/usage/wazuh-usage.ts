import type { CloudAccountConnection } from '@verax/shared';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { enqueueNotices } from '../notifications/finding-notices.js';
import { awsStallNotice } from '../notifications/ingestion-notices.js';
import { awsLogsStalledSince, DEFAULT_TOWER_THRESHOLDS, type TowerThresholds } from '../tower/tower-rules.js';
import { UsageMeter } from './usage-meter.js';
import {
  type AnalysisdCounters,
  type AnalysisdStatsSource,
  WazuhApiError,
  type WazuhApiErrorKind,
} from './wazuh-stats.js';

/** A cada 5 min. */
export const WAZUH_USAGE_INTERVAL_MS = 5 * 60 * 1000;
export const WAZUH_USAGE_TASK = 'wazuh-usage';
/** A linha da base da diferença (`WazuhCounter`): os contadores do analysisd do nó. */
export const WAZUH_COUNTER_ID = 'wazuh-analysisd';
/** O único motivo de não medir uma leitura (CHECK da migration). */
export const METER_BLOCKED_MULTIPLE_TENANTS = 'multiple_tenants';

/** A base guardada da leitura anterior. */
export interface CounterBase {
  startedAt: Date;
  bytesReceived: bigint;
  awsEvents: bigint;
}

/** O que a leitura de agora soma ao medidor. */
export interface CounterDelta {
  bytes: number;
  events: number;
  /** Primeira leitura (sem base): vira só a base, sem medir. */
  first: boolean;
  /**
   * A base foi gravada (ou marcada) com o volume ambíguo (`meterBlocked`): parte do intervalo desde ela pode ser de
   * outro cliente, e a leitura vira só a base, como a primeira.
   */
  ambiguous: boolean;
  /** O analysisd reiniciou (outra partida, ou um contador caiu): a leitura vale inteira. */
  restarted: boolean;
}

/**
 * A diferença entre a leitura de agora e a base. Na mesma partida do analysisd, soma o que os contadores andaram; numa
 * partida nova (o `uptime` mudou) ou com um contador menor que a base (o analysisd reiniciou entre as duas leituras), os
 * contadores recomeçaram do zero, e o valor inteiro é o que chegou desde então. Sem base (a primeira leitura do nó, ou
 * de um nó que acabou de ganhar esta tarefa), nada é medido: o que o analysisd contou antes pode ser de outro mês, e a
 * dúvida fica a favor do cliente. Com a base ambígua (gravada, ou marcada numa leitura que falhou, enquanto havia mais
 * de um cliente), também não: o intervalo desde ela não dá para separar, e a leitura de agora é a base nova. O que chega
 * entre a última leitura e um reinício também se perde (o contador some com o processo).
 */
export function counterDelta(
  base: (CounterBase & { meterBlocked?: string | null }) | null,
  current: AnalysisdCounters,
): CounterDelta {
  if (base === null) return { bytes: 0, events: 0, first: true, ambiguous: false, restarted: false };
  const newStart = base.startedAt.getTime() !== current.startedAt.getTime();
  const previousBytes = Number(base.bytesReceived);
  const previousEvents = Number(base.awsEvents);
  const restarted = newStart || current.bytesReceived < previousBytes || current.awsEvents < previousEvents;
  return {
    bytes: restarted ? current.bytesReceived : current.bytesReceived - previousBytes,
    events: restarted ? current.awsEvents : current.awsEvents - previousEvents,
    first: false,
    ambiguous: (base.meterBlocked ?? null) !== null,
    restarted,
  };
}

/** A diferença vale para o medidor: há base, e ela não é ambígua. */
export function chargeable(delta: CounterDelta): boolean {
  return !delta.first && !delta.ambiguous;
}

/** De quem é o volume do analysisd: de ninguém, de um cliente só, ou ambíguo. */
export type MeterOwner =
  | { kind: 'none' }
  | { kind: 'single'; tenantId: string; awsConnected: boolean }
  | { kind: 'multiple'; tenantIds: string[] };

/**
 * O cliente do volume. A premissa é um cliente por nó: o analysisd não separa o que leu por cliente. Entram os clientes
 * com conta AWS ativa e, com os agentes do Wazuh ligados, o cliente deles (o volume dos agentes passa pelo mesmo
 * analysisd). Sem conta AWS ativa, não há o que medir como `aws`. Com mais de um cliente, a leitura não é medida para
 * ninguém (nem a saúde é avaliada): a tarefa diz isso no log e a Torre da equipe da Verax o mostra.
 */
export function meterOwner(
  accounts: readonly { tenantId: string; connection: CloudAccountConnection }[],
  agentsTenantId: string | null,
): MeterOwner {
  const awsTenants = new Set(accounts.map((account) => account.tenantId));
  if (awsTenants.size === 0) return { kind: 'none' };
  const tenants = new Set(awsTenants);
  if (agentsTenantId !== null) tenants.add(agentsTenantId);
  if (tenants.size > 1) return { kind: 'multiple', tenantIds: [...tenants].sort() };
  const [tenantId] = awsTenants;
  if (tenantId === undefined) return { kind: 'none' };
  return {
    kind: 'single',
    tenantId,
    awsConnected: accounts.some((account) => account.connection === 'connected'),
  };
}

/** A saúde da ingestão do cliente nesta execução. */
export type IngestHealthState = 'not_watching' | 'flowing' | 'waiting' | 'stalled' | 'not_evaluated';

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface WazuhUsageReport {
  /** A leitura dos contadores: ok, ou o tipo do problema. */
  read: 'ok' | WazuhApiErrorKind;
  /**
   * `recorded` (somado ao cliente), `baseline` (só a base: a primeira leitura, ou a primeira depois de um intervalo
   * ambíguo), `no_tenant` (nenhum cliente com conta AWS), `multiple_tenants` (ambíguo, não medido) ou `not_read`.
   */
  meter: 'recorded' | 'baseline' | 'no_tenant' | 'multiple_tenants' | 'not_read';
  restarted: boolean;
  bytes: number;
  events: number;
  health: IngestHealthState;
  /** Avisos de parada postos na fila de saída agora. */
  stallNotices: number;
}

export class WazuhCounterConflict extends Error {
  constructor() {
    super('a base dos contadores do Wazuh mudou durante a execução');
    this.name = 'WazuhCounterConflict';
  }
}

/** O que a tarefa usa do logger (o pino do worker; um dublê nos testes). */
export interface WazuhUsageLogger {
  warn(fields: object, message: string): void;
}

export interface WazuhUsageOptions {
  now?: () => Date;
  logger?: WazuhUsageLogger;
  /** O cliente dos agentes do Wazuh do nó (WAZUH_AGENTS_TENANT), quando ligados. */
  agentsTenantId?: string | null;
  thresholds?: TowerThresholds;
  /** Só os testes, que dividem o banco: restringe a tarefa às contas destes clientes. */
  tenantIds?: readonly string[];
  /** Só os testes: outra linha da base, para não pisar na de outro arquivo de teste. */
  counterId?: string;
}

/**
 * Tarefa `wazuh-usage` do worker (fase 2, PR-V6; só no nó com o Wazuh, com a API do manager no `worker.env`): o medidor
 * da AWS e a saúde da ingestão, pelos contadores do analysisd.
 *
 * 1. Lê os contadores na API do manager (`WazuhStatsClient`: usuário `verax_stats`, só `manager:read`, TLS com a CA).
 * 2. Soma ao medidor (`UsageMeter.add(cliente, 'aws', bytes, eventos)`) a diferença desde a leitura anterior
 *    (`counterDelta`): os bytes que o analysisd recebeu e os eventos do módulo da AWS. A base nova e o uso entram na
 *    mesma transação, com a base conferida (outra execução no meio desfaz esta): nada conta duas vezes nem se perde.
 * 3. Saúde (`IngestHealth`, só do cliente do nó com conta AWS conectada): a última vez que os eventos da AWS andaram,
 *    ou o começo da observação. Parada há mais de 2 h (`awsLogsStalledSince`, a regra da Torre), um aviso
 *    `aws_ingestion_stalled` vai para a fila de saída, uma vez por parada (chave pelo começo dela); os eventos de volta
 *    rearmam o aviso. Sem a leitura (o manager fora do ar), a saúde é avaliada com o que já se sabe: o prazo corre.
 *
 * Um cliente por nó: com mais de um (`meterOwner`), a leitura vira só a base, `meterBlocked` fica gravado (a Torre da
 * equipe da Verax mostra) e o log avisa a cada execução. A ambiguidade fica gravada na base mesmo quando a leitura
 * falha, e a leitura seguinte a uma base ambígua também vira só a base: o volume de um intervalo em que havia mais de um
 * cliente nunca é cobrado de quem sobrar. A saúde de todo cliente que não é o dono de agora (ambíguo, sem conta AWS
 * ativa, ou que saiu do nó) é limpa: nada a afirmar, e uma conta que volte começa uma observação nova.
 */
export class WazuhUsage {
  private readonly now: () => Date;
  private readonly logger: WazuhUsageLogger | undefined;
  private readonly agentsTenantId: string | null;
  private readonly thresholds: TowerThresholds;
  private readonly tenantIds: readonly string[] | undefined;
  private readonly counterId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: AnalysisdStatsSource,
    {
      now = () => new Date(),
      logger,
      agentsTenantId = null,
      thresholds = DEFAULT_TOWER_THRESHOLDS,
      tenantIds,
      counterId = WAZUH_COUNTER_ID,
    }: WazuhUsageOptions = {},
  ) {
    this.now = now;
    this.logger = logger;
    this.agentsTenantId = agentsTenantId;
    this.thresholds = thresholds;
    this.tenantIds = tenantIds;
    this.counterId = counterId;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<WazuhUsageReport> {
    // Busca de sistema, entre todos os clientes do nó: quem tem conta AWS ativa, e se está conectada.
    const accounts = await this.prisma.cloudAccount.findMany({
      where: {
        provider: 'aws',
        status: 'active',
        ...(this.tenantIds !== undefined && { tenantId: { in: [...this.tenantIds] } }),
      },
      select: { tenantId: true, connection: true },
    });
    const owner = meterOwner(accounts, this.agentsTenantId);
    // A base é lida antes da API: se outra execução gravar uma base nova enquanto esta lê os contadores, a gravação
    // desta é recusada (a base conferida no fim não é mais a lida aqui), e nada conta duas vezes.
    const base = await this.prisma.wazuhCounter.findUnique({ where: { id: this.counterId } });
    let counters: AnalysisdCounters | null = null;
    let read: WazuhUsageReport['read'] = 'ok';
    try {
      counters = await this.source.read(signal);
    } catch (error) {
      if (signal.aborted || !(error instanceof WazuhApiError)) throw error;
      read = error.kind;
      this.logger?.warn({ kind: error.kind }, 'medidor do Wazuh: os contadores do analysisd não foram lidos');
    }
    signal.throwIfAborted();
    if (owner.kind === 'multiple') {
      this.logger?.warn(
        { tenants: owner.tenantIds.length },
        'medidor do Wazuh parado: mais de um cliente no Wazuh do nó (o nó atende um cliente só); o volume não é medido para ninguém',
      );
    }
    const now = this.now();
    return this.prisma.$transaction(async (tx) => {
      const report: WazuhUsageReport = {
        read,
        meter: 'not_read',
        restarted: false,
        bytes: 0,
        events: 0,
        health: 'not_evaluated',
        stallNotices: 0,
      };
      let delta: CounterDelta | null = null;
      if (counters !== null) {
        delta = await this.saveBase(tx, base, counters, owner, now);
        report.restarted = delta.restarted;
        report.meter = meterOutcome(owner, delta);
        if (owner.kind === 'single' && chargeable(delta)) {
          const meter = new UsageMeter();
          meter.add(owner.tenantId, 'aws', delta.bytes, delta.events, now);
          await meter.flushIn(tx);
          report.bytes = delta.bytes;
          report.events = delta.events;
        }
      } else if (owner.kind === 'multiple' && base !== null) {
        // Sem a leitura, a ambiguidade não pode se perder: a base fica marcada, e a próxima leitura bem-sucedida vira
        // só a base nova, mesmo que já sobre um cliente (o volume desde a base pode ser de qualquer um deles).
        await tx.wazuhCounter.updateMany({
          where: { id: this.counterId },
          data: { meterBlocked: METER_BLOCKED_MULTIPLE_TENANTS },
        });
      }
      await this.clearHealthOfOthers(tx, owner);
      if (owner.kind === 'single') {
        const health = await this.updateHealth(tx, owner, delta, now);
        report.health = health.state;
        report.stallNotices = health.notices;
      }
      return report;
    });
  }

  /**
   * Limpa a saúde de todo cliente que não é o dono de agora: com mais de um cliente, todos; sem dono (o último cliente
   * desativou a última conta AWS), quem tinha a observação; com um dono, quem saiu do nó. Uma conta que volte (o mesmo
   * cliente ou outro) começa uma observação nova, sem uma parada antiga que avise na hora.
   */
  private async clearHealthOfOthers(tx: Prisma.TransactionClient, owner: MeterOwner): Promise<void> {
    // Busca de sistema, entre todos os clientes do nó; cada gravação vai pelo escopo do próprio cliente.
    const stale = await tx.ingestHealth.findMany({
      where: {
        source: 'aws',
        OR: [{ lastProgressAt: { not: null } }, { stallNotifiedFor: { not: null } }],
        AND: [
          ...(owner.kind === 'single' ? [{ tenantId: { not: owner.tenantId } }] : []),
          ...(this.tenantIds !== undefined ? [{ tenantId: { in: [...this.tenantIds] } }] : []),
        ],
      },
      select: { tenantId: true },
    });
    for (const { tenantId } of stale) {
      await scopeToTenant(tx, tenantId).ingestHealth.updateMany({
        where: { source: 'aws' },
        data: { lastProgressAt: null, stallNotifiedFor: null },
      });
    }
  }

  /**
   * Grava a leitura como a base da próxima, conferindo que a base lida no começo ainda é a do banco (sem base, a criação
   * de outra execução no meio derruba esta pela chave primária).
   */
  private async saveBase(
    tx: Prisma.TransactionClient,
    base: (CounterBase & { readAt: Date; meterBlocked: string | null }) | null,
    counters: AnalysisdCounters,
    owner: MeterOwner,
    now: Date,
  ): Promise<CounterDelta> {
    const delta = counterDelta(base, counters);
    const data = {
      startedAt: counters.startedAt,
      bytesReceived: BigInt(counters.bytesReceived),
      awsEvents: BigInt(counters.awsEvents),
      readAt: now,
      meterBlocked: owner.kind === 'multiple' ? METER_BLOCKED_MULTIPLE_TENANTS : null,
    };
    if (base === null) {
      await tx.wazuhCounter.create({ data: { id: this.counterId, ...data } });
    } else {
      const { count } = await tx.wazuhCounter.updateMany({
        where: { id: this.counterId, readAt: base.readAt },
        data,
      });
      if (count === 0) throw new WazuhCounterConflict();
    }
    return delta;
  }

  /**
   * A saúde da ingestão da AWS do cliente do nó, no escopo dele: o começo da observação, o andamento dos eventos e o
   * aviso de uma parada nova (uma vez por parada). Só grava quando algo muda.
   */
  private async updateHealth(
    tx: Prisma.TransactionClient,
    owner: Extract<MeterOwner, { kind: 'single' }>,
    delta: CounterDelta | null,
    now: Date,
  ): Promise<{ state: IngestHealthState; notices: number }> {
    const db = scopeToTenant(tx, owner.tenantId);
    const row = await db.ingestHealth.findFirst({ where: { source: 'aws' } });
    // A diferença ambígua não diz de quem são os eventos: não conta como andamento (a observação já foi limpa).
    const progressed = delta !== null && chargeable(delta) && delta.events > 0;
    let lastProgressAt: Date | null = null;
    if (owner.awsConnected) lastProgressAt = progressed || !row?.lastProgressAt ? now : row.lastProgressAt;
    const since = awsLogsStalledSince(
      { awsConnected: owner.awsConnected, lastProgressAt },
      now,
      this.thresholds,
    );
    let stallNotifiedFor = lastProgressAt === null ? null : (row?.stallNotifiedFor ?? null);
    let notices = 0;
    if (since !== null && stallNotifiedFor?.getTime() !== since.getTime()) {
      notices = await enqueueNotices(db, [awsStallNotice(owner.tenantId, since)]);
      stallNotifiedFor = since;
    }
    const changed =
      row === null ||
      row.lastProgressAt?.getTime() !== lastProgressAt?.getTime() ||
      row.stallNotifiedFor?.getTime() !== stallNotifiedFor?.getTime();
    if (changed && (row !== null || lastProgressAt !== null)) {
      await db.ingestHealth.upsert({
        where: { tenantId_source: { tenantId: owner.tenantId, source: 'aws' } },
        create: { tenantId: owner.tenantId, source: 'aws', lastProgressAt, stallNotifiedFor },
        update: { lastProgressAt, stallNotifiedFor },
      });
    }
    const state: IngestHealthState = !owner.awsConnected
      ? 'not_watching'
      : since !== null
        ? 'stalled'
        : progressed
          ? 'flowing'
          : 'waiting';
    return { state, notices };
  }
}

function meterOutcome(owner: MeterOwner, delta: CounterDelta): WazuhUsageReport['meter'] {
  if (owner.kind === 'none') return 'no_tenant';
  if (owner.kind === 'multiple') return 'multiple_tenants';
  return chargeable(delta) ? 'recorded' : 'baseline';
}
