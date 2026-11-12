import { cellReportSchema, type UsageDailyReport } from '@verax/shared';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { usageDailyReports } from '../usage/usage-daily.js';
import type { CellReportOutbox } from './cell-report-outbox.js';

/** Nome da tarefa do worker que manda o volume por dia de cada cliente da célula. */
export const CELL_USAGE_REPORTS_TASK = 'cell-usage-reports';
/** A cada hora (§4 do desenho, "Relatórios e fechamento"): hoje provisório e ontem, que fecha às 06:00 de Brasília. */
export const CELL_USAGE_REPORTS_INTERVAL_MS = 60 * 60 * 1000;
/** Quanto da caixa de saída se olha para saber o último relatório de cada dia (hoje e ontem cabem com folga). */
const LAST_SENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export interface CellUsageReportsReport {
  tenants: number;
  enqueued: number;
  unchanged: number;
}

/** O que identifica um relatório de volume para a comparação: os contadores e o `final` (o dia e o cliente são a chave). */
function fingerprint(report: Pick<UsageDailyReport, 'sources' | 'final'>): string {
  const { aws, gcp, cloudflare } = report.sources;
  return JSON.stringify([
    aws.bytes,
    aws.events,
    gcp.bytes,
    gcp.events,
    cloudflare.bytes,
    cloudflare.events,
    report.final,
  ]);
}

/**
 * Tarefa `cell-usage-reports` (CE-05 com o CE-09; só na célula, com o canal): a cada hora, os relatórios `usage.daily` de
 * hoje e de ontem de cada cliente do canal (`usageDailyReports`, os valores absolutos do `IngestUsageDay`), na caixa de
 * saída, com o id do cliente do plano de controle. O cliente em expurgo fica de fora.
 *
 * **Idempotência:** os valores são absolutos, então reenviar nunca soma nada no plano de controle. Para não encher a
 * caixa de saída de linhas iguais, um relatório só entra quando difere do último que entrou para o mesmo cliente e dia
 * (os contadores ou o `final`), comparado com a própria caixa de saída dos últimos 3 dias (a linha publicada fica 7
 * dias). Assim, ontem sai de novo uma vez quando vira `final`, e o dia sem leitura nova não gera linha.
 */
export class CellUsageReports {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: CellReportOutbox,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<CellUsageReportsReport> {
    const now = this.now();
    const states = await this.prisma.cellTenantState.findMany({
      where: { tenant: { status: { not: 'purging' } } },
      select: { tenantId: true, controlPlaneId: true },
    });
    const report: CellUsageReportsReport = { tenants: states.length, enqueued: 0, unchanged: 0 };
    if (states.length === 0) return report;
    const controlPlaneIdOf = new Map(states.map((state) => [state.tenantId, state.controlPlaneId]));
    const lastSent = await this.lastSent(now);
    signal.throwIfAborted();
    await this.prisma.$transaction(async (tx) => {
      const reports = await usageDailyReports(tx, [...controlPlaneIdOf.keys()], now);
      for (const usage of reports) {
        const controlPlaneId = controlPlaneIdOf.get(usage.tenantId);
        if (controlPlaneId === undefined) continue;
        if (lastSent.get(`${controlPlaneId}|${usage.day}`) === fingerprint(usage)) {
          report.unchanged += 1;
          continue;
        }
        await this.outbox.enqueue(tx, {
          kind: 'usage.daily',
          tenantId: controlPlaneId,
          day: usage.day,
          sources: usage.sources,
          final: usage.final,
        });
        report.enqueued += 1;
      }
    });
    return report;
  }

  /** O último `usage.daily` que entrou na caixa de saída para cada cliente e dia (pela chave `cliente|dia`). */
  private async lastSent(now: Date): Promise<Map<string, string>> {
    const rows = await this.prisma.cellReport.findMany({
      where: { kind: 'usage.daily', createdAt: { gte: new Date(now.getTime() - LAST_SENT_WINDOW_MS) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { body: true },
    });
    const last = new Map<string, string>();
    for (const row of rows) {
      const parsed = cellReportSchema.safeParse(row.body);
      if (!parsed.success || parsed.data.kind !== 'usage.daily') continue;
      last.set(`${parsed.data.tenantId}|${parsed.data.day}`, fingerprint(parsed.data));
    }
    return last;
  }
}
