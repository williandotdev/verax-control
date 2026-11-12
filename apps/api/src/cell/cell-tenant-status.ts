import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { CellReportOutbox } from './cell-report-outbox.js';

/** Nome da tarefa do worker que relata os agregados de cada cliente da célula. */
export const CELL_TENANT_STATUS_TASK = 'cell-tenant-status';
/** O mesmo intervalo do `node-status` do nó dedicado (os guest attributes que este relatório substitui na célula). */
export const CELL_TENANT_STATUS_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Tarefa `cell-tenant-status` (CE-05; só na célula): a cada 5 min, um `tenant.status` por cliente que veio do canal, com
 * as contas conectadas e o evento mais recente, as mesmas contas do `node-status` do nó dedicado, mas por cliente. É o
 * que a ativação do plano de controle lê (`waiting_customer_connection → active`). Só agregados: nenhum nome, ID de
 * conta ou evento sai da célula. O cliente em expurgo fica de fora (os dados dele estão saindo).
 */
export class CellTenantStatusReporter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: CellReportOutbox,
  ) {}

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<{ reported: number }> {
    const states = await this.prisma.cellTenantState.findMany({
      where: { tenant: { status: { not: 'purging' } } },
      select: { tenantId: true, controlPlaneId: true },
    });
    if (states.length === 0) return { reported: 0 };
    const tenantIds = states.map((state) => state.tenantId);
    const [connected, latest] = await Promise.all([
      this.prisma.cloudAccount.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds }, status: 'active', connection: 'connected' },
        _count: { _all: true },
      }),
      this.prisma.cloudAccount.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds }, status: 'active' },
        _max: { lastEventAt: true },
      }),
    ]);
    signal.throwIfAborted();
    const connectedOf = new Map(connected.map((row) => [row.tenantId, row._count._all]));
    const latestOf = new Map(latest.map((row) => [row.tenantId, row._max.lastEventAt]));
    await this.prisma.$transaction(async (tx) => {
      for (const state of states) {
        await this.outbox.enqueue(tx, {
          kind: 'tenant.status',
          tenantId: state.controlPlaneId,
          accountsConnected: connectedOf.get(state.tenantId) ?? 0,
          lastEventAt: latestOf.get(state.tenantId)?.toISOString() ?? null,
        });
      }
    });
    return { reported: states.length };
  }
}
