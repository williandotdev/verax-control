import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_EXPIRED_LINK_TOKEN, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

// Os formulários são preenchidos letra por letra: com a suíte inteira em paralelo, passam dos 5 s padrão.
const FORM_TIMEOUT = 15_000;
const VALID_TOKEN = 'b'.repeat(43);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  window.history.replaceState(null, '', '/');
});
afterAll(() => server.close());

function renderAt(
  path: string,
  state: MockState = { me: demoMe('admin_cliente') },
  /** Respostas que valem antes das do mock (o MSW usa a primeira que casa). */
  overrides: Parameters<typeof server.use> = [],
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

describe('contato de escalonamento no cadastro de clientes (Verax)', { timeout: FORM_TIMEOUT }, () => {
  async function openTenant(name: string) {
    await userEvent.click(await screen.findByRole('button', { name }));
    return screen.findByRole('dialog', { name: 'Cliente' });
  }

  it('confirmado: a situação e a data, sem reenvio', async () => {
    renderAt('/cadastros/clientes', { me: demoMe('admin_verax') });
    const alfa = await openTenant('Cliente Demo Alfa');
    expect(await within(alfa).findByText('Confirmado')).toBeInTheDocument();
    expect(within(alfa).getByText(/Recebe por e-mail só os avisos críticos/)).toBeInTheDocument();
    expect(within(alfa).queryByRole('button', { name: 'Reenviar confirmação' })).not.toBeInTheDocument();
  });

  it('aguardando: o último e-mail de confirmação, e o reenvio põe um pedido novo na fila', async () => {
    renderAt('/cadastros/clientes', { me: demoMe('admin_verax') });
    const beta = await openTenant('Cliente Demo Beta');
    expect(await within(beta).findByText('Aguardando confirmação')).toBeInTheDocument();
    expect(within(beta).getByText(/E-mail de confirmação enviado em/)).toBeInTheDocument();
    await userEvent.click(within(beta).getByRole('button', { name: 'Reenviar confirmação' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Pedido de confirmação na fila.');
    expect(await screen.findByText(/O e-mail de confirmação está na fila/)).toBeInTheDocument();
  });

  it('o contato descadastrado aparece como tal, e o reenvio o traz de volta a aguardar', async () => {
    renderAt('/cadastros/clientes', { me: demoMe('admin_verax') });
    const inactive = await openTenant('Cliente Demo Inativo');
    expect(await within(inactive).findByText('Descadastrado')).toBeInTheDocument();
    expect(within(inactive).getByText(/não recebe mais avisos/)).toBeInTheDocument();
    await userEvent.click(within(inactive).getByRole('button', { name: 'Reenviar confirmação' }));
    expect(await screen.findByText('Aguardando confirmação')).toBeInTheDocument();
  });
});

describe('Escalonamento: a tela do administrador do cliente', { timeout: FORM_TIMEOUT }, () => {
  it('mostra o contato; trocar só o nome mantém a confirmação, e o e-mail novo volta a aguardar', async () => {
    renderAt('/cadastros/escalonamento');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Contato de escalonamento' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Confirmado')).toBeInTheDocument();
    const name = screen.getByLabelText('Nome do contato');
    expect(name).toHaveValue('Marina Alves');

    await userEvent.clear(name);
    await userEvent.type(name, 'Marina A. Alves');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar contato' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Contato salvo.');
    expect(screen.getByText('Confirmado')).toBeInTheDocument();

    const email = screen.getByLabelText('E-mail do contato');
    await userEvent.clear(email);
    await userEvent.type(email, 'sem-arroba');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar contato' }));
    expect(email).toHaveAccessibleDescription('E-mail inválido.');
    await userEvent.clear(email);
    await userEvent.type(email, 'plantao@exemplo.com.br');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar contato' }));
    expect(await screen.findByText('Aguardando confirmação')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('O e-mail de confirmação vai para o endereço');
    expect(screen.getByRole('button', { name: 'Reenviar confirmação' })).toBeInTheDocument();
  });

  it.each(['analista_cliente', 'leitura'] as const)('%s não chega à tela', async (role) => {
    const router = renderAt('/cadastros/escalonamento', { me: demoMe(role) });
    await waitFor(() => expect(router.state.location.pathname).toBe('/sem-permissao'));
  });

  it('a equipe da Verax escolhe um cliente antes', async () => {
    renderAt('/cadastros/escalonamento', { me: demoMe('admin_verax') });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
  });
});

describe('links públicos do e-mail ao contato', { timeout: FORM_TIMEOUT }, () => {
  function openLink(path: string, token: string, overrides: Parameters<typeof server.use> = []) {
    window.history.replaceState(null, '', `${path}#token=${token}`);
    return renderAt(path, { me: null }, overrides);
  }

  it('confirmar: sem login, lê o token do fragmento, o apaga da barra e pede um clique', async () => {
    const router = openLink('/escalonamento/confirmar', VALID_TOKEN);
    expect(
      await screen.findByRole('heading', { name: 'Confirmar o contato de escalonamento' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(screen.getByText(/só os avisos críticos/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar o endereço' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Endereço confirmado.');
    expect(router.state.location.pathname).toBe('/escalonamento/confirmar');
  });

  it('descadastrar: um clique, e a resposta não diz nada do cliente nem do endereço', async () => {
    openLink('/escalonamento/descadastrar', VALID_TOKEN);
    await userEvent.click(await screen.findByRole('button', { name: 'Deixar de receber' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Pronto. Este endereço não recebe mais os avisos do Verax Control.',
    );
  });

  it('link vencido (ou usado, ou de outro endereço): a mesma mensagem, que diz o que fazer', async () => {
    openLink('/escalonamento/confirmar', DEMO_EXPIRED_LINK_TOKEN);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirmar o endereço' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Este link é inválido, já foi usado ou venceu (ele vale por 72 horas).',
    );
  });

  it('limite de tentativas: pede para esperar', async () => {
    openLink('/escalonamento/descadastrar', VALID_TOKEN, [
      http.post(`${API_URL}/v1/public/escalation-contact/unsubscribe`, () =>
        HttpResponse.json({ statusCode: 429, message: 'x', code: 'TOO_MANY_REQUESTS' }, { status: 429 }),
      ),
    ]);
    await userEvent.click(await screen.findByRole('button', { name: 'Deixar de receber' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Muitas tentativas. Tente de novo em alguns minutos.',
    );
  });

  it('sem o token no link, explica o que fazer', async () => {
    renderAt('/escalonamento/descadastrar', { me: null });
    expect(await screen.findByRole('alert')).toHaveTextContent('Este link está incompleto.');
  });
});
