import { useQuery } from '@tanstack/react-query';
import { authApi } from '@/lib/api';

export const ADMIN_CLIENT_CONFIG_QUERY_KEY = ['admin', 'client-config'] as const;

/**
 * A configuração pública da entrada (`GET /v1/admin/client-config`): hoje, só a chave do site do Turnstile. Sem
 * sessão. Se a chamada falhar, a tela segue sem o widget; com o Turnstile ligado no cp-admin, o envio volta com
 * `turnstile_required`, e a tela mostra a mensagem dele.
 */
export function useAdminClientConfig() {
  return useQuery({
    queryKey: ADMIN_CLIENT_CONFIG_QUERY_KEY,
    queryFn: authApi.clientConfig,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}
