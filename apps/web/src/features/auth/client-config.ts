import { useQuery } from '@tanstack/react-query';
import { authClientConfigSchema } from '@verax/shared';
import { api } from '@/lib/api';

export const AUTH_CLIENT_CONFIG_QUERY_KEY = ['auth', 'client-config'] as const;

/**
 * Configuração pública do login (`GET /v1/auth/client-config`): hoje, só a chave do site do Turnstile. Sem sessão.
 * Se a chamada falhar, a tela segue sem o widget; com o Turnstile ligado na API, o envio volta com
 * `TURNSTILE_REQUIRED`, que a tela explica.
 */
export function useAuthClientConfig() {
  return useQuery({
    queryKey: AUTH_CLIENT_CONFIG_QUERY_KEY,
    queryFn: () => api.get('/v1/auth/client-config', authClientConfigSchema),
    staleTime: 5 * 60_000,
  });
}
