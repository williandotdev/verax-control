import { GB_BYTES, GIB_BYTES, OVERAGE_UNITS_PER_GB } from '@verax/shared';

const MIB_BYTES = 1024 ** 2;

const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Volume lido, em GiB com uma casa ("12,3 GiB"); abaixo de 0,1 GiB, em MiB, para o começo do mês não virar "0 GiB". */
export function formatVolume(bytes: number): string {
  if (bytes === 0) return '0 GiB';
  if (bytes >= GIB_BYTES / 10) return `${decimal.format(bytes / GIB_BYTES)} GiB`;
  return bytes < MIB_BYTES ? 'menos de 1 MiB' : `${integer.format(Math.floor(bytes / MIB_BYTES))} MiB`;
}

/**
 * Fração em porcentagem inteira, arredondada para baixo: 99,6% ainda não é "100%". A folga mínima evita que o erro do
 * ponto flutuante (0,29 × 100 = 28,999…) tire um ponto.
 */
export function formatPercent(ratio: number): string {
  return `${integer.format(Math.floor(ratio * 100 + 1e-6))}%`;
}

/** Mês do uso (`AAAA-MM`) por extenso: "novembro de 2026". */
export function formatUsageMonth(month: string): string {
  return monthName.format(new Date(`${month}-01T00:00:00Z`));
}

const MB_BYTES = 1_000_000;
const twoDecimals = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayMonthName = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDay = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

/**
 * Volume da franquia, em GB (10⁹ bytes, não GiB) com uma casa ("3,5 GB"); abaixo de 0,1 GB, em MB, para o começo do
 * dia não virar "0 GB". Para baixo: o painel nunca mostra mais do que foi medido.
 */
export function formatGb(bytes: number): string {
  if (bytes === 0) return '0 GB';
  if (bytes >= GB_BYTES / 10) return `${decimal.format(Math.floor(bytes / (GB_BYTES / 10)) / 10)} GB`;
  return bytes < MB_BYTES ? 'menos de 1 MB' : `${integer.format(Math.floor(bytes / MB_BYTES))} MB`;
}

/** GB/dia com uma casa, a partir de bytes por dia ("3,4 GB/dia"). */
export function formatGbPerDay(bytesPerDay: number): string {
  return `${formatGb(bytesPerDay)}/dia`;
}

/** O excedente em centésimos de GB/dia, como a cobrança conta ("0,33 GB/dia"). */
export function formatOverage(units: number): string {
  return `${twoDecimals.format(units / OVERAGE_UNITS_PER_GB)} GB/dia`;
}

/** O ciclo por extenso: "1º a 30 de novembro". */
export function formatCycle(start: string, end: string): string {
  const last = dayMonthName.format(new Date(`${end}T00:00:00Z`));
  return `${Number(start.slice(8, 10)) === 1 ? '1º' : String(Number(start.slice(8, 10)))} a ${last}`;
}

/** Dia curto do gráfico: "12/11". */
export function formatShortDay(day: string): string {
  return shortDay.format(new Date(`${day}T00:00:00Z`));
}
