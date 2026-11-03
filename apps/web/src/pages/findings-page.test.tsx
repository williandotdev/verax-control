import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFindingFilters } from '@/features/findings/filters';
import { api } from '@/lib/api';
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

function renderAt(path: string, state: MockState = { me: demoMe('analista_cliente') }) {
  server.use(...createHandlers(state));
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

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.search).toBe('?severidade=critical');
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

describe('filtros da URL', () => {
  it('valor desconhecido é ignorado, nunca enviado à API', () => {
    expect(
      readFindingFilters(new URLSearchParams('severidade=altissima&status=new&conta=123&periodo=7d')),
    ).toEqual({ severity: undefined, status: 'new', accountId: undefined, period: '7d' });
  });
});
