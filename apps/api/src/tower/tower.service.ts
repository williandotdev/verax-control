import { Injectable } from '@nestjs/common';
import {
  FINDING_SEVERITIES,
  FINDING_SOURCES,
  type FindingSeverity,
  type FindingSource,
  hasPermission,
  type MitreTactic,
  PULSE_EVENT_SOURCES,
  type PulseEventSource,
  RADAR_DETECTIONS_LIMIT,
  RADAR_SECTORS,
  RADAR_WINDOW_HOURS,
  radarSectorOf,
  REPORT_PERIOD_DAYS,
  reportWindow,
  type TowerPulse,
  type TowerRadar,
  type TowerSummary,
} from '@verax/shared';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { TenantCache } from '../common/cache/tenant-cache.js';
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
/**
 * Por quanto tempo o resumo MITRE da Torre vale para o mesmo cliente: todo painel aberto o pede a cada 60 s, e ele é o
 * cálculo mais caro da Torre (30 dias de achados). Com isto, são no máximo dois por minuto e por cliente, com qualquer
 * número de painéis; um painel só o recebe novo a cada pedido. O relatório MITRE não passa por aqui.
 */
export const TOWER_MITRE_TTL_MS = 30_000;
/** Clientes guardados por processo (a célula serve muitos): cada resumo tem no máximo 14 táticas de 10 técnicas. */
export const TOWER_MITRE_TENANTS = 500;

/** A fila sem dono que conta na Torre: os alertas dos últimos 7 dias. */
const UNOWNED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Teto de achados lidos para o minigráfico por hora e o tempo até detectar do "Pulso da operação" (os mais recentes,
 * pelo índice `(tenantId, occurredAt desc)`). O total e os esperados são contados à parte e ficam sempre exatos.
 */
const PULSE_FINDINGS_CAP = 5_000;

const HOUR_MS = 3_600_000;

/** Um inteiro seguro do JSON (o medidor guarda `BigInt`). */
const safeCount = (value: bigint): number =>
  Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);

/** O total, por severidade e por setor do radar, a partir das contagens por fonte de log e severidade. */
function windowCounts(
  groups: readonly { source: FindingSource; severity: FindingSeverity; count: number }[],
): Pick<TowerRadar, 'total' | 'bySeverity' | 'bySector'> {
  const bySeverity = Object.fromEntries(FINDING_SEVERITIES.map((severity) => [severity, 0])) as Record<
    FindingSeverity,
    number
  >;
  const bySector = Object.fromEntries(RADAR_SECTORS.map((sector) => [sector, 0])) as TowerRadar['bySector'];
  let total = 0;
  for (const group of groups) {
    bySeverity[group.severity] += group.count;
    bySector[radarSectorOf(group.source)] += group.count;
    total += group.count;
  }
  return { total, bySeverity, bySector };
}

/**
 * Resumo da Torre (T5.10) do cliente da sessão: semáforo com os motivos, decisões pendentes, incidentes abertos por
 * severidade, postura, a saúde da coleta por fonte (OP-01 e OP-02) e o pulso da operação. As regras ficam em
 * `tower-rules.ts`; aqui só se contam os dados, sempre pelo escopo do cliente da sessão.
 */
@Injectable()
export class TowerService {
  private readonly mitreByTenant = new TenantCache<MitreTactic[]>({
    ttlMs: TOWER_MITRE_TTL_MS,
    maxTenants: TOWER_MITRE_TENANTS,
  });

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
    const [agents, inventory, pulse, radar] = await Promise.all([
      this.agentCounts(),
      awsAccountIds.length === 0
        ? Promise.resolve(null)
        : db.inventorySnapshot.aggregate({
            where: { accountId: { in: awsAccountIds } },
            _max: { collectedAt: true },
          }),
      this.findingsPulse(now),
      this.radar(now),
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
      // Todos os alertas altos ou críticos ainda em "novo", dentro ou fora de incidente: cada um é uma validação pendente.
      db.finding.count({ where: { status: 'new', severity: { in: ['critical', 'high'] } } }),
      // A fila sem dono não é de cliente nenhum: só a equipe da Verax vê, e só ela recebe a contagem.
      includeUnowned
        ? this.prisma.db().unownedAlert.count({
            where: { createdAt: { gte: new Date(now.getTime() - UNOWNED_WINDOW_MS) } },
          })
        : Promise.resolve(0),
    ]);

