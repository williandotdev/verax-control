import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/http/api-error.js';
import {
  type Configuration,
  type DeploymentMode,
  type PlanId,
  type PriceTable,
  type QuoteLineItem,
  type SizeId,
  type TaxMode,
} from './pricing.schema.js';
import { startingAt } from './quote.js';

/**
 * O que o site (o "marketplace": a calculadora, a cotação e o checkout) vende: só a Plataforma, na infraestrutura da
 * Verax (decisões do responsável de 06/11/2026 e 10/11/2026). O Dedicado e o vCISO são por proposta e contrato direto,
 * cadastrados pelo responsável no console, assim como o ambiente na infraestrutura do cliente. A tabela tem os preços
 * de todos (o site mostra o Dedicado e o vCISO como referência, o simulador de DRE, a checagem de publicação e a
 * cotação de referência do contrato direto usam); a cotação e o checkout públicos recusam com 422 qualquer plano ou
 * lugar fora daqui, qualquer que seja o conteúdo da tabela publicada.
 */
export const ONLINE_PLANS: readonly PlanId[] = ['plataforma'];
export const ONLINE_MODES: readonly DeploymentMode[] = ['managed'];

export function isSoldOnline(configuration: Pick<Configuration, 'plan' | 'mode'>): boolean {
  return ONLINE_PLANS.includes(configuration.plan) && ONLINE_MODES.includes(configuration.mode);
}

/** O código do 422 de um plano (ou lugar) que o site não vende (a cotação e o checkout). */
export const PLAN_NOT_SOLD_ONLINE = 'plan_not_sold_online';

/**
 * 422 da cotação ou do checkout com um plano que o site não vende: a mensagem leva à proposta e ao contrato direto, sem
 * nome de provedor (a infraestrutura da Verax hoje é a GCP e pode mudar).
 */
export function planNotSoldOnline(): ApiError {
  return new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Pelo site, só a Plataforma é contratada na hora. O Dedicado, o vCISO e o ambiente na infraestrutura da sua empresa são por proposta e contrato direto: fale com a Verax.',
    PLAN_NOT_SOLD_ONLINE,
  );
}

/** A parte pública da tabela vigente (`GET /v1/public/pricing`): preços e regras, nunca custo, margem ou `lookup_key`. */
export interface PublicPricing {
  priceTableVersion: string;
  currency: 'brl';
  interval: 'month';
  /** `exclusive`: os valores são sem imposto (o "+ impostos"), que vai por cima na fatura. */
  taxMode: TaxMode;
  /** O "a partir de" de cada plano: o preço da configuração mínima na infraestrutura da Verax. */
  startingAt: Partial<Record<PlanId, { monthly: number; setup: number }>>;
  plans: {
    plataforma: {
      sale: 'online';
      baseAmount: number;
      includedGbDay: number;
      additionalGbDayAmount: number;
      overageGbDayAmount: number;
      maxOnlineGbDay: number;
    };
    dedicado: {
      sale: 'contract';
      gbDayAmount: number;
      minGbDay: number;
      maxGbDay: number;
      contractMonths: number;
    };
    vciso: {
      sale: 'contract';
      gbDayAmount: number;
      serviceAmount: number;
      setupAmount: number;
      minGbDay: number;
      maxGbDay: number;
      contractMonths: number;
    };
  };
  sizes: { size: SizeId; description: string; maxGbDay: number }[];
  history: { includedDays: number };
  users: { max: number };
}

export function publicPricing(version: string, table: PriceTable): PublicPricing {
  const starting: PublicPricing['startingAt'] = {};
  for (const plan of ['plataforma', 'dedicado', 'vciso'] as const) {
    const value = startingAt(table, plan);
    if (value !== undefined) starting[plan] = value;
  }
  const { plataforma, dedicado, vciso } = table.plans;
  return {
    priceTableVersion: version,
    currency: 'brl',
    interval: 'month',
    taxMode: table.taxMode,
    startingAt: starting,
    plans: {
      plataforma: {
        sale: 'online',
        baseAmount: plataforma.base.amount,
        includedGbDay: plataforma.includedGbDay,
        additionalGbDayAmount: plataforma.additionalGbDay.amount,
        overageGbDayAmount: plataforma.overageGbDay.amount,
        maxOnlineGbDay: plataforma.maxOnlineGbDay,
      },
      dedicado: {
        sale: 'contract',
        gbDayAmount: dedicado.gbDay.amount,
        minGbDay: dedicado.minGbDay,
        maxGbDay: dedicado.maxGbDay,
        contractMonths: dedicado.contractMonths,
      },
      vciso: {
        sale: 'contract',
        gbDayAmount: dedicado.gbDay.amount,
        serviceAmount: vciso.service.amount,
        setupAmount: vciso.setup.amount,
        minGbDay: dedicado.minGbDay,
        maxGbDay: dedicado.maxGbDay,
        contractMonths: dedicado.contractMonths,
      },
    },
    sizes: table.sizing.sizes.map((rule) => ({
      size: rule.size,
      description: rule.description,
      maxGbDay: rule.maxGbDay,
    })),
    history: { includedDays: table.history.includedDays },
    users: { max: table.users.max },
  };
}

/** Texto de cada item para o cliente (a calculadora do site e o resumo antes do Checkout). */
export function describeLineItem(item: QuoteLineItem): string {
  switch (item.component) {
    case 'base':
      return 'Plataforma (base mensal com a franquia incluída)';
    case 'additional_gb_day':
      return 'GB/dia adicional da franquia';
    case 'overage_gb_day':
      return 'GB/dia excedente';
    case 'gb_day':
      return 'GB/dia do servidor dedicado';
    case 'service':
      return 'Serviço de vCISO';
    case 'setup':
      return 'Implantação (cobrada uma vez)';
  }
}
