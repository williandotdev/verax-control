import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { authApi, SessionExpiredError } from '@/lib/api';
import { loginPath } from '@/lib/return-path';

/**
 * Sessão vencida em qualquer leitura ou gravação das telas protegidas (401 `unauthenticated`): o cache sai (nada do
 * responsável fica na memória da página) e a tela de entrada abre, guardando a tela atual para voltar depois. Só a
 * moldura das telas protegidas (`Layout`) usa: o 401 da própria entrada é um erro comum do formulário.
 */
export function useSessionExpiredRedirect(): () => void {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const current = `${location.pathname}${location.search}`;

  const expire = useCallback(() => {
    client.clear();
    void navigate(loginPath(current), { replace: true });
  }, [client, navigate, current]);

  useEffect(() => {
    const unsubscribeQueries = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') {
        if (event.action.error instanceof SessionExpiredError) expire();
      }
    });
    const unsubscribeMutations = client.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') {
        if (event.action.error instanceof SessionExpiredError) expire();
      }
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [client, expire]);

  return expire;
}

/** A saída: a API apaga a sessão e o cookie; aqui o cache sai e a tela de entrada abre (mesmo se a API falhar). */
export function useLogout() {
  const client = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      client.clear();
      void navigate('/entrar', { replace: true });
    },
  });
}
