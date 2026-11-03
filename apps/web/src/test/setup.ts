import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// As telas esperam a sessão e os dados antes de desenhar. Com as suítes da API e do painel rodando juntas (pre-push e
// CI), 1 s de espera padrão às vezes não basta; 3 s cobre a carga sem esconder uma tela que nunca chega.
configure({ asyncUtilTimeout: 3_000 });

// O jsdom não implementa matchMedia; os testes de tema controlam a resposta por esta variável.
let prefersDark = false;
export function setPrefersDark(value: boolean): void {
  prefersDark = value;
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: query.includes('dark') ? prefersDark : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset['theme'];
  prefersDark = false;
});
