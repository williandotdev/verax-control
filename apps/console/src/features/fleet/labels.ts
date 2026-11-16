import type { ExclusionReason, NodeState, ReleaseStatus, RolloutState } from './api';

export const ROLLOUT_STATE_LABELS: Readonly<Record<RolloutState, string>> = {
  running: 'Andando',
  paused: 'Parada',
  paused_on_failure: 'Parada na falha',
  completed: 'Concluída',
  aborted: 'Abortada',
};

export const NODE_STATE_LABELS: Readonly<Record<NodeState, string>> = {
  pending: 'Na fila',
  updating: 'Atualizando no host',
  checking: 'Conferindo a API',
  publishing: 'Publicando o painel',
  done: 'Atualizado',
  failed: 'Falhou',
  skipped: 'Pulado',
  reverted: 'Voltou de versão',
};

export const RELEASE_STATUS_LABELS: Readonly<Record<ReleaseStatus, string>> = {
  ok: 'Conferida, com o painel',
  panel_missing: 'Sem o bundle do painel',
  invalid: 'Assinatura ou manifesto recusados',
  unavailable: 'Bucket sem resposta',
};

export const EXCLUSION_LABELS: Readonly<Record<ExclusionReason, string>> = {
  cell_closed: 'Célula fechada',
  cell_without_node: 'Célula sem a VM no registro',
  cell_without_address: 'Célula sem cliente nem painel da equipe',
  tenant_stopped: 'Nó parado (cliente suspenso ou VM desligada)',
  tenant_without_node: 'Cliente ainda sem nó',
};

export const WAVE_LABELS: Readonly<Record<number, string>> = {
  0: 'Onda 0: célula da Verax (canária)',
  1: 'Onda 1: outras células',
  2: 'Onda 2: nós dedicados',
};

/** O estado que o host relatou (`verax/update-state`), em português. */
const HOST_STATES: Readonly<Record<string, string>> = {
  accepted: 'pedido recebido',
  waiting_window: 'esperando a janela',
  waiting_install: 'esperando a instalação',
  downloading: 'baixando a versão',
  verifying: 'conferindo a assinatura',
  pulling: 'baixando as imagens',
  backing_up: 'fazendo o backup',
  installing: 'instalando',
  checking: 'conferindo o nó',
  ok: 'pronto',
  failed: 'falhou antes de mexer no nó',
  rolling_back: 'voltando para a versão de antes',
  rolled_back: 'voltou para a versão de antes',
  rollback_failed: 'a volta também falhou',
};

export function hostStateLabel(state: string | undefined): string | undefined {
  return state === undefined ? undefined : (HOST_STATES[state] ?? state);
}

/** O que fazer com cada código de falha de um nó (o código vem do motor ou do host). */
export function failureHint(code: string): string {
  if (code.startsWith('node_rolled_back:')) {
    return 'O host voltou sozinho para a versão de antes. Veja o motivo no código e retome ou pule o nó.';
  }
  if (code.startsWith('node_rollback_failed:')) {
    return 'Nem a versão de antes subiu: entre no nó (journalctl -u verax-update) antes de qualquer outra coisa.';
  }
  if (code.startsWith('node_failed:')) return 'O host recusou o pedido antes de mexer no nó.';
  if (code === 'update_timeout')
    return 'O host não respondeu no prazo: a VM está ligada e com o atualizador?';
  if (code === 'health_failed') return 'A API pública do nó não respondeu depois da atualização.';
  if (code.startsWith('firebase_')) return 'O painel não foi publicado no Firebase.';
  if (code.startsWith('compute_')) return 'O cp-worker não conseguiu gravar o pedido na VM (permissão?).';
  return 'Veja o código e o runbook.';
}
