import {
  type ConfigurationInput,
  DEPLOYMENT_MODES,
  type DeploymentMode,
  type PriceTable,
  type QuoteLineItem,
  type SizeId,
} from './pricing.schema.js';
import { startingAt } from './quote.js';

/**
 * Modos vendidos pelo site na v1. Na nuvem do cliente o site mostra "Fale conosco": o provisionamento desse modo não
 * existe ainda, e a licença de uso precisa de contrato (estudo da implantação própria). A tabela já tem os preços
 * dele, para o simulador de DRE e a checagem de publicação; a cotação pública responde "fale conosco".
 */
export const ONLINE_MODES: readonly DeploymentMode[] = ['managed'];

export function isSoldOnline(mode: DeploymentMode): boolean {
  return ONLINE_MODES.includes(mode);
}

/** A parte pública da tabela vigente (`GET /v1/public/pricing`): preços e regras, nunca custo, margem ou `lookup_key`. */
export interface PublicPricing {
  priceTableVersion: string;
  currency: 'brl';
  interval: 'month';
  /** O "a partir de" de cada modo vendido no site: o preço da configuração mínima. */
  startingAt: Partial<Record<DeploymentMode, { monthly: number; setup: number }>>;
  modes: (
    | {
        mode: DeploymentMode;
        sale: 'online';
        environment: { size: SizeId; amount: number }[];
        setupAmount: number;
      }
    | { mode: DeploymentMode; sale: 'contact_us' }
  )[];
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
    modes: DEPLOYMENT_MODES.map((mode) =>
      isSoldOnline(mode)
        ? {
            mode,
            sale: 'online' as const,
            environment: table.sizing.sizes.map((rule) => ({
              size: rule.size,
              amount: table.modes[mode].environment[rule.size]?.amount ?? 0,
            })),
            setupAmount: table.modes[mode].setup?.amount ?? 0,
          }
        : { mode, sale: 'contact_us' as const },
    ),
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
        ? `Ambiente gerenciado (porte ${sizeId})`
        : `Licença na sua nuvem (porte ${sizeId})`;
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
