import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeState } from '@/mocks/fake-admin-api';
import { FICTITIOUS_LOGIN_PHRASE, FICTITIOUS_TOTP_CODE, LOGIN_FAILED_MESSAGE } from '@/mocks/fake-auth';
import { FICTITIOUS_OWNER } from '@/mocks/fixtures';
import { renderConsole } from '@/test/render';

/** O acesso ao console sobre a API simulada: credenciais FICTÍCIAS (`fake-auth.ts`). */
describe('entrada no console', () => {
  it('um formulário só, com rótulos e o preenchimento automático certo em cada campo', async () => {
    renderConsole('/entrar', createFakeState({ loggedIn: false }));
    expect(await screen.findByRole('heading', { name: 'Entrar no console' })).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Senha')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'password');
    const code = screen.getByLabelText('Código do aplicativo');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    // Nada do menu nem dos dados antes de entrar.
    expect(screen.queryByRole('navigation', { name: 'Menu do console' })).not.toBeInTheDocument();
  });

  it('erro genérico da API, sem dizer qual campo; com tudo certo, volta para a tela pedida', async () => {
    const state = createFakeState({ loggedIn: false });
    const { user, router } = renderConsole('/entrar?voltar=%2Fclientes', state);
    await user.type(await screen.findByLabelText('E-mail'), FICTITIOUS_OWNER);
    await user.type(screen.getByLabelText('Senha'), 'senha-errada-errada');
    await user.type(screen.getByLabelText('Código do aplicativo'), FICTITIOUS_TOTP_CODE);
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(LOGIN_FAILED_MESSAGE);
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText('Senha')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Senha')).toHaveValue('');
    expect(state.auth.loggedIn).toBe(false);

    await user.type(screen.getByLabelText('Senha'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(screen.getByLabelText('Código do aplicativo'), FICTITIOUS_TOTP_CODE);
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/clientes'));
    expect(await screen.findByTestId('usuario')).toHaveTextContent(FICTITIOUS_OWNER);
    expect(state.auth.lastBody).toEqual({
      email: FICTITIOUS_OWNER,
      password: FICTITIOUS_LOGIN_PHRASE,
      code: FICTITIOUS_TOTP_CODE,
    });
  });

  it('confere os campos antes de mandar: código de 6 números', async () => {
    const state = createFakeState({ loggedIn: false });
    const { user } = renderConsole('/entrar', state);
    await user.type(await screen.findByLabelText('E-mail'), FICTITIOUS_OWNER);
    await user.type(screen.getByLabelText('Senha'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(screen.getByLabelText('Código do aplicativo'), '12a');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(screen.getByLabelText('Código do aplicativo')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Código do aplicativo')).toHaveAccessibleDescription(
      /6 números do aplicativo/,
    );
    expect(state.auth.lastBody).toBeUndefined();
  });

  it('sem o celular: um código de recuperação no lugar do código do aplicativo', async () => {
    const state = createFakeState({ loggedIn: false });
    const { user, router } = renderConsole('/entrar?voltar=//exemplo.example', state);
    await user.click(await screen.findByRole('button', { name: 'Usar um código de recuperação' }));
    expect(screen.queryByLabelText('Código do aplicativo')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('E-mail'), FICTITIOUS_OWNER);
    await user.type(screen.getByLabelText('Senha'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(screen.getByLabelText('Código de recuperação'), 'aaaaa-aaaaa');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    // O `voltar` de outro site é ignorado: a entrada leva ao início.
    await waitFor(() => expect(router.state.location.pathname).toBe('/modelos-de-custo'));
    expect(state.auth.lastBody).toEqual({
      email: FICTITIOUS_OWNER,
      password: FICTITIOUS_LOGIN_PHRASE,
      recoveryCode: 'aaaaa-aaaaa',
    });
    expect(state.auth.recoveryCodes).not.toContain('AAAAA-AAAAA');
  });
});

describe('sessão do console', () => {
  it('sem sessão, nenhuma tela protegida abre: vai para a entrada, guardando a tela', async () => {
    const { router } = renderConsole('/clientes', createFakeState({ loggedIn: false }));
    expect(await screen.findByRole('heading', { name: 'Entrar no console' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/entrar');
    expect(router.state.location.search).toBe('?voltar=%2Fclientes');
    expect(screen.queryByRole('navigation', { name: 'Menu do console' })).not.toBeInTheDocument();
  });

  it('a sessão que vence no meio do uso leva à entrada no próximo pedido', async () => {
    const state = createFakeState();
    const { router } = renderConsole('/modelos-de-custo', state);
    await screen.findByRole('table', { name: /versões/i });
    state.auth.loggedIn = false;
    await act(() => router.navigate('/tabelas-de-preco'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entrar'));
    expect(router.state.location.search).toBe('?voltar=%2Ftabelas-de-preco');
    expect(await screen.findByRole('heading', { name: 'Entrar no console' })).toBeInTheDocument();
  });

  it('o botão Sair encerra a sessão na API e volta para a entrada', async () => {
    const state = createFakeState();
    const { user, router } = renderConsole('/simulador', state);
    await user.click(await screen.findByRole('button', { name: 'Sair' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/entrar'));
    expect(state.auth.loggedIn).toBe(false);
    expect(state.auth.lastBody).toEqual({});
  });

  it('sessão de quem não é responsável: a mensagem e só a saída', async () => {
    const state = createFakeState();
    state.auth.notOwner = true;
    renderConsole('/clientes', state);
    expect(await screen.findByText('Esta conta não é de um responsável pelo console.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sair' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Menu do console' })).not.toBeInTheDocument();
  });
});

describe('sem tela de cadastro', () => {
  it('a antiga /configurar não existe: sem sessão vai para a entrada, que não oferece cadastro', async () => {
    const { router } = renderConsole('/configurar', createFakeState({ loggedIn: false }));
    expect(await screen.findByRole('heading', { name: 'Entrar no console' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/entrar');
    // A entrada não oferece cadastro nenhum.
    expect(screen.queryByRole('link', { name: /configur/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
  });

  it('com sessão, /configurar é uma página que não existe', async () => {
    renderConsole('/configurar', createFakeState());
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeInTheDocument();
  });
});

describe('minha conta', () => {
  it('troca da senha: confere a senha nova antes, mostra a recusa genérica e confirma a troca', async () => {
    const state = createFakeState();
    const { user } = renderConsole('/conta', state);
    const form = await screen.findByRole('form', { name: 'Trocar a senha' });
    const field = (label: string) => within(form).getByLabelText(label);
    expect(field('Senha atual')).toHaveAttribute('autocomplete', 'current-password');
    expect(field('Senha nova')).toHaveAttribute('autocomplete', 'new-password');
    expect(field('Código do aplicativo')).toHaveAttribute('autocomplete', 'one-time-code');

    await user.type(field('Senha atual'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(field('Código do aplicativo'), FICTITIOUS_TOTP_CODE);
    await user.type(field('Senha nova'), 'curta');
    await user.click(within(form).getByRole('button', { name: 'Trocar a senha' }));
    expect(field('Senha nova')).toHaveAttribute('aria-invalid', 'true');
    expect(state.auth.lastBody).toBeUndefined();

    await user.clear(field('Senha nova'));
    await user.type(field('Senha nova'), 'nova-nova-nova-nova');
    await user.type(field('Confirme a senha nova'), 'nova-nova-nova-nova');
    await user.clear(field('Senha atual'));
    await user.type(field('Senha atual'), 'errada-errada-errada');
    await user.click(within(form).getByRole('button', { name: 'Trocar a senha' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('A senha atual ou o código não confere');
    expect(state.auth.password).toBe(FICTITIOUS_LOGIN_PHRASE);

    await user.type(field('Senha atual'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(field('Código do aplicativo'), FICTITIOUS_TOTP_CODE);
    await user.type(field('Senha nova'), 'nova-nova-nova-nova');
    await user.type(field('Confirme a senha nova'), 'nova-nova-nova-nova');
    await user.click(within(form).getByRole('button', { name: 'Trocar a senha' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('Senha trocada.');
    expect(state.auth.password).toBe('nova-nova-nova-nova');
  });

  it('troca do aplicativo: senha e código atuais, o QR novo e os códigos de recuperação novos', async () => {
    const state = createFakeState();
    const { user } = renderConsole('/conta', state);
    const form = await screen.findByRole('form', { name: 'Trocar o aplicativo autenticador' });
    await user.type(within(form).getByLabelText('Senha atual'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(within(form).getByLabelText('Código do aplicativo atual'), FICTITIOUS_TOTP_CODE);
    await user.click(within(form).getByRole('button', { name: 'Trocar o aplicativo' }));
    expect(await screen.findByRole('img', { name: /QR para cadastrar/ })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Trocar o aplicativo autenticador' });
    await user.type(within(card).getByLabelText('Código do aplicativo'), FICTITIOUS_TOTP_CODE);
    await user.click(within(card).getByRole('button', { name: 'Confirmar o aplicativo novo' }));
    const list = await screen.findByRole('list', { name: 'Códigos de recuperação' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('ZAAAA-AAAAA');
  });
});
