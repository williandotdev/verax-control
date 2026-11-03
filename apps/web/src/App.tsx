import { QueryClientProvider } from '@tanstack/react-query';
import type { Me } from '@verax/shared';
import { useState } from 'react';
import { RouterProvider } from 'react-router/dom';
import { DemoBanner } from '@/components/demo-banner';
import { ME_QUERY_KEY } from '@/features/session/session';
import { bindApiNavigation } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { createAppRouter } from '@/routes/router';

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => {
    const appRouter = createAppRouter();
    bindApiNavigation({
      onUnauthorized: () => {
        queryClient.clear();
        void appRouter.navigate('/login', { replace: true });
      },
      onMfaRequired: () => void appRouter.navigate('/mfa/cadastro', { replace: true }),
      // A API disse que a sessão é de senha temporária: a identidade em cache passa a dizer o mesmo, para a página
      // da troca não devolver ao painel por um `me` desatualizado.
      onPasswordChangeRequired: () => {
        queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) => me && { ...me, mustChangePassword: true });
        void appRouter.navigate('/trocar-senha', { replace: true });
      },
    });
    return appRouter;
  });

  return (
    <QueryClientProvider client={queryClient}>
      <DemoBanner />
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
