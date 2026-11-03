import { Inject, Injectable } from '@nestjs/common';
import {
  coverageFold,
  entitiesFold,
  exceptionsFold,
  type FindingsFold,
  incidentsReport,
  mitreFold,
  type ReportFinding,
  type ReportIncident,
  type ReportKind,
  type ReportPeriod,
  type ReportWindow,
  reportWindow,
  rulesFold,
  summaryFold,
} from '@verax/shared';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Achados lidos por consulta. O relatório passa por todos os achados do período, lote a lote: não há teto que deixe
 * achado de fora, e a memória guarda só um lote e as contagens.
 */
export const REPORT_BATCH_SIZE = Symbol('REPORT_BATCH_SIZE');
export const DEFAULT_REPORT_BATCH_SIZE = 5_000;

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
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REPORT_BATCH_SIZE) private readonly batchSize: number,
  ) {}

  /**
   * Passa pelo cálculo todos os achados que começaram no período, do mais recente para trás. A paginação é por chave
   * (data e id): nenhum achado fica de fora nem conta duas vezes, mesmo com datas iguais na virada do lote.
   */
  async foldFindings<R>(window: Pick<ReportWindow, 'from' | 'to'>, fold: FindingsFold<R>): Promise<R> {
    const db = this.prisma.scoped();
    const occurredAt = { gte: new Date(window.from), lte: new Date(window.to) };
    let after: { occurredAt: Date; id: string } | null = null;
    for (;;) {
      const rows: (FindingRow & { id: string })[] = await db.finding.findMany({
        where:
          after === null
            ? { occurredAt }
            : {
                occurredAt,
                OR: [
                  { occurredAt: { lt: after.occurredAt } },
                  { occurredAt: after.occurredAt, id: { lt: after.id } },
                ],
              },
        select: { id: true, ...findingSelect },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: this.batchSize,
      });
      for (const row of rows) fold.add(toReportFinding(row));
      const last = rows.at(-1);
      if (last === undefined || rows.length < this.batchSize) return fold.result();
      after = { occurredAt: last.occurredAt, id: last.id };
    }
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
        return this.foldFindings(window, summaryFold(await this.incidentsSince(from), window));
      case 'mitre':
        return this.foldFindings(window, mitreFold(await this.incidentsSince(from), window));
      case 'rules':
        return this.foldFindings(window, rulesFold(window));
      case 'entities':
        return this.foldFindings(window, entitiesFold(window));
      case 'incidents':
        return incidentsReport(await this.incidentsSince(from), window);
      case 'coverage': {
        const accounts = await this.prisma.scoped().cloudAccount.findMany({
          select: { provider: true, accountId: true, status: true, lastEventAt: true },
          orderBy: [{ provider: 'asc' }, { accountId: 'asc' }],
        });
        return this.foldFindings(
          window,
          coverageFold(
            accounts.map((account) => ({
              provider: account.provider,
              accountId: account.accountId,
              active: account.status === 'active',
              lastEventAt: account.lastEventAt?.toISOString() ?? null,
            })),
            window,
          ),
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
        return this.foldFindings(
          window,
          exceptionsFold(
            exceptions.map((exception) => ({
              ...exception,
              expiresAt: exception.expiresAt?.toISOString() ?? null,
              lastMatchedAt: exception.lastMatchedAt?.toISOString() ?? null,
            })),
            window,
          ),
        );
      }
    }
  }
}
