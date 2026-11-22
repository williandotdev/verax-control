import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TenantDetail } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { createFakeState, type FakeAdminState } from '@/mocks/fake-admin-api';
import { renderConsole } from '@/test/render';

const CUSTOMER_ID = '01JC0000000000000000000E01';
const NOW = new Date('2026-11-22T12:00:00.000Z');

const WARNING =
  'A senha aparece uma única vez. Depois ela é apagada do cofre e o link que o cliente recebeu por e-mail deixa de funcionar.';

/** O cliente de exemplo (o da VM própria) esperando o primeiro acesso, sem revelação, com o patch por cima. */
function waitingState(patch: Partial<TenantDetail> = {}): FakeAdminState {
  const state = createFakeState({ now: () => NOW });
  const tenant = state.tenants.tenants.get(CUSTOMER_ID);
  if (tenant === undefined) throw new Error('cliente de exemplo ausente');
  state.tenants.tenants.set(CUSTOMER_ID, {
    ...tenant,
    state: 'waiting_customer_connection',
    access: {},
    ...patch,
  });
  return state;
}

async function accessPanel(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Acesso do administrador' });
}

/** O valor de uma linha do acesso revelado (o texto no `dd` ao lado do rótulo, sem o botão de copiar). */
function revealedValue(region: HTMLElement, label: string): string {
  const term = within(region).getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.firstElementChild?.textContent ?? '';
}

/**
 * A senha inicial mostrada uma vez no detalhe do cliente, sobre a API simulada (`mocks/fake-tenants.ts`): o botão só na
 * espera do primeiro acesso e sem revelação, a confirmação pelo subdomínio com o aviso, o acesso com os botões de
 * copiar e a mensagem pronta, e cada recusa com o que fazer. Nenhum dado real.
 */
