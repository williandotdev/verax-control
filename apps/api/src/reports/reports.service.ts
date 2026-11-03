import { Inject, Injectable } from '@nestjs/common';
import {
  coverageFold,
  entitiesFold,
  exceptionsFold,
  type FindingsFold,
  incidentsReport,
  type MitreReport,
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

/** Só o que o cálculo do MITRE usa, mais o id da paginação. */
const mitreSelect = {
  id: true,
  occurredAt: true,
  mitreTactics: true,
  mitreTechniques: true,
} as const satisfies Prisma.FindingSelect;

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
   * Lê os achados que começaram no período, do mais recente para trás, em lotes de `batchSize`, e entrega cada linha
   * a `onRow`. A paginação é por chave (data e id): nenhum achado fica de fora nem conta duas vezes, mesmo com datas
   * iguais na virada do lote. O cursor também vira o limite de cima do intervalo, para o Postgres começar a varredura
   * do índice nele, em vez de reler a cada lote tudo o que já passou.
   */
  private async scanFindings<T extends { id: string; occurredAt: Date }>(
    window: Pick<ReportWindow, 'from' | 'to'>,
    read: (where: Prisma.FindingWhereInput, take: number) => Promise<T[]>,
    onRow: (row: T) => void,
  ): Promise<void> {
    const from = new Date(window.from);
    let where: Prisma.FindingWhereInput = { occurredAt: { gte: from, lte: new Date(window.to) } };
    for (;;) {
      const rows = await read(where, this.batchSize);
      for (const row of rows) onRow(row);
      const last = rows.at(-1);
      if (last === undefined || rows.length < this.batchSize) return;
      where = {
        occurredAt: { gte: from, lte: last.occurredAt },
        OR: [{ occurredAt: { lt: last.occurredAt } }, { id: { lt: last.id } }],
      };
    }
  }

  /** Passa pelo cálculo todos os achados que começaram no período. */
  async foldFindings<R>(window: Pick<ReportWindow, 'from' | 'to'>, fold: FindingsFold<R>): Promise<R> {
    const db = this.prisma.scoped();
    await this.scanFindings(
      window,
      (where, take) =>
        db.finding.findMany({ where, select: { id: true, ...findingSelect }, orderBy: KEYSET_ORDER, take }),
      (row) => fold.add(toReportFinding(row)),
    );
    return fold.result();
  }

  /**
   * Resumo MITRE ATT&CK do período (a Torre pede a cada minuto): lê só as três colunas que o cálculo usa, em vez do
   * achado inteiro.
   */
  async mitre(window: ReportWindow): Promise<MitreReport> {
    const db = this.prisma.scoped();
    const fold = mitreFold(await this.incidentsSince(new Date(window.from)), window);
    await this.scanFindings(
      window,
      (where, take) => db.finding.findMany({ where, select: mitreSelect, orderBy: KEYSET_ORDER, take }),
      (row) =>
        fold.add({
          occurredAt: row.occurredAt.toISOString(),
          mitreTactics: row.mitreTactics,
          mitreTechniques: row.mitreTechniques,
        }),
    );
    return fold.result();
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
        return this.mitre(window);
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
