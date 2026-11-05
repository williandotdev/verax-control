import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, type RequestHandler } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFindingFilters } from '@/features/findings/filters';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

function renderAt(
  path: string,
  state: MockState = { me: demoMe('analista_cliente') },
  /** Handlers que passam na frente dos da demonstração. */
  overrides: RequestHandler[] = [],
) {
  server.use(...overrides, ...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const table = () => screen.findByRole('table', { name: 'Achados do cliente' });
const rows = async () =>
  within(await table())
    .getAllByRole('row')
    .slice(1);

describe('Achados', () => {
  it('lista com os filtros da URL: o atalho da Torre abre só os novos', async () => {
    renderAt('/achados?status=new');
    const items = await rows();
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) expect(row).toHaveTextContent('Novo');
    expect(screen.getByLabelText('Status')).toHaveValue('new');
  });

  it('trocar um filtro atualiza a URL, volta para a primeira página e refaz a lista', async () => {
    const router = renderAt('/achados?pagina=2');
    await table();
    await userEvent.selectOptions(screen.getByLabelText('Severidade'), 'critical');
    await waitFor(() => expect(router.state.location.search).toBe('?severidade=critical'));
    await waitFor(async () => expect(await rows()).toHaveLength(1));
    expect((await rows())[0]).toHaveTextContent('Tentativa de desligar a trilha do CloudTrail');

    await userEvent.selectOptions(screen.getByLabelText('Conta'), DEMO_ACCOUNTS.alfaHomologacao);
    await waitFor(() => expect(screen.getByText('Nenhum achado com esses filtros')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('o detalhe abre no painel, com o evento bruto, e fecha com Esc', async () => {
    const router = renderAt('/achados?severidade=critical');
    await userEvent.click(await screen.findByRole('button', { name: /Tentativa de desligar a trilha/ }));
    const panel = await screen.findByRole('dialog', { name: 'Tentativa de desligar a trilha do CloudTrail' });
    expect(router.state.location.search).toMatch(/achado=/);
    expect(within(panel).getByText('StopLogging')).toBeInTheDocument();
    expect(within(panel).getByText('DEMO3QX7Z2KD9WLB5N8R')).toBeInTheDocument();
    expect(within(panel).getByText('T1562.008')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Ver incidente' })).toHaveAttribute(
      'href',
      '/incidentes/018f2c1e-0000-7000-8000-0000000a0001',
    );
    expect(within(panel).getByText(/"eventName": "StopLogging"/)).toBeInTheDocument();
    // A retenção do evento bruto (o índice do Wazuh) e a dos dados do achado (o histórico do plano).
    expect(
      await within(panel).findByText(
        'Evento bruto do log disponível por 30 dias. Os dados do achado acima ficam pelo histórico do plano, de 365 dias.',
      ),
    ).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.search).toBe('?severidade=critical');
  });

  it('achado de um agente do Wazuh: a origem é o agente, e o recurso, a instância', async () => {
    renderAt('/achados?severidade=medium');
    const button = await screen.findByRole('button', { name: /Arquivo de sistema alterado/ });
    const row = button.closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('agente 001');
    expect(row).toHaveTextContent('Agente (instância)');
    await userEvent.click(button);
    const panel = await screen.findByRole('dialog', { name: 'Arquivo de sistema alterado: /etc/sudoers' });
    expect(within(panel).getByText('Agente (instância) · agente 001')).toBeInTheDocument();
    expect(within(panel).getByText('host:api-producao-01')).toBeInTheDocument();
    expect(within(panel).getByText('Regra (agente do Wazuh)')).toBeInTheDocument();
    expect(within(panel).getByText(/"path": "\/etc\/sudoers"/)).toBeInTheDocument();
  });

  it('mudar o status com comentário e, ao marcar legítimo, criar a exceção', async () => {
    renderAt('/achados?severidade=critical');
    await userEvent.click(await screen.findByRole('button', { name: /Tentativa de desligar a trilha/ }));
    const panel = await screen.findByRole('dialog');

    await userEvent.type(
      within(panel).getByLabelText(/Comentário \(opcional\)/),
      'Manutenção da trilha agendada.',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Marcar como legítimo' }));

    const offer = await within(panel).findByText('Criar exceção para alertas iguais?');
    expect(await within(panel).findByText('Manutenção da trilha agendada.')).toBeInTheDocument();
    expect(await within(panel).findByText('Comentários (2)')).toBeInTheDocument();
    const form = offer.closest('form') as HTMLFormElement;
    await userEvent.click(within(form).getByLabelText(/IP de origem/));
    await userEvent.type(
      within(form).getByLabelText('Motivo (obrigatório)'),
      'Janela de manutenção do fornecedor.',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Criar exceção' }));
    expect(await within(panel).findByRole('status')).toHaveTextContent(
      'Exceção criada: alertas da regra 80255 com ip de origem 198.51.100.23',
    );
    // A lista acompanha o novo status (com o painel fechado; aberto, ele é modal e esconde a tabela).
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => expect((await rows())[0]).toHaveTextContent('Legítimo'));
  });

  it('comentário sem mudar o status', async () => {
    renderAt('/achados?severidade=critical');
    await userEvent.click(await screen.findByRole('button', { name: /Tentativa de desligar a trilha/ }));
    const panel = await screen.findByRole('dialog');
    await userEvent.type(
      within(panel).getByLabelText('Novo comentário'),
      'Aguardando retorno do fornecedor.',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Comentar' }));
    expect(await within(panel).findByText('Aguardando retorno do fornecedor.')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Novo comentário')).toHaveValue('');
  });

  it('a triagem aparece na Torre: um achado a menos sem triagem', async () => {
    const router = renderAt('/');
    expect(await screen.findByText('5 achados altos ou críticos sem triagem')).toBeInTheDocument();
    await router.navigate('/achados?status=new&severidade=high');
    await userEvent.click(await screen.findByRole('button', { name: /Login do usuário root no console/ }));
    const panel = await screen.findByRole('dialog');
    await userEvent.click(within(panel).getByRole('button', { name: 'Colocar em análise' }));
    await within(panel).findByText('Em análise');
    await userEvent.keyboard('{Escape}');
    await router.navigate('/');
    expect(await screen.findByText('4 achados altos ou críticos sem triagem')).toBeInTheDocument();
  });

  it('papel de leitura vê o detalhe, mas não muda status nem comenta', async () => {
    renderAt('/achados?severidade=critical', { me: demoMe('leitura') });
    await userEvent.click(await screen.findByRole('button', { name: /Tentativa de desligar a trilha/ }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Comentários (1)')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Marcar como/ })).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText('Novo comentário')).not.toBeInTheDocument();
  });

  it('admin_verax sem cliente escolhido é orientado a escolher um', async () => {
    renderAt('/achados', { me: demoMe('admin_verax') });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
  });
});

describe('período pelo histórico do plano', () => {
  /** O parâmetro `period` de cada lista de achados pedida à API. */
  function watchPeriods(): (string | null)[] {
    const periods: (string | null)[] = [];
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/v1/findings')) periods.push(url.searchParams.get('period'));
    });
    return periods;
  }
  afterEach(() => server.events.removeAllListeners());

  const periodOptions = () =>
    within(screen.getByLabelText('Período'))
      .getAllByRole('option')
      .map((option) => option.textContent);

  it('Profissional (a demonstração): o analista tem 12 meses, e a lista filtra por ele', async () => {
    const periods = watchPeriods();
    const router = renderAt('/achados');
    await table();
    await screen.findByRole('option', { name: 'Últimos 12 meses' });
    expect(periodOptions()).toEqual([
      'Todo o histórico',
      'Últimas 24 horas',
      'Últimos 7 dias',
      'Últimos 30 dias',
      'Últimos 90 dias',
      'Últimos 12 meses',
    ]);
    await userEvent.selectOptions(screen.getByLabelText('Período'), '12m');
    await waitFor(() => expect(router.state.location.search).toBe('?periodo=12m'));
    await waitFor(() => expect(periods).toContain('12m'));
    expect(screen.getByLabelText('Período')).toHaveValue('12m');
  });

  it('Essencial (90 dias): sem 12 meses para a leitura; o 12m da URL é ignorado e nunca vai para a API', async () => {
    const periods = watchPeriods();
    renderAt('/achados?periodo=12m', { me: demoMe('leitura'), historyDays: 90 });
    expect(await rows()).not.toHaveLength(0);
    await waitFor(() => expect(periodOptions()).toContain('Últimos 90 dias'));
    expect(periodOptions()).not.toContain('Últimos 12 meses');
    expect(screen.getByLabelText('Período')).toHaveValue('');
    expect(periods).toEqual([null]);
  });

  it('enquanto o plano não chega, só até 30 dias (o que todo plano tem)', async () => {
    renderAt('/achados', undefined, [
      http.get(`${API_URL}/v1/plan/history`, async () => {
        await delay('infinite');
      }),
    ]);
    await table();
    expect(periodOptions()).toEqual([
      'Todo o histórico',
      'Últimas 24 horas',
      'Últimos 7 dias',
      'Últimos 30 dias',
    ]);
  });
});

describe('filtros da URL', () => {
  it('valor desconhecido é ignorado, nunca enviado à API', () => {
    expect(
      readFindingFilters(new URLSearchParams('severidade=altissima&status=new&conta=123&periodo=7d')),
    ).toEqual({ severity: undefined, status: 'new', accountId: undefined, period: '7d' });
  });
});
