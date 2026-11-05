import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeState } from '@/mocks/fake-admin-api';
import { FICTITIOUS_OWNER } from '@/mocks/fixtures';
import { renderConsole } from '@/test/render';

/** Modelos de custo sobre a API simulada, com o modelo FICTÍCIO (câmbio 2, margens de 25% e 35%). */
describe('modelos de custo', () => {
  it('lista as versões com a situação, a vigente, a vigência e quem publicou', async () => {
    renderConsole('/modelos-de-custo');
    const table = await screen.findByRole('table', { name: /versões/i });
    const row = within(table).getByRole('row', { name: /custos-teste-v1/ });
    expect(within(row).getByText('Publicada')).toBeInTheDocument();
    expect(within(row).getByText('Vigente')).toBeInTheDocument();
    expect(within(row).getAllByText(FICTITIOUS_OWNER).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /novo rascunho/i })).toHaveAttribute(
      'href',
      '/modelos-de-custo/novo',
    );
  });

  it('o cabeçalho mostra o e-mail que o IAP confirmou', async () => {
    renderConsole('/modelos-de-custo');
    expect(await screen.findByTestId('usuario')).toHaveTextContent(FICTITIOUS_OWNER);
    expect(screen.getByRole('navigation', { name: 'Menu do console' })).toBeInTheDocument();
  });

  it('o rascunho novo copia a vigente; o problema que a API aponta aparece no campo e no resumo', async () => {
    const { user, router, state } = renderConsole('/modelos-de-custo/novo');
    const version = await screen.findByLabelText('Versão');
    await waitFor(() => expect(screen.getByLabelText('Câmbio (R$ por US$)')).toHaveValue('2'));
    expect(screen.getByLabelText('Começar de')).toHaveDisplayValue('Cópia de custos-teste-v1 (vigente)');
    await user.clear(version);
    await user.type(version, 'custos-teste-v2');

    // Alerta abaixo da mínima: a API recusa e diz onde.
    const alert = screen.getByLabelText('Margem de alerta (%)');
    await user.clear(alert);
    await user.type(alert, '10');
    await user.click(screen.getByRole('button', { name: 'Criar rascunho' }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('margins.alert');
    expect(alert).toHaveAttribute('aria-invalid', 'true');
    expect(alert).toHaveAccessibleDescription(/menor que a mínima/);
    expect(state['cost-models'].has('custos-teste-v2')).toBe(false);

    await user.clear(alert);
    await user.type(alert, '40');
    await user.click(screen.getByRole('button', { name: 'Criar rascunho' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/modelos-de-custo/custos-teste-v2'));
    expect(await screen.findByText('Rascunho criado.')).toBeInTheDocument();
    expect(state['cost-models'].get('custos-teste-v2')?.content.margins.alert).toBe(0.4);
  });

  it('em branco: a API diz cada campo que falta', async () => {
    const { user } = renderConsole('/modelos-de-custo/novo', createFakeState({ empty: true }));
    await waitFor(() =>
      expect(screen.getByLabelText('Começar de')).toHaveDisplayValue('Em branco (só a forma)'),
    );
    await user.click(screen.getByRole('button', { name: 'Criar rascunho' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Câmbio (R$ por US$)')).toHaveAccessibleDescription(/esperado number/);
    expect(screen.getByLabelText('Custo da hora (R$)')).toHaveAttribute('aria-invalid', 'true');
  });

  it('o custo de cada porte é recalculado na hora, e dinheiro mostra o valor lido', async () => {
    const { user } = renderConsole('/modelos-de-custo/novo');
    await waitFor(() => expect(screen.getByLabelText('Câmbio (R$ por US$)')).toHaveValue('2'));
    const preview = screen.getByRole('table', { name: /custo do nó por porte/i });
    // Porte P fictício: (100 + 1 + 0,5 + 1 + 2 + 1) US$ × 2 × 1,1 (o texto do Intl tem espaço não separável).
    expect(within(preview).getByRole('row', { name: /^P\s/ })).toHaveTextContent('R$ 232,10');
    await user.clear(screen.getByLabelText('Câmbio (R$ por US$)'));
    await user.type(screen.getByLabelText('Câmbio (R$ por US$)'), '4');
    expect(within(preview).getByRole('row', { name: /^P\s/ })).toHaveTextContent('R$ 464,20');
    const hourly = screen.getByLabelText('Custo da hora (R$)');
    await user.clear(hourly);
    await user.type(hourly, '1.234,5');
    expect(screen.getByText('= R$ 1.234,50')).toBeInTheDocument();
    await user.clear(hourly);
    await user.type(hourly, '12,345');
    expect(hourly).toHaveAccessibleDescription(/valor em reais/);
  });

  it('publica o rascunho e mostra a tabela vigente conferida com o modelo novo', async () => {
    const state = createFakeState();
    state['cost-models'].set('custos-teste-v2', {
      ...structuredClone(state['cost-models'].get('custos-teste-v1')!),
      version: 'custos-teste-v2',
      status: 'draft',
      effectiveFrom: undefined,
      publishedAt: undefined,
      publishedBy: undefined,
      createdAt: new Date().toISOString(),
    });
    const { user } = renderConsole('/modelos-de-custo/custos-teste-v2', state);
    await user.click(await screen.findByRole('button', { name: 'Publicar…' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar a publicação' }));
    expect(await screen.findByText(/Publicada: custos-teste-v2/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /tabela de preços vigente conferida/i })).toBeInTheDocument();
    expect(state['cost-models'].get('custos-teste-v1')?.status).toBe('retired');
    // Publicada, a versão vira só leitura.
    await waitFor(() => expect(screen.getByLabelText('Câmbio (R$ por US$)')).toBeDisabled());
  });

  it('importar um arquivo com a forma errada mostra os problemas nos caminhos, sem derrubar a tela', async () => {
    const { user } = renderConsole('/modelos-de-custo/novo');
    await waitFor(() => expect(screen.getByLabelText('Câmbio (R$ por US$)')).toHaveValue('2'));
    const file = new File(
      [
        JSON.stringify({
          taxes: { rates: [null, { id: 'teste_a', label: 'A', rate: 0.1 }] },
          fixedCosts: { items: [null, { name: 'Fixo de teste', monthly: 1_000 }], allocationCustomers: 2 },
          sources: { item: 'x' },
        }),
      ],
      'modelo.json',
      { type: 'application/json' },
    );
    await user.upload(screen.getByLabelText('Ou importar um arquivo JSON'), file);

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('O arquivo importado não tem a forma esperada');
    expect(summary).toHaveTextContent('taxes.rates.0: esperado um objeto, recebido null');
    expect(summary).toHaveTextContent('fixedCosts.items.0: esperado um objeto, recebido null');
    expect(summary).toHaveTextContent('sources: esperada uma lista, recebido object');
    // O formulário continua de pé: a prévia soma só o item válido, e a alíquota válida vira opção.
    expect(screen.getByText(/^Total: R\$\s10,00 por mês · R\$\s5,00 por cliente$/)).toBeInTheDocument();
    expect(screen.getByLabelText('Alíquota padrão')).toHaveTextContent('A (teste_a)');
    expect(screen.getByLabelText('Começar de')).toHaveDisplayValue('Arquivo importado');
    // O item nulo sai pelo botão da lista.
    await user.click(screen.getByRole('button', { name: 'Tirar alíquota 1' }));
    expect(screen.getAllByLabelText('Identificador')[0]).toHaveValue('teste_a');
  });
});
