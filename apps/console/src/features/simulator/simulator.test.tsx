import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderConsole } from '@/test/render';

/**
 * O simulador sobre a API simulada, com a tabela e o modelo FICTÍCIOS (`mocks/fixtures.ts`, imposto por cima): na
 * Plataforma com os 2 GB/dia incluídos, o valor da tabela de R$ 1.000,00 vira a receita bruta de R$ 1.111,11 (÷ 0,9), e
 * a célula entra rateada por GB/dia.
 */
describe('simulador de DRE', () => {
  it('preenche a Plataforma no incluído da tabela vigente e monta a DRE do mês, com o imposto por cima', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('2'));
    expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveAccessibleDescription(
      '2 GB/dia incluídos, até 5 no site.',
    );
    await user.click(screen.getByRole('button', { name: 'Simular' }));

    const dre = await screen.findByRole('region', { name: 'DRE por cliente e por mês' });
    expect(within(dre).getByText(/Plataforma, 2 GB\/dia/)).toBeInTheDocument();
    const month = within(dre).getByRole('table', { name: 'Demonstrativo do mês' });
    const gross = within(month).getByRole('row', { name: /Receita bruta/ });
    expect(gross).toHaveTextContent('R$ 1.111,11');
    expect(gross).toHaveTextContent(/Imposto por cima: o valor da tabela \(R\$\s1\.000,00\)/);
    expect(
      within(month).getByRole('row', { name: /Imposto \(Alíquota de teste A, 10,0%, por cima\)/ }),
    ).toHaveTextContent('R$ 111,11');
    // Célula: (105,5 US$ ÷ 10 × 2 + 1 + 2 × 2) × 2 × 1,1.
    const infrastructure = within(month).getByRole('row', { name: /Infraestrutura/ });
    expect(infrastructure).toHaveTextContent('R$ 57,42');
    expect(infrastructure).toHaveTextContent('O rateio da célula compartilhada');
    expect(within(month).getByRole('row', { name: /Suporte \(1 h\)/ })).toHaveTextContent('R$ 80,00');
    expect(within(month).getByRole('row', { name: /^igual a Margem de contribuição/ })).toHaveTextContent(
      /R\$\s762,08\s*68,6%/,
    );
    expect(within(month).getByRole('row', { name: /Resultado do cliente/ })).toHaveTextContent('R$ 562,08');
    expect(within(dre).getByText('Dentro da meta')).toBeInTheDocument();
    expect(within(dre).getByRole('table', { name: /doze meses/i })).toHaveTextContent('R$ 13.333,32');
  });

  it('o vCISO com desconto fica abaixo da margem de alerta (as horas do serviço pesam)', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('2'));
    await user.selectOptions(screen.getByLabelText('Plano'), 'vCISO');
    expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveAccessibleDescription(
      'De 3 a 15 GB/dia (abaixo do mínimo, sobe até ele).',
    );
    await user.type(screen.getByLabelText('Desconto nos itens mensais (%)'), '35');
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    const dre = await screen.findByRole('region', { name: 'DRE por cliente e por mês' });
    expect(within(dre).getByText(/vCISO, 3 GB\/dia/)).toBeInTheDocument();
    expect(within(dre).getByText('Abaixo do alerta (35,0%)')).toBeInTheDocument();
    expect(within(dre).getByText('Margem de contribuição: 33,3%')).toBeInTheDocument();
  });

  it('na infraestrutura do cliente: a implantação à parte e a estimativa da nuvem dele, fora da DRE', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('2'));
    await user.selectOptions(screen.getByLabelText('Plano'), 'vCISO');
    await user.selectOptions(
      screen.getByLabelText('Onde roda'),
      'Na infraestrutura do cliente (contrato direto)',
    );
    await user.selectOptions(screen.getByLabelText('Meio de pagamento'), 'Boleto');
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    const dre = await screen.findByRole('region', { name: 'DRE por cliente e por mês' });
    // A implantação fictícia de R$ 5.000,00, com o imposto por cima.
    expect(within(dre).getByRole('table', { name: /^Implantação/ })).toHaveTextContent('R$ 5.555,56');
    expect(within(dre).getByText(/Custo estimado da infraestrutura do cliente/)).toBeInTheDocument();
    expect(within(dre).getByRole('row', { name: /Meio de pagamento \(boleto\)/ })).toBeInTheDocument();
    expect(within(dre).getByRole('row', { name: /^menos Infraestrutura/ })).toHaveTextContent('R$ 0,00');
  });

  it('acima do que a tabela vende, ou a Plataforma no cliente: sob consulta, com o motivo', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('2'));
    const gbDay = screen.getByLabelText('Volume de logs (GB/dia)');
    await user.clear(gbDay);
    await user.type(gbDay, '9');
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    expect(await screen.findByRole('heading', { name: 'Sob consulta' })).toBeInTheDocument();
    expect(screen.getByText(/volume acima do máximo da Plataforma no site/)).toBeInTheDocument();

    await user.clear(gbDay);
    await user.type(gbDay, '2');
    await user.selectOptions(
      screen.getByLabelText('Onde roda'),
      'Na infraestrutura do cliente (contrato direto)',
    );
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    expect(await screen.findByText(/a Plataforma só roda na infraestrutura da Verax/)).toBeInTheDocument();
  });

  it('campo vazio: a API aponta o caminho, e ele aparece no campo', async () => {
    const { user } = renderConsole('/simulador');
    await waitFor(() => expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveValue('2'));
    await user.clear(screen.getByLabelText('Volume de logs (GB/dia)'));
    await user.click(screen.getByRole('button', { name: 'Simular' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('configuration.gbDay');
    expect(screen.getByLabelText('Volume de logs (GB/dia)')).toHaveAttribute('aria-invalid', 'true');
  });
});
