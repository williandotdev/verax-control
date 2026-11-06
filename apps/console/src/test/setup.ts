import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from '@/mocks/server';

// As telas esperam a API simulada antes de desenhar; com as suítes rodando juntas, 1 s às vezes não basta.
configure({ asyncUtilTimeout: 3_000 });

// O jsdom não implementa matchMedia (tema do sistema).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  window.localStorage.clear();
  delete document.documentElement.dataset['theme'];
});
afterAll(() => server.close());