describe('mostrar a senha inicial', () => {
  it('confirma pelo subdomínio, mostra o acesso uma vez, copia cada campo e a mensagem, e fecha sem volta', async () => {
    const state = waitingState();
    const { user, client } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const panel = await accessPanel();

    await user.click(await within(panel).findByRole('button', { name: 'Mostrar senha inicial…' }));
    expect(within(panel).getByText(WARNING)).toBeInTheDocument();
    const confirm = within(panel).getByRole('button', { name: 'Confirmar: mostrar a senha' });
    expect(confirm).toBeDisabled();
    await user.type(within(panel).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    await user.click(confirm);

    const revealed = await within(panel).findByRole('region', { name: 'Acesso para enviar ao cliente' });
    const password = revealedValue(revealed, 'Senha temporária');
    expect(password).toMatch(/^Tmp-[0-9a-f]{24}$/);
    expect(revealedValue(revealed, 'Painel')).toBe('https://cliente-demo-e.control.veraxsistemas.com.br');
    expect(revealedValue(revealed, 'Login')).toBe('admin@cliente-demo-e.example');
    const expiry = formatDateTime(new Date(NOW.getTime() + 2 * 24 * 60 * 60_000).toISOString());
    expect(revealedValue(revealed, 'Válida até')).toBe(expiry);

    await user.click(within(revealed).getByRole('button', { name: 'Copiar: Senha temporária' }));
    expect(await within(revealed).findByText('Senha copiada.')).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(password);
    await user.click(within(revealed).getByRole('button', { name: 'Copiar: Login' }));
    await expect(navigator.clipboard.readText()).resolves.toBe('admin@cliente-demo-e.example');

    await user.click(within(revealed).getByRole('button', { name: 'Copiar mensagem para o cliente' }));
    expect(await within(revealed).findByText('Mensagem copiada.')).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(
      [
        'Olá! O ambiente de vocês no Verax Control está pronto.',
        '',
        'Painel: https://cliente-demo-e.control.veraxsistemas.com.br',
        'Login: admin@cliente-demo-e.example',
        `Senha temporária: ${password}`,
        `Válida até: ${expiry} (horário de Brasília)`,
        '',
        'No primeiro acesso, o painel pede para trocar a senha e configurar a verificação em duas etapas (MFA), com um aplicativo autenticador.',
      ].join('\n'),
    );

    // A revelação foi marcada: o detalhe lido de novo mostra a data, e a senha nunca entrou no cache das consultas.
    expect(state.tenants.tenants.get(CUSTOMER_ID)?.access.passwordRevealedAt).toBe(NOW.toISOString());
    const revealedAt = within(panel).getByText('Senha inicial revelada');
    await waitFor(() =>
      expect(revealedAt.nextElementSibling).toHaveTextContent(formatDateTime(NOW.toISOString())),
    );
    const cached = JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
    expect(cached).not.toContain(password);
    expect(client.getMutationCache().getAll()).toEqual([]);

    // Fechar: o acesso some e não volta (o botão também não, a revelação já aconteceu).
    await user.click(within(revealed).getByRole('button', { name: 'Fechar' }));
    expect(
      within(panel).queryByRole('region', { name: 'Acesso para enviar ao cliente' }),
    ).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Mostrar senha inicial…' })).not.toBeInTheDocument();
    expect(screen.queryByText(password)).not.toBeInTheDocument();
  });

  it('o botão só aparece na espera do primeiro acesso e sem revelação', async () => {
    renderConsole(
      `/clientes/${CUSTOMER_ID}`,
      waitingState({ access: { passwordRevealedAt: NOW.toISOString() } }),
    );
    const revealed = await accessPanel();
    expect(
      within(revealed).queryByRole('button', { name: 'Mostrar senha inicial…' }),
    ).not.toBeInTheDocument();
  });

  it('com o cliente já ativo, nada de botão', async () => {
    renderConsole(`/clientes/${CUSTOMER_ID}`, waitingState({ state: 'active' }));
    const panel = await accessPanel();
    expect(within(panel).queryByRole('button', { name: 'Mostrar senha inicial…' })).not.toBeInTheDocument();
  });

  it('o cliente revelou antes (entre abrir e confirmar): já revelada, com o caminho que sobra', async () => {
    const state = waitingState();
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const panel = await accessPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Mostrar senha inicial…' }));
    await user.type(within(panel).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    const tenant = state.tenants.tenants.get(CUSTOMER_ID);
    if (tenant === undefined) throw new Error('cliente de exemplo ausente');
    state.tenants.tenants.set(CUSTOMER_ID, { ...tenant, access: { passwordRevealedAt: NOW.toISOString() } });
    await user.click(within(panel).getByRole('button', { name: 'Confirmar: mostrar a senha' }));

    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent(/^A senha inicial já foi revelada \(pelo cliente/);
    expect(alert).toHaveTextContent('"Esqueci minha senha"');
    expect(
      within(panel).queryByRole('region', { name: 'Acesso para enviar ao cliente' }),
    ).not.toBeInTheDocument();
  });

  it('senha vencida: nada mostrado, a renovação do runbook; cp-worker fora: o que fazer', async () => {
    const state = waitingState();
    state.tenants.bootstrapExpired = true;
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const panel = await accessPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Mostrar senha inicial…' }));
    await user.type(within(panel).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    await user.click(within(panel).getByRole('button', { name: 'Confirmar: mostrar a senha' }));
    const expired = await within(panel).findByRole('alert');
    expect(expired).toHaveTextContent(
      'A senha temporária já venceu e nada foi mostrado. Gere uma senha nova pela renovação do runbook de onboarding (docs/runbooks/onboarding-cliente.md, §7) e tente de novo.',
    );
    expect(state.tenants.tenants.get(CUSTOMER_ID)?.access.passwordRevealedAt).toBeUndefined();

    state.tenants.bootstrapExpired = false;
    state.tenants.workerDown = true;
    await user.click(within(panel).getByRole('button', { name: 'Confirmar: mostrar a senha' }));
    await waitFor(() =>
      expect(within(panel).getByRole('alert')).toHaveTextContent(/^O cp-worker não respondeu/),
    );
    expect(
      within(panel).queryByRole('region', { name: 'Acesso para enviar ao cliente' }),
    ).not.toBeInTheDocument();

    // De volta: a confirmação continua aberta para tentar de novo.
    state.tenants.workerDown = false;
    await user.click(within(panel).getByRole('button', { name: 'Confirmar: mostrar a senha' }));
    expect(
      await within(panel).findByRole('region', { name: 'Acesso para enviar ao cliente' }),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
  });
});
