import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Me, Role } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_TENANTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';
import { NARROW_QUERY } from '@/lib/use-media-query';
import { MENU_ICONS_QUERY } from './menu-collapsed';

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
    const { router } = renderApp('/cadastros/clientes', demoMe('leitura'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/sem-permissao'));
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
  });
});

describe('menu e cabeçalho por papel', () => {
  // Contas cloud, Agentes, Lista de proteção e Exceções: leitura liberada para todos (matriz de permissões).
  // "Fontes" (26/11/2026) junta Contas cloud e Agentes numa entrada só.
  const shared = ['Fontes', 'Lista de proteção', 'Exceções'];
  const operation = ['Detecções', 'Postura cloud', 'Ativos e identidades'];
  const expectedMenu: Record<Role, string[]> = {
    // R-09: Fontes, Regras e Conta no lugar de "Administração"; os clientes, no grupo da Verax.
    admin_verax: [
      ...operation,
      ...shared,
      'Usuários',
      'Plano e uso',
      'Escalonamento',
      'Auditoria',
      'Clientes',
      'Alertas sem dono',
    ],
    admin_cliente: [...operation, ...shared, 'Usuários', 'Plano e uso', 'Escalonamento', 'Auditoria'],
    analista_cliente: [...operation, ...shared],
    leitura: [...operation, ...shared],
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
    expect(screen.getByText('Analista')).toBeInTheDocument();
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

describe('menu no celular', () => {
  const original = window.matchMedia.bind(window);
  const narrow = () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === NARROW_QUERY,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  };
  afterEach(() => {
    window.matchMedia = original;
  });

  it('E-02: uma barra só (Menu, a marca e a conta); o tema e "Sair" ficam no menu', async () => {
    narrow();
    renderApp('/', demoMe('analista_cliente'));
    const open = await screen.findByRole('button', { name: 'Menu' });
    expect(open.parentElement).toContainElement(screen.getByRole('link', { name: 'Minha conta' }));
    // Sem o seletor de cliente, a segunda barra (a do cabeçalho) nem aparece.
    expect(document.querySelector('header.border-b')).toBeNull();
    const drawer = document.getElementById('menu-principal')!;
    expect(within(drawer).getByRole('radiogroup', { name: 'Tema' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Sair' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Sair' })).toHaveLength(1);
  });

  it('abre como gaveta, fecha com Esc e ao navegar', async () => {
    narrow();
    const { router } = renderApp('/', demoMe('analista_cliente'));
    const open = await screen.findByRole('button', { name: 'Menu' });
    const drawer = document.getElementById('menu-principal');
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(drawer).toHaveAttribute('data-open', 'false');

    await userEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(drawer).toHaveAttribute('data-open', 'true');
    await userEvent.keyboard('{Escape}');
    expect(drawer).toHaveAttribute('data-open', 'false');

    await userEvent.click(open);
    await userEvent.click(within(await menu()).getByRole('link', { name: 'Postura cloud' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/postura'));
    expect(drawer).toHaveAttribute('data-open', 'false');

    // Voltar pelo navegador não reabre a gaveta da página anterior.
    await router.navigate(-1);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(document.getElementById('menu-principal')).toHaveAttribute('data-open', 'false');
  });
});

describe('"Fontes": Contas cloud e Agentes numa entrada só', () => {
  it('a entrada leva às contas, fica marcada nas duas abas, e cada aba mantém o endereço de antes', async () => {
    const { router } = renderApp('/cadastros/agentes', demoMe('analista_cliente'));
    const fontes = within(await menu()).getByRole('link', { name: 'Fontes' });
    expect(fontes).toHaveAttribute('href', '/cadastros/contas');
    expect(within(await menu()).queryByRole('link', { name: 'Agentes' })).toBeNull();
    const tabs = await screen.findByRole('navigation', { name: 'Fontes' });
    expect(within(tabs).getByRole('link', { name: 'Agentes' })).toHaveAttribute('aria-current', 'page');
    expect(fontes.className).toContain('font-semibold');
    await userEvent.click(within(tabs).getByRole('link', { name: 'Contas cloud' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/cadastros/contas'));
    expect(within(tabs).getByRole('link', { name: 'Contas cloud' })).toHaveAttribute('aria-current', 'page');
  });

  it('quem vê só uma das telas vê só ela, sem abas; quem não vê nenhuma não tem "Fontes"', async () => {
    const me = demoMe('analista_cliente');
    const onlyAgents = { ...me, permissions: me.permissions.filter((p) => p !== 'cloud_accounts:read') };
    renderApp('/cadastros/agentes', onlyAgents);
    expect(within(await menu()).getByRole('link', { name: 'Fontes' })).toHaveAttribute(
      'href',
      '/cadastros/agentes',
    );
    const tabs = await screen.findByRole('navigation', { name: 'Fontes' });
    expect(within(tabs).queryByRole('link')).toBeNull();
    cleanup();
    const neither = {
      ...me,
      permissions: me.permissions.filter((p) => p !== 'cloud_accounts:read' && p !== 'agents:read'),
    };
    renderApp('/', neither);
    expect(within(await menu()).queryByRole('link', { name: 'Fontes' })).toBeNull();
  });
});

describe('"Pular para o conteúdo" (R-12)', () => {
  it('é o primeiro item do teclado e leva o foco ao conteúdo, sem mudar o endereço', async () => {
    const { router } = renderApp('/postura', demoMe('analista_cliente'));
    await menu();
    await userEvent.tab();
    const skip = screen.getByRole('link', { name: 'Pular para o conteúdo' });
    expect(skip).toHaveFocus();
    const before = `${router.state.location.pathname}${router.state.location.search}`;
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(before);
    expect(router.state.location.hash).toBe('');
  });
});

describe('menu recolhido (computador)', () => {
  afterEach(() => window.localStorage.removeItem('verax:menu'));

  it('recolhe aos ícones sem tirar o nome do link e lembra a escolha', async () => {
    renderApp('/', demoMe('analista_cliente'));
    const collapse = await screen.findByRole('button', { name: 'Recolher menu' });
    const drawer = document.getElementById('menu-principal');
    expect(drawer).toHaveAttribute('data-collapsed', 'false');

    await userEvent.click(collapse);
    expect(drawer).toHaveAttribute('data-collapsed', 'true');
    expect(window.localStorage.getItem('verax:menu')).toBe('recolhido');
    // Recolhido, o nome continua no link (para o leitor de tela) e vira dica ao passar o mouse.
    const link = within(await menu()).getByRole('link', { name: 'Postura cloud' });
    expect(link).toHaveAttribute('title', 'Postura cloud');

    await userEvent.click(screen.getByRole('button', { name: 'Expandir menu' }));
    expect(drawer).toHaveAttribute('data-collapsed', 'false');
    expect(window.localStorage.getItem('verax:menu')).toBe('aberto');
  });

  it('de 768 a 1023 px começa nos ícones (R-07); a escolha guardada vale sobre o padrão', async () => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === MENU_ICONS_QUERY,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      const first = renderApp('/', demoMe('analista_cliente'));
      expect(await screen.findByRole('button', { name: 'Expandir menu' })).toBeInTheDocument();
      cleanup();
      first.router.dispose();
      window.localStorage.setItem('verax:menu', 'aberto');
      renderApp('/', demoMe('analista_cliente'));
      expect(await screen.findByRole('button', { name: 'Recolher menu' })).toBeInTheDocument();
    } finally {
      window.matchMedia = original;
    }
  });

  it('abre recolhido quando foi a última escolha', async () => {
    window.localStorage.setItem('verax:menu', 'recolhido');
    renderApp('/', demoMe('analista_cliente'));
    expect(await screen.findByRole('button', { name: 'Expandir menu' })).toBeInTheDocument();
  });

  it('a etiqueta "Novo" aparece fora do nome do link', async () => {
    renderApp('/', demoMe('analista_cliente'));
    const link = within(await menu()).getByRole('link', { name: 'Detecções' });
    expect(link.parentElement).toHaveTextContent('Novo');
  });
});
