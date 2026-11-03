import type { UnownedPeriod, UnownedReason } from '@verax/shared';

/** Por que o alerta ficou sem dono, em português, com o que costuma resolver. */
export const UNOWNED_REASON_LABELS: Readonly<Record<UnownedReason, { label: string; hint: string }>> = {
  unknown_account: {
    label: 'Conta não cadastrada',
    hint: 'A conta do evento não está em nenhum cliente. Cadastre-a no cliente certo.',
  },
  source_mismatch: {
    label: 'Conta e origem não batem',
    hint: 'A conta é de um cliente, mas o bucket de origem foi cadastrado por outro. Confira os buckets das duas contas.',
  },
  unknown_source: {
    label: 'Origem não cadastrada',
    hint: 'O bucket de log de onde o alerta veio não está em nenhuma conta. Cadastre o bucket na conta certa.',
  },
  ambiguous_source: {
    label: 'Origem em mais de um cliente',
    hint: 'O mesmo bucket de log está cadastrado em clientes diferentes. Deixe-o só no cliente dono.',
  },
  conflicting_accounts: {
    label: 'Contas diferentes no evento',
    hint: 'O evento cita mais de uma conta, e na dúvida não é atribuído a ninguém. Investigue a origem.',
  },
  no_account: {
    label: 'Evento sem conta',
    hint: 'O evento não cita conta nenhuma. Investigue a origem.',
  },
  not_aws: {
    label: 'Não veio de conta AWS',
    hint: 'O alerta não veio da leitura dos logs da AWS (por exemplo, um alerta do próprio Wazuh).',
  },
  invalid_alert: {
    label: 'Fora do formato esperado',
    hint: 'O alerta não passou na validação. Confira a versão do Wazuh e os decodificadores.',
  },
};

export const UNOWNED_PERIOD_LABELS: Readonly<Record<UnownedPeriod, string>> = {
  '24h': 'Últimas 24 horas',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
};
