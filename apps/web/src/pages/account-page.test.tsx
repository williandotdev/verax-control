import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { notificationPreferencesSchema } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoMe, DEMO_TENANTS } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

function renderAt(path: string, state: MockState, overrides: Parameters<typeof server.use> = []) {
  server.use(...overrides, ...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const PREFERENCE = 'Receber os avisos de incidente por e-mail';

describe("Minha conta: preferência de aviso por e-mail (PR-17')", () => {
  it('o cabeçalho leva a Minha conta, com o e-mail e o papel da sessão', async () => {
    const router = renderAt('/', { me: demoMe('analista_cliente') });
    await userEvent.click(await screen.findByRole('link', { name: 'Minha conta' }));
    expect(router.state.location.pathname).toBe('/minha-conta');
    expect(await screen.findByRole('heading', { level: 1, name: 'Minha conta' })).toBeInTheDocument();
    const access = screen.getByRole('region', { name: 'Acesso' });
    expect(access).toHaveTextContent('analista.cliente@demo.verax.local');
    expect(access).toHaveTextContent('Analista do cliente');
  });

  it('analista: recebe por padrão; desligar e religar a própria preferência, com a confirmação na tela', async () => {
    const state: MockState = { me: demoMe('analista_cliente') };
    renderAt('/minha-conta', state);
    const card = await screen.findByRole('region', { name: 'Avisos por e-mail' });
    const box = await within(card).findByRole('checkbox', { name: PREFERENCE });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(/No máximo 5 e-mails por hora/);
    // Só o administrador lê que os avisos do plano e da coleta continuam.
    expect(card).not.toHaveTextContent('volume do plano');

    await userEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    // Salvar não tira o foco do teclado da caixa.
    expect(box).toHaveFocus();
    expect(await within(card).findByRole('status')).toHaveTextContent(
      'Pronto: você deixa de receber os avisos de incidente por e-mail.',
    );
    // A API simulada guardou a escolha (a mesma resposta da leitura).
    await expect(api.get('/v1/notification-preferences', notificationPreferencesSchema)).resolves.toEqual({
      incidentEmails: false,
      eligible: true,
    });

    await userEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(within(card).getByRole('status')).toHaveTextContent('Pronto: você volta a receber');
  });

  it('administrador: os avisos do plano e da coleta da AWS não dependem da opção', async () => {
    renderAt('/minha-conta', { me: demoMe('admin_cliente') });
    const box = await screen.findByRole('checkbox', { name: PREFERENCE });
    expect(box).toHaveAccessibleDescription(/volume do plano e da coleta da AWS chegam a quem administra/);
  });

  it('leitura e equipe da Verax: a tela diz que o papel não recebe, sem a opção', async () => {
    renderAt('/minha-conta', { me: demoMe('leitura') });
    const card = await screen.findByRole('region', { name: 'Avisos por e-mail' });
    expect(
      await within(card).findByText(/O papel Somente leitura não recebe avisos por e-mail/),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('equipe da Verax, com um cliente selecionado: não recebe os avisos dos clientes', async () => {
    const tenant = DEMO_TENANTS[0]?.id ?? null;
    renderAt('/minha-conta', {
      me: demoMe('admin_verax', { activeTenantId: tenant, scopeTenantId: tenant }),
    });
    const card = await screen.findByRole('region', { name: 'Avisos por e-mail' });
    expect(
      await within(card).findByText('A equipe da Verax não recebe por e-mail os avisos dos clientes.'),
    ).toBeInTheDocument();
    expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('a falha ao salvar aparece junto da opção, e a escolha da tela volta à guardada', async () => {
    renderAt('/minha-conta', { me: demoMe('analista_cliente') }, [
      http.put(`${API_URL}/v1/notification-preferences`, () =>
        HttpResponse.json({ statusCode: 503, message: 'Serviço indisponível' }, { status: 503 }),
      ),
    ]);
    const box = await screen.findByRole('checkbox', { name: PREFERENCE });
    await userEvent.click(box);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(box).toBeChecked();
  });

  it('o mock recusa como a API: leitura (403) e a equipe da Verax (403 com o código)', async () => {
    const state: MockState = { me: demoMe('leitura') };
    server.use(...createHandlers(state));
    const put = (incidentEmails: boolean) =>
      api.put('/v1/notification-preferences', { incidentEmails }, notificationPreferencesSchema);
    await expect(put(false)).rejects.toMatchObject({ status: 403 });
    state.me = demoMe('admin_verax');
    await expect(put(false)).rejects.toMatchObject({ status: 403, code: 'NOTICES_NOT_FOR_ROLE' });
    state.me = demoMe('analista_cliente');
    await expect(put(false)).resolves.toEqual({ incidentEmails: false, eligible: true });
  });
});
