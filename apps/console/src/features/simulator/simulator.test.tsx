import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderConsole } from '@/test/render';

/**
 * O simulador sobre a API simulada, com a tabela e o modelo FICTÍCIOS (as mesmas contas do `dre.test.ts` do plano de
 * controle): na configuração mínima gerenciada, receita de R$ 1.000,00 e margem de contribuição de R$ 455,20.
 */
describe('simulador de DRE', () => {
  it('preenche a configuração mínima da tabela vigente e monta a DRE do mês, dentro da meta', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    expect(screen.getByLabelText('Volume de logs (GiB/mês)')).toHaveAccessibleDescription(
      'Opções: 10, 50, 100, 200.',
    );
    await user.click(screen.getByRole('button', { name: 'Simular' }));

    const dre = await screen.findByRole('region', { name: 'DRE por cliente e por mês' });
    const month = within(dre).getByRole('table', { name: 'Demonstrativo do mês' });
    expect(within(month).getByRole('row', { name: /Receita bruta/ })).toHaveTextContent('R$ 1.000,00');
    expect(
      within(month).getByRole('row', { name: /Imposto \(Alíquota de teste A, 10,0%\)/ }),
    ).toHaveTextContent('R$ 100,00');
    expect(within(month).getByRole('row', { name: /Infraestrutura/ })).toHaveTextContent('R$ 234,30');
    expect(within(month).getByRole('row', { name: /Suporte \(1,5 h\)/ })).toHaveTextContent('R$ 120,00');
    expect(within(month).getByRole('row', { name: /^igual a Margem de contribuição/ })).toHaveTextContent(
      /R\$ 455,20\s*45,5%/,
    );
    expect(within(month).getByRole('row', { name: /Resultado do cliente/ })).toHaveTextContent('R$ 255,20');
    expect(within(dre).getByText('Dentro da meta')).toBeInTheDocument();
    expect(within(dre).getByRole('table', { name: /doze meses/i })).toHaveTextContent('R$ 12.000,00');
  });

  it('um pacote de partida com desconto fica abaixo da margem de alerta', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    await user.selectOptions(screen.getByLabelText('Pacote de partida'), 'Com agentes (teste)');
    expect(screen.getByLabelText('Agentes nas instâncias')).toHaveValue('10');
    await user.type(screen.getByLabelText('Desconto nos itens mensais (%)'), '20');
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    const dre = await screen.findByRole('region', { name: 'DRE por cliente e por mês' });
    expect(within(dre).getByText('Abaixo do alerta (35,0%)')).toBeInTheDocument();
    expect(within(dre).getByText('Margem de contribuição: 33,9%')).toBeInTheDocument();
  });

  it('na nuvem do cliente: a implantação à parte e a estimativa da nuvem dele, fora da DRE', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    await user.selectOptions(screen.getByLabelText('Pacote de partida'), 'Na nuvem do cliente (teste)');
    await user.selectOptions(screen.getByLabelText('Meio de pagamento'), 'Boleto');
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    const dre = await screen.findByRole('region', { name: 'DRE por cliente e por mês' });
    expect(within(dre).getByRole('table', { name: /^Implantação/ })).toHaveTextContent('R$ 1.000,00');
    expect(within(dre).getByText(/Custo estimado da nuvem do cliente/)).toBeInTheDocument();
    expect(within(dre).getByRole('row', { name: /Meio de pagamento \(boleto\)/ })).toBeInTheDocument();
  });

  it('acima do que a tabela vende: sob consulta, com o motivo', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    const agents = screen.getByLabelText('Agentes nas instâncias');
    await user.clear(agents);
    await user.type(agents, '999');
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    expect(await screen.findByRole('heading', { name: 'Sob consulta' })).toBeInTheDocument();
    expect(screen.getByText(/agentes acima do máximo de pacotes/)).toBeInTheDocument();
  });

  it('campo vazio: a API aponta o caminho, e ele aparece no campo', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Contas de nuvem')).toHaveValue('2'));
    await user.clear(screen.getByLabelText('Contas de nuvem'));
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('configuration.cloudAccounts');
    expect(screen.getByLabelText('Contas de nuvem')).toHaveAttribute('aria-invalid', 'true');
  });
});
