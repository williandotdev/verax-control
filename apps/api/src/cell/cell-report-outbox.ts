import { randomUUID } from 'node:crypto';
import {
  CELL_PROTOCOL_VERSION,
  type CellReport,
  type CellReportBody,
  cellIdSchema,
  cellMessageJson,
  cellReportSchema,
} from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Corpo de um relatório de cliente sem o id do cliente: quem grava conhece o cliente da célula (o id do banco daqui), e
 * a caixa de saída troca pelo id do plano de controle (`CellTenantState.controlPlaneId`).
 */
export type CellTenantReportBody = CellReportBody extends infer B
  ? B extends { tenantId: string }
    ? Omit<B, 'tenantId'>
    : never
  : never;

/**
 * A caixa de saída dos relatórios da célula ao plano de controle (CE-05): um relatório nasce na MESMA transação do que
 * ele relata (o comando aplicado, o volume do dia, a exportação gravada), e a tarefa `cell-reports` o publica depois
 * (`CellReportPublisher`). Se a transação desfaz, o relatório some junto; se a publicação falha, ele fica e sai na
 * próxima. O plano de controle ignora a repetição pelo `reportId`.
 *
 * É a porta de entrada dos relatórios para as outras partes da célula: a medição (CE-09) grava o `usage.daily` com
 * `enqueueForTenant`, e o pedido de franquia (CE-19) e o de tópico da GCP (CE-08), do mesmo jeito.
 */
export class CellReportOutbox {
  constructor(
    readonly cellId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!cellIdSchema.safeParse(cellId).success) throw new Error('CELL_ID inválido');
  }

  /**
   * Grava um relatório já com o id do cliente do plano de controle (ou o `cell.status`, sem cliente). O relatório é
   * conferido inteiro pelo contrato antes de entrar: um relatório que o plano de controle recusaria nunca é gravado.
   */
  async enqueue(db: Prisma.TransactionClient, body: CellReportBody): Promise<string> {
    const reportId = randomUUID();
    const report: CellReport = cellReportSchema.parse({
      ...body,
      v: CELL_PROTOCOL_VERSION,
      reportId,
      cellId: this.cellId,
      emittedAt: this.now().toISOString(),
    });
    // O JSON passa pelo mesmo teto da publicação: o que não caberia na mensagem nem entra na fila.
    cellMessageJson(report);
    await db.cellReport.create({
      data: { id: reportId, kind: report.kind, body: report },
      select: { id: true },
    });
    return reportId;
  }

  /**
   * Grava um relatório de um cliente da célula pelo id daqui. O cliente que não veio do canal (sem `CellTenantState`,
   * como o nó dedicado inteiro) não tem a quem relatar: devolve null e não grava nada.
   */
  async enqueueForTenant(
    db: Prisma.TransactionClient,
    tenantId: string,
    body: CellTenantReportBody,
  ): Promise<string | null> {
    const state = await db.cellTenantState.findUnique({
      where: { tenantId },
      select: { controlPlaneId: true },
    });
    if (state === null) return null;
    return this.enqueue(db, { ...body, tenantId: state.controlPlaneId });
  }
}
