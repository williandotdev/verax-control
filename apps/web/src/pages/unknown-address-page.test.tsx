import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnknownAddressPage } from './unknown-address-page';

describe('endereço não reconhecido (build único fora do endereço de um cliente)', () => {
  it('explica onde o painel abre, sem detalhe técnico e sem precisar de sessão nem de rotas', () => {
    render(<UnknownAddressPage />);
    expect(screen.getByRole('heading', { name: 'Endereço não reconhecido' })).toBeInTheDocument();
    expect(screen.getByText(/sua-empresa\.control\.veraxsistemas\.com\.br/)).toBeInTheDocument();
    expect(screen.getByText(/fale com o suporte/)).toBeInTheDocument();
  });
});
