import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

function renderAt(path: string, state: MockState = { me: demoMe('analista_cliente') }) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const checkRows = async () =>
  within(await screen.findByRole('table', { name: 'Checagens reprovadas na última varredura' }))
    .getAllByRole('row')
    .slice(1);

describe('Postura cloud', () => {
  it('nota e evolução por conta, e as checagens da mais grave à menos grave', async () => {
    renderAt('/postura');
    const prod = await screen.findByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaProducao}` });
    expect(within(prod).getByRole('meter', { name: 'Nota de postura' })).toHaveAttribute(
      'aria-valuenow',
      '61',
    );
    expect(
      within(prod).getByRole('img', { name: /Evolução da nota da conta 111122223333: de \d+ em/ }),
    ).toBeInTheDocument();
    expect(prod).toHaveTextContent('148 aprovadas e 12 reprovadas: 2 críticas, 4 altas, 4 médias, 2 baixas.');
    const homolog = screen.getByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaHomologacao}` });
    expect(within(homolog).getByRole('meter')).toHaveAttribute('aria-valuenow', '72');

    const rows = await checkRows();
    expect(rows).toHaveLength(17);
    const order = rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent);
    expect(order.slice(0, 2)).toEqual(['Crítico', 'Crítico']);
    expect(order.at(-1)).toBe('Baixo');
  });

  it('o atalho da conta filtra as checagens dela', async () => {
    const router = renderAt('/postura');
    const homolog = await screen.findByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaHomologacao}` });
    await userEvent.click(within(homolog).getByRole('button', { name: 'Ver o que corrigir nesta conta' }));
    await waitFor(() => expect(router.state.location.search).toBe(`?conta=${DEMO_ACCOUNTS.alfaHomologacao}`));
    await waitFor(async () => expect(await checkRows()).toHaveLength(5));
    for (const row of await checkRows()) expect(row).toHaveTextContent(DEMO_ACCOUNTS.alfaHomologacao);
  });

  it('filtro por gravidade', async () => {
    renderAt('/postura?severidade=critical');
    const rows = await checkRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Bucket S3 com leitura pública');
  });

  it('o detalhe diz por que importa, como corrigir e leva à referência em outra aba', async () => {
    renderAt('/postura?severidade=critical');
    await userEvent.click(await screen.findByRole('button', { name: /Usuário root sem MFA/ }));
    const panel = await screen.findByRole('dialog', { name: 'Usuário root sem MFA' });
    expect(within(panel).getByRole('region', { name: 'Por que importa' })).toHaveTextContent(
      'controla a conta inteira',
    );
    expect(within(panel).getByRole('region', { name: 'Como corrigir' })).toHaveTextContent(
      'ative um dispositivo de MFA',
    );
    // Comparação exata do endereço e do nome (nada de prefixo de URL).
    const link = within(panel).getByRole('link');
    expect(link).toHaveAttribute(
      'href',
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-virt-mfa-for-root.html',
    );
    expect(link).toHaveAccessibleName('docs.aws.amazon.com (abre em outra aba)');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('o gráfico mostra a nota de cada dia pelas setas do teclado', async () => {
    renderAt('/postura');
    const prod = await screen.findByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaProducao}` });
    const chart = within(prod).getByRole('img', { name: /Evolução da nota/ });
    chart.focus();
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(within(prod).getByText(/· nota/)).toBeInTheDocument();
    // Os mesmos números estão na tabela para leitor de tela: 30 dias.
    const table = within(prod).getByRole('table', { name: /Evolução da nota/, hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(31);
  });

  it('varredura sem nota (só checagens que não pesam) continua mostrando os resultados', async () => {
    renderAt('/postura');
    server.use(
      http.get(`${API_URL}/v1/posture`, () =>
        HttpResponse.json({
          score: null,
          warningBelow: 70,
          accounts: [
            {
              accountId: DEMO_ACCOUNTS.alfaProducao,
              score: null,
              scannedAt: new Date().toISOString(),
              passed: 0,
              failed: 1,
              failedBySeverity: { critical: 0, high: 0, medium: 0, low: 0, informational: 1 },
              history: [],
            },
          ],
        }),
      ),
    );
    const card = await screen.findByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaProducao}` });
    expect(card).toHaveTextContent('Sem nota nesta varredura');
    expect(card).toHaveTextContent('0 aprovadas e 1 reprovadas: 1 informativa.');
    expect(screen.queryByText('Ainda sem varredura')).not.toBeInTheDocument();
    expect(
      await screen.findByRole('table', { name: 'Checagens reprovadas na última varredura' }),
    ).toBeInTheDocument();
  });

  it('cliente sem varredura ainda', async () => {
    renderAt('/postura');
    server.use(
      http.get(`${API_URL}/v1/posture`, () =>
        HttpResponse.json({ score: null, warningBelow: 70, accounts: [] }),
      ),
    );
    expect(await screen.findByText('Ainda sem varredura')).toBeInTheDocument();
  });

  it('admin_verax sem cliente escolhido é orientado a escolher um', async () => {
    renderAt('/postura', { me: demoMe('admin_verax') });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
  });
});
