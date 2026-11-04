import { type AgentStatus, WAZUH_AGENTS_STALE_MINUTES } from '@verax/shared';

/** Situação de cada agente, como a lista mostra (texto e cor do selo). */
export const AGENT_STATUS_LABELS: Readonly<Record<AgentStatus, { label: string; className: string }>> = {
  active: { label: 'Conectado', className: 'border-ok/50 bg-ok/10' },
  disconnected: { label: 'Desconectado', className: 'border-high/60 bg-high/10' },
  pending: { label: 'Registrando', className: 'border-foreground/30 bg-foreground/5' },
  never_connected: { label: 'Nunca conectou', className: 'border-foreground/30 bg-foreground/5' },
};

/** A lista do manager chega a cada minuto: sem lista nova há mais que isto, o painel avisa. */
export function agentListIsStale(syncedAt: string, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(syncedAt) > WAZUH_AGENTS_STALE_MINUTES * 60_000;
}
