import { Injectable } from '@nestjs/common';
import {
  FINDING_SEVERITIES,
  type FindingSeverity,
  hasPermission,
  PULSE_EVENT_SOURCES,
  type PulseEventSource,
  REPORT_PERIOD_DAYS,
  reportWindow,
  type TowerPulse,
  type TowerSummary,
} from '@verax/shared';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { combinedScore, PostureService } from '../posture/posture.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { usageMonth } from '../usage/usage-meter.js';
import { WAZUH_COUNTER_ID } from '../usage/wazuh-usage.js';
import {
  type AccountActivity,
  awsLogsStalledSince,
  collectionHealth,
  coverage,
  DEFAULT_TOWER_THRESHOLDS,
  hourlyCounts,
  lastDataAt,
  medianTimeToDetect,
  pendingDecisions,
  pulseSince,
  stalledSources,
  trafficLight,
} from './tower-rules.js';

/** O resumo MITRE ATT&CK da Torre olha os últimos 30 dias, com as mesmas contas do relatório MITRE desse período. */
const MITRE_PERIOD = '30d';

/** A fila sem dono que conta na Torre: os alertas dos últimos 7 dias. */
const UNOWNED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Teto de achados lidos para o minigráfico por hora e o tempo até detectar do "Pulso da operação" (os mais recentes,
 * pelo índice `(tenantId, occurredAt desc)`). O total e os esperados são contados à parte e ficam sempre exatos.
 */
const PULSE_FINDINGS_CAP = 5_000;

/** Um inteiro seguro do JSON (o medidor guarda `BigInt`). */
const safeCount = (value: bigint): number =>
  Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);

/**
 * Resumo da Torre (T5.10) do cliente da sessão: semáforo com os motivos, decisões pendentes, incidentes abertos por
 * severidade, postura, a saúde da coleta por fonte (OP-01 e OP-02) e o pulso da operação. As regras ficam em
 * `tower-rules.ts`; aqui só se contam os dados, sempre pelo escopo do cliente da sessão.
 */
