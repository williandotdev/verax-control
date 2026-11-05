import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_BUCKET_MESSAGE } from '@/features/admin/aws-log-buckets';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, DEMO_ALFA_MORE_BUCKETS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

// Os formulários são preenchidos letra por letra: com a suíte inteira em paralelo, passam dos 5 s padrão.
const FORM_TIMEOUT = 15_000;
/** A conta AWS conectada da demonstração (`account(1, ...)` em mocks/admin.ts), com os três buckets. */
const DEMO_AWS_ALFA_ID = '018f2c1e-0000-7000-8000-0000000c0001';
const ALFA = DEMO_ACCOUNTS.alfaProducao;
const TRAIL = `trilha-${ALFA}`;
const WAF_MESSAGE =
  'O bucket do WAF começa com aws-waf-logs-: a AWS só grava o log do WAF num bucket com esse começo.';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

/** Os pedidos de "Verificar" que chegaram ao mock: trocar os buckets não pode pedir nada à AWS sozinho. */
function renderAt(path: string, state: MockState = { me: demoMe('admin_cliente') }) {
  const verifyCalls: string[] = [];
  server.use(
    http.post(`${API_URL}/v1/cloud-accounts/:id/aws/verify`, ({ params }) => {
      verifyCalls.push(String(params['id']));
      return undefined;
    }),
    ...createHandlers(state),
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { verifyCalls };
}

async function openAlfa(state?: MockState) {
  const rendered = renderAt(`/cadastros/contas?conta=${DEMO_AWS_ALFA_ID}`, state);
  const sheet = await screen.findByRole('dialog', { name: `Conta AWS ${ALFA}` });
  const section = within(sheet).getByRole('region', { name: 'Buckets de log' });
  const steps = within(sheet).getByRole('region', { name: `Conectar a conta ${ALFA}` });
  return { ...rendered, sheet, section, steps };
}

const rowOf = (container: HTMLElement, position: number) =>
  within(within(container).getByRole('group', { name: `Bucket ${position}` }));

describe('buckets de log da conta AWS (painel)', { timeout: FORM_TIMEOUT }, () => {
  it('a conta mostra os três buckets, um por fonte; sem fonte livre, não há o que adicionar', async () => {
    const { section } = await openAlfa();
    expect(rowOf(section, 1).getByLabelText('Fonte')).toHaveValue('cloudtrail');
    expect(rowOf(section, 1).getByLabelText('Nome do bucket')).toHaveValue(TRAIL);
    expect(rowOf(section, 2).getByLabelText('Fonte')).toHaveValue('guardduty');
    expect(rowOf(section, 2).getByLabelText('Nome do bucket')).toHaveValue(DEMO_ALFA_MORE_BUCKETS.guardduty);
    expect(rowOf(section, 3).getByLabelText('Fonte')).toHaveValue('waf');
    expect(rowOf(section, 3).getByLabelText('Nome do bucket')).toHaveAccessibleDescription(
      /Começa com aws-waf-logs-/,
    );
    // Cada fonte numa linha só: no seletor, as das outras linhas aparecem desligadas.
    const options = within(rowOf(section, 1).getByLabelText('Fonte')).getAllByRole('option');
    expect(
      options.map((option) => [option.getAttribute('value'), (option as HTMLOptionElement).disabled]),
    ).toEqual([
      ['cloudtrail', false],
      ['guardduty', true],
      ['waf', true],
    ]);
    expect(within(section).queryByRole('button', { name: 'Adicionar bucket' })).not.toBeInTheDocument();
    expect(within(section).getByText('As três fontes já têm bucket.')).toBeInTheDocument();
  });

  it('trocar o bucket do WAF: o erro fica no campo (com o foco), e a lista nova pede a pilha atualizada e o Verificar, sem pedir nada à AWS', async () => {
    const user = userEvent.setup();
    const { sheet, section, steps, verifyCalls } = await openAlfa();
    // Remover devolve o foco para "Adicionar bucket"; adicionar põe o foco no nome da linha nova (a fonte livre).
    await user.click(within(section).getByRole('button', { name: 'Remover o bucket 3 (WAF)' }));
    const add = within(section).getByRole('button', { name: 'Adicionar bucket' });
    expect(add).toHaveFocus();
    await user.keyboard('{Enter}');
    const name = rowOf(section, 3).getByLabelText('Nome do bucket');
    expect(name).toHaveFocus();
    expect(rowOf(section, 3).getByLabelText('Fonte')).toHaveValue('waf');

    await user.type(name, 'logs-do-waf');
    await user.click(within(section).getByRole('button', { name: 'Salvar buckets' }));
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(expect.stringContaining(WAF_MESSAGE));
    expect(name).toHaveFocus();

    // O ARN colado vira o nome.
    await user.clear(name);
    await user.type(name, 'arn:aws:s3:::aws-waf-logs-loja-alfa-nova');
    await user.click(within(section).getByRole('button', { name: 'Salvar buckets' }));
    expect(await within(section).findByRole('status')).toHaveTextContent(
      /Buckets salvos, e a lista mudou\. Se a pilha verax-control-reader já existe na conta, atualize o LogBucketArns/,
    );
    expect(rowOf(section, 3).getByLabelText('Nome do bucket')).toHaveValue('aws-waf-logs-loja-alfa-nova');
    // O passo 2 e o comando da CLI já trazem a lista nova.
    const arns = [
      `arn:aws:s3:::${TRAIL}`,
      `arn:aws:s3:::${DEMO_ALFA_MORE_BUCKETS.guardduty}`,
      'arn:aws:s3:::aws-waf-logs-loja-alfa-nova',
    ].join(',');
    expect(await within(steps).findByText(arns)).toBeInTheDocument();
    expect(within(steps).getByText(/^aws cloudformation deploy/)).toHaveTextContent(`LogBucketArns=${arns}`);
    // A conexão volta a aguardar, e o que fazer está no selo; o Verificar fica com o cliente.
    expect(within(sheet).getByText('Conexão').nextElementSibling).toHaveTextContent(
      'Aguardando uma nova verificação: se os buckets mudaram, atualize a pilha na conta; depois, clique em Verificar.',
    );
    expect(within(steps).getByRole('button', { name: 'Verificar conexão' })).toBeEnabled();
    expect(verifyCalls).toEqual([]);
  });

  it('salvar os mesmos nomes não muda a conexão nem pede a pilha', async () => {
    const user = userEvent.setup();
    const { sheet, section } = await openAlfa();
    await user.click(within(section).getByRole('button', { name: 'Salvar buckets' }));
    expect(await within(section).findByRole('status')).toHaveTextContent(
      'Buckets salvos. Os nomes são os mesmos: a pilha não precisa mudar.',
    );
    expect(within(sheet).getByText('Conexão').nextElementSibling).toHaveTextContent(/^Conectada/);
  });

  it('o bucket de outro cliente é recusado como na API (409), com a mensagem, sem mudar a lista', async () => {
    const user = userEvent.setup();
    const { section, steps } = await openAlfa();
    const name = rowOf(section, 2).getByLabelText('Nome do bucket');
    await user.clear(name);
    // A trilha da conta do Cliente Demo Beta.
    await user.type(name, `trilha-${DEMO_ACCOUNTS.beta}`);
    await user.click(within(section).getByRole('button', { name: 'Salvar buckets' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      `O bucket trilha-${DEMO_ACCOUNTS.beta} já está cadastrado em outro cliente`,
    );
    expect(within(steps).getByText(/^aws cloudformation deploy/)).toHaveTextContent(
      `arn:aws:s3:::${DEMO_ALFA_MORE_BUCKETS.guardduty}`,
    );
  });

  it('tirar todos os buckets: o LogBucketArns fica vazio, também no comando que atualiza a pilha', async () => {
    const user = userEvent.setup();
    const { section, steps } = await openAlfa();
    for (const label of [
      'Remover o bucket 3 (WAF)',
      'Remover o bucket 2 (GuardDuty)',
      'Remover o bucket 1 (CloudTrail)',
    ]) {
      await user.click(within(section).getByRole('button', { name: label }));
    }
    expect(within(section).getByText('Nenhum bucket na lista.')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Salvar buckets' }));
    expect(await within(section).findByRole('status')).toHaveTextContent(/a lista mudou/);
    expect(
      await within(steps).findByText(/^Nenhum bucket de log cadastrado nesta conta/),
    ).toBeInTheDocument();
    expect(
      within(steps)
        .getByText(/^aws cloudformation deploy/)
        .textContent?.endsWith('LogBucketArns=""'),
    ).toBe(true);
  });

  it('quem só lê vê os buckets, sem o formulário', async () => {
    const { section } = await openAlfa({ me: demoMe('leitura') });
    expect(within(section).getByText('CloudTrail').nextElementSibling).toHaveTextContent(TRAIL);
    expect(within(section).getByText('WAF').nextElementSibling).toHaveTextContent(DEMO_ALFA_MORE_BUCKETS.waf);
    expect(within(section).getByText('Quem administra as contas altera os buckets.')).toBeInTheDocument();
    expect(within(section).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  it('cadastro: os buckets entram junto, com o erro de cada linha ao lado do campo, e vão para o LogBucketArns', async () => {
    const user = userEvent.setup();
    renderAt('/cadastros/contas');
    await user.click(await screen.findByRole('button', { name: 'Cadastrar conta' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cadastrar conta' });
    const buckets = within(sheet).getByRole('group', { name: 'Buckets de log (opcional)' });
    expect(within(buckets).getByText('Nenhum bucket na lista.')).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText('ID da conta AWS'), '135792468024');

    await user.click(within(buckets).getByRole('button', { name: 'Adicionar bucket' }));
    expect(rowOf(buckets, 1).getByLabelText('Fonte')).toHaveValue('cloudtrail');
    await user.keyboard('exemplo-cloudtrail-logs');
    await user.click(within(buckets).getByRole('button', { name: 'Adicionar bucket' }));
    expect(rowOf(buckets, 2).getByLabelText('Fonte')).toHaveValue('guardduty');
    await user.click(within(buckets).getByRole('button', { name: 'Adicionar bucket' }));
    expect(rowOf(buckets, 3).getByLabelText('Fonte')).toHaveValue('waf');
    await user.keyboard('aws-waf-logs-exemplo');

    // O GuardDuty ficou sem nome: o erro fica na linha, e nada é cadastrado.
    await user.click(within(sheet).getByRole('button', { name: 'Cadastrar conta' }));
    expect(rowOf(buckets, 2).getByLabelText('Nome do bucket')).toHaveAccessibleDescription(
      expect.stringContaining(EMPTY_BUCKET_MESSAGE),
    );
    expect(rowOf(buckets, 1).getByLabelText('Nome do bucket')).not.toHaveAttribute('aria-invalid');
    await user.click(within(buckets).getByRole('button', { name: 'Remover o bucket 2 (GuardDuty)' }));
    expect(within(buckets).getByRole('button', { name: 'Adicionar bucket' })).toHaveFocus();

    await user.click(within(sheet).getByRole('button', { name: 'Cadastrar conta' }));
    expect(await within(sheet).findByText(/Conta AWS 135792468024 cadastrada/)).toBeInTheDocument();
    const steps = within(sheet).getByRole('region', { name: 'Conectar a conta 135792468024' });
    expect(
      within(steps).getByText('arn:aws:s3:::exemplo-cloudtrail-logs,arn:aws:s3:::aws-waf-logs-exemplo'),
    ).toBeInTheDocument();
  });
});
