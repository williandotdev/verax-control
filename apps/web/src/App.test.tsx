import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '@/lib/query-client';
import { routes } from '@/routes/router';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('rotas do painel', () => {
  it('rota inexistente mostra página não encontrada', () => {
    renderAt('/nao-existe');
    expect(screen.getByRole('heading', { name: 'Página não encontrada' })).toBeInTheDocument();
  });

  it('sem permissão mostra a página própria', () => {
    renderAt('/sem-permissao');
    expect(screen.getByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
  });

  it('login existe', () => {
    renderAt('/login');
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
  });
});
