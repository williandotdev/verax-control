import type { ContractValues, PriceTable } from '@/lib/api-types';
import { formatInteger, formatRatio } from '@/lib/numbers';

/**
 * Os valores de um contrato direto no console: o mensal e o GB/dia adicional, a referência da tabela, o preenchimento
 * que não apaga o negociado e o texto do marcador "tabela" ou "negociado".
 */

/** Os dois valores do contrato direto, na ordem da tela. */
export const CONTRACT_FIELDS = ['monthlyTotal', 'additionalGbDayAmount'] as const;
export type ContractField = (typeof CONTRACT_FIELDS)[number];

export const CONTRACT_FIELD_LABELS: Readonly<Record<ContractField, string>> = {
  monthlyTotal: 'Valor mensal do contrato',
  additionalGbDayAmount: 'Valor por GB/dia adicional',
};

export const CONTRACT_UNITS: Readonly<Record<ContractField, string>> = {
  monthlyTotal: 'por mês',
  additionalGbDayAmount: 'por GB/dia, por mês',
};

/** O teto de sanidade da API (`MAX_AMOUNT_CENTS`): barra um número absurdo digitado por engano. */
const MAX_CENTS = 100_000_000;

function isCents(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_CENTS;
}

/** Os valores prontos para a API (os limites de `contractValuesSchema`): o mensal positivo, o adicional a partir de 0. */
export function completeContractValues(value: unknown): ContractValues | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const monthly = record['monthlyTotal'];
  const additional = record['additionalGbDayAmount'];
  if (!isCents(monthly, 1) || !isCents(additional, 0)) return undefined;
  return { monthlyTotal: monthly, additionalGbDayAmount: additional };
}

/**
 * O preenchimento do contratado com a referência de uma cotação nova, sem apagar o que o responsável negociou: um campo
 * vazio, ou ainda com o valor da referência anterior (não mexido), passa a ser o da referência nova; um campo mudado
 * fica como está, e a tela o marca "negociado" diante da tabela nova.
 */
export function prefillContracted(
  current: unknown,
  reference: ContractValues,
  previous: ContractValues | undefined,
): Partial<Record<ContractField, unknown>> {
  const values = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
  const next: Partial<Record<ContractField, unknown>> = {};
  for (const field of CONTRACT_FIELDS) {
    const value = values[field];
    const untouched = value === undefined || (previous !== undefined && value === previous[field]);
    next[field] = untouched ? reference[field] : value;
  }
  return next;
}

/** "tabela" ou "negociado, 10,0% abaixo da tabela" (o texto do marcador). */
export function negotiationText(contracted: number, reference: number): string {
  if (contracted === reference) return 'tabela';
  if (reference === 0) return 'negociado';
  const ratio = Math.abs(contracted - reference) / reference;
  return `negociado, ${formatRatio(ratio)} ${contracted < reference ? 'abaixo' : 'acima'} da tabela`;
}

/** O que cada plano cota na tabela vigente, para a dica do volume (o cadastro e o aditivo). */
export function gbDayHint(table: PriceTable, plan: unknown): string {
  const { plataforma, dedicado } = table.plans;
  if (plan === 'plataforma') {
    return `${formatInteger(plataforma.includedGbDay)} GB/dia incluídos, até ${formatInteger(plataforma.maxOnlineGbDay)}.`;
  }
  return `De ${formatInteger(dedicado.minGbDay)} a ${formatInteger(dedicado.maxGbDay)} GB/dia (abaixo do mínimo, sobe até ele).`;
}
