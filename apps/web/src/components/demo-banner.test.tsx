import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DemoBanner } from './demo-banner';

describe('faixa de demonstração', () => {
  it('aparece no build de demonstração (modo mock)', () => {
    render(<DemoBanner mode="mock" />);
    expect(screen.getByRole('note')).toHaveTextContent('todos os dados são fictícios');
  });

  it.each(['production', 'development', 'test'])('não aparece no modo %s', (mode) => {
    const { container } = render(<DemoBanner mode={mode} />);
    expect(container).toBeEmptyDOMElement();
  });
});
