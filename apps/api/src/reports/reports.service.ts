import { Injectable } from '@nestjs/common';
import {
  coverageReport,
  entitiesReport,
  exceptionsReport,
  incidentsReport,
  mitreReport,
  type ReportFinding,
  type ReportIncident,
  type ReportKind,
  type ReportPeriod,
  reportWindow,
  rulesReport,
  summaryReport,
} from '@verax/shared';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Teto de achados lidos por relatório: o período mais longo (90 dias) de um cliente cabe com folga. */
const MAX_FINDINGS = 50_000;

const findingSelect = {
  occurredAt: true,
  createdAt: true,
  triagedAt: true,
  severity: true,
  status: true,
  logSource: true,
  ruleId: true,
  title: true,
  accountId: true,
  actorUser: true,
  accessKeyId: true,
  sourceIp: true,
  resource: true,
  mitreTactics: true,
  mitreTechniques: true,
  incidentId: true,
  exceptionId: true,
} as const satisfies Prisma.FindingSelect;

const incidentSelect = {
  id: true,
  severity: true,
  status: true,
  riskScore: true,
  firstSeenAt: true,
  createdAt: true,
  resolvedAt: true,
  mitreTactics: true,
  assignee: { select: { id: true, name: true } },
} as const satisfies Prisma.IncidentSelect;

type FindingRow = Prisma.FindingGetPayload<{ select: typeof findingSelect }>;
type IncidentRow = Prisma.IncidentGetPayload<{ select: typeof incidentSelect }>;

export function toReportFinding(row: FindingRow): ReportFinding {
  return {
    ...row,
    source: row.logSource,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    triagedAt: row.triagedAt?.toISOString() ?? null,
  };
}

export function toReportIncident(row: IncidentRow): ReportIncident {
  return {
    ...row,
    firstSeenAt: row.firstSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Relatórios do cliente da sessão (menu Relatórios). Lê os achados e incidentes do período e calcula com as funções
 * puras de `@verax/shared`, as mesmas do modo de demonstração.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Achados que começaram a partir de `from`, dos mais recentes para trás. */
  async findingsSince(from: Date): Promise<ReportFinding[]> {
    const rows = await this.prisma.scoped().finding.findMany({
      where: { occurredAt: { gte: from } },
      select: findingSelect,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: MAX_FINDINGS,
    });
    return rows.map(toReportFinding);
  }

  /** Incidentes que importam no período: os que começaram ou foram resolvidos nele, e todos os abertos. */
  async incidentsSince(from: Date): Promise<ReportIncident[]> {
    const rows = await this.prisma.scoped().incident.findMany({
      where: {
        OR: [{ status: { not: 'resolved' } }, { firstSeenAt: { gte: from } }, { resolvedAt: { gte: from } }],
      },
      select: incidentSelect,
      orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toReportIncident);
  }

  async report(kind: ReportKind, period: ReportPeriod, now = new Date()) {
    const window = reportWindow(period, now);
    const from = new Date(window.from);
    switch (kind) {
      case 'summary':
        return summaryReport(await this.findingsSince(from), await this.incidentsSince(from), window);
      case 'mitre':
        return mitreReport(await this.findingsSince(from), await this.incidentsSince(from), window);
      case 'rules':
        return rulesReport(await this.findingsSince(from), window);
      case 'entities':
        return entitiesReport(await this.findingsSince(from), window);
      case 'incidents':
        return incidentsReport(await this.incidentsSince(from), window);
      case 'coverage': {
        const accounts = await this.prisma.scoped().cloudAccount.findMany({
          select: { provider: true, accountId: true, status: true, lastEventAt: true },
          orderBy: [{ provider: 'asc' }, { accountId: 'asc' }],
        });
        return coverageReport(
          accounts.map((account) => ({
            provider: account.provider,
            accountId: account.accountId,
            active: account.status === 'active',
            lastEventAt: account.lastEventAt?.toISOString() ?? null,
          })),
          await this.findingsSince(from),
          window,
        );
      }
      case 'exceptions': {
        const exceptions = await this.prisma.scoped().alertException.findMany({
          select: {
            id: true,
            ruleId: true,
            field: true,
            value: true,
            reason: true,
            expiresAt: true,
            matchedCount: true,
            lastMatchedAt: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        return exceptionsReport(
          exceptions.map((exception) => ({
            ...exception,
            expiresAt: exception.expiresAt?.toISOString() ?? null,
            lastMatchedAt: exception.lastMatchedAt?.toISOString() ?? null,
          })),
          await this.findingsSince(from),
          window,
        );
      }
    }
  }
}
