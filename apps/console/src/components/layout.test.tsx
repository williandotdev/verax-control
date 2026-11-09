import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderConsole } from '@/test/render';

describe('moldura do console', () => {
  it('menu das telas, link de pular para o conteúdo e o tema escolhido guardado', async () => {
    const { user } = renderConsole('/simulador');
    const menu = await screen.findByRole('navigation', { name: 'Menu do console' });
    expect(menu).toHaveTextContent('Modelos de custo');
    expect(screen.getByRole('link', { name: 'Clientes' })).toHaveAttribute('href', '/clientes');
    expect(screen.getByRole('link', { name: 'Simulador de DRE' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' })).toHaveAttribute('href', '#conteudo');
    await user.click(screen.getByRole('radio', { name: 'Escuro' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(window.localStorage.getItem('verax.console.theme')).toBe('dark');
    expect(await screen.findByTestId('usuario')).toBeInTheDocument();
  });

  it('caminho desconhecido: página não encontrada; a raiz leva aos modelos de custo', async () => {
    const { router } = renderConsole('/nao-existe');
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeInTheDocument();
    await act(() => router.navigate('/'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/modelos-de-custo'));
  });
});
