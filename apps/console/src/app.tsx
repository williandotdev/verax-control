import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { createQueryClient } from '@/lib/query-client';
import { createRouter } from './router';

export function App() {
  const [client] = useState(createQueryClient);
  const [router] = useState(createRouter);
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
