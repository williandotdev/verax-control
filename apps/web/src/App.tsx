import { QueryClientProvider } from '@tanstack/react-query';
import type { Me } from '@verax/shared';
import { useLayoutEffect, useState } from 'react';
import { RouterProvider } from 'react-router/dom';
import { DemoBanner } from '@/components/demo-banner';
import { ME_QUERY_KEY } from '@/features/session/session';
import { bindApiNavigation } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { createAppRouter } from '@/routes/router';

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(createAppRouter);
  // As ações de navegação do cliente HTTP vão para o roteador montado. Ligadas num efeito, e não no inicializador do
  // estado: no modo estrito do React (desenvolvimento e `dev:mock`), o inicializador roda duas vezes e as ações iam
  // para o roteador descartado (a URL virava /login, e a tela ficava em "Abrindo o painel…"). O efeito de layout roda
  // antes de qualquer tela pedir dados à API.
  useLayoutEffect(() => {
    bindApiNavigation({
      onUnauthorized: () => {
        queryClient.clear();
        void router.navigate('/login', { replace: true });
      },
      onMfaRequired: () => void router.navigate('/mfa/cadastro', { replace: true }),
      // A API disse que a sessão é de senha temporária: a identidade em cache passa a dizer o mesmo, para a página
      // da troca não devolver ao painel por um `me` desatualizado.
      onPasswordChangeRequired: () => {
        queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) => me && { ...me, mustChangePassword: true });
        void router.navigate('/trocar-senha', { replace: true });
      },
    });
    return () => bindApiNavigation({});
  }, [queryClient, router]);

  return (
    <QueryClientProvider client={queryClient}>
      <DemoBanner />
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
