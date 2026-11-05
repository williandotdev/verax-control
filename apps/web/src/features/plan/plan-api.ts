import { useQuery } from '@tanstack/react-query';
import { planUsageSchema } from '@verax/shared';
import { api } from '@/lib/api';

/** Plano do nó e uso do cliente da sessão (`GET /v1/plan`). Só leitura: o plano vem da configuração do nó. */
export function usePlanUsage(enabled: boolean) {
  return useQuery({
    queryKey: ['plan'],
    queryFn: () => api.get('/v1/plan', planUsageSchema),
    enabled,
  });
}
