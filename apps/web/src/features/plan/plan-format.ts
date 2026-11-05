import { GIB_BYTES } from '@verax/shared';

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
