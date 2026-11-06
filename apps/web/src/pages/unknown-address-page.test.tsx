import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnknownAddressPage } from './unknown-address-page';

describe('endereço não reconhecido (build único fora do endereço de um cliente)', () => {
  it('explica onde o painel abre, sem detalhe técnico e sem precisar de sessão nem de rotas', () => {
    render(<UnknownAddressPage />);
    expect(screen.getByRole('heading', { name: 'Endereço não reconhecido' })).toBeInTheDocument();
    // Textos exatos: nada de expressão regular sobre o endereço.
    expect(
      screen.getByText(
        'Este painel só abre no endereço do seu ambiente, no formato sua-empresa.control.veraxsistemas.com.br.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Confira o link que você recebeu ou fale com o suporte da Verax.'),
    ).toBeInTheDocument();
  });
});
