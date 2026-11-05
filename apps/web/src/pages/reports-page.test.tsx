import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { reportWindow, summaryReport } from '@verax/shared';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
    // Os números do gráfico por dia ficam atrás de "Ver tabela", do dia mais recente ao mais antigo.
    await userEvent.click(await screen.findByText('Ver tabela'));
    const daily = await rowsOf('Achados por dia');
    expect(daily).toHaveLength(31);
    expect(daily[0]).toHaveTextContent(/^\d{2}\/\d{2}\/\d{4}/);
  });

  it('achados por dia em linhas (uma por severidade) e por status em pizza, com a legenda dos números', async () => {
    renderAt('/relatorios');
    const daily = await screen.findByRole('img', {
      name: /^Achados por dia, de \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}: \d+ achados? no total;.*Use as setas para ver cada dia\.$/,
    });
    expect(daily.querySelectorAll('path[data-series]')).toHaveLength(4);
    const legend = within(daily.closest('figure') as HTMLElement).getAllByRole('listitem');
    expect(legend.map((item) => item.textContent)).toEqual(['Crítico', 'Alto', 'Médio', 'Baixo']);

    expect(
      screen.getByRole('img', { name: /^Achados por status: Novo, \d+ achados?.*Resolvido, \d+ achados?/ }),
    ).toBeInTheDocument();
    const statuses = await rowsOf('Achados por status');
    expect(statuses.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Novo',
      'Em análise',
      'Legítimo',
      'Resolvido',
    ]);
    expect(statuses[0]).toHaveTextContent(/^Novo\d+\d+(,\d)?%$/);
    // A tabela antiga de status saiu: a legenda é a tabela.
    expect(screen.getAllByRole('table', { name: 'Achados por status' })).toHaveLength(1);
    // Os dois sobre a superfície dos cartões, contra a qual as cores foram validadas.
    expect(document.querySelectorAll('figure.bg-surface [role="img"]')).toHaveLength(2);
  });

  it('os gráficos exportam o mesmo CSV das tabelas de antes', async () => {
    const created = vi.fn((_blob: Blob) => 'blob:relatorio');
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAt('/relatorios');
    await screen.findByRole('img', { name: /^Achados por dia/ });
    await userEvent.click(screen.getByRole('button', { name: 'Exportar Achados por dia em CSV' }));
    await userEvent.click(screen.getByRole('button', { name: 'Exportar Achados por status em CSV' }));
    const [daily, status] = created.mock.calls.map((call) => call[0]);
    const dailyCsv = (await daily?.text()) ?? '';
    expect(dailyCsv).toContain('"Dia";"Crítico";"Alto";"Médio";"Baixo"');
    // Do dia mais recente ao mais antigo, com a data crua.
    const dates = [...dailyCsv.matchAll(/^"(\d{4}-\d{2}-\d{2})"/gm)].map((match) => match[1] ?? '');
    expect(dates).toHaveLength(31);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(await status?.text()).toMatch(
      /"Status";"Achados"\r\n"Novo";"\d+"\r\n"Em análise";"\d+"\r\n"Legítimo";"\d+"\r\n"Resolvido";"\d+"\r\n$/,
    );
    expect(click.mock.contexts.map((context) => (context as HTMLAnchorElement).download)).toEqual([
      'verax-achados-por-dia-30d.csv',
      'verax-achados-por-status-30d.csv',
    ]);
  });

  it('período sem achados: os dois gráficos dão o aviso de vazio no lugar do desenho', async () => {
    renderAt('/relatorios');
    server.use(
      http.get(`${API_URL}/v1/reports/summary`, () =>
        HttpResponse.json(summaryReport([], [], reportWindow('30d', new Date()))),
      ),
    );
    expect(await screen.findAllByText('Nenhum achado no período.')).toHaveLength(2);
    expect(screen.queryByRole('img', { name: /^Achados por (dia|status)/ })).not.toBeInTheDocument();
    // O CSV continua com as linhas zeradas, como antes.
    expect(screen.getByRole('button', { name: 'Exportar Achados por dia em CSV' })).toBeEnabled();
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

  it('12 meses no Profissional (a demonstração): o resumo tem os 366 dias que o período toca', async () => {
    const router = renderAt('/relatorios');
    await rowsOf('Achados por severidade');
    await screen.findByRole('option', { name: 'Últimos 12 meses' });
    await userEvent.selectOptions(screen.getByLabelText('Período'), '12m');
    await waitFor(() => expect(router.state.location.search).toBe('?periodo=12m'));
    await waitFor(() =>
      expect(screen.queryByText(/Atualizando para o período escolhido/)).not.toBeInTheDocument(),
    );
    await userEvent.click(await screen.findByText('Ver tabela'));
    expect(await rowsOf('Achados por dia')).toHaveLength(366);
  });

  it('Essencial (90 dias): sem 12 meses; o 12m da URL vira o padrão de 30 dias', async () => {
    renderAt('/relatorios?periodo=12m', { me: demoMe('leitura'), historyDays: 90 });
    await rowsOf('Achados por severidade');
    await screen.findByRole('option', { name: 'Últimos 90 dias' });
    const select = screen.getByLabelText('Período');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Últimos 7 dias', 'Últimos 30 dias', 'Últimos 90 dias']);
    expect(select).toHaveValue('30d');
    await userEvent.click(await screen.findByText('Ver tabela'));
    expect(await rowsOf('Achados por dia')).toHaveLength(31);
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
    expect(await blob.text()).toContain('"Severidade";"Abertos";"Resolvidos";"Tempo médio até resolver"');
    expect(click.mock.contexts[0]).toHaveProperty('download', 'verax-incidentes-por-severidade-30d.csv');
  });

  it('ao trocar de período, os números anteriores ficam marcados como desatualizados e não exportam', async () => {
    renderAt('/relatorios');
    await rowsOf('Achados por severidade');
    // O período novo não responde: a tela segue com o anterior, que não pode sair com o nome do novo.
    server.use(
      http.get(`${API_URL}/v1/reports/summary`, async ({ request }) => {
        if (new URL(request.url).searchParams.get('period') === '90d') await delay('infinite');
      }),
    );
    await screen.findByRole('option', { name: 'Últimos 90 dias' });
    await userEvent.selectOptions(screen.getByLabelText('Período'), '90d');
    expect(await screen.findByText(/Atualizando para o período escolhido/)).toBeInTheDocument();
    expect(await rowsOf('Achados por severidade')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Exportar Achados por severidade em CSV' })).toBeDisabled();
  });

  it('ao trocar de cliente, o relatório do anterior sai da tela na hora', async () => {
    const [alfa, beta] = DEMO_TENANTS.map((tenant) => tenant.id);
    renderAt('/relatorios?aba=entidades', {
      me: demoMe('admin_verax', { activeTenantId: alfa ?? null, scopeTenantId: alfa ?? null }),
    });
    expect(await rowsOf('Usuários e identidades')).not.toHaveLength(0);
    server.use(
      http.get(`${API_URL}/v1/reports/:kind`, async () => {
        await delay('infinite');
      }),
    );
    const select = await screen.findByLabelText('Cliente');
    await waitFor(() => expect(select).toBeEnabled());
    await userEvent.selectOptions(select, beta ?? '');
    expect(await screen.findByText(/Carregando as entidades/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Usuários e identidades' })).not.toBeInTheDocument();
  });

  it.each([
    ['entidades', 'IPs de origem'],
    ['cobertura', 'Contas monitoradas e o que chegou de cada uma'],
    ['excecoes', 'Exceções e quantos alertas cada uma silenciou'],
  ])('a aba %s mostra a tabela do relatório', async (tab, caption) => {
    renderAt(`/relatorios?aba=${tab}`);
    expect(await rowsOf(caption)).not.toHaveLength(0);
  });

  it('admin_verax sem cliente escolhido é orientado a escolher um', async () => {
    renderAt('/relatorios', { me: demoMe('admin_verax', { activeTenantId: null, scopeTenantId: null }) });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
  });
});
