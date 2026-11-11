import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { legalApi } from '@/lib/api';
import { FICTITIOUS_TERMS } from '@/mocks/fake-legal';
import { renderConsole } from '@/test/render';

/**
 * Textos legais sobre a API simulada, com textos FICTÍCIOS: os Termos publicados (`2026-11-01`) com um rascunho
 * (`2026-11-10`), a Privacidade publicada e o DPA sem nada.
 */
describe('textos legais', () => {
  it('lista os três textos com as versões, a vigente e o aviso do que falta publicar', async () => {
    renderConsole('/textos-legais');
    const terms = await screen.findByRole('region', { name: 'Termos de uso' });
    const table = within(terms).getByRole('table', { name: 'Versões: Termos de uso' });
    expect(within(table).getByRole('row', { name: /^2026-11-01/ })).toHaveTextContent('Vigente');
    expect(within(table).getByRole('row', { name: /^2026-11-10/ })).toHaveTextContent('Rascunho');
    const dpa = screen.getByRole('region', { name: 'Acordo de tratamento de dados (DPA)' });
    expect(dpa).toHaveTextContent('Nenhuma versão publicada');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Falta publicar: Acordo de tratamento de dados (DPA)',
    );
    expect(screen.getByRole('link', { name: 'Textos legais' })).toHaveAttribute('aria-current', 'page');
  });

  it('edita o rascunho com a prévia; com alteração não salva, publicar fica bloqueado; salvo, publica com a versão digitada', async () => {
    const { user, state } = renderConsole('/textos-legais/termos/2026-11-10');
    const text = await screen.findByLabelText('Texto (Markdown)');
    const preview = screen.getByRole('region', { name: 'Prévia' });
    expect(
      within(preview).getByRole('heading', { level: 2, name: 'Termos de uso (teste)' }),
    ).toBeInTheDocument();

    await user.clear(text);
    await user.type(text, '# Termos novos{enter}{enter}Texto **revisado**.');
    expect(within(preview).getByRole('heading', { name: 'Termos novos' })).toBeInTheDocument();
    expect(within(preview).getByText('revisado').tagName).toBe('STRONG');
    expect(screen.getByRole('button', { name: 'Publicar…' })).toBeDisabled();
    expect(screen.getByText('Salve as alterações antes de publicar.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    expect(await screen.findByText('Rascunho salvo.')).toBeInTheDocument();
    expect(state.legal.texts.terms.get('2026-11-10')?.content).toBe('# Termos novos\n\nTexto **revisado**.');

    await user.click(screen.getByRole('button', { name: 'Publicar…' }));
    const confirm = screen.getByRole('button', { name: 'Confirmar a publicação' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Digite a versão/), '2026-11-10');
    await user.click(confirm);
    expect(await screen.findByText(/Publicada: 2026-11-10, em/)).toBeInTheDocument();
    expect(state.legal.texts.terms.get('2026-11-10')?.status).toBe('published');
    await waitFor(() => expect(screen.getByLabelText('Texto (Markdown)')).toHaveAttribute('readonly'));
    expect(screen.getByText(/Versão publicada: não muda mais/)).toBeInTheDocument();
  });

  it('o que é digitado enquanto o rascunho é gravado continua no editor, sem salvar', async () => {
    const { user, state } = renderConsole('/textos-legais/termos/2026-11-10');
    const text = await screen.findByLabelText('Texto (Markdown)');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = legalApi.update.bind(legalApi);
    const spy = vi.spyOn(legalApi, 'update').mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    try {
      await user.clear(text);
      await user.type(text, 'primeira parte');
      await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
      await user.type(text, ' e mais');
      release();
      expect(await screen.findByText('Rascunho salvo.')).toBeInTheDocument();
      expect(state.legal.texts.terms.get('2026-11-10')?.content).toBe('primeira parte');
      expect(screen.getByLabelText('Texto (Markdown)')).toHaveValue('primeira parte e mais');
      expect(screen.getByText('Salve as alterações antes de publicar.')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('o rascunho mudou em outra aba: a gravação é recusada e a página oferece recarregar', async () => {
    const { user, state } = renderConsole('/textos-legais/termos/2026-11-10');
    const text = await screen.findByLabelText('Texto (Markdown)');
    const stored = state.legal.texts.terms.get('2026-11-10');
    if (stored === undefined) throw new Error('rascunho do teste ausente');
    state.legal.texts.terms.set('2026-11-10', {
      ...stored,
      content: 'da outra aba',
      updatedAt: new Date().toISOString(),
    });

    await user.type(text, ' mais');
    await user.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
    expect(await screen.findByText(/O rascunho mudou depois que você o abriu/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Recarregar o rascunho salvo/ }));
    await waitFor(() => expect(screen.getByLabelText('Texto (Markdown)')).toHaveValue('da outra aba'));
  });

  it('importa um arquivo .md no editor (sem gravar até salvar)', async () => {
    const { user, state } = renderConsole('/textos-legais/termos/2026-11-10');
    await screen.findByLabelText('Texto (Markdown)');
    const file = new File([String.fromCharCode(0xfeff) + '# Do advogado\r\n\r\nRevisado.\r\n'], 'termos.md', {
      type: 'text/markdown',
    });
    await user.upload(screen.getByLabelText('Importar .md'), file);
    await waitFor(() =>
      expect(screen.getByLabelText('Texto (Markdown)')).toHaveValue('# Do advogado\n\nRevisado.\n'),
    );
    expect(screen.getByText('Arquivo importado no editor: confira a prévia e salve.')).toBeInTheDocument();
    expect(state.legal.texts.terms.get('2026-11-10')?.content).toBe(FICTITIOUS_TERMS);
  });

  it('rascunho novo: copia a vigente por padrão e abre a página dele', async () => {
    const { user, state, router } = renderConsole('/textos-legais/privacidade/novo');
    const version = await screen.findByLabelText('Versão');
    expect(screen.getByLabelText('Começar de')).toHaveValue('2026-11-01');
    await user.clear(version);
    await user.type(version, '2026-12-01');
    await user.click(screen.getByRole('button', { name: 'Criar rascunho' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/textos-legais/privacidade/2026-12-01'));
    expect(await screen.findByText('Rascunho criado.')).toBeInTheDocument();
    expect(state.legal.texts.privacy.get('2026-12-01')).toMatchObject({
      status: 'draft',
      basedOn: '2026-11-01',
    });
  });

  it('versão inválida volta da API ao lado do campo', async () => {
    const { user } = renderConsole('/textos-legais/dpa/novo');
    const version = await screen.findByLabelText('Versão');
    expect(screen.getByLabelText('Começar de')).toHaveValue('__em-branco__');
    await user.clear(version);
    await user.type(version, 'Versão 1');
    await user.click(screen.getByRole('button', { name: 'Criar rascunho' }));
    await waitFor(() => expect(screen.getByLabelText('Versão')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByRole('alert')).toHaveTextContent('versão inválida');
  });

  it('em branco: criado, a publicação fica bloqueada até escrever e salvar', async () => {
    const { user } = renderConsole('/textos-legais/dpa/novo');
    await screen.findByLabelText('Versão');
    await user.click(screen.getByRole('button', { name: 'Criar rascunho' }));
    expect(await screen.findByText(/O texto está em branco: escreva ou importe/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publicar…' })).toBeDisabled();
  });

  it('histórico: quem, quando, a versão e o hash da publicação', async () => {
    renderConsole('/textos-legais/termos/historico');
    const table = await screen.findByRole('table', { name: 'Histórico: Termos de uso' });
    const row = within(table).getByRole('row', { name: /Publicada/ });
    expect(row).toHaveTextContent('2026-11-01');
    expect(row).toHaveTextContent('responsavel@verax.example');
    expect(row).toHaveTextContent(/SHA-256 [0-9a-f]{64}/);
  });
});
