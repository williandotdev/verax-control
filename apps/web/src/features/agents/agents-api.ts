import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type AgentListQuery, agentInstallSchema, agentListSchema } from '@verax/shared';
import { api } from '@/lib/api';

function toSearch(query: AgentListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** Agentes do Wazuh do cliente da sessão, com a hora da última lista vinda do manager. Atualiza a cada minuto. */
export function useAgents(query: AgentListQuery, enabled: boolean) {
  return useQuery({
    queryKey: ['agents', query],
    queryFn: () => api.get(`/v1/agents?${toSearch(query)}`, agentListSchema),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled,
  });
}

/**
 * Instruções de instalação (e a senha de registro, para quem administra). Cada leitura entra na trilha de auditoria do
 * cliente: buscadas uma vez por visita à tela, sem refazer a cada foco da janela, e esquecidas ao sair dela.
 */
export function useAgentInstall(enabled: boolean) {
  return useQuery({
    queryKey: ['agents', 'install'],
    queryFn: () => api.get('/v1/agents/install', agentInstallSchema),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    enabled,
  });
}
