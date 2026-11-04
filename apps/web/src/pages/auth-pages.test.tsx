import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeRedirect } from '@/features/auth/auth-api';
import { TURNSTILE_ERROR_MESSAGE, type TurnstileApi } from '@/features/auth/turnstile';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { MOCK_AUTH, MOCK_TURNSTILE_STORAGE_KEY } from '@/mocks/auth-handlers';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';
import { ASK_ADMIN_MESSAGE, RESET_REQUESTED_MESSAGE } from './forgot-password-page';

// Os formulários são preenchidos letra por letra: com a suíte inteira em paralelo, passam dos 5 s padrão.
const FORM_TIMEOUT = 15_000;

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
  // Preenche o formulário duas vezes, letra por letra: com a suíte inteira em paralelo, passa perto dos 5 s padrão.
  it('senha errada e e-mail desconhecido têm a mesma mensagem', { timeout: 15_000 }, async () => {
    renderAt('/login');
    await fillLogin(MOCK_AUTH.email, 'senha-errada-qualquer');
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');

    await userEvent.clear(screen.getByLabelText('E-mail'));
    await fillLogin('ninguem@demo.verax.local', MOCK_AUTH.password);
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');
  });

  it('senha temporária vencida: diz o motivo e o que fazer', async () => {
    renderAt('/login');
    server.use(
      http.post(`${API_URL}/v1/auth/sign-in/email`, () =>
        HttpResponse.json({ code: 'TEMPORARY_PASSWORD_EXPIRED', message: 'x' }, { status: 401 }),
      ),
    );
    await fillLogin(MOCK_AUTH.email, MOCK_AUTH.password);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sua senha temporária venceu. Peça outra ao administrador.',
    );
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

  it('com a senha temporária, o login leva à troca de senha (antes do MFA)', async () => {
    const { router } = renderAt('/login');
    await fillLogin(MOCK_AUTH.email, MOCK_AUTH.temporaryPassword);
    await waitFor(() => expect(router.state.location.pathname).toBe('/trocar-senha'));
    expect(await screen.findByRole('heading', { name: 'Troque a senha temporária' })).toBeInTheDocument();
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

describe('troca da senha temporária', { timeout: FORM_TIMEOUT }, () => {
  /** Sessão aberta com a senha temporária: conta nova, ainda sem MFA. */
  const temporarySession = (): MockState => ({
    me: demoMe('analista_cliente', { mfaEnabled: false, mustChangePassword: true }),
  });

  async function submitChange(temporary: string, password: string, confirmation = password) {
    await userEvent.type(await screen.findByLabelText('Senha temporária'), temporary);
    await userEvent.type(screen.getByLabelText('Nova senha'), password);
    await userEvent.type(screen.getByLabelText('Confirme a nova senha'), confirmation);
    await userEvent.click(screen.getByRole('button', { name: 'Salvar e continuar' }));
  }

  it('explica o motivo; trocada a senha, segue para o cadastro do MFA, que aceita a senha nova', async () => {
    const { router, state } = renderAt('/trocar-senha', temporarySession());
    expect(await screen.findByText(/Como outra pessoa já a viu/)).toHaveTextContent(
      'Em seguida, você vai ativar a verificação em duas etapas.',
    );
    await submitChange(MOCK_AUTH.temporaryPassword, 'uma-senha-nova-bem-longa');
    await waitFor(() => expect(router.state.location.pathname).toBe('/mfa/cadastro'));
    expect(await screen.findByRole('status')).toHaveTextContent('Senha trocada.');
    expect(state.me?.mustChangePassword).toBe(false);

    await userEvent.type(screen.getByLabelText('Senha'), 'uma-senha-nova-bem-longa');
    await userEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(
      await screen.findByRole('img', { name: 'QR code para o aplicativo autenticador' }),
    ).toBeInTheDocument();
  });

  it('valida tamanho, senha igual à temporária e confirmação antes de enviar', async () => {
    renderAt('/trocar-senha', temporarySession());
    await userEvent.type(await screen.findByLabelText('Nova senha'), 'curta');
    expect(screen.getByLabelText('Nova senha')).toHaveAccessibleDescription(
      /A senha precisa ter pelo menos 12 caracteres\./,
    );
    await userEvent.clear(screen.getByLabelText('Nova senha'));
    await userEvent.type(screen.getByLabelText('Senha temporária'), MOCK_AUTH.temporaryPassword);
    await userEvent.type(screen.getByLabelText('Nova senha'), MOCK_AUTH.temporaryPassword);
    expect(screen.getByLabelText('Nova senha')).toHaveAccessibleDescription(
      /A senha nova precisa ser diferente da temporária\./,
    );
    // A mesma senha em caracteres de largura total vira o mesmo hash na API (NFKC): também é igual.
    const fullWidth = [...MOCK_AUTH.temporaryPassword]
      .map((char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))
      .join('');
    await userEvent.clear(screen.getByLabelText('Nova senha'));
    await userEvent.type(screen.getByLabelText('Nova senha'), fullWidth);
    expect(screen.getByLabelText('Nova senha')).toHaveAccessibleDescription(
      /A senha nova precisa ser diferente da temporária\./,
    );
    await userEvent.clear(screen.getByLabelText('Nova senha'));
    await userEvent.type(screen.getByLabelText('Nova senha'), 'uma-senha-bem-longa');
    await userEvent.type(screen.getByLabelText('Confirme a nova senha'), 'outra-senha-longa');
    expect(screen.getByLabelText('Confirme a nova senha')).toHaveAccessibleDescription(
      'As senhas não são iguais.',
    );
    expect(screen.getByRole('button', { name: 'Salvar e continuar' })).toBeDisabled();
  });

  it('mostra a recusa da API: senha temporária errada e senha nova vazada', async () => {
    const { router } = renderAt('/trocar-senha', temporarySession());
    await submitChange('senha-temporaria-errada', 'uma-senha-bem-longa');
    expect(await screen.findByRole('alert')).toHaveTextContent('Senha temporária incorreta.');

    await userEvent.clear(screen.getByLabelText('Senha temporária'));
    await userEvent.clear(screen.getByLabelText('Nova senha'));
    await userEvent.clear(screen.getByLabelText('Confirme a nova senha'));
    await submitChange(MOCK_AUTH.temporaryPassword, MOCK_AUTH.leakedPassword);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Esta senha aparece em vazamentos conhecidos. Escolha outra.',
    );
    expect(router.state.location.pathname).toBe('/trocar-senha');
  });

  it('a sessão com senha temporária não chega às rotas internas nem ao cadastro do MFA', async () => {
    const { router } = renderAt('/incidentes', temporarySession());
    await waitFor(() => expect(router.state.location.pathname).toBe('/trocar-senha'));
    await router.navigate('/mfa/cadastro');
    await waitFor(() => expect(router.state.location.pathname).toBe('/trocar-senha'));
  });

  it('sem senha temporária, a página segue adiante', async () => {
    const { router } = renderAt('/trocar-senha', { me: demoMe('analista_cliente') });
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('dá para sair sem trocar', async () => {
    const { router, state } = renderAt('/trocar-senha', temporarySession());
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(state.me).toBeNull();
  });
});

describe('Turnstile (chave do site vinda da API)', { timeout: FORM_TIMEOUT }, () => {
  const PASS_KEY = '1x00000000000000000000AA';
  const BLOCK_KEY = '2x00000000000000000000AB';
  type RenderOptions = Record<string, unknown> & {
    callback?: (token: string) => void;
    'error-callback'?: (code?: string) => void;
  };

  /**
   * O script da Cloudflare não roda no jsdom: um dublê do objeto global faz o que o widget faria. `pass` entrega um
   * token logo depois de desenhar (e outro a cada `reset`); `block` chama o erro, como a chave de teste que bloqueia.
   */
  function stubTurnstile(behaviour: 'pass' | 'block') {
    let tokens = 0;
    const emit = (options: RenderOptions): void => {
      tokens += 1;
      const token = `token-de-teste-${tokens}`;
      queueMicrotask(() => {
        if (behaviour === 'pass') options.callback?.(token);
        else options['error-callback']?.('300030');
      });
    };
    const stub = {
      render: vi.fn((container: HTMLElement, options: RenderOptions) => {
        container.append(document.createElement('iframe'));
        emit(options);
        return `widget-${stub.render.mock.calls.length}`;
      }),
      reset: vi.fn(() => emit(stub.render.mock.lastCall?.[1] ?? {})),
      remove: vi.fn(),
    };
    window.turnstile = stub as unknown as TurnstileApi;
    return stub;
  }

  /** Os tokens que chegaram no header de uma rota (um handler que só observa e deixa o mock responder). */
  function sentTokens(path: string): (string | null)[] {
    const tokens: (string | null)[] = [];
    server.use(
      http.post(`${API_URL}${path}`, ({ request }) => {
        tokens.push(request.headers.get('X-Turnstile-Token'));
        return undefined;
      }),
    );
    return tokens;
  }

  afterEach(() => {
    delete window.turnstile;
  });

  it('sem a chave do site, nada do Turnstile aparece e o login é o de sempre', async () => {
    const stub = stubTurnstile('pass');
    const { router } = renderAt('/login');
    await fillLogin(MOCK_AUTH.email, MOCK_AUTH.password);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login/codigo'));
    expect(stub.render).not.toHaveBeenCalled();
    expect(screen.queryByText('Carregando verificação…')).toBeNull();
  });

  it('com a chave, o widget segue o tema e o idioma do painel, e o token vai no header do login', async () => {
    window.localStorage.setItem(MOCK_TURNSTILE_STORAGE_KEY, PASS_KEY);
    // A preferência guardada: o seletor de tema da tela a aplica antes de o widget ser desenhado.
    window.localStorage.setItem('verax.theme', 'dark');
    const stub = stubTurnstile('pass');
    const { router } = renderAt('/login');
    const sent = sentTokens('/v1/auth/sign-in/email');

    await waitFor(() => expect(stub.render).toHaveBeenCalledOnce());
    expect(stub.render.mock.calls[0]?.[1]).toMatchObject({
      sitekey: PASS_KEY,
      action: 'login',
      theme: 'dark',
      language: 'pt-br',
      'response-field': false,
    });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

    // Trocar o tema redesenha o widget com o tema novo.
    document.documentElement.dataset['theme'] = 'light';
    await waitFor(() => expect(stub.render).toHaveBeenCalledTimes(2));
    expect(stub.remove).toHaveBeenCalledWith('widget-1');
    expect(stub.render.mock.calls[1]?.[1]).toMatchObject({ theme: 'light' });

    await fillLogin(MOCK_AUTH.email, MOCK_AUTH.password);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login/codigo'));
    expect(sent).toEqual(['token-de-teste-2']);
  });

  it('senha errada reinicia o widget (cada token vale uma vez); a recusa do Turnstile pela API tem mensagem própria', async () => {
    window.localStorage.setItem(MOCK_TURNSTILE_STORAGE_KEY, PASS_KEY);
    const stub = stubTurnstile('pass');
    const { router } = renderAt('/login');
    const sent = sentTokens('/v1/auth/sign-in/email');
    await waitFor(() => expect(stub.render).toHaveBeenCalledOnce());

    await fillLogin(MOCK_AUTH.email, 'senha-errada-qualquer');
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');
    expect(stub.reset).toHaveBeenCalledOnce();
    expect(sent).toEqual(['token-de-teste-1']);

    // A recusa vem antes do observador (o `use` põe o handler na frente): outro observador para esta chamada.
    server.use(
      http.post(`${API_URL}/v1/auth/sign-in/email`, () =>
        HttpResponse.json({ code: 'TURNSTILE_FAILED', message: 'x' }, { status: 400 }),
      ),
    );
    const sentAfter = sentTokens('/v1/auth/sign-in/email');
    await userEvent.clear(screen.getByLabelText('Senha'));
    await userEvent.type(screen.getByLabelText('Senha'), MOCK_AUTH.password);
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A verificação de segurança não foi concluída',
    );
    expect(stub.reset).toHaveBeenCalledTimes(2);
    expect(router.state.location.pathname).toBe('/login');
    expect(sentAfter).toEqual(['token-de-teste-2']);
  });

  it('chave que bloqueia: o aviso aparece e o envio fica desligado', async () => {
    window.localStorage.setItem(MOCK_TURNSTILE_STORAGE_KEY, BLOCK_KEY);
    stubTurnstile('block');
    renderAt('/login');
    expect(await screen.findByRole('alert')).toHaveTextContent(TURNSTILE_ERROR_MESSAGE);
    await userEvent.type(screen.getByLabelText('E-mail'), MOCK_AUTH.email);
    await userEvent.type(screen.getByLabelText('Senha'), MOCK_AUTH.password);
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeDisabled();
  });

  it('enquanto o script não carrega: "Carregando verificação…" e o envio desligado', async () => {
    window.localStorage.setItem(MOCK_TURNSTILE_STORAGE_KEY, PASS_KEY);
    renderAt('/login');
    expect(await screen.findByRole('status')).toHaveTextContent('Carregando verificação…');
    expect(
      document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]'),
    ).not.toBeNull();
    await userEvent.type(screen.getByLabelText('E-mail'), MOCK_AUTH.email);
    await userEvent.type(screen.getByLabelText('Senha'), MOCK_AUTH.password);
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeDisabled();
  });

  it('esqueci a senha: o token vai no header, e a recusa do Turnstile não vira a mensagem de "enviado"', async () => {
    window.localStorage.setItem(MOCK_TURNSTILE_STORAGE_KEY, PASS_KEY);
    const stub = stubTurnstile('pass');
    renderAt('/esqueci-senha');
    await waitFor(() => expect(stub.render).toHaveBeenCalledOnce());
    expect(stub.render.mock.calls[0]?.[1]).toMatchObject({ sitekey: PASS_KEY, action: 'password-reset' });

    server.use(
      http.post(`${API_URL}/v1/auth/request-password-reset`, () =>
        HttpResponse.json({ code: 'TURNSTILE_REQUIRED', message: 'x' }, { status: 400 }),
      ),
    );
    const sent = sentTokens('/v1/auth/request-password-reset');
    await userEvent.type(await screen.findByLabelText('E-mail'), 'qualquer@demo.verax.local');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A verificação de segurança não foi concluída',
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(stub.reset).toHaveBeenCalledOnce();

    server.resetHandlers();
    server.use(...createHandlers({ me: null }));
    const sentAfter = sentTokens('/v1/auth/request-password-reset');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(RESET_REQUESTED_MESSAGE);
    expect(sent).toEqual(['token-de-teste-1']);
    expect(sentAfter).toEqual(['token-de-teste-2']);

    // Enviado, o formulário sai da tela e o widget sai junto: trocar o tema não o redesenha num contêiner solto.
    expect(stub.remove).toHaveBeenCalledWith('widget-1');
    document.documentElement.dataset['theme'] = 'dark';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stub.render).toHaveBeenCalledOnce();
  });
});

describe('esqueci a senha', () => {
  it('mesma mensagem para qualquer e-mail, e o caminho se o e-mail não chegar', async () => {
    renderAt('/esqueci-senha');
    expect(await screen.findByText(ASK_ADMIN_MESSAGE)).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('E-mail'), 'qualquer@demo.verax.local');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(RESET_REQUESTED_MESSAGE);
    expect(screen.getByText(ASK_ADMIN_MESSAGE)).toHaveTextContent(
      'peça ao administrador do painel uma senha temporária',
    );
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

  it('link sem token explica o que fazer', async () => {
    renderAt('/redefinir-senha');
    expect(await screen.findByRole('alert')).toHaveTextContent('Este link está incompleto.');
  });
});
