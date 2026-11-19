import type { AmendablePlan, ContractTerm, PriceTable } from '@/lib/api-types';
import { formatDate } from '@/lib/format';
import { formatInteger } from '@/lib/numbers';

/**
 * A vigência de um contrato direto, como o cp-admin a calcula (`apps/control-plane/src/pricing/contract-term.ts`): 12
 * meses no SIEM Dedicado (a da tabela de preços) e 60 no SIEM + vCISO, contados do último aditivo.
 */
export const VCISO_CONTRACT_MONTHS = 60;

/** A duração do contrato do plano, em meses; sem a tabela carregada, a do Dedicado fica desconhecida. */
export function contractMonthsOf(plan: AmendablePlan, table: PriceTable | undefined): number | undefined {
  if (plan === 'vciso') return VCISO_CONTRACT_MONTHS;
  return table?.plans.dedicado.contractMonths;
}

/** `start` mais `months` meses, com o dia preso ao último do mês de chegada (31/01 + 1 mês é o fim de fevereiro). */
export function addMonths(start: Date, months: number): Date {
  const target = new Date(start.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** "12 meses, de 19/11/2026 a 19/11/2027". */
export function termText(term: ContractTerm): string {
  return `${formatInteger(term.months)} meses, de ${formatDate(term.startsAt)} a ${formatDate(term.endsAt)}`;
}
