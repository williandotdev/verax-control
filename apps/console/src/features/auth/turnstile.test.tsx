import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeState } from '@/mocks/fake-admin-api';
import { FICTITIOUS_LOGIN_PHRASE, FICTITIOUS_TOTP_CODE } from '@/mocks/fake-auth';
import { FICTITIOUS_OWNER } from '@/mocks/fixtures';
import { renderConsole } from '@/test/render';
import {
  CONSOLE_LOGIN_ACTION,
  loadTurnstile,
  TURNSTILE_ERROR_MESSAGE,
  TURNSTILE_SCRIPT_TIMEOUT_MS,
  useTurnstile,
} from './turnstile';
import { TurnstileWidget } from './turnstile-widget';

/** A chave de site de teste da Cloudflare (pública por natureza; só existe nos testes). */
const SITE_KEY = '1x00000000000000000000AA';
const SCRIPT_SELECTOR = 'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]';

interface RenderOptions {
  sitekey?: string;
  action?: string;
  callback?: (token: string) => void;
  'error-callback'?: (code?: string) => void;
}

/** Um dublê do objeto global que guarda as opções do último `render`, para o teste disparar os callbacks. */
function stubTurnstile() {
  const stub = {
    options: undefined as RenderOptions | undefined,
    render: vi.fn((_container: HTMLElement, options: RenderOptions) => {
      stub.options = options;
      return 'widget-1';
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = stub;
  return stub;
}

function Harness() {
  const turnstile = useTurnstile(SITE_KEY, CONSOLE_LOGIN_ACTION);
  return (
    <>
      <TurnstileWidget containerRef={turnstile.containerRef} status={turnstile.status} />
      <span data-testid="token">{turnstile.token ?? ''}</span>
    </>
  );
}

afterEach(() => {
  delete window.turnstile;
  delete window.veraxTurnstileOnload;
  for (const script of document.querySelectorAll(SCRIPT_SELECTOR)) script.remove();
  vi.useRealTimers();
});

describe('Turnstile na entrada do console', () => {
  it('desligado (sem chave do site): nenhum script da Cloudflare, nenhum widget, e o "Entrar" ligado', async () => {
    renderConsole('/entrar', createFakeState({ loggedIn: false }));
    const entrar = await screen.findByRole('button', { name: 'Entrar' });
    await waitFor(() => expect(entrar).toBeEnabled());
    expect(screen.queryByRole('group', { name: 'Verificação de segurança' })).toBeNull();
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
  });

  it('ligado: o widget com a chave e a action do console; o "Entrar" só liga com o token, que vai no header', async () => {
    const stub = stubTurnstile();
    const state = createFakeState({ loggedIn: false });
    state.auth.turnstileSiteKey = SITE_KEY;
    const { user, router } = renderConsole('/entrar', state);
    expect(await screen.findByRole('group', { name: 'Verificação de segurança' })).toBeInTheDocument();
    await waitFor(() => expect(stub.render).toHaveBeenCalledOnce());
    expect(stub.options).toMatchObject({
      sitekey: SITE_KEY,
      action: CONSOLE_LOGIN_ACTION,
      language: 'pt-br',
    });

    await user.type(screen.getByLabelText('E-mail'), FICTITIOUS_OWNER);
    await user.type(screen.getByLabelText('Senha'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(screen.getByLabelText('Código do aplicativo'), FICTITIOUS_TOTP_CODE);
    const entrar = screen.getByRole('button', { name: 'Entrar' });
    expect(entrar).toBeDisabled();

    act(() => stub.options?.callback?.('token-1'));
    await waitFor(() => expect(entrar).toBeEnabled());
    await user.click(entrar);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(state.auth.turnstileTokens).toEqual(['token-1']);
    // O token nunca vai no corpo.
    expect(state.auth.lastBody).toEqual({
      email: FICTITIOUS_OWNER,
      password: FICTITIOUS_LOGIN_PHRASE,
      code: FICTITIOUS_TOTP_CODE,
    });
  });

  it('tentativa recusada: a mensagem é anunciada, o widget é reiniciado e o próximo envio leva um token novo', async () => {
    const stub = stubTurnstile();
    const state = createFakeState({ loggedIn: false });
    state.auth.turnstileSiteKey = SITE_KEY;
    state.auth.turnstileRejects = true;
    const { user } = renderConsole('/entrar', state);
    await waitFor(() => expect(stub.render).toHaveBeenCalledOnce());
    await user.type(screen.getByLabelText('E-mail'), FICTITIOUS_OWNER);
    await user.type(screen.getByLabelText('Senha'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(screen.getByLabelText('Código do aplicativo'), FICTITIOUS_TOTP_CODE);
    act(() => stub.options?.callback?.('token-1'));
    const entrar = screen.getByRole('button', { name: 'Entrar' });
    await waitFor(() => expect(entrar).toBeEnabled());
    await user.click(entrar);

    const alert = await screen.findByText('A verificação de segurança não foi aceita. Tente de novo.');
    expect(alert.closest('[role="alert"]')).toHaveFocus();
    expect(stub.reset).toHaveBeenCalledWith('widget-1');
    // Sem token novo, o "Entrar" fica desligado.
    expect(entrar).toBeDisabled();

    state.auth.turnstileRejects = false;
    await user.type(screen.getByLabelText('Senha'), FICTITIOUS_LOGIN_PHRASE);
    await user.type(screen.getByLabelText('Código do aplicativo'), FICTITIOUS_TOTP_CODE);
    act(() => stub.options?.callback?.('token-2'));
    await waitFor(() => expect(entrar).toBeEnabled());
    await user.click(entrar);
    await waitFor(() => expect(state.auth.loggedIn).toBe(true));
    expect(state.auth.turnstileTokens).toEqual(['token-1', 'token-2']);
  });

  it('a Cloudflare bloqueia: o aviso aparece (role="alert") e o "Entrar" continua desligado', async () => {
    const stub = stubTurnstile();
    const state = createFakeState({ loggedIn: false });
    state.auth.turnstileSiteKey = SITE_KEY;
    renderConsole('/entrar', state);
    await waitFor(() => expect(stub.render).toHaveBeenCalledOnce());
    act(() => stub.options?.['error-callback']?.('300030'));
    expect(await screen.findByRole('alert')).toHaveTextContent(TURNSTILE_ERROR_MESSAGE);
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeDisabled();
    expect(state.auth.lastBody).toBeUndefined();
  });
});

describe('useTurnstile', () => {
  it('o erro não é definitivo: o token que chega depois apaga o aviso', async () => {
    const stub = stubTurnstile();
    render(<Harness />);
    await waitFor(() => expect(stub.render).toHaveBeenCalledOnce());
    act(() => stub.options?.['error-callback']?.('300030'));
    expect(screen.getByRole('alert')).toHaveTextContent(TURNSTILE_ERROR_MESSAGE);
    act(() => stub.options?.callback?.('token-depois-do-erro'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('token').textContent).toBe('token-depois-do-erro');
  });

  it('"Carregando verificação…" anunciado até o widget; script que não chega no prazo: o aviso', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    expect(screen.getByRole('status')).toHaveTextContent('Carregando verificação…');
    expect(document.querySelector(SCRIPT_SELECTOR)).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(TURNSTILE_SCRIPT_TIMEOUT_MS);
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(TURNSTILE_ERROR_MESSAGE);
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
  });
});

describe('loadTurnstile', () => {
  it('script que falha ao carregar: rejeita na hora, e a carga seguinte tenta de novo', async () => {
    vi.useFakeTimers();
    const promise = loadTurnstile();
    document.querySelector(SCRIPT_SELECTOR)?.dispatchEvent(new Event('error'));
    await expect(promise).rejects.toThrow('não carregou');
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
    const again = loadTurnstile();
    const stub = stubTurnstile();
    window.veraxTurnstileOnload?.();
    await expect(again).resolves.toBe(stub);
  });
});
