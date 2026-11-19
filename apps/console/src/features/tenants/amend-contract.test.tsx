import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeState } from '@/mocks/fake-admin-api';
import { renderConsole } from '@/test/render';

const FAILED_ID = '01JC0000000000000000000A01';
const PAID_ID = '01JC0000000000000000000B01';
const ACTIVE_ID = '01JC0000000000000000000D01';
const CUSTOMER_ID = '01JC0000000000000000000E01';

/**
 * O aditivo do contrato direto no detalhe do cliente ("Alterar contrato…"), sobre a API simulada
 * (`mocks/fake-tenants.ts`) com a tabela e os clientes FICTÍCIOS: onde o ambiente roda muda só antes de qualquer
 * instalação; o plano, o volume e os valores vêm da cotação de referência e podem ser negociados; o que muda aparece
 * antes da confirmação pelo subdomínio; o histórico fica no detalhe.
 */
describe('aditivo do contrato', () => {
  it('no cliente, antes da instalação: muda para a Verax e o vCISO, com a implantação negociada, e aponta o "Iniciar provisionamento"', async () => {
    const state = createFakeState();
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const contracted = await screen.findByRole('region', { name: 'Contratado' });
    expect(screen.getByRole('region', { name: 'Aditivos do contrato' })).toHaveTextContent('Nenhum aditivo');
    await user.click(within(contracted).getByRole('button', { name: 'Alterar contrato…' }));

    const form = screen.getByRole('region', { name: 'Alterar contrato (aditivo)' });
    // Começa com o contrato de hoje: no cliente, o SIEM Dedicado com 3 GB/dia.
    expect(within(form).getByRole('radio', { name: 'Infraestrutura do cliente' })).toBeChecked();
    expect(within(form).getByLabelText('Plano')).toHaveValue('dedicado');
    expect(within(form).getByLabelText('Volume de logs (GB/dia)')).toHaveValue('3');
    // O SIEM Cloud não entra num aditivo.
    expect(within(form).queryByRole('option', { name: 'SIEM Cloud' })).not.toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Revisar e confirmar…' })).toBeDisabled();

    await user.click(within(form).getByRole('radio', { name: 'Infraestrutura da Verax' }));
    await user.selectOptions(within(form).getByLabelText('Plano'), 'vciso');
    await user.clear(within(form).getByLabelText('Volume de logs (GB/dia)'));
    await user.type(within(form).getByLabelText('Volume de logs (GB/dia)'), '4');
    await user.click(within(form).getByRole('button', { name: 'Calcular a cotação' }));
    const quote = await within(form).findByRole('region', { name: 'Cotação de referência' });
    expect(quote).toHaveTextContent('SIEM + vCISO, 4 GB/dia');
    expect(quote).toHaveTextContent('R$ 4.000,00 por mês · implantação R$ 5.000,00 (uma vez)');
    // Os valores vêm da referência da tabela, como no cadastro; a implantação também.
    expect(within(form).getByLabelText('Valor mensal do contrato')).toHaveValue('4.000,00');
    expect(within(form).getByLabelText('Valor por GB/dia adicional')).toHaveValue('500,00');
    const setup = within(form).getByLabelText('Implantação do SIEM + vCISO (uma vez)');
    expect(setup).toHaveValue('5.000,00');
    await user.clear(setup);
    await user.type(setup, '0');
    await user.clear(within(form).getByLabelText('Valor mensal do contrato'));
    await user.type(within(form).getByLabelText('Valor mensal do contrato'), '3.800,00');
    await user.type(within(form).getByLabelText('Observação (opcional)'), 'Aditivo n.º 1 (fictício)');

    await user.click(within(form).getByRole('button', { name: 'Revisar e confirmar…' }));
    const confirm = within(form).getByRole('region', { name: 'Confirmar o aditivo' });
    const diff = within(confirm).getByRole('table', { name: 'O que muda no contrato' });
    expect(within(diff).getByRole('row', { name: /Onde o ambiente roda/ })).toHaveTextContent(
      'Infraestrutura do clienteInfraestrutura da Veraxmuda',
    );
    expect(within(diff).getByRole('row', { name: /Plano/ })).toHaveTextContent(
      'SIEM DedicadoSIEM + vCISOmuda',
    );
    expect(within(diff).getByRole('row', { name: /Valor mensal/ })).toHaveTextContent(
      'R$ 1.350,00R$ 3.800,00',
    );
    expect(within(diff).getByRole('row', { name: /Implantação/ })).toHaveTextContent('R$ 0,00R$ 0,00igual');
    expect(within(diff).getByRole('row', { name: /Vigência/ })).toHaveTextContent('Sem registro60 meses');
    expect(within(diff).getByRole('row', { name: /Estado/ })).toHaveTextContent(
      'Aguardando instalação pelo clienteAguardando início',
    );
    expect(confirm).toHaveTextContent('Iniciar provisionamento');
    const save = within(confirm).getByRole('button', { name: 'Gravar o aditivo' });
    expect(save).toBeDisabled();
    await user.type(within(confirm).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    await user.click(save);

    const done = await within(contracted).findByRole('status');
    expect(done).toHaveTextContent('Aditivo gravado. A vigência recomeça: 60 meses');
    expect(done).toHaveTextContent('use “Iniciar provisionamento”');
    expect(state.tenants.tenants.get(CUSTOMER_ID)).toMatchObject({
      hosting: 'verax',
      state: 'pending',
      configuration: { plan: 'vciso', mode: 'managed', gbDay: 4 },
      contractPricing: {
        contracted: { monthlyTotal: 380_000, additionalGbDayAmount: 50_000 },
        setup: { reference: 500_000, contracted: 0 },
      },
      contractTerm: { months: 60 },
    });
    // O detalhe recarregado: o "Iniciar provisionamento" de sempre, a vigência e o histórico com o antes e o depois.
    const provisioning = await screen.findByRole('region', { name: 'Provisionamento' });
    expect(
      within(provisioning).getByRole('button', { name: 'Iniciar provisionamento…' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(contracted).toHaveTextContent('Vigência: 60 meses'));
    expect(contracted).toHaveTextContent('Implantação contratada (uma vez)R$ 0,00 (tabela: R$ 5.000,00)');
    const history = screen.getByRole('list', { name: /Aditivos do contrato/ });
    expect(history).toHaveTextContent('responsavel@verax.example');
    expect(history).toHaveTextContent(
      'AntesSIEM Dedicado · 3 GB/dia · porte P · na infraestrutura do cliente · R$ 1.350,00 por mês',
    );
    expect(history).toHaveTextContent(
      'DepoisSIEM + vCISO · 4 GB/dia · porte P · na infraestrutura da Verax · R$ 3.800,00 por mês',
    );
    expect(history).toHaveTextContent('Aguardando instalação pelo cliente → Aguardando início');
    expect(history).toHaveTextContent('Aditivo n.º 1 (fictício)');
  });

  it('com o ambiente rodando: onde roda fica travado com o motivo, e os limites novos ficam pendentes no nó', async () => {
    const state = createFakeState();
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const contracted = await screen.findByRole('region', { name: 'Contratado' });
    await user.click(within(contracted).getByRole('button', { name: 'Alterar contrato…' }));
    const form = screen.getByRole('region', { name: 'Alterar contrato (aditivo)' });
    expect(within(form).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(form).getByRole('note')).toHaveTextContent(
      'Onde o ambiente roda: Infraestrutura da VeraxNão muda neste aditivo: o ambiente já começou a ser criado (o provisionamento já começou)',
    );
    // O SIEM Cloud de hoje vira o Dedicado (o plano mais comum no contrato direto).
    expect(within(form).getByLabelText('Plano')).toHaveValue('dedicado');
    await user.clear(within(form).getByLabelText('Volume de logs (GB/dia)'));
    await user.type(within(form).getByLabelText('Volume de logs (GB/dia)'), '5');
    await user.click(within(form).getByRole('button', { name: 'Calcular a cotação' }));
    await within(form).findByRole('region', { name: 'Cotação de referência' });
    // No Dedicado não há implantação.
    expect(within(form).queryByLabelText('Implantação do SIEM + vCISO (uma vez)')).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Revisar e confirmar…' }));
    const confirm = within(form).getByRole('region', { name: 'Confirmar o aditivo' });
    expect(confirm).toHaveTextContent('os limites do nó');
    expect(within(confirm).queryByRole('row', { name: /Estado/ })).not.toBeInTheDocument();
    await user.type(within(confirm).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(within(confirm).getByRole('button', { name: 'Gravar o aditivo' }));

    const done = await within(contracted).findByRole('status');
    expect(done).toHaveTextContent('A vigência recomeça: 12 meses');
    expect(done).toHaveTextContent('o nó em execução continua com os anteriores');
    expect(state.tenants.tenants.get(ACTIVE_ID)).toMatchObject({
      state: 'active',
      configuration: { plan: 'dedicado', gbDay: 5 },
    });
    expect(await screen.findByRole('list', { name: /Aditivos do contrato/ })).toHaveTextContent(
      'o nó em execução continua com os anteriores',
    );
  });

  it('o que o provisionamento não cria: o motivo na cotação, e a confirmação não abre', async () => {
    const { user } = renderConsole(`/clientes/${FAILED_ID}`);
    const contracted = await screen.findByRole('region', { name: 'Contratado' });
    await user.click(within(contracted).getByRole('button', { name: 'Alterar contrato…' }));
    const form = screen.getByRole('region', { name: 'Alterar contrato (aditivo)' });
    await user.clear(within(form).getByLabelText('Volume de logs (GB/dia)'));
    await user.type(within(form).getByLabelText('Volume de logs (GB/dia)'), '8');
    await user.click(within(form).getByRole('button', { name: 'Calcular a cotação' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'O provisionamento ainda não cria esta configuração',
    );
    expect(within(form).getByRole('button', { name: 'Revisar e confirmar…' })).toBeDisabled();
    await user.click(within(form).getByRole('button', { name: 'Desistir' }));
    expect(screen.queryByRole('region', { name: 'Alterar contrato (aditivo)' })).not.toBeInTheDocument();
  });

  it('a recusa da API aparece no formulário (o mesmo contrato de hoje: nada muda)', async () => {
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`);
    const contracted = await screen.findByRole('region', { name: 'Contratado' });
    await user.click(within(contracted).getByRole('button', { name: 'Alterar contrato…' }));
    const form = screen.getByRole('region', { name: 'Alterar contrato (aditivo)' });
    await user.click(within(form).getByRole('button', { name: 'Calcular a cotação' }));
    await within(form).findByRole('region', { name: 'Cotação de referência' });
    // Os valores negociados de hoje, de volta: o mesmo contrato.
    await user.clear(within(form).getByLabelText('Valor mensal do contrato'));
    await user.type(within(form).getByLabelText('Valor mensal do contrato'), '1.350,00');
    await user.clear(within(form).getByLabelText('Valor por GB/dia adicional'));
    await user.type(within(form).getByLabelText('Valor por GB/dia adicional'), '450,00');
    await user.click(within(form).getByRole('button', { name: 'Revisar e confirmar…' }));
    const confirm = within(form).getByRole('region', { name: 'Confirmar o aditivo' });
    await user.type(within(confirm).getByLabelText(/Digite o subdomínio/), 'cliente-demo-e');
    await user.click(within(confirm).getByRole('button', { name: 'Gravar o aditivo' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Nada muda neste aditivo');
  });

  it('cliente da Stripe: sem aditivo nem histórico de aditivos', async () => {
    renderConsole(`/clientes/${PAID_ID}`);
    const contracted = await screen.findByRole('region', { name: 'Contratado' });
    expect(within(contracted).queryByRole('button', { name: 'Alterar contrato…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Aditivos do contrato' })).not.toBeInTheDocument();
  });
});
