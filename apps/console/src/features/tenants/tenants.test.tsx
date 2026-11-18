import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TenantDetail } from '@/lib/api-types';
import { createFakeState, type FakeAdminState } from '@/mocks/fake-admin-api';
import { renderConsole } from '@/test/render';

const FAILED_ID = '01JC0000000000000000000A01';
const PENDING_ID = '01JC0000000000000000000C01';
const ACTIVE_ID = '01JC0000000000000000000D01';
const CUSTOMER_ID = '01JC0000000000000000000E01';

/** Muda o cliente de exemplo na infraestrutura do cliente (as operações disponíveis ficam as dele). */
function patchCustomer(state: FakeAdminState, patch: Partial<TenantDetail>): void {
  const tenant = state.tenants.tenants.get(CUSTOMER_ID);
  if (tenant === undefined) throw new Error('cliente de exemplo ausente');
  state.tenants.tenants.set(CUSTOMER_ID, { ...tenant, ...patch });
}

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
    expect(failed).toHaveTextContent('SIEM Cloud · porte P');
    const paid = within(table).getByRole('row', { name: /Cliente Demo B/ });
    expect(paid).toHaveTextContent('Stripe (site)');
    // Contratado no modelo de preço anterior: sem plano.
    expect(paid).toHaveTextContent('modelo anterior · porte P');
    expect(screen.getByRole('link', { name: 'Novo cliente (contrato direto)' })).toHaveAttribute(
      'href',
      '/clientes/novo',
    );
  });

  it('cadastro: cotação de referência, confirmação digitando o subdomínio e o cliente criado em provisionamento', async () => {
    const state = createFakeState();
    const { user, router } = renderConsole('/clientes/novo', state);
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('3'));
    await user.type(screen.getByLabelText('Razão social'), 'Cliente Demo D Ltda');
    await user.type(screen.getByLabelText('CNPJ'), '11.222.333/0001-81');
    await user.type(
      screen.getByLabelText('E-mail do administrador do cliente'),
      'admin@cliente-demo-d.example',
    );
    await user.type(screen.getByLabelText('Subdomínio'), 'cliente-demo-d');
    expect(screen.getByRole('button', { name: 'Revisar e confirmar…' })).toBeDisabled();

    // Onde o ambiente roda é obrigatório e começa sem escolha: calcular sem ele aponta o grupo.
    expect(screen.getByRole('radio', { name: 'Infraestrutura da Verax' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Infraestrutura do cliente' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Escolha onde o ambiente roda');
    expect(screen.getByRole('radio', { name: 'Infraestrutura da Verax' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await user.click(screen.getByRole('radio', { name: 'Infraestrutura da Verax' }));

    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    const quote = await screen.findByRole('region', { name: 'Cotação de referência' });
    expect(quote).toHaveTextContent('R$ 1.500,00 por mês');
    expect(quote).toHaveTextContent('SIEM Dedicado, 3 GB/dia');
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
      hosting: 'verax',
      adminEmail: 'admin@cliente-demo-d.example',
    });
    // A chave de idempotência é o id do cliente: a que o formulário gerou.
    expect(router.state.location.pathname).toBe(`/clientes/${created?.id}`);
  });

  it('valores do contrato: preenchidos com a tabela, negociados, mantidos ao recalcular, de volta à tabela e enviados', async () => {
    const state = createFakeState();
    const { user, router } = renderConsole('/clientes/novo', state);
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('3'));
    await user.type(screen.getByLabelText('Razão social'), 'Cliente Demo H Ltda');
    await user.type(screen.getByLabelText('CNPJ'), '11.222.333/0001-81');
    await user.type(
      screen.getByLabelText('E-mail do administrador do cliente'),
      'admin@cliente-demo-h.example',
    );
    await user.type(screen.getByLabelText('Subdomínio'), 'cliente-demo-h');
    await user.click(screen.getByRole('radio', { name: 'Infraestrutura do cliente' }));
    // Antes da cotação, nada de valores do contrato.
    expect(screen.queryByRole('region', { name: 'Valores do contrato' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));

    // Pré-preenchidos com a tabela (Dedicado, 3 GB/dia, FICTÍCIO): R$ 1.500,00 por mês e R$ 500,00 por GB/dia.
    const values = await screen.findByRole('region', { name: 'Valores do contrato' });
    const monthly = within(values).getByLabelText('Valor mensal do contrato');
    const additional = within(values).getByLabelText('Valor por GB/dia adicional');
    expect(monthly).toHaveValue('1.500,00');
    expect(additional).toHaveValue('500,00');
    expect(monthly).toHaveAccessibleDescription(/Tabela: R\$\s1\.500,00 por mês/);
    expect(within(values).getAllByText('Tabela')).toHaveLength(2);
    expect(
      within(values).queryByRole('button', { name: /Voltar ao valor da tabela/ }),
    ).not.toBeInTheDocument();

    // Negociado por fora: o marcador diz quanto difere da tabela.
    await user.clear(monthly);
    await user.type(monthly, '1.350');
    expect(values).toHaveTextContent('Negociado, 10,0% abaixo da tabela');
    expect(
      within(values).getByRole('button', { name: 'Voltar ao valor da tabela: Valor mensal do contrato' }),
    ).toBeInTheDocument();

    // Outra configuração: a cotação nova não apaga o negociado; o que não foi mexido segue a tabela nova.
    await user.click(screen.getByRole('radio', { name: 'Infraestrutura da Verax' }));
    await user.selectOptions(screen.getByLabelText('Plano'), 'SIEM Cloud');
    expect(screen.queryByRole('region', { name: 'Valores do contrato' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    const recalculated = await screen.findByRole('region', { name: 'Valores do contrato' });
    // SIEM Cloud, 3 GB/dia (FICTÍCIO): R$ 1.300,00 por mês e R$ 300,00 por GB/dia adicional.
    expect(within(recalculated).getByLabelText('Valor mensal do contrato')).toHaveValue('1.350,00');
    expect(within(recalculated).getByLabelText('Valor por GB/dia adicional')).toHaveValue('300,00');
    expect(recalculated).toHaveTextContent('Negociado, 3,8% acima da tabela');

    // De volta à tabela, e o GB/dia adicional negociado; sem valor, a confirmação não abre.
    await user.click(
      within(recalculated).getByRole('button', {
        name: 'Voltar ao valor da tabela: Valor mensal do contrato',
      }),
    );
    expect(within(recalculated).getByLabelText('Valor mensal do contrato')).toHaveValue('1.300,00');
    const additionalNow = within(recalculated).getByLabelText('Valor por GB/dia adicional');
    await user.clear(additionalNow);
    expect(screen.getByRole('button', { name: 'Revisar e confirmar…' })).toBeDisabled();
    expect(screen.getByText(/Preencha os valores do contrato/)).toBeInTheDocument();
    await user.type(additionalNow, '270');
    expect(recalculated).toHaveTextContent('Negociado, 10,0% abaixo da tabela');

    // A confirmação mostra o contratado com a tabela ao lado, e o cadastro manda o editado.
    await user.click(screen.getByRole('button', { name: 'Revisar e confirmar…' }));
    const confirm = screen.getByRole('region', { name: 'Confirmar o cadastro' });
    expect(confirm).toHaveTextContent('Valor mensal do contratoR$ 1.300,00 por mêsTabela');
    expect(confirm).toHaveTextContent(
      'Valor por GB/dia adicionalR$ 270,00 por GB/dia, por mêsNegociado, 10,0% abaixo da tabelatabela: R$ 300,00',
    );
    // Confirmando, os campos ficam só para leitura.
    expect(within(recalculated).getByLabelText('Valor por GB/dia adicional')).toBeDisabled();
    await user.type(within(confirm).getByLabelText(/Digite o subdomínio/), 'cliente-demo-h');
    await user.click(within(confirm).getByRole('button', { name: 'Criar e provisionar' }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/clientes\/[0-9A-Z]{26}$/));
    const created = [...state.tenants.tenants.values()].find((tenant) => tenant.slug === 'cliente-demo-h');
    expect(created?.contractPricing).toEqual({
      reference: { monthlyTotal: 130_000, additionalGbDayAmount: 30_000 },
      contracted: { monthlyTotal: 130_000, additionalGbDayAmount: 27_000 },
    });
    const contracted = await screen.findByRole('region', { name: 'Contratado' });
    expect(contracted).toHaveTextContent('R$ 270,00 por GB/dia, por mês');
    expect(contracted).toHaveTextContent('tabela: R$ 300,00');
  });

  it('o que não se instala: o motivo na cotação, e a confirmação não abre; no cliente, os agentes também não', async () => {
    const { user } = renderConsole('/clientes/novo');
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('3'));
    await user.click(screen.getByRole('radio', { name: 'Infraestrutura da Verax' }));
    // 10 GB/dia pede o porte M (fictício), que o provisionamento ainda não cria.
    const gbDay = screen.getByLabelText('Volume de logs (GB/dia)');
    await user.clear(gbDay);
    await user.type(gbDay, '10');
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    const quote = await screen.findByRole('region', { name: 'Cotação de referência' });
    expect(within(quote).getByRole('alert')).toHaveTextContent('o provisionamento cria só o porte P hoje');
    expect(screen.getByRole('button', { name: 'Revisar e confirmar…' })).toBeDisabled();
    // Mudar o lugar depois da cotação pede outra; no cliente, o porte não conta (nada é provisionado) e o preço é o mesmo.
    await user.click(screen.getByRole('radio', { name: 'Infraestrutura do cliente' }));
    expect(screen.getByText('A configuração mudou: calcule a cotação de novo.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Cotação de referência' })).queryByRole('alert'),
      ).not.toBeInTheDocument(),
    );
    const customerQuote = screen.getByRole('region', { name: 'Cotação de referência' });
    expect(customerQuote).toHaveTextContent('GB/dia do servidor dedicado');
    expect(customerQuote).toHaveTextContent('R$ 5.000,00 por mês');
    expect(screen.getByRole('button', { name: 'Revisar e confirmar…' })).toBeEnabled();
    // A Plataforma no cliente não existe: sob consulta, com o motivo.
    await user.selectOptions(screen.getByLabelText('Plano'), 'SIEM Cloud');
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    expect(await screen.findByText(/o SIEM Cloud só roda na infraestrutura da Verax/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revisar e confirmar…' })).toBeDisabled();
  });

  it('o subdomínio de outro cliente: a API recusa e o problema aparece no campo', async () => {
    const { user } = renderConsole('/clientes/novo');
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('3'));
    await user.type(screen.getByLabelText('Razão social'), 'Cliente Demo E Ltda');
    await user.type(screen.getByLabelText('CNPJ'), '11.222.333/0001-81');
    await user.type(
      screen.getByLabelText('E-mail do administrador do cliente'),
      'admin@cliente-demo-e.example',
    );
    await user.type(screen.getByLabelText('Subdomínio'), 'cliente-demo-b');
    await user.click(screen.getByRole('radio', { name: 'Infraestrutura da Verax' }));
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
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('3'));
    await user.type(screen.getByLabelText('Razão social'), 'Cliente Demo F Ltda');
    await user.type(screen.getByLabelText('CNPJ'), '11.222.333/0001-81');
    await user.type(
      screen.getByLabelText('E-mail do administrador do cliente'),
      'admin@cliente-demo-f.example',
    );
    await user.type(screen.getByLabelText('Subdomínio'), 'cliente-demo-f');
    await user.click(screen.getByRole('radio', { name: 'Infraestrutura da Verax' }));
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
    expect(within(steps).getAllByRole('listitem')).toHaveLength(11);
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
    // Contratado no modelo de preço anterior: o que ele tem, só para consulta.
    const contracted = screen.getByRole('region', { name: 'Contratado' });
    expect(contracted).toHaveTextContent('Modelo anterior · na Verax · porte P · 2 contas · 10 GiB/mês');
    expect(contracted).toHaveTextContent('Contratado no modelo de preço anterior');
  });

  it('o contratado no modelo por GB/dia: o plano, a franquia e os valores negociados com a tabela ao lado', async () => {
    renderConsole(`/clientes/${CUSTOMER_ID}`);
    const contracted = await screen.findByRole('region', { name: 'Contratado' });
    expect(contracted).toHaveTextContent('SIEM Dedicado · 3 GB/dia · no cliente · porte P');
    expect(contracted).toHaveTextContent('Franquia contratada: 3 GB/dia');
    expect(contracted).toHaveTextContent(
      'Valor mensal do contratoR$ 1.350,00 por mêsNegociado, 10,0% abaixo da tabelatabela: R$ 1.500,00',
    );
    expect(contracted).toHaveTextContent(
      'Valor por GB/dia adicionalR$ 450,00 por GB/dia, por mêsNegociado, 10,0% abaixo da tabelatabela: R$ 500,00',
    );
    expect(contracted).toHaveTextContent(
      'Preço de referência (tabela teste-v2): R$ 1.500,00 por mês, R$ 500,00 por GB/dia adicional.',
    );
  });

  it('contrato direto de antes dos valores do contrato: só a referência, com a explicação', async () => {
    renderConsole(`/clientes/${PENDING_ID}`);
    const contracted = await screen.findByRole('region', { name: 'Contratado' });
    expect(contracted).toHaveTextContent('Preço de referência (tabela teste-v2): R$ 1.000,00 por mês.');
    expect(contracted).toHaveTextContent('o contratado é o preço de referência');
    expect(contracted).not.toHaveTextContent('Valor mensal do contrato');
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

  it('no cliente: o cadastro com a licença, sem provisionar, e o detalhe com o que mandar a ele', async () => {
    const state = createFakeState();
    const { user, router } = renderConsole('/clientes/novo', state);
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('3'));
    await user.type(screen.getByLabelText('Razão social'), 'Cliente Demo G Ltda');
    await user.type(screen.getByLabelText('CNPJ'), '11.222.333/0001-81');
    await user.type(
      screen.getByLabelText('E-mail do administrador do cliente'),
      'admin@cliente-demo-g.example',
    );
    await user.type(screen.getByLabelText('Subdomínio'), 'cliente-demo-g');
    await user.click(screen.getByRole('radio', { name: 'Infraestrutura do cliente' }));
    await user.click(screen.getByRole('button', { name: 'Calcular a cotação' }));
    const quote = await screen.findByRole('region', { name: 'Cotação de referência' });
    // O mesmo preço por GB/dia no cliente.
    expect(quote).toHaveTextContent('R$ 1.500,00 por mês');
    await user.click(screen.getByRole('button', { name: 'Revisar e confirmar…' }));
    const confirm = screen.getByRole('region', { name: 'Confirmar o cadastro' });
    expect(confirm).toHaveTextContent('Infraestrutura do cliente');
    expect(confirm).toHaveTextContent('Nada é criado na infraestrutura da Verax');
    expect(confirm).not.toHaveTextContent(/GCP|Google/);
    await user.type(within(confirm).getByLabelText(/Digite o subdomínio/), 'cliente-demo-g');
    await user.click(within(confirm).getByRole('button', { name: 'Criar o cliente' }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/clientes\/[0-9A-Z]{26}$/));
    expect(await screen.findByRole('heading', { name: 'Cliente Demo G Ltda' })).toBeInTheDocument();
    expect(screen.getByText(/O ambiente roda numa VM do cliente: gere o comando/)).toBeInTheDocument();
    const created = [...state.tenants.tenants.values()].find((tenant) => tenant.slug === 'cliente-demo-g');
    expect(created).toMatchObject({
      state: 'waiting_customer_install',
      hosting: 'customer',
      configuration: { plan: 'dedicado', mode: 'self_hosted', gbDay: 3 },
      timeline: [],
    });
    expect(screen.queryByRole('region', { name: 'Provisionamento' })).not.toBeInTheDocument();
    const installation = screen.getByRole('region', { name: 'Instalação na infraestrutura do cliente' });
    expect(within(installation).getByRole('group', { name: 'Situação da instalação' })).toHaveTextContent(
      'Aguardando o comando',
    );
    expect(await within(installation).findByRole('button', { name: 'Gerar comando…' })).toBeEnabled();
  });

  it('detalhe no cliente: o perfil da VM, a rede só de saída, o comando e os detalhes técnicos fechados; só cancelar', async () => {
    const state = createFakeState();
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    expect(await screen.findByRole('heading', { name: 'Cliente Demo E Ltda' })).toBeInTheDocument();
    expect(screen.getAllByText('Aguardando instalação pelo cliente').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Infraestrutura do cliente').length).toBeGreaterThan(0);
    // Nada de endereços nem de passos da Verax.
    expect(document.body.textContent).not.toContain('.control.veraxsistemas.com.br');
    expect(screen.queryByRole('region', { name: 'Provisionamento' })).not.toBeInTheDocument();

    const installation = screen.getByRole('region', { name: 'Instalação na infraestrutura do cliente' });
    // 1. O perfil da VM do porte do contrato (P), com o sistema e o swap.
    const profile = within(installation).getByRole('region', { name: '1. Perfil da VM' });
    expect(profile).toHaveTextContent('porte P');
    expect(profile).toHaveTextContent('vCPU2');
    expect(profile).toHaveTextContent('Memória8 GB');
    expect(profile).toHaveTextContent('Disco60 GB');
    expect(profile).toHaveTextContent('Debian 12, Ubuntu 22.04 ou Ubuntu 24.04, x86_64');
    expect(profile).toHaveTextContent('Swap desligado ou cifrado');
    // 2. A rede: nenhuma porta de entrada e a saída que a VM precisa.
    const network = within(installation).getByRole('region', { name: '2. Rede' });
    expect(within(network).getByText('Nenhuma porta de entrada.')).toBeInTheDocument();
    const egress = within(network).getByRole('table', { name: 'Destinos de saída da VM' });
    expect(
      within(egress).getByRole('row', { name: (name) => name.includes('argotunnel.com') }),
    ).toHaveTextContent('443 e 7844');
    expect(
      within(egress).getByRole('row', { name: (name) => name.includes('conta.veraxsistemas.com.br') }),
    ).toBeInTheDocument();
    expect(within(egress).getByRole('row', { name: (name) => name.includes('ghcr.io') })).toBeInTheDocument();
    expect(
      within(egress).getByRole('row', { name: (name) => name.includes('registry-1.docker.io') }),
    ).toBeInTheDocument();
    expect(within(egress).getByRole('row', { name: /NTP/ })).toHaveTextContent('123');
    // 3. O comando: o botão, sem o comando antes de gerar.
    const command = within(installation).getByRole('region', { name: '3. Comando de instalação' });
    expect(await within(command).findByRole('button', { name: 'Gerar comando…' })).toBeEnabled();
    expect(within(command).queryByLabelText('Comando de instalação gerado')).not.toBeInTheDocument();
    // O conteúdo técnico antigo saiu; só a versão e o guia, fechados em "Detalhes técnicos".
    expect(installation).not.toHaveTextContent('manifest.json');
    expect(installation).not.toHaveTextContent('PLAN=enterprise');
    expect(installation).not.toHaveTextContent(`sha256:${'1'.repeat(64)}`);
    expect(installation).not.toHaveTextContent('4'.repeat(64));
    const details = within(installation).getByText('Detalhes técnicos').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('node-v1.2.3');
    expect(within(installation).getByRole('link', { name: /Guia de instalação/ })).toHaveAttribute(
      'href',
      'https://github.com/williandotdev/verax-control/blob/main/docs/runbooks/instalacao-no-cliente.md',
    );

    // O acesso: o e-mail "ambiente pronto" quando a VM avisa que está pronta.
    expect(screen.getByRole('region', { name: 'Acesso do administrador' })).toHaveTextContent(
      'Quando a VM do cliente avisa que está pronta',
    );
    // O ciclo de vida: só cancelar (nada de suspender), e o texto do que não acontece.
    const lifecycle = screen.getByRole('region', { name: 'Ciclo de vida' });
    expect(lifecycle).toHaveTextContent('quem apaga o ambiente é o próprio cliente');
    expect(within(lifecycle).queryByRole('button', { name: 'Suspender…' })).not.toBeInTheDocument();
    await user.click(within(lifecycle).getByRole('button', { name: 'Cancelar contrato…' }));
    expect(within(lifecycle).getByText(/Só registra o fim do contrato/)).toBeInTheDocument();
    await user.type(within(lifecycle).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    await user.click(within(lifecycle).getByRole('button', { name: 'Confirmar: cancelar contrato' }));
    expect(await within(lifecycle).findByText(/Contrato cancelado/)).toBeInTheDocument();
    // Cancelado: não há comando a gerar.
    expect(await within(command).findByText(/não há comando a gerar/)).toBeInTheDocument();
    expect(within(command).getByRole('button', { name: 'Gerar comando…' })).toBeDisabled();
    // Cancelado no cliente: sem exportação (os dados nunca estiveram na Verax); apagar agora só o cadastro.
    expect(within(lifecycle).queryByRole('button', { name: 'Exportar dados…' })).not.toBeInTheDocument();
    await user.click(await within(lifecycle).findByRole('button', { name: 'Apagar agora…' }));
    expect(within(lifecycle).getByText(/Nada é apagado no ambiente do cliente/)).toBeInTheDocument();
    expect(state.tenants.tenants.get(CUSTOMER_ID)?.lifecycle.exportUntil).toBeUndefined();
  });

  it('gerar o comando: a confirmação pelo subdomínio, o comando uma vez com o vencimento, copiar e a VM esperada', async () => {
    const state = createFakeState();
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const command = await screen.findByRole('region', { name: '3. Comando de instalação' });
    await user.click(await within(command).findByRole('button', { name: 'Gerar comando…' }));
    expect(command).toHaveTextContent('Um comando novo revoga o anterior');
    expect(command).not.toHaveTextContent('O ambiente já está instalado');
    const confirm = within(command).getByRole('button', { name: 'Confirmar: gerar comando' });
    expect(confirm).toBeDisabled();
    await user.type(within(command).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    await user.click(confirm);

    const generated = await within(command).findByLabelText('Comando de instalação gerado');
    const text = generated.textContent ?? '';
    const prefix = `curl -fsSLo verax-install.sh https://github.com/williandotdev/verax-control/releases/download/node-v1.2.3/verax-install.sh && echo "${'5'.repeat(64)}  verax-install.sh" | sha256sum -c - && sudo bash verax-install.sh --codigo `;
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.slice(prefix.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(command).toHaveTextContent('aparece só agora');
    expect(command).toHaveTextContent(/de uso único e vale até \d{2}\/\d{2}\/\d{4}/);
    expect(command).not.toHaveTextContent('A VM anterior deixou de valer');

    await user.click(within(command).getByRole('button', { name: 'Copiar o comando' }));
    expect(await within(command).findByText('Comando copiado.')).toBeInTheDocument();
    await expect(navigator.clipboard.readText()).resolves.toBe(text);

    // A execução reduzida começou: a situação diz que espera a VM do cliente.
    expect(state.tenants.tenants.get(CUSTOMER_ID)?.state).toBe('provisioning');
    expect(await screen.findByText('Esperando a VM do cliente')).toBeInTheDocument();
    // O comando continua na tela depois da atualização, até ocultar; depois, não volta.
    expect(within(command).getByLabelText('Comando de instalação gerado')).toBeInTheDocument();
    await user.click(within(command).getByRole('button', { name: 'Ocultar' }));
    expect(within(command).queryByLabelText('Comando de instalação gerado')).not.toBeInTheDocument();
    expect(within(command).getByRole('button', { name: 'Gerar comando…' })).toBeEnabled();
  });

  it('ambiente pronto: gerar outro comando avisa da reinstalação e diz que a VM anterior deixou de valer', async () => {
    const state = createFakeState();
    patchCustomer(state, { state: 'active' });
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const installation = await screen.findByRole('region', {
      name: 'Instalação na infraestrutura do cliente',
    });
    expect(within(installation).getByRole('group', { name: 'Situação da instalação' })).toHaveTextContent(
      'Pronto',
    );
    const command = within(installation).getByRole('region', { name: '3. Comando de instalação' });
    await user.click(await within(command).findByRole('button', { name: 'Gerar comando…' }));
    expect(command).toHaveTextContent('O ambiente já está instalado');
    await user.type(within(command).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    await user.click(within(command).getByRole('button', { name: 'Confirmar: gerar comando' }));
    expect(await within(command).findByLabelText('Comando de instalação gerado')).toBeInTheDocument();
    expect(command).toHaveTextContent('A VM anterior deixou de valer');
  });

  it('a instalação parou: o código do instalador com o que fazer, e o perfil do porte M', async () => {
    const state = createFakeState();
    const tenant = state.tenants.tenants.get(CUSTOMER_ID);
    if (tenant === undefined) throw new Error('cliente de exemplo ausente');
    patchCustomer(state, {
      state: 'provisioning_failed',
      configuration: { ...tenant.configuration, size: 'M' },
      provisioning: {
        runId: '01JC00000000000000000R9999',
        step: 'enrollment.wait',
        attempts: 1,
        lastError: { code: 'node_error:host_below_size', at: '2026-11-18T10:00:00Z' },
      },
    });
    renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const status = await screen.findByRole('alert', { name: 'Situação da instalação' });
    expect(status).toHaveTextContent('A instalação parou');
    expect(status).toHaveTextContent('node_error:host_below_size');
    expect(status).toHaveTextContent('A VM é menor que o porte do contrato');
    expect(status).toHaveTextContent('gere um comando novo');
    const profile = screen.getByRole('region', { name: '1. Perfil da VM' });
    expect(profile).toHaveTextContent('vCPU4');
    expect(profile).toHaveTextContent('Memória16 GB');
    expect(profile).toHaveTextContent('Disco120 GB');
  });

  it('versão sem o instalador: o aviso de publicar uma versão nova e o botão desligado', async () => {
    const state = createFakeState();
    state.tenants.withoutInstaller = true;
    renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const command = await screen.findByRole('region', { name: '3. Comando de instalação' });
    expect(await within(command).findByRole('note')).toHaveTextContent(
      'A versão atual do nó (node-v1.2.3) ainda não tem o instalador',
    );
    expect(within(command).getByRole('button', { name: 'Gerar comando…' })).toBeDisabled();
    // O perfil e a rede continuam lá.
    expect(screen.getByRole('region', { name: '1. Perfil da VM' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '2. Rede' })).toBeInTheDocument();
  });

  it('a versão não veio do cp-worker: o que fazer, com a opção de tentar de novo', async () => {
    const state = createFakeState();
    state.tenants.workerDown = true;
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const command = await screen.findByRole('region', { name: '3. Comando de instalação' });
    expect(await within(command).findByRole('alert')).toHaveTextContent('O cp-worker não respondeu');
    expect(within(command).queryByRole('button', { name: 'Gerar comando…' })).not.toBeInTheDocument();
    state.tenants.workerDown = false;
    await user.click(within(command).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(command).findByRole('button', { name: 'Gerar comando…' })).toBeEnabled();
  });

  it('gerar o comando com o cp-worker fora do alcance: o que fazer, e nenhum comando na tela', async () => {
    const state = createFakeState();
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const command = await screen.findByRole('region', { name: '3. Comando de instalação' });
    await user.click(await within(command).findByRole('button', { name: 'Gerar comando…' }));
    await user.type(within(command).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    state.tenants.workerDown = true;
    await user.click(within(command).getByRole('button', { name: 'Confirmar: gerar comando' }));
    expect(await within(command).findByRole('alert')).toHaveTextContent('O cp-worker não respondeu');
    expect(within(command).queryByLabelText('Comando de instalação gerado')).not.toBeInTheDocument();
    expect(state.tenants.tenants.get(CUSTOMER_ID)?.state).toBe('waiting_customer_install');
    // A confirmação continua aberta para tentar de novo.
    state.tenants.workerDown = false;
    await user.click(within(command).getByRole('button', { name: 'Confirmar: gerar comando' }));
    expect(await within(command).findByLabelText('Comando de instalação gerado')).toBeInTheDocument();
    expect(within(command).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a lista diz onde cada ambiente roda', async () => {
    renderConsole('/clientes');
    const table = await screen.findByRole('table', { name: /Clientes/ });
    expect(within(table).getByRole('row', { name: /Cliente Demo E Ltda/ })).toHaveTextContent(
      'Infraestrutura do cliente',
    );
    expect(within(table).getByRole('row', { name: /Cliente Demo E Ltda/ })).toHaveTextContent(
      'Aguardando instalação pelo cliente',
    );
    expect(within(table).getByRole('row', { name: /Cliente Demo B/ })).toHaveTextContent(
      'Infraestrutura da Verax',
    );
  });

  it('cliente inexistente: o erro da API, com a opção de tentar de novo', async () => {
    renderConsole('/clientes/01JC0000000000000000000Z99');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cliente não encontrado.');
  });
});
