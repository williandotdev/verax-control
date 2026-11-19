import { PLAN_IDS, type PlanId, type PriceTable } from './pricing.schema.js';

/**
 * A vigência de um contrato direto (decisões do responsável de 19/11/2026): 12 meses no SIEM Cloud, 12 no SIEM
 * Dedicado e 60 no SIEM + vCISO, contados do último aditivo (o aditivo recomeça a contagem com a duração do plano novo).
 *
 * A do Dedicado é a da tabela de preços (`plans.dedicado.contractMonths`, que o responsável edita). A tabela não tem
 * campo para o SIEM Cloud nem para o vCISO (o vCISO repete o preço por GB/dia, o mínimo e o máximo do Dedicado); o site
 * vende o SIEM Cloud em 12 meses e o vCISO em 60: ficam aqui até a tabela ganhar os campos próprios.
 */
export const PLATAFORMA_CONTRACT_MONTHS = 12;
export const VCISO_CONTRACT_MONTHS = 60;

/**
 * Os planos que um aditivo aceita: os três, como o cadastro do contrato direto. O SIEM Cloud só na infraestrutura da
 * Verax (`PLAN_MODES`: no cliente, a cotação responde "sob consulta", `mode_unavailable`, como no cadastro); por
 * contrato, ele ganha um nó P próprio até a célula compartilhada existir (`node-fit.ts`).
 */
export const AMENDABLE_PLANS = PLAN_IDS;
export type AmendablePlan = PlanId;

/** A duração do contrato do plano, em meses. */
export function contractMonthsFor(plan: AmendablePlan, table: PriceTable): number {
  if (plan === 'vciso') return VCISO_CONTRACT_MONTHS;
  if (plan === 'plataforma') return PLATAFORMA_CONTRACT_MONTHS;
  return table.plans.dedicado.contractMonths;
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
