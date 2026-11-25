import { Inject, Injectable } from '@nestjs/common';
import {
  coverageFold,
  entitiesFold,
  exceptionsFold,
  type FindingsFold,
  incidentsReport,
  type MitreCount,
  type MitreReport,
  mitreReportFromCounts,
  type ReportFinding,
  type ReportIncident,
  type ReportKind,
  type ReportWindow,
  rulesFold,
  summaryFold,
  type SummaryReport,
} from '@verax/shared';
import { caseOutcomes, mitreWithCases } from '../cases/case-summary-store.js';
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

/** Do mais recente para trás, com o id como desempate: a ordem da paginação por chave. */
const KEYSET_ORDER = [
  { occurredAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.FindingOrderByWithRelationInput[];

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
   * Passa pelo cálculo todos os achados que começaram no período, do mais recente para trás, em lotes de `batchSize`. A
   * paginação é por chave (data e id): nenhum achado fica de fora nem conta duas vezes, mesmo com datas iguais na virada
   * do lote. O cursor também vira o limite de cima do intervalo, para o Postgres começar a varredura do índice nele, em
   * vez de reler a cada lote tudo o que já passou.
   */
  async foldFindings<R>(window: Pick<ReportWindow, 'from' | 'to'>, fold: FindingsFold<R>): Promise<R> {
    const db = this.prisma.scoped();
    const from = new Date(window.from);
    let where: Prisma.FindingWhereInput = { occurredAt: { gte: from, lte: new Date(window.to) } };
    for (;;) {
      const rows = await db.finding.findMany({
        where,
        select: { id: true, ...findingSelect },
        orderBy: KEYSET_ORDER,
        take: this.batchSize,
      });
      for (const row of rows) fold.add(toReportFinding(row));
      const last = rows.at(-1);
      if (last === undefined || rows.length < this.batchSize) return fold.result();
      where = {
        occurredAt: { gte: from, lte: last.occurredAt },
        OR: [{ occurredAt: { lt: last.occurredAt } }, { id: { lt: last.id } }],
      };
    }
  }

  /**
   * Resumo MITRE ATT&CK do período (o relatório, e a Torre em toda tela aberta): o banco conta os achados por combinação
   * de táticas e técnicas (algumas dezenas, e não centenas de milhares de linhas), e o cálculo é o mesmo de sempre, com
   * a contagem no lugar do achado. O cliente é o da sessão. Com `cases`, a mesma leitura conta também os casos por tática.
   */
  async mitre(window: ReportWindow, { cases = false }: { cases?: boolean } = {}): Promise<MitreReport> {
    const tenantId = this.prisma.scopeTenantId();
    const from = new Date(window.from);
    const to = new Date(window.to);
    const read = cases ? await mitreWithCases(this.prisma.db(), tenantId, { from, to }) : null;
    const counts =
      read?.counts ??
      (await this.prisma.db().$queryRaw<MitreCount[]>`
      SELECT "mitreTactics", COALESCE("mitreTechniques", '{}') AS "mitreTechniques", count(*)::int AS count
      FROM "Finding"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "occurredAt" BETWEEN ${from} AND ${to}
        AND cardinality("mitreTactics") > 0
      GROUP BY 1, 2`);
    const incidents = await this.prisma.scoped().incident.findMany({
      where: { firstSeenAt: { gte: from, lte: to } },
      select: { mitreTactics: true },
    });
    const byTactic = read === null ? undefined : new Map(read.cases.map((row) => [row.tactic, row.cases]));
    return mitreReportFromCounts(counts, incidents, window, byTactic);
  }

  /** O resumo do período. Com `cases`, leva também os casos abertos nele. */
  private async summary(window: ReportWindow, cases: boolean): Promise<SummaryReport> {
    const from = new Date(window.from);
    const summary = await this.foldFindings(window, summaryFold(await this.incidentsSince(from), window));
    if (!cases) return summary;
    const outcomes = await caseOutcomes(this.prisma.db(), this.prisma.scopeTenantId(), {
      from,
      to: new Date(window.to),
    });
    return { ...summary, cases: outcomes };
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

  /** O relatório pedido, na janela do pedido (um período até agora ou um intervalo personalizado). */
  async report(kind: ReportKind, window: ReportWindow, { cases = false }: { cases?: boolean } = {}) {
    const from = new Date(window.from);
    switch (kind) {
      case 'summary':
        return this.summary(window, cases);
      case 'mitre':
        return this.mitre(window, { cases });
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
