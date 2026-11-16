import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { Me } from '@verax/shared';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { SSO_REFUSED_MESSAGE } from '@/pages/login-page';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

/** O console fictício (RFC 2606), como a API o devolve na configuração pública do endereço da equipe. */
const CONSOLE = 'https://admin.example.com/';

function renderApp(path: string, me: Me | null, adminMasterUrl: string | null) {
  const state: MockState = { me, adminMasterUrl, turnstileSiteKey: null };
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

/**
 * O "Admin master" no SIEM da Verax: o botão do login que leva à entrada única pela API, a recusa genérica do retorno e
 * o item do menu que abre o console, só para o `admin_verax` e só quando a API diz onde o console fica (o endereço da
 * equipe na célula). Esconder o item é só a interface: quem decide é o console, com a sessão dele.
 */
describe('Admin master no painel', () => {
  it('no login: "Entrar com o Admin master" leva à entrada única da API (navegação de verdade)', async () => {
    renderApp('/login', null, CONSOLE);
    const link = await screen.findByRole('link', { name: 'Entrar com o Admin master' });
    expect(link).toHaveAttribute('href', `${API_URL}/v1/auth/sso/start`);
    // O login com senha continua lá.
    expect(screen.getByLabelText('E-mail')).toBeInTheDocument();
  });

  it('sem o console na configuração (todo endereço de cliente), o login é o de sempre', async () => {
    renderApp('/login', null, null);
    expect(await screen.findByLabelText('E-mail')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Entrar com o Admin master' })).not.toBeInTheDocument();
  });

  it('retorno recusado (?sso=recusado): a mensagem genérica, sem o motivo', async () => {
    renderApp('/login?sso=recusado', null, CONSOLE);
    expect(await screen.findByRole('alert')).toHaveTextContent(SSO_REFUSED_MESSAGE);
  });

  it('menu do admin_verax: o item "Admin master" abre o console na mesma aba', async () => {
    renderApp('/', demoMe('admin_verax'), CONSOLE);
    const menu = await screen.findByRole('navigation', { name: 'Menu principal' });
    const item = await within(menu).findByRole('link', { name: 'Admin master' });
    expect(item).toHaveAttribute('href', CONSOLE);
    expect(item).not.toHaveAttribute('target');
  });

  it('quem não é admin_verax, ou o endereço sem o console: nenhum item', async () => {
    renderApp('/', demoMe('admin_cliente'), CONSOLE);
    const menu = await screen.findByRole('navigation', { name: 'Menu principal' });
    await within(menu).findByRole('link', { name: 'Torre' });
    expect(within(menu).queryByRole('link', { name: 'Admin master' })).not.toBeInTheDocument();
  });

  it('admin_verax num endereço sem o console: nenhum item', async () => {
    renderApp('/', demoMe('admin_verax'), null);
    const menu = await screen.findByRole('navigation', { name: 'Menu principal' });
    await within(menu).findByRole('link', { name: 'Torre' });
    expect(within(menu).queryByRole('link', { name: 'Admin master' })).not.toBeInTheDocument();
  });
});
