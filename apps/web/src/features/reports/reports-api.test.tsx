import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { CaseMode } from '@verax/shared';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { useContext } from 'react';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { CasesContext } from '@/features/cases/cases-context';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import { useReport } from './reports-api';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** O que a tela teria: os números com os casos, sem eles, ou nada ainda. */
function Probe({ period }: { period: '7d' | '30d' }) {
  const { data } = useReport('summary', { period }, true);
  return <p>{data === undefined ? 'nada ainda' : data.cases === undefined ? 'sem casos' : 'com casos'}</p>;
}

function Screen({ mode, period }: { mode: CaseMode; period: '7d' | '30d' }) {
  const context = useContext(CasesContext);
  return (
    <CasesContext.Provider value={{ ...context, mode }}>
      <Probe period={period} />
    </CasesContext.Provider>
  );
}

it('os números de antes ficam na tela ao trocar a janela, e não ao ligar ou desligar os casos', async () => {
  server.use(...createHandlers({ me: demoMe('analista_cliente'), cases: 'on' }));
  const client = createQueryClient();
  const view = (mode: CaseMode, period: '7d' | '30d') => (
    <QueryClientProvider client={client}>
      <Screen mode={mode} period={period} />
    </QueryClientProvider>
  );
  const { rerender } = render(view('on', '30d'));
  expect(await screen.findByText('com casos')).toBeInTheDocument();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(`${API_URL}/v1/reports/summary`, async () => {
      await gate;
    }),
  );
  // Só a janela: os números anteriores ficam.
  rerender(view('on', '7d'));
  expect(screen.getByText('com casos')).toBeInTheDocument();
  // Os casos desligados no meio: os números deles somem já.
  rerender(view('off', '7d'));
  expect(screen.getByText('nada ainda')).toBeInTheDocument();
  release();
  await waitFor(() => expect(screen.getByText('sem casos')).toBeInTheDocument());
});
