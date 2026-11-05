import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { usageMonth } from '../usage/usage-meter.js';

/** O GiB do plano: 2^30 bytes, a mesma régua do medidor (`IngestUsage.bytes`). */
export const BYTES_PER_GIB = 1024n ** 3n;

/** Faixas do volume mensal que avisam por e-mail, uma vez por mês cada. */
export const USAGE_THRESHOLDS = [80, 100] as const;
export type UsageThreshold = (typeof USAGE_THRESHOLDS)[number];

/** Chave de deduplicação do aviso de volume: `usage:<AAAA-MM>:<80|100>`, uma por cliente, mês e faixa. */
export function usageDedupeKey(month: Date, percent: UsageThreshold): string {
  return `usage:${month.toISOString().slice(0, 7)}:${percent}`;
}

/** As faixas que o volume do mês já alcançou, contra o limite do plano em bytes. */
export function reachedThresholds(bytes: bigint, limitBytes: bigint): UsageThreshold[] {
  return USAGE_THRESHOLDS.filter((percent) => bytes * 100n >= limitBytes * BigInt(percent));
}

/**
 * As linhas da fila de saída para o volume de um cliente no mês. Quando o mês chega aos 100% sem ter passado pelo aviso
 * de 80% (um salto entre duas execuções), o de 80% nasce `skipped` (`superseded`): sai um e-mail só, e o de 80% não é
 * criado de novo na execução seguinte.
 */
export function usageNoticeRows(
  tenantId: string,
  month: Date,
  bytes: bigint,
  limitBytes: bigint,
): Prisma.NotificationCreateManyInput[] {
  const reached = reachedThresholds(bytes, limitBytes);
  const row = (percent: UsageThreshold): Prisma.NotificationCreateManyInput => ({
    tenantId,
    kind: 'plan_usage',
    dedupeKey: usageDedupeKey(month, percent),
    usageMonth: month,
    usagePercent: percent,
  });
  if (reached.includes(100)) return [{ ...row(80), status: 'skipped', lastError: 'superseded' }, row(100)];
  return reached.map(row);
}

/**
 * Avisos de 80% e 100% do volume mensal do plano (fase 2, PR-16; antes no PR-18), calculados a cada execução da tarefa
 * `notifications` a partir do medidor de uso (`IngestUsage`, PR-03) contra o limite do plano do nó (`PLAN` e
 * `PLAN_MONTHLY_GIB`). O mês é o do calendário de Brasília, como no medidor. Cada faixa avisa uma vez por mês e
 * cliente (a chave de deduplicação). O aviso só informa: acima de 100%, a coleta e os achados continuam (nada aqui
 * bloqueia o medidor nem os coletores). Sem limite de volume (plano `interno`), nada é calculado.
 */
export class UsageNotices {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monthlyGib: number | null,
  ) {}

  /** Grava os avisos que faltam no mês de `now`. Devolve quantas linhas entraram na fila. */
  async check(now: Date): Promise<number> {
    if (this.monthlyGib === null) return 0;
    const month = usageMonth(now);
    const limitBytes = BigInt(this.monthlyGib) * BYTES_PER_GIB;
    // Busca de sistema, entre todos os clientes do nó; cada gravação vai pelo escopo do próprio cliente.
    const totals = await this.prisma.ingestUsage.groupBy({
      by: ['tenantId'],
      where: { month },
      _sum: { bytes: true },
      orderBy: { tenantId: 'asc' },
    });
    let created = 0;
    for (const { tenantId, _sum } of totals) {
      const rows = usageNoticeRows(tenantId, month, _sum.bytes ?? 0n, limitBytes);
      if (rows.length === 0) continue;
      const { count } = await this.prisma
        .forTenant(tenantId)
        .notification.createMany({ data: rows, skipDuplicates: true });
      created += count;
    }
    return created;
  }
}
