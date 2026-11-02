import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Me, Role } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_TENANTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

function renderApp(path: string, me: Me | null) {
  const state: MockState = { me };
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, state };
}

const menu = () => screen.findByRole('navigation', { name: 'Menu principal' });

describe('rotas internas', () => {
  it('sem sessão, leva ao login', async () => {
    const { router } = renderApp('/incidentes', null);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('sessão sem MFA vai para o cadastro do MFA', async () => {
    const { router } = renderApp('/', demoMe('analista_cliente', { mfaEnabled: false }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/mfa/cadastro'));
  });

  it('página sem permissão leva a "Sem permissão" (a API recusaria os dados de qualquer forma)', async () => {
    const { router } = renderApp('/auditoria', demoMe('leitura'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sem-permissao'));
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
  });
});

describe('menu e cabeçalho por papel', () => {
  const expectedMenu: Record<Role, string[]> = {
    admin_verax: [
      'Torre',
      'Incidentes',
      'Achados',
      'Postura cloud',
      'Ativos e identidades',
      'Clientes',
      'Usuários',
      'Auditoria',
    ],
    admin_cliente: [
      'Torre',
      'Incidentes',
      'Achados',
      'Postura cloud',
      'Ativos e identidades',
      'Usuários',
      'Auditoria',
    ],
    analista_cliente: ['Torre', 'Incidentes', 'Achados', 'Postura cloud', 'Ativos e identidades'],
    leitura: ['Torre', 'Incidentes', 'Achados', 'Postura cloud', 'Ativos e identidades'],
  };

  it.each(Object.entries(expectedMenu))('%s vê só o que pode', async (role, items) => {
    renderApp('/', demoMe(role as Role));
    const links = within(await menu())
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(links).toEqual(items);
  });

  it('cabeçalho mostra o usuário e o papel', async () => {
    renderApp('/', demoMe('analista_cliente'));
    expect(await screen.findByText('analista.cliente@demo.verax.local')).toBeInTheDocument();
    expect(screen.getByText('Analista do cliente')).toBeInTheDocument();
  });

  it('seletor de cliente só aparece para admin_verax', async () => {
    renderApp('/', demoMe('admin_cliente'));
    await menu();
    expect(screen.queryByLabelText('Cliente')).not.toBeInTheDocument();
  });
});

describe('troca de cliente (admin_verax)', () => {
  it('lista só clientes ativos e troca pela API, com token CSRF', async () => {
    const csrfHeaders: (string | null)[] = [];
    const { state } = renderApp('/', demoMe('admin_verax'));
    server.use(
      http.post(`${API_URL}/v1/session/tenant`, async ({ request }) => {
        csrfHeaders.push(request.headers.get('X-CSRF-Token'));
        const { tenantId } = (await request.json()) as { tenantId: string };
        if (state.me) state.me = { ...state.me, activeTenantId: tenantId, scopeTenantId: tenantId };
        return HttpResponse.json({ activeTenantId: tenantId });
      }),
    );

    const select = await screen.findByLabelText('Cliente');
    await waitFor(() => expect(select).toBeEnabled());
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Nenhum (visão Verax)', 'Cliente Demo Alfa', 'Cliente Demo Beta']);

    const beta = DEMO_TENANTS[1]?.id ?? '';
    await userEvent.selectOptions(select, beta);
    await waitFor(() => expect(screen.getByLabelText('Cliente')).toHaveValue(beta));
    expect(csrfHeaders).toEqual(['token-csrf-ficticio']);
  });
});

it('sair encerra a sessão e volta ao login', async () => {
  const { router, state } = renderApp('/', demoMe('leitura'));
  await userEvent.click(await screen.findByRole('button', { name: 'Sair' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  expect(state.me).toBeNull();
});
