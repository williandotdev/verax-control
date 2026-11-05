import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeState } from '@/mocks/fake-admin-api';
import { renderConsole } from '@/test/render';

/**
 * Tabelas de preço sobre a API simulada, com a tabela e o modelo FICTÍCIOS: o rascunho `teste-v3` (cópia da vigente
 * `teste-v2`) passa na checagem; com o suporte prioritário quase de graça, as configurações com ele ficam abaixo da
 * margem mínima (o mesmo caso da suíte do plano de controle).
 */
describe('tabelas de preço', () => {
  it('lista vigente, aposentada e rascunho', async () => {
    renderConsole('/tabelas-de-preco');
    const table = await screen.findByRole('table', { name: /versões/i });
    expect(
      within(within(table).getByRole('row', { name: /^teste-v2/ })).getByText('Vigente'),
    ).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /^teste-v1/ })).toHaveTextContent(
      /Aposentada.*substituída por teste-v2/,
    );
    expect(within(table).getByRole('row', { name: /^teste-v3/ })).toHaveTextContent('Rascunho');
  });

  it('conferir: a checagem aprovada com o relatório (a partir de, piores, por modo e porte)', async () => {
    const { user } = renderConsole('/tabelas-de-preco/teste-v3');
    await user.click(await screen.findByRole('button', { name: 'Conferir' }));
    const report = await screen.findByRole('region', { name: 'Checagem de teste-v3' });
    expect(within(report).getByText(/Aprovada/)).toBeInTheDocument();
    expect(within(report).getByText('Configurações conferidas').nextElementSibling).toHaveTextContent(/\d/);
    expect(within(report).getByRole('table', { name: /a partir de/i })).toHaveTextContent('R$ 1.000,00');
    expect(within(report).getByRole('table', { name: 'As piores configurações' })).toBeInTheDocument();
    expect(within(report).getByRole('table', { name: 'A pior de cada porte' })).toHaveTextContent('Porte G');
    expect(within(report).getByRole('table', { name: /outros cenários/i })).toHaveTextContent('Boleto');
  });

  it('com alteração não salva, conferir e publicar ficam bloqueados; salvo, a checagem reprova e a publicação é recusada com o relatório', async () => {
    const { user, state } = renderConsole('/tabelas-de-preco/teste-v3');
    const amount = await screen.findByLabelText('Suporte prioritário (R$)');
    await user.clear(amount);
    await user.type(amount, '1,00');
    expect(screen.getByRole('button', { name: 'Conferir' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publicar…' })).toBeDisabled();
    expect(screen.getAllByText('Salve as alterações antes de conferir ou publicar.').length).toBeGreaterThan(
      0,
    );

    await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    expect(await screen.findByText('Rascunho salvo.')).toBeInTheDocument();
    expect(state['pricing-tables'].get('teste-v3')?.content.prioritySupport.amount).toBe(100);

    await user.click(screen.getByRole('button', { name: 'Conferir' }));
    const check = await screen.findByRole('region', { name: 'Checagem de teste-v3' });
    expect(within(check).getByText(/Reprovada/)).toBeInTheDocument();
    expect(within(check).getByRole('table', { name: /abaixo da margem mínima/i })).toHaveTextContent(
      /Abaixo da mínima \(25,0%\)/,
    );

    await user.click(screen.getByRole('button', { name: 'Publicar…' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar a publicação' }));
    const refusal = await screen.findByRole('region', { name: 'Publicação recusada pela checagem' });
    expect(refusal).toHaveTextContent('modelo de custos custos-teste-v1');
    expect(state['pricing-tables'].get('teste-v3')?.status).toBe('draft');
  });

  it('publica com a data de vigência; a anterior é aposentada e a versão vira só leitura', async () => {
    const { user, state } = renderConsole('/tabelas-de-preco/teste-v3');
    await user.click(await screen.findByRole('button', { name: 'Publicar…' }));
    const when = new Date(Date.now() + 2 * 86_400_000);
    const local = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}T09:00`;
    await user.type(screen.getByLabelText('Vigente a partir de'), local);
    await user.click(screen.getByRole('button', { name: 'Confirmar a publicação' }));
    expect(await screen.findByText(/Publicada: teste-v3, vigente a partir de/)).toBeInTheDocument();
    expect(state['pricing-tables'].get('teste-v3')?.effectiveFrom).toBe(new Date(local).toISOString());
    expect(state['pricing-tables'].get('teste-v2')?.status).toBe('retired');
    await waitFor(() => expect(screen.getByLabelText('Suporte prioritário (R$)')).toBeDisabled());
    expect(screen.getByRole('link', { name: 'Novo rascunho a partir desta versão' })).toHaveAttribute(
      'href',
      '/tabelas-de-preco/novo?de=teste-v3',
    );
  });

  it('sem modelo de custos publicado, a publicação para com a mensagem da API', async () => {
    const state = createFakeState();
    state['cost-models'].clear();
    const { user } = renderConsole('/tabelas-de-preco/teste-v3', state);
    await user.click(await screen.findByRole('button', { name: 'Publicar…' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar a publicação' }));
    expect(await screen.findByText(/Nenhum modelo de custos publicado/)).toBeInTheDocument();
  });

  it('a versão publicada não edita, e o rascunho novo parte dela', async () => {
    const { user, router } = renderConsole('/tabelas-de-preco/teste-v2');
    expect(await screen.findByLabelText('Contas incluídas')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Salvar rascunho' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publicar…' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Novo rascunho a partir desta versão' }));
    await waitFor(() => expect(router.state.location.search).toBe('?de=teste-v2'));
    await waitFor(() => expect(screen.getByLabelText('Contas incluídas')).toHaveValue('2'));
    expect(screen.getByLabelText('Versão')).toHaveValue(
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-v1`,
    );
  });

  it('com a confirmação aberta, uma alteração feita depois bloqueia a publicação (ela levaria o salvo)', async () => {
    const { user, state } = renderConsole('/tabelas-de-preco/teste-v3');
    await user.click(await screen.findByRole('button', { name: 'Publicar…' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar a publicação' });
    expect(confirm).toBeEnabled();
    const amount = screen.getByLabelText('Suporte prioritário (R$)');
    await user.clear(amount);
    await user.type(amount, '1,00');
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(state['pricing-tables'].get('teste-v3')?.status).toBe('draft');
    expect(amount).toHaveValue('1,00');
    // Salvo, a confirmação volta a valer (e publicaria o que foi salvo).
    await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar a publicação' })).toBeEnabled());
  });

  it('importar na versão um arquivo com a forma errada aponta os caminhos e mantém a tela', async () => {
    const { user } = renderConsole('/tabelas-de-preco/teste-v3');
    await screen.findByLabelText('Contas incluídas');
    const file = new File(
      [
        JSON.stringify({
          content: { sizing: { sizes: [null] }, modes: 'x', presets: [{ configuration: null }] },
        }),
      ],
      'tabela.json',
      { type: 'application/json' },
    );
    await user.upload(screen.getByLabelText('Importar JSON'), file);
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('modes: esperado um objeto, recebido string');
    expect(summary).toHaveTextContent('sizing.sizes.0: esperado um objeto, recebido null');
    expect(summary).toHaveTextContent('presets.0.configuration: esperado um objeto, recebido null');
    expect(screen.getByLabelText('Ambiente porte P (R$)')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Publicar…' })).toBeDisabled();
  });
});
