import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FormErrorBoundary } from './form-error-boundary';

describe('defesa do formulário', () => {
  it('um erro no desenho vira o aviso com o botão de voltar, não a página de erro', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let broken = true;
    function Fragile() {
      if (broken) throw new TypeError('forma inesperada');
      return <p>formulário</p>;
    }
    const onReset = vi.fn(() => {
      broken = false;
    });
    render(
      <FormErrorBoundary onReset={onReset}>
        <Fragile />
      </FormErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('não pôde ser mostrado');
    await userEvent.click(screen.getByRole('button', { name: 'Voltar ao conteúdo anterior' }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.getByText('formulário')).toBeInTheDocument();
    quiet.mockRestore();
  });
});
