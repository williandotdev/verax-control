import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { temporaryPasswordSchema } from '@verax/shared';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, demoMe } from '@/mocks/fixtures';
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

const rowsOf = async (caption: string) =>
  within(await screen.findByRole('table', { name: caption }))
    .getAllByRole('row')
    .slice(1);

describe('Clientes (T7.1)', { timeout: FORM_TIMEOUT }, () => {
  it('lista, valida e cadastra; o novo cliente entra na lista', async () => {
    renderAt('/cadastros/clientes', { me: demoMe('admin_verax') });
    expect(await rowsOf('Clientes')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Novo cliente' }));
    const sheet = await screen.findByRole('dialog', { name: 'Novo cliente' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar cliente' }));
    expect(within(sheet).getByLabelText('Nome')).toHaveAccessibleDescription('Preencha este campo.');

    await userEvent.type(within(sheet).getByLabelText('Nome'), 'Cliente Novo Gama');
    await userEvent.type(within(sheet).getByLabelText(/^CNPJ/), '45.723.174/0001-10');
    await userEvent.type(within(sheet).getByLabelText('Plano'), 'Postura');
    await userEvent.type(within(sheet).getByLabelText('Nome do contato'), 'Gabriel Lima');
    await userEvent.type(within(sheet).getByLabelText('E-mail do contato'), 'gabriel@exemplo.com.br');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar cliente' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(async () => expect(await rowsOf('Clientes')).toHaveLength(4));
  });

  it('edita e desativa um cliente existente', async () => {
    renderAt('/cadastros/clientes', { me: demoMe('admin_verax') });
    await userEvent.click(await screen.findByRole('button', { name: 'Cliente Demo Beta' }));
    const sheet = await screen.findByRole('dialog', { name: 'Cliente' });
    expect(await within(sheet).findByDisplayValue('Postura e alertas')).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Desativar cliente' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const beta = (await rowsOf('Clientes')).find((row) => row.textContent?.includes('Beta')) as HTMLElement;
    await waitFor(() => expect(beta).toHaveTextContent('Inativo'));
  });
});

/** A senha temporária do mock tem o formato da API: quatro grupos de cinco, sem caracteres ambíguos. */
const TEMPORARY_PASSWORD =
  /^[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}-[A-HJ-NP-Za-km-z2-9]{5}$/;

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

  it('GCP: conectada pela leitura da assinatura; trocar a assinatura volta para Aguardando', async () => {
    renderAt('/cadastros/contas');
    const row = (await rowsOf('Contas cloud do cliente')).find((candidate) =>
      candidate.textContent?.includes(DEMO_ACCOUNTS.alfaGcp),
    ) as HTMLElement;
    await userEvent.click(
      within(row).getByRole('button', { name: (name) => name.includes(DEMO_ACCOUNTS.alfaGcp) }),
    );
    const sheet = await screen.findByRole('dialog', { name: `Projeto da GCP ${DEMO_ACCOUNTS.alfaGcp}` });
    expect(within(sheet).getByText('A última leitura deu certo.')).toBeInTheDocument();
    expect(within(sheet).getByText(/na primeira leitura bem-sucedida da assinatura/)).toBeInTheDocument();
    const field = within(sheet).getByLabelText('Assinatura do Pub/Sub');
    await userEvent.clear(field);
    await userEvent.type(field, 'verax-logs-nova');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Salvar assinatura' }));
    expect(await within(sheet).findByText(/Aguardando a configuração/)).toBeInTheDocument();
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

  it('projeto da GCP: sem ExternalId nem papel, com os passos da assinatura do Pub/Sub', async () => {
    renderAt('/cadastros/contas');
    // A assinatura no próprio projeto aparece só pelo ID; a API guarda o nome completo.
    const gcpRow = (await rowsOf('Contas cloud do cliente')).find((candidate) =>
      candidate.textContent?.includes(DEMO_ACCOUNTS.alfaGcp),
    ) as HTMLElement;
    expect(gcpRow).toHaveTextContent('verax-logs-seguranca');
    expect(gcpRow).not.toHaveTextContent('projects/');
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
    await userEvent.type(within(sheet).getByLabelText('ID do projeto da GCP'), 'verax-soc-prod');
    await userEvent.type(within(sheet).getByLabelText('Assinatura do Pub/Sub (opcional)'), 'verax-logs');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cadastrar conta' }));
    expect(await within(sheet).findByRole('status')).toHaveTextContent(
      'Projeto da GCP verax-soc-prod cadastrado. Falta configurar a leitura no nó.',
    );
    expect(
      within(sheet).getByRole('heading', { name: 'Leitura do projeto verax-soc-prod' }),
    ).toBeInTheDocument();
    expect(within(sheet).getByText(/Nenhuma chave de conta de serviço é criada/)).toBeInTheDocument();
    expect(within(sheet).queryByText(/^vx-/)).not.toBeInTheDocument();
  });

  it('Cloudflare: zonas na tabela; o token fica no nó; as zonas mudam no detalhe', async () => {
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
    expect(within(sheet).getByText(/nunca entra neste cadastro/)).toBeInTheDocument();
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
