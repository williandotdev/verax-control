import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { createQueryClient } from '@/lib/query-client';
import { createFakeState, type FakeAdminState } from '@/mocks/fake-admin-api';
import { adminHandlers } from '@/mocks/handlers';
import { server } from '@/mocks/server';
import { routes } from '@/router';

/** Abre o console num caminho, sobre a API simulada em memória (o estado volta para o teste conferir). */
export function renderConsole(path: string, state: FakeAdminState = createFakeState()) {
  server.use(...adminHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  render(
    createElement(
      QueryClientProvider,
      { client: createQueryClient() },
      createElement(RouterProvider, { router }),
    ),
  );
  return { user, router, state };
}
