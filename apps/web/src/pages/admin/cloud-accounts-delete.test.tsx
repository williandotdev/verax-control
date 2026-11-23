import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoAdminStore } from '@/mocks/admin';
import { DEMO_ACCOUNTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';
import { readerTemplateHandler } from '@/test/aws-reader-template';

/** O ID é digitado letra por letra: com a suíte inteira em paralelo, passa dos 5 s padrão. */
const FORM_TIMEOUT = 20_000;
/** As contas da demonstração (`account(2, ...)` e `account(5, ...)` em mocks/admin.ts). */
const DEMO_AWS_HOMOLOGACAO_ID = '018f2c1e-0000-7000-8000-0000000c0002';
const DEMO_CLOUDFLARE_ID = '018f2c1e-0000-7000-8000-0000000c0005';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

function renderAt(
  path: string,
  state: MockState = { me: demoMe('admin_cliente') },
  overrides: Parameters<typeof server.use> = [],
) {
  server.use(...overrides, readerTemplateHandler(), ...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Abre a confirmação da exclusão no detalhe da conta e devolve o grupo dela. */
async function openConfirmation(user: ReturnType<typeof userEvent.setup>, sheet: HTMLElement) {
  const zone = await within(sheet).findByRole('region', { name: 'Excluir conta' });
  await user.click(within(zone).getByRole('button', { name: 'Excluir conta…' }));
  return within(zone).getByRole('group', { name: /^Confirmar a exclusão de / });
}

describe('Contas cloud: excluir a conta', { timeout: FORM_TIMEOUT }, () => {
  it('AWS: a confirmação explica o que sai e o que fica; o botão só libera com o ID; excluída, a conta sai da lista', async () => {
    const user = userEvent.setup();
    const router = renderAt(`/cadastros/contas?conta=${DEMO_AWS_HOMOLOGACAO_ID}`);
    const sheet = await screen.findByRole('dialog', { name: `Conta AWS ${DEMO_ACCOUNTS.alfaHomologacao}` });
    // À parte do "Desativar monitoramento", que continua lá.
    expect(within(sheet).getByRole('button', { name: 'Desativar monitoramento' })).toBeEnabled();

    const confirmation = await openConfirmation(user, sheet);
    expect(confirmation).toHaveAccessibleDescription(/O cadastro some do painel e a coleta desta conta para/);
    expect(confirmation).toHaveTextContent('Os achados, os incidentes e o histórico já registrados ficam.');
    expect(confirmation).toHaveTextContent('Nada é apagado na nuvem do cliente.');
    expect(confirmation).toHaveTextContent(/a pilha verax-control-reader continua na conta/);
    expect(confirmation).not.toHaveTextContent('cadastrada pela Verax');
    const field = within(confirmation).getByLabelText(
      `Digite o ID da conta (${DEMO_ACCOUNTS.alfaHomologacao}) para confirmar`,
    );
    expect(field).toHaveFocus();
    const confirm = within(confirmation).getByRole('button', { name: 'Excluir definitivamente' });
    expect(confirm).toBeDisabled();
    await user.type(field, DEMO_ACCOUNTS.alfaProducao);
    expect(confirm).toBeDisabled();
    await user.clear(field);
    await user.type(field, DEMO_ACCOUNTS.alfaHomologacao);
    expect(field).toHaveAccessibleDescription('Confere.');
    await user.click(confirm);

    // O painel fecha, a linha sai da tabela e o aviso recebe o foco.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const notice = screen.getByRole('status', { name: '' });
    expect(notice).toHaveTextContent(`Conta AWS ${DEMO_ACCOUNTS.alfaHomologacao} excluída.`);
    expect(notice).toHaveFocus();
    expect(router.state.location.search).not.toContain('conta=');
    const table = await screen.findByRole('table', { name: 'Contas cloud do cliente' });
    await waitFor(() => expect(table).not.toHaveTextContent(DEMO_ACCOUNTS.alfaHomologacao));
    expect(table).toHaveTextContent(DEMO_ACCOUNTS.alfaProducao);
  });

  it('cancelar fecha a confirmação sem excluir e devolve o foco ao botão', async () => {
    const user = userEvent.setup();
    renderAt(`/cadastros/contas?conta=${DEMO_CLOUDFLARE_ID}`);
    const sheet = await screen.findByRole('dialog', {
      name: (name) => name.includes(DEMO_ACCOUNTS.alfaCloudflare),
    });
    const confirmation = await openConfirmation(user, sheet);
    // Fora da AWS, nada de pilha.
    expect(confirmation).not.toHaveTextContent('verax-control-reader');
    await user.click(within(confirmation).getByRole('button', { name: 'Cancelar' }));
    const zone = within(sheet).getByRole('region', { name: 'Excluir conta' });
    expect(within(zone).queryByRole('group')).not.toBeInTheDocument();
    await waitFor(() => expect(within(zone).getByRole('button', { name: 'Excluir conta…' })).toHaveFocus());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('conta cadastrada pela Verax: o cliente também exclui, e a confirmação diz que a Verax será avisada', async () => {
    const user = userEvent.setup();
    const accounts = [...demoAdminStore().accounts.values()].flat();
    const cloudflare = accounts.find((account) => account.id === DEMO_CLOUDFLARE_ID);
    if (!cloudflare) throw new Error('a conta do Cloudflare da demonstração sumiu');
    let items = [{ ...cloudflare, managedBy: 'verax' as const }];
    const bodies: unknown[] = [];
    renderAt(`/cadastros/contas?conta=${DEMO_CLOUDFLARE_ID}`, undefined, [
      http.get(`${API_URL}/v1/cloud-accounts`, () =>
        HttpResponse.json({ items, page: 1, pageSize: 20, total: items.length }),
      ),
      http.post(`${API_URL}/v1/cloud-accounts/:id/delete`, async ({ request }) => {
        bodies.push(await request.json());
        items = [];
        return new HttpResponse(null, { status: 204 });
      }),
    ]);
    const sheet = await screen.findByRole('dialog', { name: (name) => name.includes(cloudflare.accountId) });
    // A fonte e o monitoramento são da Verax; a exclusão, não.
    expect(within(sheet).getByRole('button', { name: 'Desativar monitoramento' })).toBeDisabled();
    const confirmation = await openConfirmation(user, sheet);
    expect(confirmation).toHaveTextContent('Esta conta foi cadastrada pela Verax; a Verax será avisada.');
    await user.type(within(confirmation).getByRole('textbox'), cloudflare.accountId);
    await user.click(within(confirmation).getByRole('button', { name: 'Excluir definitivamente' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bodies).toEqual([{ confirmAccountId: cloudflare.accountId }]);
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent(
      `Conta do Cloudflare ${cloudflare.accountId} excluída.`,
    );
  });

  it.each([
    [
      'o ID recusado pela API (400 ACCOUNT_ID_MISMATCH)',
      HttpResponse.json(
        { message: 'O ID digitado não é o desta conta: nada foi excluído.', code: 'ACCOUNT_ID_MISMATCH' },
        { status: 400 },
      ),
      'O ID digitado não é o desta conta: nada foi excluído. Confira e digite de novo.',
    ],
    [
      'a conta que já não existe (404)',
      HttpResponse.json({ message: 'Conta não encontrada' }, { status: 404 }),
      'Esta conta não existe mais (talvez já tenha sido excluída). Atualize a lista.',
    ],
    [
      'sem permissão (403)',
      HttpResponse.json({ message: 'Sem permissão' }, { status: 403 }),
      'Sem permissão para excluir contas: peça a um administrador do cliente.',
    ],
  ])('%s: o erro aparece junto da confirmação, e nada sai da lista', async (_label, reply, message) => {
    const user = userEvent.setup();
    renderAt(`/cadastros/contas?conta=${DEMO_CLOUDFLARE_ID}`, undefined, [
      http.post(`${API_URL}/v1/cloud-accounts/:id/delete`, () => reply.clone()),
    ]);
    const sheet = await screen.findByRole('dialog', {
      name: (name) => name.includes(DEMO_ACCOUNTS.alfaCloudflare),
    });
    const confirmation = await openConfirmation(user, sheet);
    await user.type(within(confirmation).getByRole('textbox'), DEMO_ACCOUNTS.alfaCloudflare);
    await user.click(within(confirmation).getByRole('button', { name: 'Excluir definitivamente' }));
    expect(await within(confirmation).findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '' })).not.toBeInTheDocument();
  });

  it('quem só lê não vê a exclusão', async () => {
    renderAt(`/cadastros/contas?conta=${DEMO_CLOUDFLARE_ID}`, { me: demoMe('leitura') });
    const sheet = await screen.findByRole('dialog', {
      name: (name) => name.includes(DEMO_ACCOUNTS.alfaCloudflare),
    });
    expect(within(sheet).queryByRole('region', { name: 'Excluir conta' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Excluir/ })).not.toBeInTheDocument();
  });
});
