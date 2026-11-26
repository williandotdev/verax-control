import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { alertExceptionCreatedSchema } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoFindings } from '@/mocks/findings-fixtures';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';
import { createWithOpenAlerts } from './open-alerts-api';
import { openPreviewText, openResolutionText } from './open-alerts-text';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

const FORM_TIMEOUT = 20_000;

function renderAt(path: string, state: MockState = { me: demoMe('admin_cliente') }) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('textos dos alertas em aberto', () => {
  it('a prévia: quantos resolve e quantos ficam em incidente', () => {
    expect(openPreviewText({ resolve: 12, keptInIncident: 3, complete: true })).toBe(
      'Vai resolver 12 alertas em aberto (3 ficam porque estão em incidente).',
    );
    expect(openPreviewText({ resolve: 1, keptInIncident: 1, complete: true })).toBe(
      'Vai resolver 1 alerta em aberto (1 fica porque está em incidente).',
    );
    expect(openPreviewText({ resolve: 4, keptInIncident: 0, complete: false })).toBe(
      'Vai resolver pelo menos 4 alertas em aberto.',
    );
    expect(openPreviewText({ resolve: 0, keptInIncident: 0, complete: true })).toBe(
      'Nenhum alerta em aberto é coberto por ela agora.',
    );
  });

  it('o resultado: resolvidos, os que ficaram e se ainda há mais', () => {
    expect(openResolutionText({ resolved: 2, keptInIncident: 1, more: false })).toBe(
      '2 alertas em aberto resolvidos como legítimos. 1 ficou porque está em incidente.',
    );
    expect(openResolutionText({ resolved: 2000, keptInIncident: 0, more: true })).toBe(
      '2.000 alertas em aberto resolvidos como legítimos. Ainda há alertas em aberto cobertos por ela.',
    );
    expect(openResolutionText({ resolved: 0, keptInIncident: 0, more: false })).toBe(
      'Nenhum alerta em aberto era coberto por ela.',
    );
  });
});

describe('criar pedindo a contagem', () => {
  const created = {
    id: '018f2c1e-0000-7000-8000-00000000e001',
    ruleId: '80202',
    field: 'user',
    value: 'automacao',
    reason: 'Job',
    expiresAt: null,
    active: true,
    matchedCount: 0,
    lastMatchedAt: null,
    createdBy: { id: 'u', name: 'Pessoa Demo' },
    createdAt: '2026-11-26T12:00:00.000Z',
    updatedAt: '2026-11-26T12:00:00.000Z',
  };
  const csrf = http.get(`${API_URL}/v1/csrf-token`, () => HttpResponse.json({ token: 't' }));

  it('um nó de antes recusa o pedido (400, sem campo): cria de novo sem ele, uma vez', async () => {
    const calls: string[] = [];
    server.use(
      csrf,
      http.post(`${API_URL}/v1/alert-exceptions`, ({ request }) => {
        calls.push(new URL(request.url).search);
        if (new URL(request.url).search !== '') {
          return HttpResponse.json(
            {
              message: 'Dados inválidos',
              issues: [{ path: '', message: 'Esta rota não aceita parâmetros de consulta' }],
            },
            { status: 400 },
          );
        }
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const result = await createWithOpenAlerts('/v1/alert-exceptions', {}, alertExceptionCreatedSchema);
    expect(calls).toEqual(['?openAlerts=true', '']);
    expect(result.openAlerts).toBeUndefined();
  });

  it('a recusa do próprio corpo (com campo) não repete a criação', async () => {
    const calls: string[] = [];
    server.use(
      csrf,
      http.post(`${API_URL}/v1/alert-exceptions`, ({ request }) => {
        calls.push(new URL(request.url).search);
        return HttpResponse.json(
          { message: 'Dados inválidos', issues: [{ path: 'value', message: 'IP ou faixa CIDR inválida' }] },
          { status: 400 },
        );
      }),
    );
    await expect(
      createWithOpenAlerts('/v1/alert-exceptions', {}, alertExceptionCreatedSchema),
    ).rejects.toThrow();
    expect(calls).toEqual(['?openAlerts=true']);
  });
});

describe('tela Exceções: a prévia e o resultado', { timeout: FORM_TIMEOUT }, () => {
  it('a exceção nova mostra quantos alertas em aberto vai resolver e, criada, quantos resolveu', async () => {
    const me = demoMe('admin_cliente');
    const open = (demoFindings().get(me.scopeTenantId ?? '') ?? []).find(
      (finding) => finding.status === 'new' && finding.incidentId === null && finding.actor.user !== null,
    );
    expect(open).toBeDefined();
    renderAt('/cadastros/excecoes', { me });
    await userEvent.click(await screen.findByRole('button', { name: 'Nova exceção' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nova exceção' });
    await userEvent.type(within(sheet).getByLabelText(/^Regra/), open?.ruleId ?? '');
    await userEvent.type(within(sheet).getByLabelText(/^Valor/), open?.actor.user ?? '');
    const preview = await within(sheet).findByText(/^Vai resolver \d+/, undefined, { timeout: 5_000 });
    // "Vai resolver N alertas em aberto…": o terceiro termo é o número.
    const expected = (preview.textContent ?? '').split(' ')[2] ?? '';
    expect(Number(expected)).toBeGreaterThan(0);
    await userEvent.type(within(sheet).getByLabelText('Motivo (obrigatório)'), 'Automação conhecida.');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Criar exceção' }));
    const result = await within(sheet).findByRole('status');
    expect(result.textContent?.startsWith(`${expected} alerta`)).toBe(true);
    expect(result).toHaveTextContent('em aberto resolvido');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
