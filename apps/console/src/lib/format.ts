import type {
  ComponentId,
  ContactReason,
  ContractedConfiguration,
  DeploymentMode,
  PlanId,
  TaxMode,
  VersionStatus,
} from './api-types';

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
  self_hosted: 'Na infraestrutura do cliente (contrato direto)',
};

export const PLAN_LABELS: Readonly<Record<PlanId, string>> = {
  plataforma: 'Plataforma',
  dedicado: 'Dedicado',
  vciso: 'vCISO',
};

/** Os planos, na ordem do site. */
export const PLANS: readonly PlanId[] = ['plataforma', 'dedicado', 'vciso'];

export const TAX_MODE_LABELS: Readonly<Record<TaxMode, string>> = {
  inclusive: 'Imposto embutido no preço',
  exclusive: 'Imposto por cima ("+ impostos")',
};

export const CONTACT_REASON_LABELS: Readonly<Record<ContactReason, string>> = {
  above_online_max: 'volume acima do máximo da Plataforma no site',
  above_max: 'volume acima do máximo cotável do plano',
  above_largest_size: 'nenhum porte comporta o volume',
  mode_unavailable: 'a Plataforma só roda na infraestrutura da Verax',
};

/** O texto de um item da cotação na DRE e no resumo da cotação. */
export function lineItemLabel(component: ComponentId): string {
  switch (component) {
    case 'base':
      return 'Plataforma (base com a franquia incluída)';
    case 'additional_gb_day':
      return 'GB/dia adicional da franquia';
    case 'overage_gb_day':
      return 'GB/dia excedente';
    case 'gb_day':
      return 'GB/dia do servidor dedicado';
    case 'service':
      return 'Serviço de vCISO';
    case 'setup':
      return 'Implantação (uma vez)';
  }
}

/** "1 configuração", "2 configurações". */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${new Intl.NumberFormat('pt-BR').format(count)} ${count === 1 ? singular : pluralForm}`;
}

/** "5 GB/dia". */
export function gbDayLabel(gbDay: number): string {
  return `${new Intl.NumberFormat('pt-BR').format(gbDay)} GB/dia`;
}

/**
 * Uma configuração numa linha: "Dedicado · 5 GB/dia · na Verax · porte P". Um cliente do modelo de preço anterior (sem
 * `plan`) sai como "Modelo anterior · na Verax · porte P · 4 contas · 50 GiB/mês · …", com o que ele tem.
 */
export function configurationSummary(
  configuration:
    ContractedConfiguration | { plan: PlanId; gbDay: number; mode: DeploymentMode; size?: string },
): string {
  const place = configuration.mode === 'managed' ? 'na Verax' : 'no cliente';
  if ('plan' in configuration) {
    return [
      PLAN_LABELS[configuration.plan],
      gbDayLabel(configuration.gbDay),
      place,
      ...(configuration.size === undefined ? [] : [`porte ${configuration.size}`]),
    ].join(' · ');
  }
  return [
    'Modelo anterior',
    place,
    `porte ${configuration.size}`,
    plural(configuration.cloudAccounts, 'conta', 'contas'),
    `${configuration.monthlyGib} GiB/mês`,
    plural(configuration.agents, 'agente', 'agentes'),
    `${configuration.historyDays} dias`,
    `suporte ${configuration.support === 'priority' ? 'prioritário' : 'padrão'}`,
  ].join(' · ');
}
