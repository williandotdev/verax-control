import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Me,
  meSchema,
  paginatedSchema,
  switchTenantResponseSchema,
  tenantSummarySchema,
} from '@verax/shared';
import { api } from '@/lib/api';

export const ME_QUERY_KEY = ['me'] as const;

/** Identidade da sessão (`GET /v1/me`), validada pelo contrato compartilhado. */
export function useMe() {
  return useQuery({ queryKey: ME_QUERY_KEY, queryFn: () => api.get('/v1/me', meSchema), staleTime: 60_000 });
}

const tenantListSchema = paginatedSchema(tenantSummarySchema);

/** Clientes para o seletor do admin_verax. Só é buscado para quem pode trocar de cliente. */
export function useTenantOptions(me: Me | undefined) {
  return useQuery({
    queryKey: ['tenants', 'options'],
    queryFn: () => api.get('/v1/tenants?pageSize=100', tenantListSchema),
    enabled: me?.permissions.includes('session:switch_tenant') === true,
    select: (page) => page.items.filter((tenant) => tenant.status === 'active'),
  });
}

/**
 * Troca o cliente da sessão (só admin_verax; a API decide e audita). Todos os dados em cache são de outro
 * cliente depois da troca, então o cache inteiro é descartado.
 */
export function useSwitchTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string | null) =>
      tenantId === null
        ? api.delete('/v1/session/tenant')
        : api.post('/v1/session/tenant', { tenantId }, switchTenantResponseSchema),
    onSuccess: async () => {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'me' && query.queryKey[0] !== 'tenants',
      });
      await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/v1/auth/sign-out', {}),
    onSettled: () => {
      api.resetCsrf();
      queryClient.clear();
    },
  });
}
