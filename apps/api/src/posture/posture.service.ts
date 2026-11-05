import { Injectable } from '@nestjs/common';
import {
  type Paginated,
  type PostureAccount,
  type PostureCheck,
  type PostureCheckListQuery,
  type PostureOverview,
  postureHistoryDays,
} from '@verax/shared';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PlanService } from '../plan/plan.service.js';
import { DEFAULT_TOWER_THRESHOLDS } from '../tower/tower-rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const scanSelect = {
  id: true,
  accountId: true,
  scannedAt: true,
  score: true,
  weightPassed: true,
  weightTotal: true,
  passed: true,
  failed: true,
  failedCritical: true,
  failedHigh: true,
  failedMedium: true,
  failedLow: true,
  failedInformational: true,
} as const satisfies Prisma.PostureScanSelect;

type ScanRow = Prisma.PostureScanGetPayload<{ select: typeof scanSelect }>;

/** Nota de várias varreduras: soma dos pesos aprovados sobre a soma dos totais (a mesma regra de uma conta). */
export function combinedScore(
  scans: readonly Pick<ScanRow, 'weightPassed' | 'weightTotal'>[],
): number | null {
  const total = scans.reduce((sum, scan) => sum + scan.weightTotal, 0);
  if (total === 0) return null;
  return Math.round((scans.reduce((sum, scan) => sum + scan.weightPassed, 0) / total) * 100);
}

/**
 * Postura do cliente da sessão (T5.8), a partir das varreduras gravadas pelo job do Prowler: a nota de cada conta,
 * a evolução e as checagens reprovadas na última varredura. Conta sem varredura aparece com nota vazia.
 */
@Injectable()
export class PostureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plan: PlanService,
  ) {}

  /** A varredura mais recente de cada conta ativa (as contas sem varredura ficam de fora do mapa). */
  async latestScans(): Promise<{ accounts: string[]; latest: Map<string, ScanRow> }> {
    const db = this.prisma.scoped();
    const accounts = (
      await db.cloudAccount.findMany({
        where: { status: 'active' },
        select: { accountId: true },
        orderBy: [{ provider: 'asc' }, { accountId: 'asc' }],
      })
    ).map((account) => account.accountId);
    const latest = new Map<string, ScanRow>();
    for (const accountId of accounts) {
      const scan = await db.postureScan.findFirst({
        where: { accountId },
        select: scanSelect,
        orderBy: [{ scannedAt: 'desc' }, { id: 'desc' }],
      });
      if (scan) latest.set(accountId, scan);
    }
    return { accounts, latest };
  }

  async overview(now = new Date()): Promise<PostureOverview> {
    const { accounts, latest } = await this.latestScans();
    // A evolução segue o histórico do plano (PR-20): 90 dias no Essencial, 365 no Profissional, até 365.
    const historyDays = postureHistoryDays(this.plan.historyDays);
    const since = new Date(now.getTime() - historyDays * DAY_MS);
    const db = this.prisma.scoped();
    const items: PostureAccount[] = [];
    for (const accountId of accounts) {
      const scan = latest.get(accountId);
      const recent = await db.postureScan.findMany({
        where: { accountId, scannedAt: { gte: since }, score: { not: null } },
        select: { scannedAt: true, score: true },
        orderBy: [{ scannedAt: 'asc' }, { id: 'asc' }],
      });
      // Uma nota por dia: a última varredura do dia vale.
      const byDay = new Map<string, number>();
      for (const point of recent)
        byDay.set(point.scannedAt.toISOString().slice(0, 10), point.score as number);
      items.push({
        accountId,
        score: scan?.score ?? null,
        scannedAt: scan?.scannedAt.toISOString() ?? null,
        passed: scan?.passed ?? 0,
        failed: scan?.failed ?? 0,
        failedBySeverity: {
          critical: scan?.failedCritical ?? 0,
          high: scan?.failedHigh ?? 0,
          medium: scan?.failedMedium ?? 0,
          low: scan?.failedLow ?? 0,
          informational: scan?.failedInformational ?? 0,
        },
        history: [...byDay].map(([date, score]) => ({ date, score })).slice(-historyDays),
      });
    }
    return {
      score: combinedScore([...latest.values()]),
      warningBelow: DEFAULT_TOWER_THRESHOLDS.postureWarning,
      accounts: items,
    };
  }

  async checks(query: PostureCheckListQuery): Promise<Paginated<PostureCheck>> {
    const { latest } = await this.latestScans();
    const scanIds = [...latest.values()]
      .filter((scan) => !query.accountId || scan.accountId === query.accountId)
      .map((scan) => scan.id);
    const where: Prisma.PostureFailureWhereInput = {
      scanId: { in: scanIds },
      ...(query.severity && { severity: query.severity }),
    };
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.postureFailure.findMany({
        where,
        select: {
          id: true,
          checkId: true,
          title: true,
          severity: true,
          region: true,
          resource: true,
          resourceType: true,
          risk: true,
          remediation: true,
          references: true,
          scan: { select: { accountId: true } },
        },
        // O enum segue a ordem de gravidade (crítica primeiro).
        orderBy: [{ severity: 'asc' }, { title: 'asc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      db.postureFailure.count({ where }),
    ]);
    return toPaginated(
      rows.map(({ scan, ...row }) => ({ ...row, accountId: scan.accountId })),
      total,
      query,
    );
  }
}
