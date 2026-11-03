import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, demoMe } from '@/mocks/fixtures';
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
      within(accounts[0] as HTMLElement).getByRole('link', { name: /Cadastrar a conta/ }),
    ).toHaveAttribute('href', '/cadastros/contas');
    const beta = accounts.find((row) => row.textContent?.includes(DEMO_ACCOUNTS.beta));
    expect(beta).toHaveTextContent('Cadastrada em Cliente Demo Beta');
  });

  it('ver os alertas de uma conta filtra a lista, pela URL', async () => {
    const router = renderAt('/alertas-sem-dono');
    await rowsOf('Alertas sem dono');
    await userEvent.click(
      await screen.findByRole('button', { name: `Ver os alertas da conta ${DEMO_ACCOUNTS.beta}` }),
    );
    await waitFor(() => expect(router.state.location.search).toBe(`?conta=${DEMO_ACCOUNTS.beta}`));
    await waitFor(async () => expect(await rowsOf('Alertas sem dono')).toHaveLength(2));
    for (const row of await rowsOf('Alertas sem dono'))
      expect(row).toHaveTextContent('Conta e origem não batem');
    await userEvent.click(screen.getByRole('button', { name: 'Ver de todas' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('o filtro de motivo explica o que costuma resolver', async () => {
    const router = renderAt('/alertas-sem-dono');
    await rowsOf('Alertas sem dono');
    await userEvent.selectOptions(screen.getByLabelText('Motivo'), 'unknown_source');
    await waitFor(() => expect(router.state.location.search).toBe('?motivo=unknown_source'));
    expect(await screen.findByText(/O bucket de log de onde o alerta veio/)).toBeInTheDocument();
    await waitFor(async () => expect(await rowsOf('Alertas sem dono')).toHaveLength(1));
  });

  it.each(['admin_cliente', 'analista_cliente', 'leitura'] as const)('%s não vê a fila', async (role) => {
    renderAt('/alertas-sem-dono', { me: demoMe(role) });
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
  });
});
