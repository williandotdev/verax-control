import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('Usuários (T7.2)', { timeout: FORM_TIMEOUT }, () => {
  it('convida com validação, e o convidado aparece na lista', async () => {
    renderAt('/cadastros/usuarios');
    expect(await rowsOf('Usuários do cliente')).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', { name: 'Convidar usuário' }));
    const sheet = await screen.findByRole('dialog', { name: 'Convidar usuário' });
    await userEvent.type(within(sheet).getByLabelText('Nome'), 'Bruna Melo');
    await userEvent.type(within(sheet).getByLabelText('E-mail'), 'bruna-sem-arroba');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Enviar convite' }));
    expect(within(sheet).getByLabelText('E-mail')).toHaveAccessibleDescription('E-mail inválido.');
    await userEvent.clear(within(sheet).getByLabelText('E-mail'));
    await userEvent.type(within(sheet).getByLabelText('E-mail'), 'bruna@exemplo.com.br');
    await userEvent.selectOptions(within(sheet).getByLabelText('Papel'), 'leitura');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Enviar convite' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const rows = await rowsOf('Usuários do cliente');
    await waitFor(() => expect(rows.length).toBeGreaterThanOrEqual(6));
    expect(await screen.findByText('bruna@exemplo.com.br')).toBeInTheDocument();
  });

  it('troca o papel, desativa o acesso e reenvia o convite pendente', async () => {
    renderAt('/cadastros/usuarios');
    await userEvent.click(await screen.findByRole('button', { name: /Ana Souza/ }));
    let sheet = await screen.findByRole('dialog', { name: 'Ana Souza' });
    await userEvent.selectOptions(within(sheet).getByLabelText('Papel'), 'leitura');
    await waitFor(() => expect(within(sheet).getByLabelText('Papel')).toHaveValue('leitura'));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Desativar acesso' }));
    expect(await within(sheet).findByRole('button', { name: 'Reativar acesso' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(await screen.findByRole('button', { name: /Carlos Dev/ }));
    sheet = await screen.findByRole('dialog', { name: 'Carlos Dev' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Reenviar convite' }));
    expect(await within(sheet).findByRole('status')).toHaveTextContent('Convite reenviado');
    // Convite para a pessoa errada: cancelar antes do aceite.
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancelar convite' }));
    expect(await within(sheet).findByRole('button', { name: 'Reativar acesso' })).toBeInTheDocument();
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
    expect(row).toHaveTextContent('Aguardando a configuração');
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
