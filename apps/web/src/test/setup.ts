import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

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
