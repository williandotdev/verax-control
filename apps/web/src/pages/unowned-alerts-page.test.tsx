import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, DEMO_TENANTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { DEMO_UNKNOWN_ACCOUNTS } from '@/mocks/unowned-handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

function renderAt(path: string, state: MockState = { me: demoMe('admin_verax') }) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const rowsOf = async (name: string) =>
  within(await screen.findByRole('table', { name }))
    .getAllByRole('row')
    .slice(1);

describe('Alertas sem dono', () => {
  it('resume as contas que mais aparecem, com onde cada uma está cadastrada', async () => {
    renderAt('/alertas-sem-dono');
    expect(await screen.findByRole('heading', { level: 1, name: 'Alertas sem dono' })).toBeInTheDocument();
    const accounts = await rowsOf('Contas citadas nos alertas sem dono');
    expect(accounts[0]).toHaveTextContent(DEMO_UNKNOWN_ACCOUNTS.forgotten);
    expect(accounts[0]).toHaveTextContent('Não cadastrada');
    expect(
      within(accounts[0] as HTMLElement).getByRole('link', { name: /^Cadastrar conta/ }),
    ).toHaveAttribute('href', '/cadastros/contas');
    const beta = accounts.find((row) => row.textContent?.includes(DEMO_ACCOUNTS.beta));
    expect(beta).toHaveTextContent('Cadastrada em Cliente Demo Beta');
  });

  it('ver os alertas de uma conta filtra a lista, pela URL', async () => {
    const router = renderAt('/alertas-sem-dono');
    await rowsOf('Alertas sem dono');
    await userEvent.click(
      await screen.findByRole('button', { name: `Ver alertas da conta ${DEMO_ACCOUNTS.beta}` }),
    );
    // A lista abre no mesmo período do resumo (30 dias), e o foco vai para ela.
    await waitFor(() =>
      expect(router.state.location.search).toBe(`?conta=${DEMO_ACCOUNTS.beta}&periodo=30d`),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Alertas' })).toHaveFocus();
    await waitFor(async () => expect(await rowsOf('Alertas sem dono')).toHaveLength(2));
    for (const row of await rowsOf('Alertas sem dono'))
      expect(row).toHaveTextContent('Conta e origem não batem');
    await userEvent.click(screen.getByRole('button', { name: 'Ver de todas' }));
    await waitFor(() => expect(router.state.location.search).toBe('?periodo=30d'));
  });

  it('o filtro de motivo explica o que costuma resolver', async () => {
    const router = renderAt('/alertas-sem-dono');
    await rowsOf('Alertas sem dono');
    await userEvent.selectOptions(screen.getByLabelText('Motivo'), 'unknown_source');
    await waitFor(() => expect(router.state.location.search).toBe('?motivo=unknown_source'));
    expect(await screen.findByText(/O bucket de log de onde o alerta veio/)).toBeInTheDocument();
    await waitFor(async () => expect(await rowsOf('Alertas sem dono')).toHaveLength(1));
  });

  it('conta vazia na URL conta como sem filtro', async () => {
    renderAt('/alertas-sem-dono?conta=');
    expect(await rowsOf('Alertas sem dono')).not.toHaveLength(0);
    expect(screen.queryByText(/Só os alertas que citam/)).not.toBeInTheDocument();
  });

  it('a decisão da Torre leva à fila nos mesmos 7 dias que ela conta', async () => {
    const alfa = DEMO_TENANTS[0]?.id ?? null;
    const router = renderAt('/', {
      me: demoMe('admin_verax', { activeTenantId: alfa, scopeTenantId: alfa }),
    });
    const title = await screen.findByText(/alertas? de conta não cadastrada/);
    const count = Number.parseInt(title.textContent ?? '', 10);
    expect(count).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Ver a fila' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/alertas-sem-dono'));
    expect(router.state.location.search).toBe('?periodo=7d');
    await rowsOf('Alertas sem dono');
    // O total da lista ("1–N de T") é o mesmo número do cartão da Torre.
    expect(
      await screen.findByText((content) => content.endsWith(` de ${count}`) && content.includes('–')),
    ).toBeInTheDocument();
  });

  it.each(['admin_cliente', 'analista_cliente', 'leitura'] as const)('%s não vê a fila', async (role) => {
    renderAt('/alertas-sem-dono', { me: demoMe(role) });
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
  });
});
