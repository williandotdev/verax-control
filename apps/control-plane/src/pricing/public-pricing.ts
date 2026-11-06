import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/http/api-error.js';
import {
  type ConfigurationInput,
  type DeploymentMode,
  type PriceTable,
  type QuoteLineItem,
  type SizeId,
} from './pricing.schema.js';
import { startingAt } from './quote.js';

/**
 * O que o site (o "marketplace": a calculadora, a cotação e o checkout) vende: só o ambiente na infraestrutura da
 * Verax (decisão do responsável, 06/11/2026). O ambiente na infraestrutura do cliente (`self_hosted`) saiu do site: é só
 * por contrato direto, cadastrado pelo responsável no console (`hosting = customer`). A tabela continua com os preços
 * dele, para o simulador de DRE, a checagem de publicação e a cotação de referência do contrato direto; nas rotas
 * públicas, o modo não aparece (`GET /v1/public/pricing`) e é recusado com 422 (`POST /v1/public/quote` e o checkout),
 * qualquer que seja o conteúdo da tabela publicada.
 */
export const ONLINE_MODES: readonly DeploymentMode[] = ['managed'];

export function isSoldOnline(mode: DeploymentMode): boolean {
  return ONLINE_MODES.includes(mode);
}

/** O código do 422 de um modo que o site não vende (a cotação e o checkout). */
export const MODE_NOT_SOLD_ONLINE = 'mode_not_sold_online';

/**
 * 422 da cotação ou do checkout com o ambiente na infraestrutura do cliente: a mensagem leva ao contrato direto, sem
 * nome de provedor (a infraestrutura da Verax hoje é a GCP e pode mudar).
 */
export function modeNotSoldOnline(): ApiError {
  return new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Pelo site, o Verax Control roda na infraestrutura da Verax. Para o ambiente na infraestrutura da sua empresa, fale com a Verax: é um contrato direto.',
    MODE_NOT_SOLD_ONLINE,
  );
}

/** A parte pública da tabela vigente (`GET /v1/public/pricing`): preços e regras, nunca custo, margem ou `lookup_key`. */
export interface PublicPricing {
  priceTableVersion: string;
  currency: 'brl';
  interval: 'month';
  /** O "a partir de" de cada modo vendido no site: o preço da configuração mínima. */
  startingAt: Partial<Record<DeploymentMode, { monthly: number; setup: number }>>;
  /** Só os modos vendidos no site (`ONLINE_MODES`): o da infraestrutura do cliente nunca aparece aqui. */
  modes: {
    mode: DeploymentMode;
    sale: 'online';
    environment: { size: SizeId; amount: number }[];
    setupAmount: number;
  }[];
  sizes: {
    size: SizeId;
    description: string;
    maxCloudAccounts: number;
    maxMonthlyGib: number;
    maxAgents: number;
  }[];
  cloudAccounts: { included: number; max: number; additionalAmount: number };
  volume: { includedMonthlyGib: number; bands: { monthlyGib: number; amount: number }[] };
  agents: { packSize: number; maxPacks: number; packAmount: number };
  history: { includedDays: number; extended: { days: number; amount: number }[] };
  prioritySupport: { amount: number };
  users: { max: number };
  presets: { id: string; label: string; configuration: ConfigurationInput }[];
}

export function publicPricing(version: string, table: PriceTable): PublicPricing {
  const starting: PublicPricing['startingAt'] = {};
  for (const mode of ONLINE_MODES) {
    const value = startingAt(table, mode);
    if (value !== undefined) starting[mode] = value;
  }
  return {
    priceTableVersion: version,
    currency: 'brl',
    interval: 'month',
    startingAt: starting,
    modes: ONLINE_MODES.map((mode) => ({
      mode,
      sale: 'online' as const,
      environment: table.sizing.sizes.map((rule) => ({
        size: rule.size,
        amount: table.modes[mode].environment[rule.size]?.amount ?? 0,
      })),
      setupAmount: table.modes[mode].setup?.amount ?? 0,
    })),
    sizes: table.sizing.sizes.map((rule) => ({
      size: rule.size,
      description: rule.description,
      maxCloudAccounts: rule.maxCloudAccounts,
      maxMonthlyGib: rule.maxMonthlyGib,
      maxAgents: rule.maxAgents,
    })),
    cloudAccounts: {
      included: table.cloudAccounts.included,
      max: table.cloudAccounts.max,
      additionalAmount: table.cloudAccounts.additional.amount,
    },
    volume: {
      includedMonthlyGib: table.volume.includedMonthlyGib,
      bands: table.volume.bands.map((band) => ({ monthlyGib: band.monthlyGib, amount: band.amount })),
    },
    agents: {
      packSize: table.agents.packSize,
      maxPacks: table.agents.maxPacks,
      packAmount: table.agents.pack.amount,
    },
    history: {
      includedDays: table.history.includedDays,
      extended: table.history.extended.map((option) => ({ days: option.days, amount: option.amount })),
    },
    prioritySupport: { amount: table.prioritySupport.amount },
    users: { max: table.users.max },
    presets: table.presets
      .filter((preset) => isSoldOnline(preset.configuration.mode))
      .map((preset) => ({ id: preset.id, label: preset.label, configuration: { ...preset.configuration } })),
  };
}

/** Texto de cada item para o cliente (a calculadora do site e o resumo antes do Checkout). */
export function describeLineItem(item: QuoteLineItem, mode: DeploymentMode, sizeId: SizeId): string {
  switch (item.component) {
    case 'environment':
      return mode === 'managed'
        ? `Ambiente na infraestrutura da Verax (porte ${sizeId})`
        : `Licença na infraestrutura do cliente (porte ${sizeId})`;
    case 'cloud_accounts':
      return 'Contas de nuvem adicionais';
    case 'volume':
      return `Volume de logs até ${item.variant} GiB/mês`;
    case 'agents':
      return `Agentes nas instâncias (pacote de ${item.variant})`;
    case 'history':
      return `Histórico de ${item.variant} dias`;
    case 'priority_support':
      return 'Suporte prioritário';
    case 'setup':
      return 'Implantação (cobrada uma vez)';
  }
}
