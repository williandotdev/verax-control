import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoWebTraffic } from '@/mocks/web-traffic';
import { OriginBand } from './origin-band';
import { readOriginPlace, rememberOriginPlace } from './origin-place';

/** O arquivo do mapa ainda vindo: só o que fica no lugar dele. */
vi.mock('@/components/security/world-map-lazy', () => ({
  LazyWorldMap: ({ fallback }: { fallback: ReactNode }) => fallback,
}));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});
afterAll(() => server.close());

it('a altura do esqueleto, enquanto o arquivo do mapa não vem, não é guardada como a do mapa', async () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(321);
  rememberOriginPlace('pessoa-a', 'cliente-a', 611);
  server.use(
    http.get(`${API_URL}/v1/web-logs/traffic`, () =>
      HttpResponse.json(demoWebTraffic('ok', '24h', new Date())),
    ),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <OriginBand scope="cliente-a" userId="pessoa-a" startCollapsed={false} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // Com a resposta da API (os balanceadores contados), falta só o arquivo do mapa.
  expect(await screen.findByText(/pelos logs de acesso de 3 balanceadores/)).toBeInTheDocument();
  const loading = screen.getByRole('status');
  expect(loading).toHaveTextContent('Carregando o mapa de origens…');
  expect(loading.parentElement?.style.height).toBe('611px');
  expect(callbacks.length).toBeGreaterThan(0);
  act(() => callbacks.forEach((callback) => callback()));
  expect(readOriginPlace('pessoa-a', 'cliente-a')).toEqual({ height: 611 });
});
