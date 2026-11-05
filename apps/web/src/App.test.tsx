import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { CREDENTIAL_CHANGE_REQUIRED_CODE } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import { routes } from '@/routes/router';
import { App } from './App';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  window.history.replaceState(null, '', '/');
});
afterAll(() => server.close());

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('rotas do painel', () => {
  it('rota inexistente mostra página não encontrada', () => {
    renderAt('/nao-existe');
    expect(screen.getByRole('heading', { name: 'Página não encontrada' })).toBeInTheDocument();
  });

  it('sem permissão mostra a página própria', () => {
    renderAt('/sem-permissao');
    expect(screen.getByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
  });

  it('login existe', () => {
    renderAt('/login');
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
  });
});

describe('navegação ligada às respostas da API', () => {
  it('sem sessão, o painel leva ao login também no modo estrito do React (o roteador montado recebe a navegação)', async () => {
    // No modo estrito (desenvolvimento e `dev:mock`), o React cria o estado duas vezes: a navegação do 401 ia para o
    // roteador descartado, e a tela ficava em "Abrindo o painel…" com a URL já em /login.
    server.use(...createHandlers({ me: null }));
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
  });

  it('recusa com PASSWORD_CHANGE_REQUIRED leva à troca de senha, mesmo com a identidade em cache desatualizada', async () => {
    // A identidade diz que não há senha temporária, mas a API recusa a Torre: vale a API, e a página da troca não
    // devolve ao painel por causa do `me` antigo.
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json(
          { statusCode: 403, code: CREDENTIAL_CHANGE_REQUIRED_CODE, message: 'x' },
          { status: 403 },
        ),
      ),
      ...createHandlers({ me: demoMe('analista_cliente') }),
    );
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/trocar-senha'));
    expect(await screen.findByRole('heading', { name: 'Troque a senha temporária' })).toBeInTheDocument();
  });
});
