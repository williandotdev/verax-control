import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function renderAt(path: string, state: MockState = { me: demoMe('leitura') }) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const rowsOf = async (caption: string) =>
  within(await screen.findByRole('table', { name: caption }))
    .getAllByRole('row')
    .slice(1);

describe('Relatórios', () => {
  it('abre no resumo do período, com os indicadores e as tabelas', async () => {
    renderAt('/relatorios');
    expect(await screen.findByRole('heading', { level: 1, name: 'Relatórios' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Resumo do período' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Achados no período')).toBeInTheDocument();
    expect(await rowsOf('Achados por severidade')).toHaveLength(4);
    expect(await rowsOf('Achados por dia')).toHaveLength(31);
  });

  it('a aba MITRE ATT&CK mostra as 14 táticas em português, com o id', async () => {
    const router = renderAt('/relatorios');
    await userEvent.click(await screen.findByRole('tab', { name: 'MITRE ATT&CK' }));
    await waitFor(() => expect(router.state.location.search).toBe('?aba=mitre'));
    const rows = await rowsOf('Táticas e técnicas do MITRE ATT&CK');
    expect(rows).toHaveLength(14);
    expect(rows[6]).toHaveTextContent('TA0005 · Evasão de defesas');
  });

  it('o período vai para a URL e muda a janela do relatório', async () => {
    const router = renderAt('/relatorios?aba=deteccoes');
    expect(await rowsOf('Regras que mais dispararam')).not.toHaveLength(0);
    await userEvent.selectOptions(screen.getByLabelText('Período'), '7d');
    await waitFor(() => expect(router.state.location.search).toBe('?aba=deteccoes&periodo=7d'));
  });

  it('exporta a tabela em CSV, no navegador', async () => {
    const created = vi.fn((_blob: Blob) => 'blob:relatorio');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAt('/relatorios?aba=incidentes');
    await rowsOf('Por severidade');
    await userEvent.click(screen.getByRole('button', { name: 'Exportar Por severidade em CSV' }));
    expect(click).toHaveBeenCalledOnce();
    const blob = created.mock.calls[0]?.[0] as Blob;
    expect(await blob.text()).toContain('"Severidade","Abertos","Resolvidos","Tempo médio até resolver"');
  });

  it('admin_verax sem cliente escolhido é orientado a escolher um', async () => {
    renderAt('/relatorios', { me: demoMe('admin_verax', { activeTenantId: null, scopeTenantId: null }) });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
  });
});
