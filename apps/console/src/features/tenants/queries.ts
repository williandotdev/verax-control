import { useQuery, useQueryClient } from '@tanstack/react-query';
import { logSourcesApi, tenantsApi } from '@/lib/api';

/** Enquanto o cliente provisiona, o detalhe se atualiza sozinho (os passos andam no cp-worker). */
const PROVISIONING_REFRESH_MS = 15_000;

export function useTenants() {
  return useQuery({ queryKey: ['tenants'], queryFn: tenantsApi.list });
}

export function useTenant(id: string) {
  return useQuery({
    queryKey: ['tenant', id],
    queryFn: () => tenantsApi.get(id),
    refetchInterval: (query) =>
      query.state.data?.state === 'provisioning' ? PROVISIONING_REFRESH_MS : false,
  });
}

/** O que mandar ao cliente que instala na infraestrutura dele (a versão vigente, conferida pelo cp-worker). */
export function useTenantInstallation(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['tenant', id, 'installation'],
    queryFn: () => tenantsApi.installation(id),
    enabled,
    retry: false,
  });
}

/**
 * Com algo esperando o nó (uma fonte pendente ou um usuário pedido; o nó sincroniza a cada 5 minutos), a leitura se
 * atualiza sozinha.
 */
const NODE_SYNC_REFRESH_MS = 30_000;

/**
 * O nó do cliente, as fontes de log e os usuários pedidos pela Verax (`GET .../node-sync`), lidos pelas duas regiões da
 * página. Nenhuma resposta leva segredo: a senha temporária de um usuário só vem na resposta da criação, fora daqui.
 */
export function useNodeSync(id: string) {
  return useQuery({
    queryKey: ['tenant', id, 'node-sync'],
    queryFn: () => logSourcesApi.overview(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      const waiting =
        data !== undefined &&
        (data.sources.some((source) => source.pending) ||
          data.users.some((user) => user.status === 'pending'));
      return waiting ? NODE_SYNC_REFRESH_MS : false;
    },
  });
}

/** Depois de uma escrita nas fontes de log: só a leitura delas. */
export function useInvalidateNodeSync(): (id: string) => Promise<void> {
  const client = useQueryClient();
  return async (id) => {
    await client.invalidateQueries({ queryKey: ['tenant', id, 'node-sync'] });
  };
}

/** Depois de uma operação: a lista e o detalhe do cliente. */
export function useInvalidateTenants(): (id?: string) => Promise<void> {
  const client = useQueryClient();
  return async (id) => {
    await client.invalidateQueries({ queryKey: ['tenants'] });
    if (id !== undefined) await client.invalidateQueries({ queryKey: ['tenant', id] });
  };
}
