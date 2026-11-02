import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router/dom';
import { DemoBanner } from '@/components/demo-banner';
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
