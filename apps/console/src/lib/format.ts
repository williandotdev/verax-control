import type { ComponentId, ContactReason, DeploymentMode, SupportLevel, VersionStatus } from './api-types';

const dateTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});
const dateOnly = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'UTC' });

/** "04/11/2026, 12:00" no horário de São Paulo (o do responsável e da vigência). */
export function formatDateTime(value: string | undefined): string {
  if (value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTime.format(date);
}

/** O fuso de Brasília: desde 2019 sem horário de verão, sempre 3 horas atrás do UTC (o `America/Sao_Paulo`). */
const BRASILIA_OFFSET = '-03:00';
const DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * O começo de um dia escolhido no calendário (AAAA-MM-DD, o valor de um `<input type="date">`) no horário de Brasília,
 * como ISO. Não depende do fuso do navegador nem do servidor: o dia que o responsável escolheu é o mesmo dia que as
 * telas mostram (`formatDateTime`, sempre em São Paulo). `undefined` para texto que não é uma data.
 */
export function startOfDayInBrasilia(day: string): string | undefined {
  if (!DAY_PATTERN.test(day)) return undefined;
  const date = new Date(`${day}T00:00:00${BRASILIA_OFFSET}`);
  // Um dia que não existe (31/02) não vira outro: a data em Brasília tem de ser a mesma que foi escolhida.
  if (Number.isNaN(date.getTime())) return undefined;
  const back = new Date(date.getTime() - 3 * 60 * 60_000).toISOString().slice(0, 10);
  return back === day ? date.toISOString() : undefined;
}

/** Uma data sem hora (AAAA-MM-DD) como "04/11/2026". */
export function formatDay(value: string | undefined): string {
  if (value === undefined) return '—';
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? '—' : dateOnly.format(date);
}

export const STATUS_LABELS: Readonly<Record<VersionStatus, string>> = {
  draft: 'Rascunho',
  published: 'Publicada',
  retired: 'Aposentada',
};

export const MODE_LABELS: Readonly<Record<DeploymentMode, string>> = {
  managed: 'Na infraestrutura da Verax',
  self_hosted: 'Na nuvem do cliente',
};

export const SUPPORT_LABELS: Readonly<Record<SupportLevel, string>> = {
  standard: 'Padrão',
  priority: 'Prioritário',
};

export const CONTACT_REASON_LABELS: Readonly<Record<ContactReason, string>> = {
  cloud_accounts_above_max: 'contas de nuvem acima do máximo da tabela',
  volume_above_max: 'volume de logs acima da maior faixa',
  agents_above_max: 'agentes acima do máximo de pacotes',
  history_above_max: 'histórico acima da maior opção',
  above_largest_size: 'nenhum porte comporta a combinação',
};

/** O texto de um item da cotação na DRE (o componente, a variante e o modo). */
export function lineItemLabel(component: ComponentId, variant: string, mode: DeploymentMode): string {
  switch (component) {
    case 'environment':
      return mode === 'managed'
        ? `Ambiente gerenciado (porte ${variant.slice(-1)})`
        : `Licença na nuvem do cliente (porte ${variant.slice(-1)})`;
    case 'cloud_accounts':
      return 'Contas de nuvem adicionais';
    case 'volume':
      return `Volume de logs até ${variant} GiB/mês`;
    case 'agents':
      return `Agentes nas instâncias (pacote de ${variant})`;
    case 'history':
      return `Histórico de ${variant} dias`;
    case 'priority_support':
      return 'Suporte prioritário';
    case 'setup':
      return 'Implantação (uma vez)';
  }
}

/** "1 configuração", "2 configurações". */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${new Intl.NumberFormat('pt-BR').format(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Uma configuração numa linha: "Verax · P · 4 contas · 50 GiB · 10 agentes · 180 dias · padrão". */
export function configurationSummary(configuration: {
  mode: DeploymentMode;
  size?: string;
  cloudAccounts: number;
  monthlyGib: number;
  agents: number;
  historyDays: number;
  support: SupportLevel;
}): string {
  return [
    configuration.mode === 'managed' ? 'Gerenciado' : 'Nuvem do cliente',
    ...(configuration.size === undefined ? [] : [`porte ${configuration.size}`]),
    plural(configuration.cloudAccounts, 'conta', 'contas'),
    `${configuration.monthlyGib} GiB/mês`,
    plural(configuration.agents, 'agente', 'agentes'),
    `${configuration.historyDays} dias`,
    `suporte ${SUPPORT_LABELS[configuration.support].toLowerCase()}`,
  ].join(' · ');
}
