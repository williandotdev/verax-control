import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  GLOBAL_KEY_REFUSED_MESSAGE,
  paginatedSchema,
  temporaryPasswordSchema,
  tenantCreatedSchema,
  tenantSummarySchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import {
  DEMO_ACCOUNTS,
  DEMO_CLOUDFLARE_TOKEN_SUFFIX,
  DEMO_EGRESS_IPS,
  DEMO_SINK_TOPIC_PREFIX,
  demoMe,
} from '@/mocks/fixtures';
import { demoAdminStore } from '@/mocks/admin';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

// Os formulários são preenchidos letra por letra: com a suíte inteira em paralelo, passam dos 5 s padrão.
const FORM_TIMEOUT = 15_000;

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
  client: QueryClient = createQueryClient(),
  /** Respostas que valem antes das do mock (o MSW usa a primeira que casa). */
  overrides: Parameters<typeof server.use> = [],
) {
  server.use(...overrides, ...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const rowsOf = async (caption: string) =>
  within(await screen.findByRole('table', { name: caption }))
    .getAllByRole('row')
    .slice(1);

/** A senha temporária do mock tem o formato da API: quatro grupos de cinco, sem caracteres ambíguos. */
const TEMPORARY_PASSWORD =
  /^[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}$/;

describe('Clientes (T7.1)', { timeout: FORM_TIMEOUT }, () => {
  it('lista, valida e cadastra com o primeiro administrador; a senha temporária dele aparece uma vez', async () => {
    // Com `setup`, a área de transferência simulada do user-event recebe a cópia.
    const user = userEvent.setup();
    renderAt('/cadastros/clientes', { me: demoMe('admin_verax') });
    expect(await rowsOf('Clientes')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Novo cliente' }));
    const sheet = await screen.findByRole('dialog', { name: 'Novo cliente' });
    await user.click(within(sheet).getByRole('button', { name: 'Cadastrar cliente' }));
    expect(within(sheet).getByLabelText('Nome')).toHaveAccessibleDescription('Preencha este campo.');
    expect(within(sheet).getByLabelText('Nome do administrador')).toHaveAccessibleDescription(
      'Preencha este campo.',
    );

    await user.type(within(sheet).getByLabelText('Nome'), 'Cliente Novo Gama');
    await user.type(within(sheet).getByLabelText(/^CNPJ/), '45.723.174/0001-10');
    await user.type(within(sheet).getByLabelText('Plano'), 'Postura');
    await user.type(within(sheet).getByLabelText('Nome do contato'), 'Gabriel Lima');
    await user.type(within(sheet).getByLabelText('E-mail do contato'), 'gabriel@exemplo.com.br');
    await user.type(within(sheet).getByLabelText('Nome do administrador'), 'Helena Prado');
    await user.type(within(sheet).getByLabelText('E-mail do administrador'), 'helena-sem-arroba');
    await user.click(within(sheet).getByRole('button', { name: 'Cadastrar cliente' }));
    expect(within(sheet).getByLabelText('E-mail do administrador')).toHaveAccessibleDescription(
      'E-mail inválido.',
    );
    await user.clear(within(sheet).getByLabelText('E-mail do administrador'));
    await user.type(within(sheet).getByLabelText('E-mail do administrador'), 'helena@exemplo.com.br');
    await user.click(within(sheet).getByRole('button', { name: 'Cadastrar cliente' }));

    // O formulário sai da tela; no lugar, a senha temporária do administrador, com o foco.
    const notice = await within(sheet).findByRole('region', { name: 'Senha temporária de Helena Prado' });
    expect(within(sheet).getByRole('status')).toHaveTextContent(
      'Cliente Cliente Novo Gama cadastrado. Conta de Helena Prado (helena@exemplo.com.br) criada como administrador do cliente.',
    );
    expect(within(notice).getByRole('heading', { name: 'Senha temporária de Helena Prado' })).toHaveFocus();
    const password = within(notice).getByText(TEMPORARY_PASSWORD);
    expect(password.tagName).toBe('CODE');
    expect(notice).toHaveTextContent('Ela só aparece agora.');
    expect(notice).toHaveTextContent('canal seguro');
    expect(notice).toHaveTextContent(
      'No primeiro login, a pessoa troca esta senha por uma só dela e cadastra o MFA.',
    );
    await user.click(within(notice).getByRole('button', { name: 'Copiar' }));
    expect(await within(notice).findByRole('button', { name: 'Copiada' })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(password.textContent);

    await user.click(within(notice).getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(async () => expect(await rowsOf('Clientes')).toHaveLength(4));

    // Reabrir o cadastro não traz a senha de volta.
    await user.click(screen.getByRole('button', { name: 'Novo cliente' }));
    const again = await screen.findByRole('dialog', { name: 'Novo cliente' });
    expect(within(again).getByLabelText('Nome do administrador')).toHaveValue('');
    expect(within(again).queryByText(password.textContent ?? '')).not.toBeInTheDocument();
  });

  it('edita e desativa um cliente existente, sem o primeiro administrador no formulário', async () => {
    renderAt('/cadastros/clientes', { me: demoMe('admin_verax') });
    await userEvent.click(await screen.findByRole('button', { name: 'Cliente Demo Beta' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cliente' });
    expect(await within(sheet).findByDisplayValue('Postura e alertas')).toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Nome do administrador')).not.toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Desativar cliente' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const beta = (await rowsOf('Clientes')).find((row) => row.textContent?.includes('Beta')) as HTMLElement;
    await waitFor(() => expect(beta).toHaveTextContent('Inativo'));
  });

  it('o mock recusa como a API: e-mail do administrador já usado em qualquer cliente (409), sem criar o cliente', async () => {
    const state: MockState = { me: demoMe('admin_verax') };
    server.use(...createHandlers(state));
    const body = (email: string) => ({
      name: 'Cliente Repetido',
      cnpj: '04.252.011/0001-10',
      plan: 'Postura',
      escalationContact: { name: 'Ana', email: 'ana@exemplo.com.br' },
      firstAdmin: { name: 'Marina Alves', email },
    });
    await expect(api.post('/v1/tenants', body('marina.alves@exemplo.com.br'))).rejects.toMatchObject({
      status: 409,
    });
    const list = await api.get('/v1/tenants?pageSize=100', paginatedSchema(tenantSummarySchema));
    expect(list.items.some((tenant) => tenant.name === 'Cliente Repetido')).toBe(false);
    const created = await api.post('/v1/tenants', body('nova@exemplo.com.br'), tenantCreatedSchema);
    expect(created.firstAdmin).toMatchObject({ name: 'Marina Alves', email: 'nova@exemplo.com.br' });
    expect(created.firstAdmin.temporaryPassword).toMatch(TEMPORARY_PASSWORD);
  });
});

describe('Usuários (T7.2)', { timeout: FORM_TIMEOUT }, () => {
  it('cria com validação; a senha temporária aparece uma vez, e a lista indica quem ainda está com ela', async () => {
    // Com `setup`, a área de transferência simulada do user-event recebe a cópia.
    const user = userEvent.setup();
    renderAt('/cadastros/usuarios');
    const before = await rowsOf('Usuários do cliente');
    expect(before).toHaveLength(6);
    expect(before.find((row) => row.textContent?.includes('Carlos Dev'))).toHaveTextContent(
      'Com senha temporária',
    );
    expect(before.find((row) => row.textContent?.includes('Ana Souza'))).not.toHaveTextContent(
      'Com senha temporária',
    );

    await user.click(screen.getByRole('button', { name: 'Criar usuário' }));
    let sheet = await screen.findByRole('dialog', { name: 'Criar usuário' });
    await user.type(within(sheet).getByLabelText('Nome'), 'Bruna Melo');
    await user.type(within(sheet).getByLabelText('E-mail'), 'bruna-sem-arroba');
    await user.click(within(sheet).getByRole('button', { name: 'Criar usuário' }));
    expect(within(sheet).getByLabelText('E-mail')).toHaveAccessibleDescription('E-mail inválido.');
    await user.clear(within(sheet).getByLabelText('E-mail'));
    await user.type(within(sheet).getByLabelText('E-mail'), 'bruna@exemplo.com.br');
    await user.selectOptions(within(sheet).getByLabelText('Papel'), 'leitura');
    await user.click(within(sheet).getByRole('button', { name: 'Criar usuário' }));

    const notice = await within(sheet).findByRole('region', { name: 'Senha temporária de Bruna Melo' });
    expect(within(sheet).getByRole('status')).toHaveTextContent(
      'Conta de Bruna Melo (bruna@exemplo.com.br) criada.',
    );
    // O formulário saiu da tela: o foco vai para a senha.
    expect(within(notice).getByRole('heading', { name: 'Senha temporária de Bruna Melo' })).toHaveFocus();
    const password = within(notice).getByText(TEMPORARY_PASSWORD);
    expect(password.tagName).toBe('CODE');
    expect(notice).toHaveTextContent('Ela só aparece agora.');
    expect(notice).toHaveTextContent('canal seguro');
    expect(notice).toHaveTextContent(/Vale até \d{2}\/\d{2}\/\d{4},? \d{2}:\d{2} \(72 horas\)/);
    expect(notice).toHaveTextContent(
      'No primeiro login, a pessoa troca esta senha por uma só dela e cadastra o MFA.',
    );

    await user.click(within(notice).getByRole('button', { name: 'Copiar' }));
    expect(await within(notice).findByRole('button', { name: 'Copiada' })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe(password.textContent);

    await user.click(within(notice).getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(async () =>
      expect(
        (await rowsOf('Usuários do cliente')).find((row) =>
          row.textContent?.includes('bruna@exemplo.com.br'),
        ),
      ).toHaveTextContent('Com senha temporária'),
    );

    // Reabrir o cadastro não traz a senha de volta.
    await user.click(screen.getByRole('button', { name: 'Criar usuário' }));
    sheet = await screen.findByRole('dialog', { name: 'Criar usuário' });
    expect(within(sheet).getByLabelText('Nome')).toHaveValue('');
    expect(within(sheet).queryByText(password.textContent ?? '')).not.toBeInTheDocument();
  });

  it('gera senha temporária só depois da confirmação, e a nova aparece uma vez', async () => {
    renderAt('/cadastros/usuarios');
    await userEvent.click(await screen.findByRole('button', { name: /Ana Souza/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Ana Souza' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Gerar senha temporária' }));
    const confirmation = within(sheet).getByRole('group', { name: 'Confirmação' });
    expect(confirmation).toHaveAccessibleDescription(
      'A senha atual de Ana Souza deixa de valer, e as sessões abertas da conta caem na hora.',
    );
    // Desistir não gera nada.
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Cancelar' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Gerar senha temporária' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Gerar e encerrar as sessões' }));

    const notice = await within(sheet).findByRole('region', { name: 'Senha temporária de Ana Souza' });
    expect(within(sheet).getByRole('status')).toHaveTextContent(
      'A anterior deixou de valer, e as sessões abertas foram encerradas.',
    );
    const password = within(notice).getByText(TEMPORARY_PASSWORD).textContent ?? '';
    // Ana já tem MFA: ele continua valendo.
    expect(notice).toHaveTextContent('O MFA já cadastrado continua valendo.');

    await userEvent.click(within(notice).getByRole('button', { name: 'Concluir' }));
    expect(
      await within(sheet).findByText('Ainda com a senha temporária: não entrou nem trocou a senha.'),
    ).toBeInTheDocument();
    expect(within(sheet).queryByText(password)).not.toBeInTheDocument();
  });

  it('troca o papel e desativa o acesso; conta desativada não recebe senha temporária', async () => {
    renderAt('/cadastros/usuarios');
    await userEvent.click(await screen.findByRole('button', { name: /Ana Souza/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Ana Souza' });
    await userEvent.selectOptions(within(sheet).getByLabelText('Papel'), 'leitura');
    await waitFor(() => expect(within(sheet).getByLabelText('Papel')).toHaveValue('leitura'));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Desativar acesso' }));
    expect(await within(sheet).findByRole('button', { name: 'Reativar acesso' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Gerar senha temporária' })).not.toBeInTheDocument();
    expect(within(sheet).getByText(/Conta desativada: reative o acesso/)).toBeInTheDocument();
  });

  it('na própria conta, nenhuma ação: nem papel, nem desativar, nem senha temporária', async () => {
    renderAt('/cadastros/usuarios', { me: demoMe('admin_cliente', { userId: 'demo-marina.alves' }) });
    await userEvent.click(await screen.findByRole('button', { name: /Marina Alves/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Marina Alves' });
    expect(within(sheet).getByText(/Ninguém altera o próprio acesso/)).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Gerar senha temporária' })).not.toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Papel')).not.toBeInTheDocument();
  });

  it('o mock recusa como a API: a própria conta (403), conta desativada (409) e sem permissão (403)', async () => {
    const state: MockState = { me: demoMe('admin_cliente', { userId: 'demo-marina.alves' }) };
    server.use(...createHandlers(state));
    const generate = (id: string) =>
      api.post(`/v1/users/${id}/temporary-password`, undefined, temporaryPasswordSchema);

    await expect(generate('demo-marina.alves')).rejects.toMatchObject({ status: 403 });
    await expect(generate('demo-ex.funcionario')).rejects.toMatchObject({ status: 409 });
    await expect(generate('demo-carlos.dev')).resolves.toHaveProperty(
      'temporaryPassword',
      expect.stringMatching(TEMPORARY_PASSWORD),
    );
    state.me = demoMe('analista_cliente');
    await expect(generate('demo-carlos.dev')).rejects.toMatchObject({ status: 403 });
  });
});

describe('Contas cloud (T7.3)', { timeout: FORM_TIMEOUT }, () => {
  it('mostra conexão e último evento; cadastrar conta AWS gera o ExternalId e o passo do conector', async () => {
    renderAt('/cadastros/contas');
    const rows = await rowsOf('Contas cloud do cliente');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('Conectada');
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar conta' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cadastrar conta' });
    await userEvent.type(within(sheet).getByLabelText('ID da conta AWS'), '1234');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar e gerar o ExternalId' }));
    expect(within(sheet).getByLabelText('ID da conta AWS')).toHaveAccessibleDescription(/12 dígitos/);
    await userEvent.clear(within(sheet).getByLabelText('ID da conta AWS'));
    await userEvent.type(within(sheet).getByLabelText('ID da conta AWS'), '210987654321');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar e gerar o ExternalId' }));
    expect(await within(sheet).findByRole('status')).toHaveTextContent('Conta AWS 210987654321 cadastrada');
    expect(within(sheet).getByText(/^vx-/)).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'template do conector' })).toHaveAttribute(
      'href',
      'https://github.com/williandotdev/verax-control/blob/main/infra/cloudformation/verax-control-connector.yaml',
    );
  });

  it('selo da conexão: Conectada, Erro ou Aguardando; o detalhe mostra a última coleta e o tipo do erro', async () => {
    renderAt('/cadastros/contas');
    const rows = await rowsOf('Contas cloud do cliente');
    const rowOf = (id: string) => rows.find((row) => row.textContent?.includes(id)) as HTMLElement;
    // A terceira coluna é a da conexão.
    const badge = (id: string) => within(rowOf(id)).getAllByRole('cell')[2];
    expect(badge(DEMO_ACCOUNTS.alfaProducao)).toHaveTextContent(/^Conectada$/);
    expect(badge(DEMO_ACCOUNTS.alfaGcp)).toHaveTextContent(/^Conectada$/);
    expect(badge(DEMO_ACCOUNTS.alfaHomologacao)).toHaveTextContent(/^Erro$/);
    expect(badge(DEMO_ACCOUNTS.alfaCloudflare)).toHaveTextContent(/^Aguardando$/);

    await userEvent.click(
      within(rowOf(DEMO_ACCOUNTS.alfaHomologacao)).getByRole('button', {
        name: (name) => name.includes(DEMO_ACCOUNTS.alfaHomologacao),
      }),
    );
    const sheet = await screen.findByRole('dialog', { name: `Conta AWS ${DEMO_ACCOUNTS.alfaHomologacao}` });
    expect(
      within(sheet).getByText(/A última tentativa de assumir o papel de leitura falhou/),
    ).toHaveTextContent('Tipo do erro: AccessDenied.');
    expect(within(sheet).getByText('Última coleta').nextElementSibling).toHaveTextContent('ontem');
    expect(within(sheet).getByText('Último evento').nextElementSibling).toHaveTextContent('ontem');
  });

  it('GCP: conecta quando o primeiro evento chega; trocar a assinatura volta para Aguardando', async () => {
    renderAt('/cadastros/contas');
    const row = (await rowsOf('Contas cloud do cliente')).find((candidate) =>
      candidate.textContent?.includes(DEMO_ACCOUNTS.alfaGcp),
    ) as HTMLElement;
    await userEvent.click(
      within(row).getByRole('button', { name: (name) => name.includes(DEMO_ACCOUNTS.alfaGcp) }),
    );
    const sheet = await screen.findByRole('dialog', { name: `Projeto da GCP ${DEMO_ACCOUNTS.alfaGcp}` });
    expect(within(sheet).getByText('A última leitura deu certo.')).toBeInTheDocument();
    // A GCP entrega por evento: a leitura vazia da assinatura não conecta a conta.
    expect(within(sheet).getByText(/Conectada" quando o primeiro evento chegar/)).toBeInTheDocument();
    const field = within(sheet).getByLabelText('Assinatura do Pub/Sub');
    await userEvent.clear(field);
    await userEvent.type(field, 'verax-logs-nova');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Salvar assinatura' }));
    expect(
      await within(sheet).findByText(
        'Aguardando a configuração: a conta conecta quando o primeiro evento chegar.',
      ),
    ).toBeInTheDocument();
    expect(within(sheet).getByText('Conexão').nextElementSibling).toHaveTextContent(/^Aguardando/);
  });

  it('conta já cadastrada (em qualquer cliente) é recusada pela API, com a mensagem', async () => {
    renderAt('/cadastros/contas');
    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar conta' }));
    const sheet = await screen.findByRole('dialog');
    await userEvent.type(within(sheet).getByLabelText('ID da conta AWS'), DEMO_ACCOUNTS.beta);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar e gerar o ExternalId' }));
    expect(await within(sheet).findByRole('alert')).toBeInTheDocument();
  });

  it('projeto da GCP: sem ExternalId nem papel; o comando do sink aponta para o tópico do nó, sem dar acesso à Verax', async () => {
    renderAt('/cadastros/contas');
    // Projeto de cliente: a assinatura fica no projeto do nó e aparece pelo nome completo.
    const gcpRow = (await rowsOf('Contas cloud do cliente')).find((candidate) =>
      candidate.textContent?.includes(DEMO_ACCOUNTS.alfaGcp),
    ) as HTMLElement;
    expect(gcpRow).toHaveTextContent(
      `projects/verax-nos-demo/subscriptions/verax-demo-security-${DEMO_ACCOUNTS.alfaGcp}`,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar conta' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cadastrar conta' });
    await userEvent.selectOptions(within(sheet).getByLabelText('Provedor'), 'gcp');
    expect(within(sheet).queryByLabelText('Regiões monitoradas')).not.toBeInTheDocument();
    await userEvent.type(within(sheet).getByLabelText('ID do projeto da GCP'), '123456789012');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar conta' }));
    expect(within(sheet).getByLabelText('ID do projeto da GCP')).toHaveAccessibleDescription(
      /ID de projeto da GCP inválido/,
    );
    await userEvent.clear(within(sheet).getByLabelText('ID do projeto da GCP'));
    await userEvent.type(within(sheet).getByLabelText('ID do projeto da GCP'), 'cliente-soc-prod');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar conta' }));
    expect(await within(sheet).findByRole('status')).toHaveTextContent(
      'Projeto da GCP cliente-soc-prod cadastrado. Falta configurar a leitura no nó.',
    );
    expect(
      within(sheet).getByRole('heading', { name: 'Leitura do projeto cliente-soc-prod' }),
    ).toBeInTheDocument();
    // O comando só cria o sink no projeto do cliente, apontando para o tópico do nó; nada de papel para a Verax.
    const command = within(sheet).getByText(/^gcloud logging sinks create/);
    expect(command).toHaveTextContent(`pubsub.googleapis.com/${DEMO_SINK_TOPIC_PREFIX}cliente-soc-prod`);
    expect(command).toHaveTextContent('--project=cliente-soc-prod');
    expect(command).toHaveTextContent('log_id("cloudaudit.googleapis.com/activity")');
    expect(command).not.toHaveTextContent('AND NOT');
    expect(within(sheet).getByText(/^gcloud logging sinks describe/)).toHaveTextContent(
      '--project=cliente-soc-prod',
    );
    expect(within(sheet).getByText(/nenhuma chave de conta de serviço é criada/)).toBeInTheDocument();
    // Um projeto da própria Verax, com o sink criado pelo Terraform, não pode ganhar um segundo sink pelo comando.
    expect(
      within(sheet).getByText(/o sink já existe, criado pelo Terraform: não rode o comando/),
    ).toBeInTheDocument();
    expect(within(sheet).queryByText(/revisor de segurança/)).not.toBeInTheDocument();
    expect(within(sheet).queryByText(/^vx-/)).not.toBeInTheDocument();
  });

  it('projeto da GCP: o admin cola a identidade do sink (como o gcloud mostra); a inválida é recusada', async () => {
    renderAt('/cadastros/contas');
    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar conta' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cadastrar conta' });
    await userEvent.selectOptions(within(sheet).getByLabelText('Provedor'), 'gcp');
    await userEvent.type(within(sheet).getByLabelText('ID do projeto da GCP'), 'cliente-loja-prod');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar conta' }));
    const field = await within(sheet).findByLabelText('Identidade do sink');
    // Uma conta de serviço comum não é a identidade de um sink.
    await userEvent.type(field, 'serviceAccount:coletor@cliente-loja-prod.iam.gserviceaccount.com');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Salvar identidade' }));
    expect(field).toHaveAccessibleDescription(/identidade do sink inválida/);
    // Colada do aviso do gcloud, entre crases: vira a forma completa.
    await userEvent.clear(field);
    await userEvent.type(
      field,
      '`serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com`',
    );
    await userEvent.click(within(sheet).getByRole('button', { name: 'Salvar identidade' }));
    expect(
      await within(sheet).findByText('Identidade salva. A Verax libera a publicação no tópico só para ela.'),
    ).toBeInTheDocument();
    expect(field).toHaveValue('serviceAccount:service-210987654321@gcp-sa-logging.iam.gserviceaccount.com');
  });

  it('projeto da GCP: quem só lê vê o comando e a identidade, sem o campo', async () => {
    renderAt('/cadastros/contas', { me: demoMe('leitura') });
    const row = (await rowsOf('Contas cloud do cliente')).find((candidate) =>
      candidate.textContent?.includes(DEMO_ACCOUNTS.alfaGcp),
    ) as HTMLElement;
    await userEvent.click(
      within(row).getByRole('button', { name: (name) => name.includes(DEMO_ACCOUNTS.alfaGcp) }),
    );
    const sheet = await screen.findByRole('dialog', { name: `Projeto da GCP ${DEMO_ACCOUNTS.alfaGcp}` });
    expect(within(sheet).getByText(/^gcloud logging sinks create/)).toHaveTextContent(
      `${DEMO_SINK_TOPIC_PREFIX}${DEMO_ACCOUNTS.alfaGcp}`,
    );
    expect(
      within(sheet).getByText('serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com'),
    ).toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Identidade do sink')).not.toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Assinatura do Pub/Sub')).not.toBeInTheDocument();
  });

  it('Cloudflare com o token recusado pelo coletor: o detalhe explica o erro e diz que a coleta parou', async () => {
    const accounts = [...demoAdminStore().accounts.values()].flat();
    const cloudflare = accounts.find((account) => account.accountId === DEMO_ACCOUNTS.alfaCloudflare);
    if (!cloudflare) throw new Error('a conta do Cloudflare da demonstração sumiu');
    const failing = { ...cloudflare, connection: 'error' as const, connectionError: 'credential_rejected' };
    renderAt('/cadastros/contas', undefined, undefined, [
      http.get(`${API_URL}/v1/cloud-accounts`, () =>
        HttpResponse.json({ items: [failing], page: 1, pageSize: 20, total: 1 }),
      ),
    ]);
    const [row] = await rowsOf('Contas cloud do cliente');
    expect(row).toHaveTextContent('Erro');
    await userEvent.click(
      within(row as HTMLElement).getByRole('button', {
        name: (name) => name.includes(DEMO_ACCOUNTS.alfaCloudflare),
      }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: `Conta do Cloudflare ${DEMO_ACCOUNTS.alfaCloudflare}`,
    });
    expect(within(sheet).getByText(/A última leitura falhou/)).toHaveTextContent(
      'A última leitura falhou. O Cloudflare recusou o token (inválido ou revogado). A coleta está parada até um token válido ser colado abaixo. Tipo do erro: credential_rejected.',
    );
  });

  it('Cloudflare: zonas na tabela; o token guardado aparece só pelo fim do ID; as zonas mudam no detalhe', async () => {
    renderAt('/cadastros/contas');
    const row = (await rowsOf('Contas cloud do cliente')).find((candidate) =>
      candidate.textContent?.includes(DEMO_ACCOUNTS.alfaCloudflare),
    ) as HTMLElement;
    expect(row).toHaveTextContent('loja-alfa.example');
    expect(row).toHaveTextContent('Aguardando');
    await userEvent.click(
      within(row).getByRole('button', { name: (name) => name.includes(DEMO_ACCOUNTS.alfaCloudflare) }),
    );
    const sheet = await screen.findByRole('dialog', {
      name: `Conta do Cloudflare ${DEMO_ACCOUNTS.alfaCloudflare}`,
    });
    expect(within(sheet).getByText(/fica\s+cifrado no cofre do nó/)).toBeInTheDocument();
    expect(within(sheet).queryByText('Papel de leitura')).not.toBeInTheDocument();
    const zones = within(sheet).getByLabelText('Zonas monitoradas');
    await userEvent.clear(zones);
    await userEvent.type(zones, 'loja-alfa.example, https://errado');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Salvar zonas' }));
    expect(zones).toHaveAccessibleDescription(/zona inválida/);
    await userEvent.clear(zones);
    await userEvent.type(zones, 'loja-alfa.example, api.loja-alfa.example');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Salvar zonas' }));
    // O detalhe relê a conta depois de salvar (a tabela fica fora da árvore enquanto o painel modal está aberto).
    expect(await within(sheet).findByText('loja-alfa.example, api.loja-alfa.example')).toBeInTheDocument();
  });

  it('Cloudflare: o link cria um token de conta só de leitura, e o filtro de IP recomendado é o IP de saída do nó', async () => {
    renderAt(`/cadastros/contas?conta=018f2c1e-0000-7000-8000-0000000c0005`);
    const sheet = await screen.findByRole('dialog', {
      name: `Conta do Cloudflare ${DEMO_ACCOUNTS.alfaCloudflare}`,
    });
    const link = within(sheet).getByRole('link', { name: /criar o token no Cloudflare/ });
    const url = new URL(link.getAttribute('href') ?? '');
    expect(url.origin).toBe('https://dash.cloudflare.com');
    expect(url.searchParams.get('to')).toBe('/:account/api-tokens');
    const permissions = JSON.parse(url.searchParams.get('permissionGroupKeys') ?? '[]') as { type: string }[];
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.every((permission) => permission.type === 'read')).toBe(true);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(sheet).getByText('Conta · Account Settings · Read')).toBeInTheDocument();
    expect(within(sheet).getByText(DEMO_EGRESS_IPS.join(', '))).toBeInTheDocument();
  });

  it('Cloudflare: o cartão mostra o token guardado pelo fim do ID, a validade e o aviso de 14 dias', async () => {
    renderAt(`/cadastros/contas?conta=018f2c1e-0000-7000-8000-0000000c0005`);
    const card = await screen.findByRole('group', { name: 'Token de API guardado' });
    expect(within(card).getByText(`…${DEMO_CLOUDFLARE_TOKEN_SUFFIX}`)).toBeInTheDocument();
    expect(within(card).getByText('Vence em breve')).toBeInTheDocument();
    expect(within(card).getByText(/^vence em \d{2}\/\d{2}\/\d{4}$/)).toBeInTheDocument();
    expect(within(card).getByText(/O token vence em 9 dias/)).toBeInTheDocument();
    // Não há como ver o token: nenhum campo com valor, nenhum botão de mostrar.
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card).queryByLabelText('Token de API do Cloudflare')).not.toBeInTheDocument();
  });

  it('Cloudflare: trocar o token pelo campo de senha; o campo zera no envio, e nada do token fica no cache', async () => {
    const user = userEvent.setup();
    const client = createQueryClient();
    renderAt(`/cadastros/contas?conta=018f2c1e-0000-7000-8000-0000000c0005`, undefined, client);
    const card = await screen.findByRole('group', { name: 'Token de API guardado' });
    await user.click(within(card).getByRole('button', { name: 'Trocar token' }));
    const field = within(card).getByLabelText('Token de API do Cloudflare');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');

    // A Global API Key é recusada antes de sair do navegador, com a mensagem própria; o campo zera.
    const globalKey = Array.from(crypto.getRandomValues(new Uint8Array(19)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    )
      .join('')
      .slice(0, 37);
    await user.click(field);
    await user.paste(globalKey);
    await user.click(within(card).getByRole('button', { name: 'Trocar token' }));
    expect(field).toHaveValue('');
    expect(field).toHaveAccessibleDescription(expect.stringContaining(GLOBAL_KEY_REFUSED_MESSAGE));

    // Token gerado na hora, no formato; colado com a quebra de linha que a cópia costuma trazer.
    const token = `cfat_${Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}`;
    await user.click(field);
    await user.paste(`${token}\n`);
    await user.click(within(card).getByRole('button', { name: 'Trocar token' }));
    expect(field).toHaveValue('');
    // Primeiro o aviso de conferência, depois a confirmação, os dois anunciados (role=status).
    const saved = await within(card).findByText(
      /Token conferido no Cloudflare e guardado no cofre do nó \(…[0-9a-f]{4}\)/,
    );
    expect(saved).toHaveAttribute('role', 'status');
    await waitFor(() => expect(within(card).getByText('Válido')).toBeInTheDocument());
    expect(within(card).getByText('sem data de vencimento')).toBeInTheDocument();
    expect(within(card).queryByLabelText('Token de API do Cloudflare')).not.toBeInTheDocument();
    expect(within(card).getByText('Token de API guardado')).toHaveFocus();
    // Sem `useMutation`: o cache de mutações não guardou as variáveis, e nenhuma consulta guardou o token.
    expect(client.getMutationCache().getAll()).toEqual([]);
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(token);
    expect(document.body.innerHTML).not.toContain(token);
  });

  it('Cloudflare: remover o token pede confirmação; depois, o campo para colar outro', async () => {
    const user = userEvent.setup();
    renderAt(`/cadastros/contas?conta=018f2c1e-0000-7000-8000-0000000c0005`);
    const card = await screen.findByRole('group', { name: 'Token de API guardado' });
    await user.click(within(card).getByRole('button', { name: 'Remover token' }));
    const confirmation = within(card).getByRole('group', { name: 'Confirmação' });
    expect(confirmation).toHaveAccessibleDescription(/A coleta do Cloudflare para/);
    await user.click(within(confirmation).getByRole('button', { name: 'Confirmar remoção' }));
    const sheet = screen.getByRole('dialog');
    const field = await within(sheet).findByLabelText('Token de API do Cloudflare');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveFocus();
    expect(within(sheet).getByRole('status')).toHaveTextContent(/Token removido do cofre do nó/);
    expect(within(sheet).queryByRole('group', { name: 'Token de API guardado' })).not.toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Guardar token' })).toBeInTheDocument();
  });

  it('Cloudflare: o Cloudflare fora do ar (503) aparece junto do campo, e dá para tentar de novo', async () => {
    const user = userEvent.setup();
    renderAt(`/cadastros/contas?conta=018f2c1e-0000-7000-8000-0000000c0005`);
    const card = await screen.findByRole('group', { name: 'Token de API guardado' });
    server.use(
      http.put(`${API_URL}/v1/cloud-accounts/:id/credential`, () =>
        HttpResponse.json(
          { statusCode: 503, message: 'Serviço temporariamente indisponível' },
          { status: 503 },
        ),
      ),
    );
    await user.click(within(card).getByRole('button', { name: 'Trocar token' }));
    const field = within(card).getByLabelText('Token de API do Cloudflare');
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    await user.click(field);
    await user.paste(token);
    await user.click(within(card).getByRole('button', { name: 'Trocar token' }));
    await waitFor(() => expect(field).toHaveAccessibleDescription(/O Cloudflare não respondeu a tempo/));
    expect(field).toHaveValue('');
    expect(within(card).getByRole('button', { name: 'Trocar token' })).toBeEnabled();
  });

  it('Cloudflare: depois de trocar o token, desativar o monitoramento tira o cartão; reativada, a conta pede o token', async () => {
    const user = userEvent.setup();
    renderAt(`/cadastros/contas?conta=018f2c1e-0000-7000-8000-0000000c0005`);
    const sheet = await screen.findByRole('dialog', {
      name: `Conta do Cloudflare ${DEMO_ACCOUNTS.alfaCloudflare}`,
    });
    const card = within(sheet).getByRole('group', { name: 'Token de API guardado' });
    await user.click(within(card).getByRole('button', { name: 'Trocar token' }));
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    await user.click(within(card).getByLabelText('Token de API do Cloudflare'));
    await user.paste(token);
    await user.click(within(card).getByRole('button', { name: 'Trocar token' }));
    await within(card).findByText(/guardado no cofre do nó/);

    // Desativar apaga o token na API (e no mock): a conta relida vale sobre a troca feita aqui.
    await user.click(within(sheet).getByRole('button', { name: 'Desativar monitoramento' }));
    await waitFor(() =>
      expect(within(sheet).queryByRole('group', { name: 'Token de API guardado' })).not.toBeInTheDocument(),
    );
    expect(within(sheet).getByText(/Reative o monitoramento para colar o token/)).toBeInTheDocument();
    expect(within(sheet).queryByLabelText('Token de API do Cloudflare')).not.toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: 'Reativar monitoramento' }));
    expect(await within(sheet).findByLabelText('Token de API do Cloudflare')).toHaveValue('');
    expect(within(sheet).queryByRole('group', { name: 'Token de API guardado' })).not.toBeInTheDocument();
    expect(within(sheet).queryByText(/guardado no cofre do nó/)).not.toBeInTheDocument();
  });

  it('Cloudflare: quem só lê vê o cartão, sem o campo, sem trocar e sem remover', async () => {
    renderAt(`/cadastros/contas?conta=018f2c1e-0000-7000-8000-0000000c0005`, { me: demoMe('leitura') });
    const card = await screen.findByRole('group', { name: 'Token de API guardado' });
    expect(within(card).getByText(`…${DEMO_CLOUDFLARE_TOKEN_SUFFIX}`)).toBeInTheDocument();
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Token de API do Cloudflare')).not.toBeInTheDocument();
  });

  it('Cloudflare: conta nova sem token mostra o campo; o mock recusa como a API', async () => {
    const user = userEvent.setup();
    renderAt('/cadastros/contas');
    await user.click(await screen.findByRole('button', { name: 'Cadastrar conta' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cadastrar conta' });
    await user.selectOptions(within(sheet).getByLabelText('Provedor'), 'cloudflare');
    await user.type(
      within(sheet).getByLabelText('ID da conta do Cloudflare'),
      'd0e0000000000000000000000000b2fb',
    );
    await user.click(within(sheet).getByRole('button', { name: 'Cadastrar conta' }));
    expect(
      await within(sheet).findByText(/Falta colar o token de leitura do Cloudflare/),
    ).toBeInTheDocument();
    const field = within(sheet).getByLabelText('Token de API do Cloudflare');
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    await user.click(field);
    await user.paste(token);
    await user.click(within(sheet).getByRole('button', { name: 'Guardar token' }));
    expect(field).toHaveValue('');
    // O cartão entra no lugar do campo, com a confirmação e o foco; do token, só o fim do ID.
    const card = await within(sheet).findByRole('group', { name: 'Token de API guardado' });
    expect(within(card).getByRole('status')).toHaveTextContent(/guardado no cofre do nó \(…[0-9a-f]{4}\)/);
    expect(within(card).getByText('Token de API guardado')).toHaveFocus();
    expect(document.body.innerHTML).not.toContain(token);
  });
});

describe('Lista de proteção (T7.4)', { timeout: FORM_TIMEOUT }, () => {
  it('recusa identificador fora do formato do tipo, inclui o válido e remove com confirmação', async () => {
    renderAt('/cadastros/protecao');
    expect(await rowsOf('Lista de proteção do cliente')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Incluir item' }));
    const sheet = await screen.findByRole('dialog', { name: 'Incluir na lista de proteção' });
    await userEvent.selectOptions(within(sheet).getByLabelText('Tipo'), 'access_key');
    await userEvent.type(within(sheet).getByLabelText('Identificador'), 'abc');
    await userEvent.type(
      within(sheet).getByLabelText('Motivo (obrigatório)'),
      'Chave do sistema de pagamentos.',
    );
    await userEvent.click(within(sheet).getByRole('button', { name: 'Incluir' }));
    expect(within(sheet).getByLabelText('Identificador')).toHaveAccessibleDescription(
      /identificador fora do formato/,
    );
    await userEvent.clear(within(sheet).getByLabelText('Identificador'));
    await userEvent.type(within(sheet).getByLabelText('Identificador'), 'AKIAIOSFODNN7EXAMPLE');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Incluir' }));
    await waitFor(async () => expect(await rowsOf('Lista de proteção do cliente')).toHaveLength(4));

    await userEvent.click(screen.getByRole('button', { name: 'loja-exemplo-backups' }));
    const edit = await screen.findByRole('dialog', { name: 'loja-exemplo-backups' });
    await userEvent.click(within(edit).getByRole('button', { name: 'Remover da lista' }));
    await userEvent.click(within(edit).getByRole('button', { name: 'Confirmar remoção' }));
    await waitFor(async () => expect(await rowsOf('Lista de proteção do cliente')).toHaveLength(3));
  });
});

describe('Exceções (T7.5)', { timeout: FORM_TIMEOUT }, () => {
  it('mostra quantos achados cada uma marcou e a validade; cria e edita', async () => {
    renderAt('/cadastros/excecoes');
    const rows = await rowsOf('Exceções de alerta do cliente');
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.textContent?.includes('relatorios-app'))).toHaveTextContent('48 achados');
    expect(rows.find((row) => row.textContent?.includes('203.0.113.0/24'))).toHaveTextContent('Vencida em');

    await userEvent.click(screen.getByRole('button', { name: 'Nova exceção' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nova exceção' });
    await userEvent.type(within(sheet).getByLabelText(/^Regra/), '80254');
    await userEvent.selectOptions(within(sheet).getByLabelText('Comparar por'), 'ip');
    await userEvent.type(within(sheet).getByLabelText(/^Valor/), 'não-é-ip');
    await userEvent.type(within(sheet).getByLabelText('Motivo (obrigatório)'), 'VPN da empresa.');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Criar exceção' }));
    expect(within(sheet).getByLabelText(/^Valor/)).toHaveAccessibleDescription(/IP ou faixa CIDR inválida/);
    await userEvent.clear(within(sheet).getByLabelText(/^Valor/));
    await userEvent.type(within(sheet).getByLabelText(/^Valor/), '198.51.100.0/24');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Criar exceção' }));
    await waitFor(async () => expect(await rowsOf('Exceções de alerta do cliente')).toHaveLength(4));

    // Exceção vencida: mudar só o motivo salva, sem reenviar a validade no passado.
    await userEvent.click(screen.getByRole('button', { name: '80250' }));
    const expired = await screen.findByRole('dialog', { name: 'Exceção da regra 80250' });
    await userEvent.clear(within(expired).getByLabelText('Motivo'));
    await userEvent.type(within(expired).getByLabelText('Motivo'), 'Troca de senha concluída.');
    await userEvent.click(within(expired).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const expiredRow = (await rowsOf('Exceções de alerta do cliente')).find((row) =>
      row.textContent?.includes('Troca de senha concluída.'),
    ) as HTMLElement;
    expect(expiredRow).toHaveTextContent('Vencida em');

    await userEvent.click(screen.getByRole('button', { name: '80202' }));
    const edit = await screen.findByRole('dialog', { name: 'Exceção da regra 80202' });
    expect(edit).toHaveTextContent('48 achados marcados por esta exceção');
    await userEvent.clear(within(edit).getByLabelText('Motivo'));
    await userEvent.type(within(edit).getByLabelText('Motivo'), 'Correção do job em andamento.');
    await userEvent.click(within(edit).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Correção do job em andamento.')).toBeInTheDocument();
  });

  it('a exceção criada ao marcar um achado como legítimo aparece aqui', async () => {
    const router = renderAt('/achados?severidade=critical');
    await userEvent.click(await screen.findByRole('button', { name: /Tentativa de desligar a trilha/ }));
    const panel = await screen.findByRole('dialog');
    await userEvent.click(within(panel).getByRole('button', { name: 'Marcar como legítimo' }));
    const offer = (await within(panel).findByText('Criar exceção para alertas iguais?')).closest(
      'form',
    ) as HTMLFormElement;
    await userEvent.type(within(offer).getByLabelText('Motivo (obrigatório)'), 'Manutenção agendada.');
    await userEvent.click(within(offer).getByRole('button', { name: 'Criar exceção' }));
    await within(panel).findByText(/Exceção criada/);
    await userEvent.keyboard('{Escape}');
    await router.navigate('/cadastros/excecoes');
    expect(await screen.findByText('Manutenção agendada.')).toBeInTheDocument();
  });
});

describe('papel de leitura nos cadastros', { timeout: FORM_TIMEOUT }, () => {
  it('vê as listas, sem os botões de escrita', async () => {
    renderAt('/cadastros/excecoes', { me: demoMe('leitura') });
    expect(await rowsOf('Exceções de alerta do cliente')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Nova exceção' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '80202' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
  });
});
