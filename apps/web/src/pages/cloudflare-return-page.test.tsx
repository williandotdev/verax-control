import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CloudflareOauthAttempt } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const TIMEOUT = 20_000;
const STATE = `alfa.${'b'.repeat(43)}`;
const CODE = 'codigo-ficticio-0002';
const ATTEMPT = '018f2c1e-0000-7000-8000-00000000cf01';
const CLOUDFLARE_ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0005';
const RETURN = `#code=${CODE}&state=${STATE}&iss=${encodeURIComponent('https://dash.cloudflare.com')}`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});
afterAll(() => server.close());

function attempt(overrides: Partial<CloudflareOauthAttempt>): CloudflareOauthAttempt {
  return {
    id: ATTEMPT,
    status: 'code_received',
    errorCode: null,
    accounts: [],
    accountIdRequired: false,
    cloudAccountIds: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function renderAt(
  path: string,
  state: MockState = { me: demoMe('admin_cliente'), cloudflareOauth: 'one' },
  overrides: Parameters<typeof server.use> = [],
) {
  // A página lê o fragmento da barra de endereço (o roteador em memória não o tem).
  window.history.replaceState(null, '', path);
  server.use(...overrides, ...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('/conexao-cloudflare', { timeout: TIMEOUT }, () => {
  it('limpa a URL antes de concluir, manda só os três campos uma vez e acompanha até a conta conectada', async () => {
    const bodies: unknown[] = [];
    let hashAtCall: string | null = null;
    let reads = 0;
    renderAt(`/conexao-cloudflare${RETURN}`, undefined, [
      http.post(`${API_URL}/v1/cloudflare-oauth/complete`, async ({ request }) => {
        hashAtCall = window.location.hash;
        bodies.push(await request.json());
        return HttpResponse.json({ attemptId: ATTEMPT });
      }),
      http.get(`${API_URL}/v1/cloudflare-oauth/attempts/:id`, () => {
        reads += 1;
        return HttpResponse.json(
          reads === 1 ? attempt({}) : attempt({ status: 'done', cloudAccountIds: [CLOUDFLARE_ACCOUNT] }),
        );
      }),
    ]);
    expect(await screen.findByText(/Conferindo a autorização no Cloudflare/)).toBeInTheDocument();
    const done = await screen.findByText(/Conta conectada\./, undefined, { timeout: 8_000 });
    expect(done.closest('[role="status"]')).toHaveFocus();
    expect(bodies).toEqual([{ code: CODE, state: STATE, iss: 'https://dash.cloudflare.com' }]);
    expect(hashAtCall).toBe('');
    expect(window.location.href).not.toContain(CODE);
    expect(window.location.search).toBe(`?tentativa=${ATTEMPT}`);
    expect(screen.getByRole('link', { name: 'Ver a conta conectada' })).toHaveAttribute(
      'href',
      `/cadastros/contas?conta=${CLOUDFLARE_ACCOUNT}`,
    );
  });

  it('sem sessão, o retorno é descartado: nada vai à API', async () => {
    let completes = 0;
    renderAt(`/conexao-cloudflare${RETURN}`, { me: null, cloudflareOauth: 'one' }, [
      http.post(`${API_URL}/v1/cloudflare-oauth/complete`, () => {
        completes += 1;
        return HttpResponse.json({ attemptId: ATTEMPT });
      }),
    ]);
    await waitFor(() => expect(window.location.hash).toBe(''));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(completes).toBe(0);
  });

  it('recusa do retorno: a mensagem única, com o começar de novo', async () => {
    renderAt(`/conexao-cloudflare${RETURN}`);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('já foi usado ou não é desta sessão');
    expect(alert).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Começar de novo' })).toBeEnabled();
  });

  it('cada falha da tentativa tem a explicação dela', async () => {
    renderAt(`/conexao-cloudflare?tentativa=${ATTEMPT}`, undefined, [
      http.get(`${API_URL}/v1/cloudflare-oauth/attempts/:id`, () =>
        HttpResponse.json(attempt({ status: 'failed', errorCode: 'plan_limit_reached' })),
      ),
    ]);
    expect(await screen.findByRole('alert')).toHaveTextContent('não tem vaga para mais contas');
  });

  it('sem fragmento: explica o que é a página e não chama a API', async () => {
    renderAt('/conexao-cloudflare');
    expect(await screen.findByText(/Esta página só recebe o retorno/)).toBeInTheDocument();
  });

  it('escolha: os nomes do Cloudflare como texto, a conta sem permissão desligada, e a escolha enviada', async () => {
    const user = userEvent.setup();
    const chosen: unknown[] = [];
    renderAt(`/conexao-cloudflare?tentativa=${ATTEMPT}`, undefined, [
      http.get(`${API_URL}/v1/cloudflare-oauth/attempts/:id`, () =>
        HttpResponse.json(
          attempt({
            status: 'choosing',
            accounts: [
              { accountId: 'c0ffee00000000000000000000000b01', name: '<img src=x>', state: 'available' },
              { accountId: 'c0ffee00000000000000000000000b02', name: 'Cliente Demo B', state: 'forbidden' },
            ],
          }),
        ),
      ),
      http.post(`${API_URL}/v1/cloudflare-oauth/attempts/:id/accounts`, async ({ request }) => {
        chosen.push(await request.json());
        return HttpResponse.json(attempt({}), { status: 202 });
      }),
    ]);
    const form = (await screen.findByRole('heading', { name: 'Escolha as contas a monitorar' })).closest(
      'form',
    );
    if (!form) throw new Error('sem formulário');
    expect(within(form).getByText('<img src=x>')).toBeInTheDocument();
    expect(form.querySelector('img')).toBeNull();
    expect(within(form).getByRole('checkbox', { name: /Cliente Demo B/ })).toBeDisabled();
    // A única conta que pode ser monitorada já vem marcada.
    expect(within(form).getByRole('checkbox', { name: /<img src=x>/ })).toBeChecked();
    await user.click(within(form).getByRole('button', { name: 'Monitorar as contas escolhidas' }));
    await waitFor(() => expect(chosen).toEqual([{ accountIds: ['c0ffee00000000000000000000000b01'] }]));
  });
});

describe('Contas cloud no nó com OAuth', { timeout: TIMEOUT }, () => {
  it('autorização revogada: o aviso e o "Conectar de novo"', async () => {
    renderAt(`/cadastros/contas?conta=${CLOUDFLARE_ACCOUNT}`, undefined, [
      http.get(`${API_URL}/v1/cloud-accounts/:id/cloudflare-connection`, () =>
        HttpResponse.json({
          method: 'oauth',
          grant: {
            status: 'reconnect',
            consentedAt: '2026-11-01T12:00:00.000Z',
            lastRefreshAt: null,
            scopes: ['account-settings.read', 'offline_access'],
            accounts: 2,
          },
        }),
      ),
    ]);
    const sheet = await screen.findByRole('dialog', { name: /Conta do Cloudflare/ });
    expect(await within(sheet).findByText('Precisa conectar de novo')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Conectar de novo' })).toBeEnabled();
    expect(within(sheet).getByText(/1 outra conta cadastrada/)).toBeInTheDocument();
    expect(within(sheet).queryByRole('link', { name: /criar o token/ })).toBeNull();
  });

  it('sem o OAuth no nó: o token colado, como antes, e nenhum botão de conectar', async () => {
    renderAt(`/cadastros/contas?conta=${CLOUDFLARE_ACCOUNT}`, {
      me: demoMe('admin_cliente'),
      cloudflareOauth: null,
    });
    const sheet = await screen.findByRole('dialog', { name: /Conta do Cloudflare/ });
    expect(
      await within(sheet).findByRole('link', { name: /criar o token no Cloudflare/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conectar com Cloudflare' })).toBeNull();
  });
});
