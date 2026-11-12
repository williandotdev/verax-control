import {
  addDays,
  brasiliaDay,
  dayAsDate,
  dayOfDate,
  isUsageDayFinal,
  METERED_SOURCES,
  type MeteredSource,
  type UsageDailyReport,
  type UsageDayCounters,
  usageDailyReportSchema,
} from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** Quantos dias antes de hoje entram no relatório de cada hora: ontem, que fecha às 06:00. */
export const USAGE_DAILY_LOOKBACK_DAYS = 1;
/** Um teto para quem pede mais dias (a reconciliação de um nó que ficou fora do ar). */
const MAX_LOOKBACK_DAYS = 62;

function safeCount(value: bigint): number {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

/**
 * Os relatórios `usage.daily` da célula (CE-09), para o canal com o plano de controle (o CE-05 os põe na fila de saída
 * e publica): um por cliente e dia, de `lookbackDays` dias antes de hoje até hoje, no calendário de Brasília, com as
 * três fontes (zero quando não houve leitura) e os valores **absolutos** do `IngestUsageDay` (o total do dia até
 * agora). Mandar de novo não soma nada: o plano de controle guarda o último.
 *
 * - `final` só depois das 06:00 de Brasília do dia seguinte (`isUsageDayFinal`): chamada a cada hora com o padrão
 *   (`lookbackDays = 1`), manda hoje (provisório) e ontem, que vira final na primeira chamada depois das 06:00.
 * - `tenantIds`: os clientes que a célula atende (quem chama sabe quais). Nenhum dado de outro cliente entra; a ordem
 *   é a dos clientes pedidos e, em cada um, a dos dias.
 * - `db`: o cliente base ou a transação do chamador (a da fila de saída). Só lê.
 */
export async function usageDailyReports(
  db: Prisma.TransactionClient,
  tenantIds: readonly string[],
  now: Date,
  { lookbackDays = USAGE_DAILY_LOOKBACK_DAYS }: { lookbackDays?: number } = {},
): Promise<UsageDailyReport[]> {
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 0 || lookbackDays > MAX_LOOKBACK_DAYS) {
    throw new RangeError(`lookbackDays deve ser um inteiro de 0 a ${MAX_LOOKBACK_DAYS}`);
  }
  if (tenantIds.length === 0) return [];
  const today = brasiliaDay(now);
  const first = addDays(today, -lookbackDays);
  const days = Array.from({ length: lookbackDays + 1 }, (_, index) => addDays(first, index));
  // Busca de sistema, só dos clientes pedidos.
  const rows = await db.ingestUsageDay.findMany({
    where: {
      tenantId: { in: [...new Set(tenantIds)] },
      day: { gte: dayAsDate(first), lte: dayAsDate(today) },
    },
    select: { tenantId: true, day: true, source: true, bytes: true, events: true },
  });
  const counters = new Map<string, UsageDayCounters>();
  for (const row of rows) {
    counters.set(`${row.tenantId}|${dayOfDate(row.day)}|${row.source}`, {
      bytes: safeCount(row.bytes),
      events: safeCount(row.events),
    });
  }
  const zero: UsageDayCounters = { bytes: 0, events: 0 };
  const reports: UsageDailyReport[] = [];
  for (const tenantId of new Set(tenantIds)) {
    for (const day of days) {
      const of = (source: MeteredSource) => counters.get(`${tenantId}|${day}|${source}`) ?? zero;
      reports.push(
        usageDailyReportSchema.parse({
          tenantId,
          day,
          sources: Object.fromEntries(METERED_SOURCES.map((source) => [source, of(source)])),
          final: isUsageDayFinal(day, now),
        }),
      );
    }
  }
  return reports;
}
