import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
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

function renderAt(path: string, state: MockState = { me: demoMe('admin_cliente') }) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const rows = async () =>
  within(await screen.findByRole('table', { name: 'Trilha de auditoria' }))
    .getAllByRole('row')
    .slice(1);

describe('Auditoria', () => {
  it('o admin do cliente vê a trilha do cliente, com a equipe da Verax marcada e sem o IP dela', async () => {
    renderAt('/auditoria');
    expect(await screen.findByRole('heading', { level: 1, name: 'Auditoria' })).toBeInTheDocument();
    const lines = await rows();
    expect(lines[0]).toHaveTextContent('Ana Souza');
    expect(lines[0]).toHaveTextContent('Mudou o status de achado');
    const verax = lines.find((line) => line.textContent?.includes('Equipe Verax entrou no cliente'));
    expect(verax).toHaveTextContent('Verax');
    expect(verax).not.toHaveTextContent('198.51.100.7');
    // Só a trilha do próprio cliente: nada da Beta nem da Verax.
    expect(screen.queryByText('Rafael Costa')).not.toBeInTheDocument();
    expect(screen.queryByText('Sem identificação')).not.toBeInTheDocument();
  });

  it('abre o registro com o estado anterior e o novo, e o link leva à mesma visão', async () => {
    const router = renderAt('/auditoria');
    await userEvent.click(await screen.findByRole('button', { name: /Desativou usuário/ }));
    await waitFor(() => expect(router.state.location.search).toMatch(/registro=/));
    const dialog = await screen.findByRole('dialog', { name: 'Desativou usuário' });
    expect(within(dialog).getByText('Antes')).toBeInTheDocument();
    expect(within(dialog).getByText(/"status": "disabled"/)).toBeInTheDocument();
    expect(
      within(dialog).getByText('Os registros de auditoria não podem ser alterados nem apagados.', {
        exact: false,
      }),
    ).toBeInTheDocument();
  });

  it('o registro da equipe da Verax avisa que o IP e o navegador não aparecem para o cliente', async () => {
    renderAt('/auditoria');
    await userEvent.click(await screen.findByRole('button', { name: /Equipe Verax entrou no cliente/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Equipe Verax entrou no cliente' });
    expect(within(dialog).getByText(/não aparecem para o cliente/)).toBeInTheDocument();
    expect(within(dialog).queryByText('198.51.100.7')).not.toBeInTheDocument();
  });

  it('filtros vão para a URL: área, resultado e as ações de uma pessoa', async () => {
    const router = renderAt('/auditoria');
    await rows();
    await userEvent.selectOptions(screen.getByLabelText('Resultado'), 'denied');
    await waitFor(() => expect(router.state.location.search).toBe('?resultado=denied'));
    await waitFor(async () => expect(await rows()).toHaveLength(1));
    expect((await rows())[0]).toHaveTextContent('POST /v1/cloud-accounts');

    await userEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await userEvent.click((await screen.findAllByRole('button', { name: /Marina Alves/ }))[0] as HTMLElement);
    await waitFor(() => expect(router.state.location.search).toBe('?pessoa=demo-marina.alves'));
    expect(await screen.findByText('Marina Alves', { selector: 'strong' })).toBeInTheDocument();
    await waitFor(async () =>
      expect((await rows()).every((line) => line.textContent?.includes('Marina Alves'))).toBe(true),
    );
  });

  it('o período segue o histórico do plano: 12 meses no Profissional, até 90 dias no Essencial', async () => {
    const router = renderAt('/auditoria');
    await rows();
    await screen.findByRole('option', { name: 'Últimos 12 meses' });
    await userEvent.selectOptions(screen.getByLabelText('Período'), '12m');
    await waitFor(() => expect(router.state.location.search).toBe('?periodo=12m'));
    expect(await rows()).not.toHaveLength(0);
  });

  it('Essencial: sem 12 meses, e o 12m da URL fica de fora', async () => {
    renderAt('/auditoria?periodo=12m', { me: demoMe('admin_cliente'), historyDays: 90 });
    await rows();
    await screen.findByRole('option', { name: 'Últimos 90 dias' });
    expect(screen.queryByRole('option', { name: 'Últimos 12 meses' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Período')).toHaveValue('');
  });

  it('o admin_verax sem cliente escolhido vê a trilha da Verax, com tentativas de login anônimas', async () => {
    renderAt('/auditoria', { me: demoMe('admin_verax') });
    expect(await screen.findByText(/Trilha da Verax/)).toBeInTheDocument();
    const lines = await rows();
    expect(lines[0]).toHaveTextContent('Sem identificação');
    expect(lines[0]).toHaveTextContent('192.0.2.44');
    // O que a Verax faz num cliente, inclusive o cadastro dele, fica na trilha do cliente.
    expect(screen.queryByText('Cadastrou cliente')).not.toBeInTheDocument();
    expect(screen.getAllByText('Convidou usuário').length).toBeGreaterThan(0);
  });

  it('o admin_verax com cliente escolhido vê a trilha dele, com o IP da equipe da Verax', async () => {
    const alfa = DEMO_TENANTS[0]?.id ?? null;
    renderAt('/auditoria', { me: demoMe('admin_verax', { activeTenantId: alfa, scopeTenantId: alfa }) });
    const verax = (await rows()).find((line) => line.textContent?.includes('Equipe Verax entrou no cliente'));
    expect(verax).toHaveTextContent('198.51.100.7');
  });

  it('pessoa vazia na URL conta como sem filtro', async () => {
    renderAt('/auditoria?pessoa=');
    expect(await rows()).not.toHaveLength(0);
    expect(screen.queryByText(/Só as ações de/)).not.toBeInTheDocument();
  });

  it('analista não vê a tela', async () => {
    renderAt('/auditoria', { me: demoMe('analista_cliente') });
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
  });
});
