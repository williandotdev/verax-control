import { useQuery, useQueryClient } from '@tanstack/react-query';
import { tenantsApi } from '@/lib/api';

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

/** Depois de uma operação: a lista e o detalhe do cliente. */
export function useInvalidateTenants(): (id?: string) => Promise<void> {
  const client = useQueryClient();
  return async (id) => {
    await client.invalidateQueries({ queryKey: ['tenants'] });
    if (id !== undefined) await client.invalidateQueries({ queryKey: ['tenant', id] });
  };
}
