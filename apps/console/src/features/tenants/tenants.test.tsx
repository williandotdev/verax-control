import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeState } from '@/mocks/fake-admin-api';
import { renderConsole } from '@/test/render';

const FAILED_ID = '01JC0000000000000000000A01';
const PENDING_ID = '01JC0000000000000000000C01';
const ACTIVE_ID = '01JC0000000000000000000D01';

/**
 * Os clientes sobre a API simulada (`mocks/fake-tenants.ts`), com os clientes e a tabela FICTÍCIOS: a lista, o cadastro
 * de contrato direto (cotação de referência, confirmação pelo subdomínio, o erro da API no campo), o detalhe com a linha
 * do tempo e as operações do responsável.
 */
describe('clientes', () => {
  it('a lista: estado, cobrança, o passo e o código de quem parou, e o botão do contrato direto', async () => {
    renderConsole('/clientes');
    const table = await screen.findByRole('table', { name: /Clientes/ });
    const failed = within(table).getByRole('row', { name: /Cliente Demo A Ltda/ });
    expect(failed).toHaveTextContent('Provisionamento parou');
    expect(failed).toHaveTextContent('Contrato direto');
    expect(failed).toHaveTextContent('Túnel e DNS no Cloudflare');
    expect(failed).toHaveTextContent('cloudflare_denied');
    expect(within(table).getByRole('row', { name: /Cliente Demo B/ })).toHaveTextContent('Stripe (site)');
    expect(screen.getByRole('link', { name: 'Novo cliente (contrato direto)' })).toHaveAttribute(
      'href',
      '/clientes/novo',
    );
  });

  it('cadastro: cotação de referência, confirmação digitando o subdomínio e o cliente criado em provisionamento', async () => {
    const state = createFakeState();
    const { user, router } = renderConsole('/clientes/novo', state);
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    await user.type(screen.getByLabelText('Razão social'), 'Cliente Demo D Ltda');
    await user.type(screen.getByLabelText('CNPJ'), '11.222.333/0001-81');
    await user.type(
      screen.getByLabelText('E-mail do administrador do cliente'),
      'admin@cliente-demo-d.example',
    );
    await user.type(screen.getByLabelText('Subdomínio'), 'cliente-demo-d');
    expect(screen.getByRole('button', { name: 'Revisar e confirmar…' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    const quote = await screen.findByRole('region', { name: 'Cotação de referência' });
    expect(quote).toHaveTextContent('R$ 1.000,00 por mês');
    expect(quote).toHaveTextContent('Porte de teste P');

    await user.click(screen.getByRole('button', { name: 'Revisar e confirmar…' }));
    const confirm = screen.getByRole('region', { name: 'Confirmar o cadastro' });
    expect(confirm).toHaveTextContent('Cliente Demo D Ltda');
    expect(confirm).toHaveTextContent('Nenhuma cobrança é feita pela Stripe');
    const create = within(confirm).getByRole('button', { name: 'Criar e provisionar' });
    expect(create).toBeDisabled();
    await user.type(within(confirm).getByLabelText(/Digite o subdomínio/), 'cliente-demo-x');
    expect(create).toBeDisabled();
    await user.clear(within(confirm).getByLabelText(/Digite o subdomínio/));
    await user.type(within(confirm).getByLabelText(/Digite o subdomínio/), 'cliente-demo-d');
    await user.click(create);

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/clientes\/[0-9A-Z]{26}$/));
    expect(await screen.findByRole('heading', { name: 'Cliente Demo D Ltda' })).toBeInTheDocument();
    expect(screen.getByText('Cliente criado. O provisionamento começou.')).toBeInTheDocument();
    const created = [...state.tenants.tenants.values()].find((tenant) => tenant.slug === 'cliente-demo-d');
    expect(created).toMatchObject({
      state: 'provisioning',
      billingMode: 'contract',
      adminEmail: 'admin@cliente-demo-d.example',
    });
    // A chave de idempotência é o id do cliente: a que o formulário gerou.
    expect(router.state.location.pathname).toBe(`/clientes/${created?.id}`);
  });

  it('o que o provisionamento não cria: o motivo na cotação, e a confirmação não abre', async () => {
    const { user } = renderConsole('/clientes/novo');
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    await user.selectOptions(screen.getByLabelText('Onde roda'), 'Na nuvem do cliente');
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    const quote = await screen.findByRole('region', { name: 'Cotação de referência' });
    expect(within(quote).getByRole('alert')).toHaveTextContent('só o modo gerenciado');
    expect(screen.getByRole('button', { name: 'Revisar e confirmar…' })).toBeDisabled();
    // Mudar a configuração depois da cotação pede outra.
    await user.selectOptions(screen.getByLabelText('Onde roda'), 'Na infraestrutura da Verax');
    expect(screen.getByText('A configuração mudou: calcule a cotação de novo.')).toBeInTheDocument();
  });

  it('o subdomínio de outro cliente: a API recusa e o problema aparece no campo', async () => {
    const { user } = renderConsole('/clientes/novo');
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    await user.type(screen.getByLabelText('Razão social'), 'Cliente Demo E Ltda');
    await user.type(screen.getByLabelText('CNPJ'), '11.222.333/0001-81');
    await user.type(
      screen.getByLabelText('E-mail do administrador do cliente'),
      'admin@cliente-demo-e.example',
    );
    await user.type(screen.getByLabelText('Subdomínio'), 'cliente-demo-b');
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    await screen.findByRole('region', { name: 'Cotação de referência' });
    await user.click(screen.getByRole('button', { name: 'Revisar e confirmar…' }));
    await user.type(screen.getByLabelText(/Digite o subdomínio/), 'cliente-demo-b');
    await user.click(screen.getByRole('button', { name: 'Criar e provisionar' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('slug');
    expect(screen.getByLabelText('Subdomínio')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Subdomínio')).toHaveAccessibleDescription(
      /Este subdomínio não está disponível\. Escolha outro\./,
    );
  });

  it('cp-worker fora do alcance: o cliente nasce em pending, com o aviso, e o "Iniciar provisionamento" depois', async () => {
    const state = createFakeState();
    state.tenants.workerDown = true;
    const { user } = renderConsole('/clientes/novo', state);
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    await user.type(screen.getByLabelText('Razão social'), 'Cliente Demo F Ltda');
    await user.type(screen.getByLabelText('CNPJ'), '11.222.333/0001-81');
    await user.type(
      screen.getByLabelText('E-mail do administrador do cliente'),
      'admin@cliente-demo-f.example',
    );
    await user.type(screen.getByLabelText('Subdomínio'), 'cliente-demo-f');
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    await screen.findByRole('region', { name: 'Cotação de referência' });
    await user.click(screen.getByRole('button', { name: 'Revisar e confirmar…' }));
    await user.type(screen.getByLabelText(/Digite o subdomínio/), 'cliente-demo-f');
    await user.click(screen.getByRole('button', { name: 'Criar e provisionar' }));

    expect(await screen.findByText(/o provisionamento não começou/)).toHaveTextContent(
      'INGRESS_TRAFFIC_INTERNAL_ONLY',
    );
    expect(screen.getAllByText('Aguardando início').length).toBeGreaterThan(0);

    state.tenants.workerDown = false;
    await user.click(screen.getByRole('button', { name: 'Iniciar provisionamento…' }));
    await user.type(screen.getByLabelText(/Digite o subdomínio/), 'cliente-demo-f');
    await user.click(screen.getByRole('button', { name: 'Confirmar: iniciar provisionamento' }));
    expect(
      await screen.findByText('Provisionamento iniciado: o primeiro passo está na fila.'),
    ).toBeInTheDocument();
  });

  it('detalhe de quem parou: o código com a explicação, a linha do tempo e o retomar com a confirmação', async () => {
    const state = createFakeState();
    const { user } = renderConsole(`/clientes/${FAILED_ID}`, state);
    expect(await screen.findByRole('heading', { name: 'Cliente Demo A Ltda' })).toBeInTheDocument();
    const provisioning = screen.getByRole('region', { name: 'Provisionamento' });
    expect(within(provisioning).getAllByRole('alert')[0]).toHaveTextContent('cloudflare_denied');
    expect(within(provisioning).getAllByRole('alert')[0]).toHaveTextContent('recusou a credencial');
    const steps = within(provisioning).getByRole('list', { name: 'Linha do tempo do provisionamento' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(10);
    expect(within(steps).getAllByRole('listitem')[1]).toHaveTextContent('Parou');
    expect(screen.getByText('11.222.333/0001-81')).toBeInTheDocument();

    // Sem o cp-worker: a explicação de verdade, não o "tente de novo" genérico.
    state.tenants.workerDown = true;
    await user.click(within(provisioning).getByRole('button', { name: 'Retomar provisionamento…' }));
    const confirm = within(provisioning).getByRole('button', { name: 'Confirmar: retomar provisionamento' });
    expect(confirm).toBeDisabled();
    await user.type(within(provisioning).getByLabelText(/Digite o subdomínio/), 'cliente-demo-a');
    await user.click(confirm);
    expect(await within(provisioning).findByText(/O cp-worker não respondeu/)).toBeInTheDocument();

    state.tenants.workerDown = false;
    await user.click(
      within(provisioning).getByRole('button', { name: 'Confirmar: retomar provisionamento' }),
    );
    expect(await screen.findByText(/Provisionamento retomado/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Provisionando').length).toBeGreaterThan(0));
  });

  it('contrato direto ativo: suspender e reativar, cancelar numa data e agora, exportar e apagar, sempre com a confirmação', async () => {
    const state = createFakeState();
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const lifecycle = await screen.findByRole('region', { name: 'Ciclo de vida' });
    expect(within(lifecycle).queryByRole('button', { name: 'Reativar…' })).not.toBeInTheDocument();
    expect(within(lifecycle).queryByRole('button', { name: 'Apagar agora…' })).not.toBeInTheDocument();

    await user.click(within(lifecycle).getByRole('button', { name: 'Suspender…' }));
    expect(within(lifecycle).getByText(/A VM do cliente para/)).toBeInTheDocument();
    await user.type(within(lifecycle).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(within(lifecycle).getByRole('button', { name: 'Confirmar: suspender' }));
    expect(
      await within(lifecycle).findByText('Cliente suspenso: a VM está sendo parada.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Suspenso').length).toBeGreaterThan(0));

    await user.click(await within(lifecycle).findByRole('button', { name: 'Reativar…' }));
    await user.type(within(lifecycle).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(within(lifecycle).getByRole('button', { name: 'Confirmar: reativar' }));
    expect(
      await within(lifecycle).findByText('Cliente reativado: a VM está sendo ligada.'),
    ).toBeInTheDocument();

    // Cancelar no fim do contrato: marcado, o cliente segue ativo.
    await user.click(await within(lifecycle).findByRole('button', { name: 'Cancelar contrato…' }));
    await user.type(within(lifecycle).getByLabelText('Cancelar em'), '2027-01-31');
    await user.type(within(lifecycle).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(within(lifecycle).getByRole('button', { name: 'Confirmar: cancelar contrato' }));
    expect(await within(lifecycle).findByText(/Cancelamento marcado para 31\/01\/2027/)).toBeInTheDocument();
    expect(await within(lifecycle).findByText('Cancelamento marcado')).toBeInTheDocument();

    // Agora: cancelado, com a exportação e o apagar agora.
    await user.click(within(lifecycle).getByRole('button', { name: 'Cancelar contrato…' }));
    await user.type(within(lifecycle).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(within(lifecycle).getByRole('button', { name: 'Confirmar: cancelar contrato' }));
    expect(await within(lifecycle).findByText(/Contrato cancelado/)).toBeInTheDocument();

    await user.click(await within(lifecycle).findByRole('button', { name: 'Exportar dados…' }));
    await user.type(within(lifecycle).getByLabelText('Backup'), 'postgres/verax-20261105T030000Z.dump');
    await user.type(within(lifecycle).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(within(lifecycle).getByRole('button', { name: 'Confirmar: exportar dados' }));
    const link = await within(lifecycle).findByRole('link', {
      name: /^https:\/\/storage\.googleapis\.com\/projeto-dos-nos-demo-vx-contrato-ativo-backups\//,
    });
    expect(link.getAttribute('href')).toMatch(/^https:\/\//);

    await user.click(within(lifecycle).getByRole('button', { name: 'Apagar agora…' }));
    expect(within(lifecycle).getByText(/Não tem volta/)).toBeInTheDocument();
    await user.type(within(lifecycle).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(within(lifecycle).getByRole('button', { name: 'Confirmar: apagar agora' }));
    expect(await within(lifecycle).findByText('A exclusão começou.')).toBeInTheDocument();
  });

  it('cliente da Stripe: só a explicação no ciclo de vida, sem botão de cancelar nem suspender', async () => {
    renderConsole('/clientes/01JC0000000000000000000B01');
    const lifecycle = await screen.findByRole('region', { name: 'Ciclo de vida' });
    expect(lifecycle).toHaveTextContent('Cliente da Stripe');
    expect(within(lifecycle).queryByRole('button')).not.toBeInTheDocument();
    expect(lifecycle).toHaveTextContent('Nenhuma operação do ciclo de vida neste estado.');
  });

  it('a exportação sem a conta que assina: o que configurar, não o erro genérico', async () => {
    const state = createFakeState();
    state.tenants.workerDown = true;
    const { user } = renderConsole(`/clientes/${PENDING_ID}`, state);
    const provisioning = await screen.findByRole('region', { name: 'Provisionamento' });
    await user.click(within(provisioning).getByRole('button', { name: 'Iniciar provisionamento…' }));
    await user.type(within(provisioning).getByLabelText(/Digite o subdomínio/), 'cliente-demo-c');
    await user.click(
      within(provisioning).getByRole('button', { name: 'Confirmar: iniciar provisionamento' }),
    );
    expect(await within(provisioning).findByRole('alert')).toHaveTextContent('INGRESS_TRAFFIC_INTERNAL_ONLY');
  });

  it('cliente inexistente: o erro da API, com a opção de tentar de novo', async () => {
    renderConsole('/clientes/01JC0000000000000000000Z99');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cliente não encontrado.');
  });
});
