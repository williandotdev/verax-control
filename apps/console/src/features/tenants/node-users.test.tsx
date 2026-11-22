import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@/lib/format';
import { createFakeState, type FakeAdminState } from '@/mocks/fake-admin-api';
import { server } from '@/mocks/server';
import { renderConsole } from '@/test/render';

const ACTIVE_ID = '01JC0000000000000000000D01';
/** O cliente com o servidor parado, de versão de antes dos usuários. */
const OUTDATED_ID = '01JC0000000000000000000B01';
const NEVER_SYNCED_ID = '01JC0000000000000000000A01';
const START = new Date('2026-11-22T12:00:00.000Z');
const MINUTE = 60_000;

/** O estado da API simulada com o relógio que o teste anda. */
function stateAt(): { state: FakeAdminState; advance: (ms: number) => void } {
  let now = START;
  const state = createFakeState({ now: () => now });
  return {
    state,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function usersPanel(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Usuários do cliente' });
}

/** A linha da tabela de um pedido, pelo e-mail. */
function rowOf(panel: HTMLElement, email: string): HTMLElement {
  const row = within(within(panel).getByRole('table')).getByText(email).closest('tr');
  if (row === null) throw new Error(`linha de ${email} ausente`);
  return row;
}

/** O valor de uma linha do acesso (o texto no `dd` ao lado do rótulo, sem o botão de copiar). */
function accessValue(region: HTMLElement, label: string): string {
  const term = within(region).getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.firstElementChild?.textContent ?? '';
}

/**
 * Os usuários do cliente pedidos pela Verax no detalhe do cliente, sobre a API simulada (`mocks/fake-node-users.ts`): a
 * lista com a situação e o motivo de cada pedido, o formulário, a senha temporária mostrada uma única vez (fora do cache
 * das consultas e das mutações), o pedido que o servidor do cliente cria na sincronização seguinte e o botão desligado,
 * com o motivo, quando o servidor do cliente não pode receber usuários. Nenhum dado real.
 */
describe('usuários do cliente', () => {
  it('lista os pedidos com a situação e o motivo de cada um', async () => {
    renderConsole(`/clientes/${ACTIVE_ID}`, stateAt().state);
    const panel = await usersPanel();
    await within(panel).findByText('pessoa.um@cliente-demo-z.example');

    const created = rowOf(panel, 'pessoa.um@cliente-demo-z.example');
    expect(created).toHaveTextContent('Administrador');
    expect(created).toHaveTextContent('Criado');
    expect(created).toHaveTextContent('Conta ativa · senha trocada · MFA configurado');

    const failed = rowOf(panel, 'ja-existe@cliente-demo-z.example');
    expect(failed).toHaveTextContent('Analista');
    expect(failed).toHaveTextContent('Não criado');
    expect(failed).toHaveTextContent('Já existe um usuário com esse e-mail no painel do cliente.');

    const expired = rowOf(panel, 'pessoa.tres@cliente-demo-z.example');
    expect(expired).toHaveTextContent('Somente leitura');
    expect(expired).toHaveTextContent('Vencido');
    expect(expired).toHaveTextContent('peça de novo');
  });

  it('cria, mostra o acesso uma vez com os botões de copiar e a mensagem, e fecha sem volta', async () => {
    const { state, advance } = stateAt();
    const { user, client } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const panel = await usersPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Criar usuário…' }));
    const form = within(panel).getByRole('form', { name: 'Criar usuário do cliente' });

    // A conferência local antes de chamar a API.
    await user.click(within(form).getByRole('button', { name: 'Criar usuário' }));
    expect(within(form).getByLabelText('Nome')).toHaveAccessibleDescription('Informe o nome.');
    expect(within(form).getByLabelText('E-mail (o login)')).toHaveAccessibleDescription(
      'Nenhum e-mail sai da Verax: você manda o acesso à pessoa. Informe um e-mail válido.',
    );

    await user.type(within(form).getByLabelText('Nome'), 'Pessoa Demo Nova');
    await user.type(within(form).getByLabelText('E-mail (o login)'), 'Nova.Pessoa@Cliente-Demo-Z.example');
    expect(within(form).getByLabelText('Papel')).toHaveValue('analista_cliente');
    expect(
      within(within(form).getByLabelText('Papel'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Administrador', 'Analista', 'Somente leitura']);
    await user.selectOptions(within(form).getByLabelText('Papel'), 'leitura');
    await user.click(within(form).getByRole('button', { name: 'Criar usuário' }));

    const access = await within(panel).findByRole('region', {
      name: 'Acesso do novo usuário para enviar ao cliente',
    });
    const password = accessValue(access, 'Senha temporária');
    expect(password).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}-[0-9a-f]{5}-[0-9a-f]{5}$/);
    expect(accessValue(access, 'Painel')).toBe('https://contrato-ativo.control.veraxsistemas.com.br');
    expect(accessValue(access, 'Login')).toBe('nova.pessoa@cliente-demo-z.example');
    const expiry = formatDateTime(new Date(START.getTime() + 72 * 60 * MINUTE).toISOString());
    expect(accessValue(access, 'Válida até')).toBe(expiry);
    expect(access).toHaveTextContent('na próxima sincronização');

    await user.click(within(access).getByRole('button', { name: 'Copiar: Senha temporária' }));
    expect(await within(access).findByText('Senha copiada.')).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(password);
    await user.click(within(access).getByRole('button', { name: 'Copiar: Painel' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(
      'https://contrato-ativo.control.veraxsistemas.com.br',
    );
    await user.click(within(access).getByRole('button', { name: 'Copiar mensagem para o cliente' }));
    expect(await within(access).findByText('Mensagem copiada.')).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(
      [
        'Olá! O seu acesso ao Verax Control foi criado.',
        '',
        'Painel: https://contrato-ativo.control.veraxsistemas.com.br',
        'Login: nova.pessoa@cliente-demo-z.example',
        `Senha temporária: ${password}`,
        `Válida até: ${expiry} (horário de Brasília)`,
        '',
        'No primeiro acesso, troque a senha e configure a verificação em duas etapas (MFA), com um aplicativo autenticador.',
      ].join('\n'),
    );

    // A lista lida de novo traz o pedido, pendente; a senha nunca entrou no cache das consultas nem no das mutações.
    await waitFor(() =>
      expect(rowOf(panel, 'nova.pessoa@cliente-demo-z.example')).toHaveTextContent('Esperando o servidor'),
    );
    expect(rowOf(panel, 'nova.pessoa@cliente-demo-z.example')).toHaveTextContent('Somente leitura');
    const cached = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
    expect(cached).toContain('nova.pessoa@cliente-demo-z.example');
    expect(cached).not.toContain(password);
    expect(client.getMutationCache().getAll()).toEqual([]);

    // Fechar: o acesso some e não volta.
    await user.click(within(access).getByRole('button', { name: 'Fechar' }));
    expect(
      within(panel).queryByRole('region', { name: 'Acesso do novo usuário para enviar ao cliente' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(password)).not.toBeInTheDocument();

    // O servidor do cliente sincroniza: o pedido vira criado, com a conta ainda na senha temporária.
    advance(3 * MINUTE);
    await client.invalidateQueries({ queryKey: ['tenant', ACTIVE_ID, 'node-sync'] });
    await waitFor(() =>
      expect(rowOf(panel, 'nova.pessoa@cliente-demo-z.example')).toHaveTextContent('Criado'),
    );
    expect(rowOf(panel, 'nova.pessoa@cliente-demo-z.example')).toHaveTextContent(
      'Conta ativa · ainda com a senha temporária · MFA ainda não configurado',
    );
  });

  it('a releitura da lista falha depois da criação: o acesso continua na tela', async () => {
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, stateAt().state);
    const panel = await usersPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Criar usuário…' }));
    await user.type(within(panel).getByLabelText('Nome'), 'Pessoa Demo');
    await user.type(within(panel).getByLabelText('E-mail (o login)'), 'pessoa.demo@cliente-demo-z.example');
    server.use(
      http.get('*/v1/admin/tenants/:tenantId/node-sync', () =>
        HttpResponse.json({ message: 'Indisponível', code: 'unavailable' }, { status: 503 }),
      ),
    );
    await user.click(within(panel).getByRole('button', { name: 'Criar usuário' }));
    const access = await within(panel).findByRole('region', {
      name: 'Acesso do novo usuário para enviar ao cliente',
    });
    const password = accessValue(access, 'Senha temporária');
    // Um tempo para a releitura falhar; o acesso fica.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      accessValue(screen.getByRole('region', { name: /^Acesso do novo usuário/ }), 'Senha temporária'),
    ).toBe(password);
  });

  it('pedido pendente para o mesmo e-mail: a recusa no campo, nada mostrado', async () => {
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, stateAt().state);
    const panel = await usersPanel();
    const create = async (email: string) => {
      await user.click(await within(panel).findByRole('button', { name: 'Criar usuário…' }));
      await user.type(within(panel).getByLabelText('Nome'), 'Pessoa Demo');
      await user.type(within(panel).getByLabelText('E-mail (o login)'), email);
      await user.click(within(panel).getByRole('button', { name: 'Criar usuário' }));
    };
    await create('repetida@cliente-demo-z.example');
    const access = await within(panel).findByRole('region', {
      name: 'Acesso do novo usuário para enviar ao cliente',
    });
    await user.click(within(access).getByRole('button', { name: 'Fechar' }));

    await create('REPETIDA@cliente-demo-z.example');
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent(/^Já há um pedido para este e-mail esperando o servidor do cliente/);
    expect(within(panel).getByLabelText('E-mail (o login)')).toHaveAccessibleDescription(
      'Nenhum e-mail sai da Verax: você manda o acesso à pessoa. Pedido pendente para este e-mail.',
    );
    expect(
      within(panel).queryByRole('region', { name: 'Acesso do novo usuário para enviar ao cliente' }),
    ).not.toBeInTheDocument();
  });

  it('o servidor do cliente recusa: o motivo de cada código', async () => {
    const { state } = stateAt();
    const sync = state.logSources.tenants.get(ACTIVE_ID);
    if (sync === undefined) throw new Error('nó de exemplo ausente');
    const base = sync.users?.[0];
    if (base === undefined) throw new Error('pedido de exemplo ausente');
    sync.users = [
      {
        ...base,
        requestId: '01JC0000000000000000000U11',
        email: 'a@cliente-demo-z.example',
        status: 'failed',
        code: 'users_disabled',
      },
      {
        ...base,
        requestId: '01JC0000000000000000000U12',
        email: 'b@cliente-demo-z.example',
        status: 'failed',
        code: 'plan_limit_reached',
      },
      {
        ...base,
        requestId: '01JC0000000000000000000U13',
        email: 'c@cliente-demo-z.example',
        status: 'failed',
        code: 'envelope_unreadable',
      },
      {
        ...base,
        requestId: '01JC0000000000000000000U14',
        email: 'd@cliente-demo-z.example',
        status: 'expired',
        code: 'expired',
      },
    ];
    renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const panel = await usersPanel();
    await within(panel).findByText('a@cliente-demo-z.example');
    expect(rowOf(panel, 'a@cliente-demo-z.example')).toHaveTextContent(
      'O cliente desligou a criação de usuários pela Verax neste servidor.',
    );
    expect(rowOf(panel, 'b@cliente-demo-z.example')).toHaveTextContent(
      'O plano do cliente não tem vaga para mais um usuário',
    );
    expect(rowOf(panel, 'c@cliente-demo-z.example')).toHaveTextContent(
      'O servidor do cliente não conseguiu abrir a senha',
    );
    expect(rowOf(panel, 'd@cliente-demo-z.example')).toHaveTextContent(
      'O pedido venceu antes de o servidor do cliente criar o usuário: peça de novo.',
    );
  });

  it('o botão desligado, com o motivo: servidor de versão antiga, nunca sincronizado, sem cofre, contrato terminado', async () => {
    const expectBlocked = async (id: string, state: FakeAdminState, reason: string) => {
      renderConsole(`/clientes/${id}`, state);
      const panel = await usersPanel();
      const button = await within(panel).findByRole('button', { name: 'Criar usuário…' });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
      expect(within(panel).queryByRole('form')).not.toBeInTheDocument();
      cleanup();
    };

    await expectBlocked(
      OUTDATED_ID,
      stateAt().state,
      'O servidor do cliente precisa da versão nova para receber usuários.',
    );
    await expectBlocked(
      NEVER_SYNCED_ID,
      stateAt().state,
      'O servidor do cliente ainda não sincronizou com a Verax: o usuário só pode ser pedido depois disso.',
    );
    const noVault = stateAt().state;
    const sync = noVault.logSources.tenants.get(ACTIVE_ID);
    if (sync?.node === null || sync?.node === undefined) throw new Error('nó de exemplo ausente');
    sync.node = { ...sync.node, vaultReady: false };
    await expectBlocked(
      ACTIVE_ID,
      noVault,
      'O servidor do cliente está sem o cofre de credenciais (ou não consegue lê-lo): não há para quem cifrar a senha.',
    );
    const canceled = stateAt().state;
    const tenant = canceled.tenants.tenants.get(ACTIVE_ID);
    if (tenant === undefined) throw new Error('cliente de exemplo ausente');
    canceled.tenants.tenants.set(ACTIVE_ID, { ...tenant, state: 'canceled' });
    await expectBlocked(
      ACTIVE_ID,
      canceled,
      'O contrato deste cliente já terminou: não há usuário para criar.',
    );
  });
});
