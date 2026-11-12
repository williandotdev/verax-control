import { CELL_PROTOCOL_VERSION, cellReportSchema } from '@verax/shared';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { PUBSUB_PUBLISH_MAX_MESSAGES, type PubsubPublisher } from '../gcp/pubsub.client.js';

/** Nome da tarefa do worker que publica a caixa de saída. */
export const CELL_REPORTS_TASK = 'cell-reports';
export const CELL_REPORTS_INTERVAL_MS = 10_000;

/** Até quantos relatórios uma execução publica (o resto fica para a seguinte, 10 s depois). */
const MAX_PER_RUN = 500;
/** Depois de uma falha, o lote espera isto antes da próxima tentativa (o Pub/Sub fora do ar não vira laço quente). */
export const CELL_REPORT_RETRY_MS = 60_000;
/** Os já publicados ficam 7 dias (para conferência) e então saem da tabela. */
export const CELL_REPORT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface CellReportPublishReport {
  published: number;
  failed: number;
  dropped: number;
  cleaned: number;
}

/** O que o publicador usa do logger (o pino do worker; um dublê nos testes). */
export interface CellReportLogger {
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/**
 * Tarefa `cell-reports` (CE-05): publica a caixa de saída (`CellReport`) no tópico de relatórios da célula, em ordem de
 * criação, em lotes de até 100. O lote que falha fica com a próxima tentativa marcada, e o resto da execução para (o
 * Pub/Sub fora do ar não ganha uma chamada por lote). Um relatório que o contrato não aceita mais (gravado por uma versão
 * anterior com outro formato) sai da fila com um erro no log: o plano de controle o recusaria do mesmo jeito.
 *
 * Com mais de uma réplica do worker, um relatório pode sair duas vezes; o plano de controle ignora a repetição pelo
 * `reportId`. Os atributos da mensagem são só o tipo e a versão (sem dado de cliente).
 */
export class CellReportPublisher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: PubsubPublisher,
    private readonly topic: string,
    private readonly logger: CellReportLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<CellReportPublishReport> {
    const report: CellReportPublishReport = { published: 0, failed: 0, dropped: 0, cleaned: 0 };
    const now = this.now();
    const pending = await this.prisma.cellReport.findMany({
      where: { publishedAt: null, nextAttemptAt: { lte: now } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_PER_RUN,
      select: { id: true, kind: true, body: true },
    });
    for (let start = 0; start < pending.length; start += PUBSUB_PUBLISH_MAX_MESSAGES) {
      signal.throwIfAborted();
      const batch: { id: string; kind: string; data: string }[] = [];
      for (const row of pending.slice(start, start + PUBSUB_PUBLISH_MAX_MESSAGES)) {
        const parsed = cellReportSchema.safeParse(row.body);
        if (!parsed.success) {
          // Só o id e o tipo: o corpo cita o cliente.
          this.logger.error(
            { event: 'cell_report_dropped', reportId: row.id, kind: row.kind },
            'relatório fora do contrato',
          );
          await this.prisma.cellReport.delete({ where: { id: row.id }, select: { id: true } });
          report.dropped += 1;
          continue;
        }
        batch.push({
          id: row.id,
          kind: parsed.data.kind,
          data: Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64'),
        });
      }
      if (batch.length === 0) continue;
      const ids = batch.map((item) => item.id);
      try {
        await this.publisher.publish(
          this.topic,
          batch.map((item) => ({
            data: item.data,
            attributes: { kind: item.kind, v: String(CELL_PROTOCOL_VERSION) },
          })),
        );
      } catch {
        // A mensagem de erro do Pub/Sub não vai ao log (pode citar recursos); o agendador loga o tipo se a tarefa cair.
        await this.prisma.cellReport.updateMany({
          where: { id: { in: ids } },
          data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + CELL_REPORT_RETRY_MS) },
        });
        this.logger.warn(
          { event: 'cell_report_publish_failed', reports: ids.length },
          'relatórios ficam para depois',
        );
        report.failed += ids.length;
        break;
      }
      await this.prisma.cellReport.updateMany({ where: { id: { in: ids } }, data: { publishedAt: now } });
      report.published += ids.length;
    }
    const cleaned = await this.prisma.cellReport.deleteMany({
      where: { publishedAt: { lt: new Date(now.getTime() - CELL_REPORT_KEEP_MS) } },
    });
    report.cleaned = cleaned.count;
    return report;
  }
}