    const mitre = { periodDays: REPORT_PERIOD_DAYS[MITRE_PERIOD], tactics: await this.mitreTactics(now) };

    // O medidor da AWS parado por mais de um cliente no Wazuh do nó é do nó, não de um cliente: só a equipe da Verax vê
    // (como a fila sem dono), e o aviso não cita cliente nenhum.
    const meterVisible = hasPermission(auth.role, 'tenants:read');
    const counter = meterVisible
      ? await this.prisma
          .db()
          .wazuhCounter.findUnique({ where: { id: WAZUH_COUNTER_ID }, select: { meterBlocked: true } })
      : null;

    const { light, reasons } = trafficLight(
      { openIncidents, postureScore, stalledSources: stalledSources(sources), untriagedFindings },
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
      radar,
      mitre,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Achados e incidentes que começaram nos últimos 30 dias, pelas mesmas contas do relatório MITRE, de até
   * `TOWER_MITRE_TTL_MS` atrás. A chave é o cliente da sessão, o mesmo de onde o cálculo lê.
   */
  private mitreTactics(now: Date): Promise<MitreTactic[]> {
    return this.mitreByTenant.get(this.prisma.scopeTenantId(), async () => {
      const { tactics } = await this.reports.mitre(reportWindow(MITRE_PERIOD, now));
      return tactics;
    });
  }

  /**
   * O radar de detecções: os achados das últimas `RADAR_WINDOW_HOURS` horas (até agora), os mais recentes primeiro, até
   * `RADAR_DETECTIONS_LIMIT` (pelo índice `(tenantId, occurredAt desc)`), com o incidente de cada um e se ele segue
   * aberto (não resolvido). O total da janela é contado à parte. Só fontes conhecidas: o sync não grava outras, e uma
   * fora da lista (dado corrompido) fica de fora do radar em vez de derrubar a Torre.
   */
  private async radar(now: Date): Promise<TowerRadar> {
    const db = this.prisma.scoped();
    const since = new Date(now.getTime() - RADAR_WINDOW_HOURS * HOUR_MS);
    const where = {
      occurredAt: { gte: since, lte: now },
      logSource: { in: [...FINDING_SOURCES] },
    };
    const rows = await db.finding.findMany({
      where,
      select: {
        id: true,
        severity: true,
        status: true,
        logSource: true,
        occurredAt: true,
        title: true,
        incidentId: true,
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: RADAR_DETECTIONS_LIMIT,
    });
    // As contagens da janela inteira (o total, por severidade e por setor) num agrupamento só, depois da lista: um
    // achado que chegue no meio entra na contagem, e a lista nunca passa do total (achado não some da janela de 24
    // horas; se sumisse, as contagens saem da própria lista).
    const groups = await db.finding.groupBy({ by: ['logSource', 'severity'], where, _count: { _all: true } });
    const counted = groups.map((group) => ({
      source: group.logSource as FindingSource,
      severity: group.severity,
      count: group._count._all,
    }));
    const tally = counted.reduce((sum, group) => sum + group.count, 0);
    const counts = windowCounts(
      tally >= rows.length
        ? counted
        : rows.map((row) => ({ source: row.logSource as FindingSource, severity: row.severity, count: 1 })),
    );
    // O estado dos incidentes também pelo escopo do cliente (e não pela relação aninhada, que o escopo não alcança).
    const incidentIds = [...new Set(rows.flatMap((row) => (row.incidentId ? [row.incidentId] : [])))];
    const incidents =
      incidentIds.length === 0
        ? []
        : await db.incident.findMany({
            where: { id: { in: incidentIds } },
            select: { id: true, status: true },
          });
    const openById = new Map(incidents.map((incident) => [incident.id, incident.status !== 'resolved']));
    return {
      since: since.toISOString(),
      windowHours: RADAR_WINDOW_HOURS,
      limit: RADAR_DETECTIONS_LIMIT,
      ...counts,
      detections: rows.map((row) => ({
        id: row.id,
        severity: row.severity,
        status: row.status,
        source: row.logSource as FindingSource,
        occurredAt: row.occurredAt.toISOString(),
        title: row.title,
        incident:
          row.incidentId && openById.has(row.incidentId)
            ? { id: row.incidentId, open: openById.get(row.incidentId) === true }
            : null,
      })),
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