@Injectable()
export class TowerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posture: PostureService,
    private readonly reports: ReportsService,
  ) {}

  async summary(auth: RequestAuth, now = new Date()): Promise<TowerSummary> {
    const db = this.prisma.scoped();
    const thresholds = DEFAULT_TOWER_THRESHOLDS;

    const bySeverity = await db.incident.groupBy({
      by: ['severity'],
      where: { status: { not: 'resolved' } },
      _count: { _all: true },
    });
    const openIncidents = Object.fromEntries(FINDING_SEVERITIES.map((severity) => [severity, 0])) as Record<
      FindingSeverity,
      number
    >;
    for (const group of bySeverity) openIncidents[group.severity] = group._count._all;

    const { latest } = await this.posture.latestScans();
    const scans = [...latest.values()];
    const postureScore = combinedScore(scans);
    const scannedAt =
      scans
        .map((scan) => scan.scannedAt.toISOString())
        .sort()
        .at(-1) ?? null;

    const rows = await db.cloudAccount.findMany({
      where: { status: 'active' },
      select: { accountId: true, provider: true, connection: true, lastCollectedAt: true, lastEventAt: true },
    });
    const accounts: AccountActivity[] = rows.map((account) => ({
      accountId: account.accountId,
      provider: account.provider,
      connection: account.connection,
      lastCollectedAt: account.lastCollectedAt?.toISOString() ?? null,
      lastEventAt: account.lastEventAt?.toISOString() ?? null,
    }));

    // Saúde da ingestão da AWS (PR-V6): com conta AWS conectada, a última vez que os eventos da AWS andaram no Wazuh do
    // nó, gravada pela tarefa `wazuh-usage` no escopo do cliente. Sem a linha (nó sem o Wazuh, ou a tarefa ainda não
    // leu), nada a afirmar. É também o sinal de vida das contas AWS conectadas e o último dado da fonte (OP-01).
    const awsConnected = accounts.some(
      (account) => account.provider === 'aws' && account.connection === 'connected',
    );
    const health = awsConnected
      ? await db.ingestHealth.findFirst({ where: { source: 'aws' }, select: { lastProgressAt: true } })
      : null;
    const awsLastProgressAt = health?.lastProgressAt?.toISOString() ?? null;
    const stalledSince = awsLogsStalledSince(
      { awsConnected, lastProgressAt: health?.lastProgressAt ?? null },
      now,
      thresholds,
    );
    const cover = coverage(accounts, now, thresholds, awsLastProgressAt);

    const awsAccountIds = accounts
      .filter((account) => account.provider === 'aws')
      .map((account) => account.accountId);
    const [agents, inventory, pulse] = await Promise.all([
      this.agentCounts(),
      awsAccountIds.length === 0
        ? Promise.resolve(null)
        : db.inventorySnapshot.aggregate({
            where: { accountId: { in: awsAccountIds } },
            _max: { collectedAt: true },
          }),
      this.findingsPulse(now),
    ]);
    const sources = collectionHealth(
      {
        accounts,
        awsLastProgressAt,
        agents: { registered: agents.total, lastKeepAliveAt: agents.lastKeepAliveAt },
        lastPostureScanAt: scannedAt,
        lastInventoryAt: inventory?._max.collectedAt?.toISOString() ?? null,
      },
      now,
      thresholds,
    );

    const includeUnowned = hasPermission(auth.role, 'unowned_alerts:read');
    const [unassignedIncidents, untriagedFindings, unownedAlerts] = await Promise.all([
      db.incident.count({ where: { status: { not: 'resolved' }, assigneeId: null } }),
      db.finding.count({
        where: { status: 'new', severity: { in: ['critical', 'high'] }, incidentId: null },
      }),
      // A fila sem dono não é de cliente nenhum: só a equipe da Verax vê, e só ela recebe a contagem.
      includeUnowned
        ? this.prisma.db().unownedAlert.count({
            where: { createdAt: { gte: new Date(now.getTime() - UNOWNED_WINDOW_MS) } },
          })
        : Promise.resolve(0),
    ]);

    // Achados e incidentes que começaram nos últimos 30 dias, pelas mesmas contas do relatório MITRE.
    const { tactics } = await this.reports.mitre(reportWindow(MITRE_PERIOD, now));
    const mitre = { periodDays: REPORT_PERIOD_DAYS[MITRE_PERIOD], tactics };

    // O medidor da AWS parado por mais de um cliente no Wazuh do nó é do nó, não de um cliente: só a equipe da Verax vê
    // (como a fila sem dono), e o aviso não cita cliente nenhum.
    const meterVisible = hasPermission(auth.role, 'tenants:read');
    const counter = meterVisible
      ? await this.prisma
          .db()
          .wazuhCounter.findUnique({ where: { id: WAZUH_COUNTER_ID }, select: { meterBlocked: true } })
      : null;

    const { light, reasons } = trafficLight(
      { openIncidents, postureScore, stalledSources: stalledSources(sources) },
      thresholds,
    );
    return {
      light,
      reasons,
      pendingDecisions: pendingDecisions(
        { unassignedIncidents, untriagedFindings, unownedAlerts },
        { includeUnowned },
      ),
      openIncidents,
      posture: { score: postureScore, scannedAt, warningBelow: thresholds.postureWarning },
      coverage: {
        ...cover,
        silentAfterHours: thresholds.silentAfterHours,
        awsLogsStalledSince: stalledSince?.toISOString() ?? null,
        awsStalledAfterHours: thresholds.awsStalledAfterHours,
        ...(meterVisible && { awsMeterBlocked: counter?.meterBlocked != null }),
        lastDataAt: lastDataAt(sources),
        sources,
      },
      pulse: {
        ...pulse,
        agents: agents.total === 0 ? null : { online: agents.online, total: agents.total },
        monthEvents: await this.monthEvents(now),
      },
      mitre,
      generatedAt: now.toISOString(),
    };
  }

  /** Agentes do Wazuh registrados do cliente da sessão: quantos, quantos ativos e o keepalive mais recente. */
  private async agentCounts(): Promise<{ total: number; online: number; lastKeepAliveAt: string | null }> {
    const groups = await this.prisma.scoped().wazuhAgent.groupBy({
      by: ['status'],
      _count: { _all: true },
      _max: { lastKeepAliveAt: true },
    });
    let total = 0;
    let online = 0;
    let lastKeepAliveAt: Date | null = null;
    for (const group of groups) {
      total += group._count._all;
      if (group.status === 'active') online += group._count._all;
      const at = group._max.lastKeepAliveAt;
      if (at && (lastKeepAliveAt === null || at > lastKeepAliveAt)) lastKeepAliveAt = at;
    }
    return { total, online, lastKeepAliveAt: lastKeepAliveAt?.toISOString() ?? null };
  }

  /**
   * Os achados do "Pulso da operação": os que aconteceram desde a hora cheia de 23 horas atrás, quantos chegaram
   * esperados (exceção), por hora, e a mediana do tempo até detectar. O total e os esperados são contagens exatas; as
   * horas e a mediana vêm dos `PULSE_FINDINGS_CAP` mais recentes.
   */
  private async findingsPulse(
    now: Date,
  ): Promise<Pick<TowerPulse, 'since' | 'findings' | 'timeToDetectSeconds'>> {
    const db = this.prisma.scoped();
    const since = pulseSince(now);
    const window = { occurredAt: { gte: since, lte: now } };
    const [total, expected, recent] = await Promise.all([
      db.finding.count({ where: window }),
      db.finding.count({ where: { ...window, exceptionId: { not: null } } }),
      db.finding.findMany({
        where: window,
        select: { occurredAt: true, createdAt: true },
        orderBy: { occurredAt: 'desc' },
        take: PULSE_FINDINGS_CAP,
      }),
    ]);
    return {
      since: since.toISOString(),
      findings: {
        total,
        expected,
        hourly: hourlyCounts(
          recent.map((finding) => finding.occurredAt),
          since,
        ),
      },
      timeToDetectSeconds: medianTimeToDetect(recent),
    };
  }

  /** Eventos lidos no mês corrente (calendário de Brasília) pelo medidor, das fontes com eventos de log de verdade. */
  private async monthEvents(now: Date): Promise<TowerPulse['monthEvents']> {
    const month = usageMonth(now);
    const usage = await this.prisma.scoped().ingestUsage.findMany({
      where: { month, source: { in: [...PULSE_EVENT_SOURCES] } },
      select: { source: true, events: true },
    });
    const events = new Map(usage.map((row) => [row.source, row.events]));
    return {
      month: month.toISOString().slice(0, 7),
      sources: PULSE_EVENT_SOURCES.flatMap((source: PulseEventSource) => {
        const value = events.get(source);
        return value === undefined || value === 0n ? [] : [{ source, events: safeCount(value) }];
      }),
    };
  }
}
