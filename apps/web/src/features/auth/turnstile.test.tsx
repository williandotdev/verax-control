import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadTurnstile,
  TURNSTILE_ERROR_MESSAGE,
  TURNSTILE_SCRIPT_TIMEOUT_MS,
  useTurnstile,
} from './turnstile';
import { TurnstileWidget } from './turnstile-widget';

const SITE_KEY = '1x00000000000000000000AA';
const SCRIPT_SELECTOR = 'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]';

interface RenderOptions {
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

/** A tela mínima: o hook, o contêiner com o estado visível (o mesmo componente das telas de login) e o token. */
function Harness() {
  const turnstile = useTurnstile(SITE_KEY, 'login');
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

describe('useTurnstile', () => {
  it('o erro não é definitivo: o token que chega depois (a Cloudflare tenta de novo sozinha) apaga o aviso', async () => {
    const stub = stubTurnstile();
    render(<Harness />);
    await waitFor(() => expect(stub.render).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => stub.options?.['error-callback']?.('300030'));
    expect(screen.getByRole('alert')).toHaveTextContent(TURNSTILE_ERROR_MESSAGE);
    expect(screen.getByTestId('token').textContent).toBe('');

    act(() => stub.options?.callback?.('token-depois-do-erro'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('token').textContent).toBe('token-depois-do-erro');
  });

  it('script que não chega no prazo: a tela mostra o aviso', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    expect(screen.getByRole('status')).toHaveTextContent('Carregando verificação…');
    expect(document.querySelector(SCRIPT_SELECTOR)).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(TURNSTILE_SCRIPT_TIMEOUT_MS - 1);
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(TURNSTILE_ERROR_MESSAGE);
    expect(screen.queryByRole('status')).toBeNull();
    // O script que não veio sai da página: a próxima carga põe outro.
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
  });
});

// Carregado uma vez por página: o último caso deixa a API pronta, como numa página de verdade; por isso vem por último.
describe('loadTurnstile', () => {
  it('script que falha ao carregar: rejeita na hora, sem esperar o prazo', async () => {
    vi.useFakeTimers();
    const promise = loadTurnstile();
    document.querySelector(SCRIPT_SELECTOR)?.dispatchEvent(new Event('error'));
    await expect(promise).rejects.toThrow('não carregou');
    expect(document.querySelector(SCRIPT_SELECTOR)).toBeNull();
  });

  it('rejeita no prazo; a carga seguinte é outra, e o erro atrasado da primeira não a atrapalha', async () => {
    vi.useFakeTimers();
    const first = loadTurnstile();
    // Enquanto carrega, a mesma promessa é reaproveitada.
    expect(loadTurnstile()).toBe(first);
    const firstScript = document.querySelector(SCRIPT_SELECTOR);
    expect(firstScript).not.toBeNull();

    vi.advanceTimersByTime(TURNSTILE_SCRIPT_TIMEOUT_MS);
    await expect(first).rejects.toThrow('não carregou a tempo');
    expect(window.veraxTurnstileOnload).toBeUndefined();

    const second = loadTurnstile();
    expect(second).not.toBe(first);
    expect(window.veraxTurnstileOnload).toBeDefined();
    // O evento de erro do primeiro script, chegando agora, não derruba a segunda carga.
    firstScript?.dispatchEvent(new Event('error'));
    expect(window.veraxTurnstileOnload).toBeDefined();

    // O script da segunda carga chega e chama o `onload`: a API está pronta.
    const stub = stubTurnstile();
    window.veraxTurnstileOnload?.();
    await expect(second).resolves.toBe(stub);
    expect(window.veraxTurnstileOnload).toBeUndefined();
  });
});
