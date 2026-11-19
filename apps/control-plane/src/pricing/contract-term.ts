import type { PlanId, PriceTable } from './pricing.schema.js';

/**
 * A vigência de um contrato direto (decisão do responsável de 19/11/2026): 12 meses no SIEM Dedicado e 60 no SIEM +
 * vCISO, contados do cadastro ou do último aditivo (o aditivo recomeça a contagem com a duração do plano novo).
 *
 * A do Dedicado é a da tabela de preços (`plans.dedicado.contractMonths`, que o responsável edita). A tabela não tem
 * campo para o vCISO (o vCISO repete o preço por GB/dia, o mínimo e o máximo do Dedicado), e o site vende o vCISO em 60
 * meses: fica aqui até a tabela ganhar o campo próprio.
 */
export const VCISO_CONTRACT_MONTHS = 60;

/** Os planos que um aditivo aceita: os dois que rodam num servidor próprio (a Plataforma é a célula da Verax). */
export const AMENDABLE_PLANS = ['dedicado', 'vciso'] as const satisfies readonly PlanId[];
export type AmendablePlan = (typeof AMENDABLE_PLANS)[number];

/** A duração do contrato do plano, em meses. */
export function contractMonthsFor(plan: AmendablePlan, table: PriceTable): number {
  return plan === 'vciso' ? VCISO_CONTRACT_MONTHS : table.plans.dedicado.contractMonths;
}

/**
 * `start` mais `months` meses, no calendário UTC, com o dia preso ao último do mês de chegada (31/01 + 1 mês é 28 ou
 * 29/02, nunca 03/03).
 */
export function addMonths(start: Date, months: number): Date {
  const target = new Date(start.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}
