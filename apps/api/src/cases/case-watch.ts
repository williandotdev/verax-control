import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { CaseLogger } from './case-assign-job.js';
import { oldestUnassigned } from './case-store.js';

export const CASE_WATCH_TASK = 'case-watch';
export const CASE_WATCH_INTERVAL_MS = 60_000;
export const CASE_WATCH_BUDGET_MS = 60_000;
/** Um alerta alto ou crítico sem caso há mais que isto é atraso: vai para o log como aviso. */
export const CASE_LAG_WARN_MS = 10 * 60_000;

/** Contagens de uma conferência (vão para o log do agendador; nenhum dado de cliente). */
export interface CaseWatchReport {
  tenants: number;
  /** Clientes com um alerta alto ou crítico sem caso há mais de 10 min. */
  lagging: number;
  /** A idade, em segundos, do alerta alto ou crítico mais antigo ainda sem caso no nó; null se não há nenhum. */
  oldestSeconds: number | null;
}

export interface CaseWatchOptions {
  logger?: CaseLogger;
  now?: () => Date;
  /** Só os testes, que dividem o banco: restringe a tarefa a estes clientes. */
  tenantIds?: readonly string[];
}

/**
 * Vigia da atribuição: numa tarefa à parte, para ver também a `case-assign` parada. Só mede e registra no log; o aviso
 * por e-mail do atraso (fail-open) vem com os avisos por caso. Só lê, então não precisa de concessão.
 */
export class CaseWatch {
  constructor(
    private readonly prisma: PrismaService,
    private readonly options: CaseWatchOptions = {},
  ) {}

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<CaseWatchReport> {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const tenants = await this.prisma.tenant.findMany({
      where: this.options.tenantIds === undefined ? {} : { id: { in: [...this.options.tenantIds] } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const report: CaseWatchReport = { tenants: tenants.length, lagging: 0, oldestSeconds: null };
    for (const { id: tenantId } of tenants) {
      signal.throwIfAborted();
      const oldest = await oldestUnassigned(this.prisma, tenantId);
      if (oldest === null) continue;
      const ageMs = Math.max(0, now - oldest.createdAt.getTime());
      const seconds = Math.round(ageMs / 1000);
      report.oldestSeconds = Math.max(report.oldestSeconds ?? 0, seconds);
      if (ageMs <= CASE_LAG_WARN_MS) continue;
      report.lagging += 1;
      this.options.logger?.warn(
        { tenantId, severity: oldest.severity, seconds },
        'alerta alto ou crítico sem caso há mais de 10 min',
      );
    }
    return report;
  }
}
