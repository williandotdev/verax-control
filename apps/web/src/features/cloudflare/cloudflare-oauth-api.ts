import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CloudflareConnectMode,
  cloudflareConnectionSchema,
  cloudflareConnectOptionsSchema,
  type CloudflareOauthAttempt,
  cloudflareOauthAttemptSchema,
  type CloudflareOauthChoose,
  type CloudflareOauthComplete,
  cloudflareOauthCompletedSchema,
  cloudflareOauthStartedSchema,
  cloudflareZonesSchema,
  isCloudflareAuthorizeUrl,
} from '@verax/shared';
import { api } from '@/lib/api';
import { ApiRequestError } from '@/lib/api-client';

/**
 * "Conectar com Cloudflare" (OAuth) no painel. O nó anterior (ou o que não tem o OAuth ligado) responde 404 nas rotas
 * novas: para o painel, isso é o modo do token colado, e a tela fica exatamente como antes.
 */

const isNotFound = (error: unknown) => error instanceof ApiRequestError && error.status === 404;

/** Sem repetir o 404: ele é a resposta certa do nó sem OAuth, não uma falha passageira. */
const retryUnlessNotFound = (failures: number, error: unknown) => !isNotFound(error) && failures < 2;

/** Como este nó conecta o Cloudflare. Enquanto não sabe, ou em qualquer falha, o painel fica no token colado. */
export function useCloudflareConnectMode(enabled = true): CloudflareConnectMode | undefined {
  const query = useQuery({
    queryKey: ['cloudflare-oauth', 'options'],
    queryFn: async () => {
      try {
        return (await api.get('/v1/cloudflare-oauth/options', cloudflareConnectOptionsSchema)).mode;
      } catch (error) {
        if (isNotFound(error)) return 'token' as const;
        throw error;
      }
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: retryUnlessNotFound,
  });
  if (query.isPending && enabled) return undefined;
  return query.data ?? 'token';
}

/**
 * Começa a tentativa e leva o navegador à autorização do Cloudflare. A URL vem da API e só é seguida se for a de
 * autorização do Cloudflare (o contrato confere de novo aqui): nenhum outro destino.
 */
export function useStartCloudflareOauth(
  navigate: (url: string) => void = (url) => window.location.assign(url),
) {
  return useMutation({
    mutationFn: (cloudAccountId: string | undefined) =>
      api.post(
        '/v1/cloudflare-oauth/start',
        cloudAccountId === undefined ? {} : { cloudAccountId },
        cloudflareOauthStartedSchema,
      ),
    onSuccess: (started) => {
      if (isCloudflareAuthorizeUrl(started.authorizeUrl)) navigate(started.authorizeUrl);
    },
    // A resposta não fica no cache de mutações depois de a tela sair.
    gcTime: 0,
  });
}

/** O retorno lido do fragmento. Chamada direta, sem `useMutation`: o código não fica guardado nas `variables`. */
export function completeCloudflareOauth(input: CloudflareOauthComplete) {
  return api.post('/v1/cloudflare-oauth/complete', input, cloudflareOauthCompletedSchema);
}

/** Enquanto o worker troca o código ou liga as contas, a tentativa é relida neste intervalo. */
export const CLOUDFLARE_ATTEMPT_POLL_MS = 2_000;

const WAITING: readonly CloudflareOauthAttempt['status'][] = ['started', 'code_received'];

export function useCloudflareOauthAttempt(id: string | null) {
  return useQuery({
    queryKey: ['cloudflare-oauth', 'attempt', id],
    queryFn: () =>
      api.get(`/v1/cloudflare-oauth/attempts/${encodeURIComponent(id ?? '')}`, cloudflareOauthAttemptSchema),
    enabled: id !== null,
    retry: retryUnlessNotFound,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && WAITING.includes(status) ? CLOUDFLARE_ATTEMPT_POLL_MS : false;
    },
  });
}

export function useChooseCloudflareAccounts(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CloudflareOauthChoose) =>
      api.post(
        `/v1/cloudflare-oauth/attempts/${encodeURIComponent(id)}/accounts`,
        input,
        cloudflareOauthAttemptSchema,
      ),
    onSuccess: (attempt) => {
      queryClient.setQueryData(['cloudflare-oauth', 'attempt', id], attempt);
      void queryClient.invalidateQueries({ queryKey: ['cloudflare-oauth', 'attempt', id] });
    },
  });
}

/** Por onde a conta é lida (token colado ou OAuth). No nó anterior, 404: a tela não mostra nada disso. */
export function useCloudflareConnection(accountId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['cloudflare-connection', accountId],
    queryFn: () =>
      api.get(
        `/v1/cloud-accounts/${encodeURIComponent(accountId)}/cloudflare-connection`,
        cloudflareConnectionSchema,
      ),
    enabled,
    retry: retryUnlessNotFound,
  });
}

/** A saúde das zonas e da auditoria da conta. No nó anterior, 404: a seção não aparece. */
export function useCloudflareZones(accountId: string) {
  return useQuery({
    queryKey: ['cloudflare-zones', accountId],
    queryFn: () =>
      api.get(`/v1/cloud-accounts/${encodeURIComponent(accountId)}/cloudflare-zones`, cloudflareZonesSchema),
    retry: retryUnlessNotFound,
  });
}

export { isNotFound };
