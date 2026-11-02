import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { safeRedirect } from '@/features/auth/auth-api';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { MOCK_AUTH } from '@/mocks/auth-handlers';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';
import { RESET_REQUESTED_MESSAGE } from './forgot-password-page';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  window.history.replaceState(null, '', '/');
});
afterAll(() => server.close());

function renderAt(path: string, state: MockState = { me: null }, routerState?: unknown) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [{ pathname: path, state: routerState }] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, state };
}

async function fillLogin(email: string, password: string) {
  await userEvent.type(await screen.findByLabelText('E-mail'), email);
  await userEvent.type(screen.getByLabelText('Senha'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

describe('login', () => {
  it('senha errada e e-mail desconhecido têm a mesma mensagem', async () => {
    renderAt('/login');
    await fillLogin(MOCK_AUTH.email, 'senha-errada-qualquer');
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');

    await userEvent.clear(screen.getByLabelText('E-mail'));
    await fillLogin('ninguem@demo.verax.local', MOCK_AUTH.password);
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');
  });

  it('conta bloqueada mostra a espera, sem confirmar que a conta existe', async () => {
    renderAt('/login');
    server.use(
      http.post(`${API_URL}/v1/auth/sign-in/email`, () =>
        HttpResponse.json({ code: 'ACCOUNT_LOCKED', message: 'x' }, { status: 429 }),
      ),
    );
    await fillLogin(MOCK_AUTH.email, MOCK_AUTH.password);
    expect(await screen.findByRole('alert')).toHaveTextContent('Muitas tentativas. Aguarde alguns minutos');
  });

  it('com MFA, a senha leva ao código; o código leva ao painel (ou ao destino interno pedido)', async () => {
    const { router } = renderAt('/login', { me: null }, { from: '/incidentes' });
    await fillLogin(MOCK_AUTH.email, MOCK_AUTH.password);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login/codigo'));

    await userEvent.type(await screen.findByLabelText('Código do aplicativo'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Código inválido ou expirado');
    expect(router.state.location.pathname).toBe('/login/codigo');

    await userEvent.type(screen.getByLabelText('Código do aplicativo'), MOCK_AUTH.totp);
    await userEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/incidentes'));
  });

  it('código de recuperação também entra', async () => {
    const { router } = renderAt('/login/codigo');
    await userEvent.click(await screen.findByRole('button', { name: /usar código de recuperação/i }));
    await userEvent.type(screen.getByLabelText('Código de recuperação'), MOCK_AUTH.recoveryCode);
    await userEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('sem MFA cadastrado, o login leva ao cadastro do MFA', async () => {
    const { router } = renderAt('/login', { me: null, mfa: false });
    await fillLogin(MOCK_AUTH.email, MOCK_AUTH.password);
    await waitFor(() => expect(router.state.location.pathname).toBe('/mfa/cadastro'));
  });

  it.each([
    'https://site-malicioso.example',
    '//site-malicioso.example',
    '/\\site-malicioso.example',
    'javascript:alert(1)',
  ])('destino %s depois do login vira a página inicial (sem redirecionamento aberto)', (target) => {
    expect(safeRedirect(target)).toBe('/');
  });
});

describe('cadastro do MFA', () => {
  it('senha, QR gerado no navegador, códigos guardados e primeiro código', async () => {
    // Sessão sem MFA, como logo depois do primeiro login.
    const { router } = renderAt('/mfa/cadastro', { me: demoMe('analista_cliente', { mfaEnabled: false }) });

    await userEvent.type(await screen.findByLabelText('Senha'), MOCK_AUTH.password);
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    expect(
      await screen.findByRole('img', { name: 'QR code para o aplicativo autenticador' }),
    ).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Códigos de recuperação' }).children).toHaveLength(10);

    await userEvent.type(screen.getByLabelText('Código do aplicativo'), MOCK_AUTH.totp);
    const activate = screen.getByRole('button', { name: 'Ativar e entrar' });
    expect(activate).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Guardei os códigos em local seguro'));
    await userEvent.click(activate);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('senha errada não inicia o cadastro', async () => {
    renderAt('/mfa/cadastro', { me: demoMe('leitura', { mfaEnabled: false }) });
    await userEvent.type(await screen.findByLabelText('Senha'), 'senha-errada');
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Senha incorreta.');
  });
});

describe('esqueci a senha', () => {
  it('mesma mensagem para qualquer e-mail', async () => {
    renderAt('/esqueci-senha');
    await userEvent.type(await screen.findByLabelText('E-mail'), 'qualquer@demo.verax.local');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(RESET_REQUESTED_MESSAGE);
  });

  it('recusa da API que não seja limite ou falha também mostra a mesma mensagem', async () => {
    renderAt('/esqueci-senha');
    server.use(
      http.post(`${API_URL}/v1/auth/request-password-reset`, () => HttpResponse.json({}, { status: 400 })),
    );
    await userEvent.type(await screen.findByLabelText('E-mail'), 'x@demo.verax.local');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(RESET_REQUESTED_MESSAGE);
  });
});

describe('redefinição e convite', () => {
  function openLink(path: string, token: string) {
    window.history.replaceState(null, '', `${path}#token=${token}`);
    return renderAt(path);
  }

  it('lê o token do fragmento e o apaga da barra de endereço', async () => {
    openLink('/redefinir-senha', MOCK_AUTH.validLinkToken);
    expect(await screen.findByRole('heading', { name: 'Defina uma nova senha' })).toBeInTheDocument();
    expect(window.location.hash).toBe('');
  });

  it('valida tamanho e confirmação antes de enviar', async () => {
    openLink('/redefinir-senha', MOCK_AUTH.validLinkToken);
    await userEvent.type(await screen.findByLabelText('Nova senha'), 'curta');
    expect(screen.getByText('A senha precisa ter pelo menos 12 caracteres.')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Nova senha'));
    await userEvent.type(screen.getByLabelText('Nova senha'), 'uma-senha-bem-longa');
    await userEvent.type(screen.getByLabelText('Confirme a senha'), 'outra-senha-longa');
    expect(screen.getByText('As senhas não são iguais.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar senha' })).toBeDisabled();
  });

  async function submitPassword(password: string) {
    await userEvent.type(await screen.findByLabelText('Nova senha'), password);
    await userEvent.type(screen.getByLabelText('Confirme a senha'), password);
    await userEvent.click(screen.getByRole('button', { name: 'Salvar senha' }));
  }

  it('senha vazada é recusada com a explicação', async () => {
    openLink('/redefinir-senha', MOCK_AUTH.validLinkToken);
    await submitPassword(MOCK_AUTH.leakedPassword);
    expect(await screen.findByRole('alert')).toHaveTextContent('vazamentos conhecidos');
  });

  it('link inválido ou expirado pede um novo', async () => {
    openLink('/redefinir-senha', 'token-qualquer');
    await submitPassword('uma-senha-bem-longa');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Este link é inválido ou expirou. Peça um novo.',
    );
  });

  it('convite: ativa e leva ao login com o aviso', async () => {
    const { router } = openLink('/convite', MOCK_AUTH.validLinkToken);
    expect(await screen.findByRole('heading', { name: 'Ative seu acesso' })).toBeInTheDocument();
    await submitPassword('uma-senha-bem-longa');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByRole('status')).toHaveTextContent('Acesso ativado.');
  });

  it('link sem token explica o que fazer', async () => {
    renderAt('/convite');
    expect(await screen.findByRole('alert')).toHaveTextContent('Este link está incompleto.');
  });
});
