import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Cloudflare Turnstile nos formulários públicos (login e "esqueci minha senha"), sem pacote do npm: o script oficial
 * é carregado uma vez (`render=explicit`) e o widget é desenhado no modo gerenciado, com o tema do painel e em
 * português. O token vai à API no header `X-Turnstile-Token`; ela o confere na Cloudflare antes de olhar a senha.
 * Sem chave do site (`GET /v1/auth/client-config` com `null`), nada daqui roda e os formulários seguem como sempre.
 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit&onload=veraxTurnstileOnload`;
export const TURNSTILE_TOKEN_HEADER = 'X-Turnstile-Token';

/** O que o painel mostra quando o widget não carrega ou a Cloudflare bloqueia a verificação. */
export const TURNSTILE_ERROR_MESSAGE =
  'A verificação de segurança não pôde ser concluída. Recarregue a página e tente de novo.';

interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: string;
  size?: 'normal' | 'flexible' | 'compact';
  appearance?: 'always' | 'execute' | 'interaction-only';
  'response-field'?: boolean;
  'refresh-expired'?: 'auto' | 'manual' | 'never';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: (code?: string) => void;
  'timeout-callback'?: () => void;
}

/** O objeto global que o script da Cloudflare define (só o que o painel usa). */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    veraxTurnstileOnload?: () => void;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/** Carrega o script uma vez por página. Resolve quando a Cloudflare chama o `onload` (a API pronta para desenhar). */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const fail = (): void => {
      loading = undefined;
      delete window.veraxTurnstileOnload;
      reject(new Error('o script do Turnstile não carregou'));
    };
    window.veraxTurnstileOnload = () => {
      delete window.veraxTurnstileOnload;
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.addEventListener('error', fail);
    document.head.append(script);
  });
  return loading;
}

/** O tema que o painel está usando (o `theme-init.js` e o `useTheme` escrevem em `data-theme`). */
function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light';
}

export type TurnstileStatus = 'loading' | 'ready' | 'error';

export interface TurnstileHandle {
  /** Onde o widget é desenhado; a tela renderiza um `div` com esta ref enquanto houver chave do site. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** `loading` até o widget aparecer; `error` quando o script não carrega ou a Cloudflare recusa de vez. */
  status: TurnstileStatus;
  /** Token da verificação atual; `undefined` enquanto a pessoa não passou (ou depois de um `reset`). */
  token: string | undefined;
  /** Pede outro token (cada um vale uma vez: depois de um envio recusado, o próximo precisa de um novo). */
  reset: () => void;
}

/**
 * Desenha o widget no contêiner enquanto houver chave do site e o acompanha: tema (redesenha quando o painel troca
 * de tema), token, expiração e erro. Sem chave, não faz nada.
 */
export function useTurnstile(siteKey: string | null | undefined, action: string): TurnstileHandle {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<{ api: TurnstileApi; id: string }>(null);
  const [status, setStatus] = useState<TurnstileStatus>('loading');
  const [token, setToken] = useState<string>();

  useEffect(() => {
    const container = containerRef.current;
    if (!siteKey || !container) return undefined;
    let cancelled = false;
    let observer: MutationObserver | undefined;

    const removeWidget = (): void => {
      const widget = widgetRef.current;
      widgetRef.current = null;
      if (!widget) return;
      try {
        widget.api.remove(widget.id);
      } catch {
        // O widget já pode ter saído da página.
      }
    };

    const render = (api: TurnstileApi): void => {
      removeWidget();
      container.replaceChildren();
      setToken(undefined);
      const id = api.render(container, {
        sitekey: siteKey,
        action,
        theme: currentTheme(),
        // Código como a Cloudflare o escreve (`pt-BR` cai no mesmo idioma, com um aviso no console).
        language: 'pt-br',
        size: 'flexible',
        appearance: 'always',
        // O token vai no header da chamada, não num campo escondido do formulário.
        'response-field': false,
        'refresh-expired': 'auto',
        callback: (value) => {
          if (!cancelled) setToken(value);
        },
        'expired-callback': () => {
          if (!cancelled) setToken(undefined);
        },
        'timeout-callback': () => {
          if (!cancelled) setToken(undefined);
        },
        'error-callback': () => {
          if (cancelled) return;
          setToken(undefined);
          setStatus('error');
        },
      });
      if (id === undefined) {
        setStatus('error');
        return;
      }
      widgetRef.current = { api, id };
      setStatus('ready');
    };

    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        render(api);
        // O tema muda sem recarregar a página: o widget é redesenhado com o tema novo.
        observer = new MutationObserver(() => render(api));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      removeWidget();
    };
  }, [siteKey, action]);

  const reset = useCallback(() => {
    setToken(undefined);
    const widget = widgetRef.current;
    if (widget) widget.api.reset(widget.id);
  }, []);

  return { containerRef, status, token, reset };
}
