import { Injectable } from '@nestjs/common';
import {
  FINDING_SEVERITIES,
  type FindingSeverity,
  hasPermission,
  REPORT_PERIOD_DAYS,
  reportWindow,
  type TowerSummary,
} from '@verax/shared';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { combinedScore, PostureService } from '../posture/posture.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { coverage, DEFAULT_TOWER_THRESHOLDS, pendingDecisions, trafficLight } from './tower-rules.js';

/** O resumo MITRE ATT&CK da Torre olha os últimos 30 dias, com as mesmas contas do relatório MITRE desse período. */
const MITRE_PERIOD = '30d';

/** A fila sem dono que conta na Torre: os alertas dos últimos 7 dias. */
const UNOWNED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resumo da Torre (T5.10) do cliente da sessão: semáforo com os motivos, decisões pendentes, incidentes abertos por
 * severidade, postura e cobertura. As regras ficam em `tower-rules.ts`; aqui só se contam os dados.
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

    const accounts = await db.cloudAccount.findMany({
      where: { status: 'active' },
      select: { accountId: true, provider: true, connection: true, lastCollectedAt: true, lastEventAt: true },
    });
    const cover = coverage(
      accounts.map((account) => ({
        accountId: account.accountId,
        provider: account.provider,
        connection: account.connection,
        lastCollectedAt: account.lastCollectedAt?.toISOString() ?? null,
        lastEventAt: account.lastEventAt?.toISOString() ?? null,
      })),
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

    const { light, reasons } = trafficLight({ openIncidents, postureScore }, thresholds);
    return {
      light,
      reasons,
      pendingDecisions: pendingDecisions(
        { unassignedIncidents, untriagedFindings, unownedAlerts },
        { includeUnowned },
      ),
      openIncidents,
      posture: { score: postureScore, scannedAt, warningBelow: thresholds.postureWarning },
      coverage: { ...cover, silentAfterHours: thresholds.silentAfterHours },
      mitre,
      generatedAt: now.toISOString(),
    };
  }
}
