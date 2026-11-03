import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK_AUTH } from '@/mocks/auth-handlers';
import { DemoBanner, DemoLoginHint } from './demo-banner';

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

describe('acesso de demonstração no login', () => {
  it('mostra as credenciais do mock, as mesmas que o mock aceita', () => {
    render(<DemoLoginHint mode="mock" />);
    const hint = screen.getByRole('note');
    expect(hint).toHaveTextContent(MOCK_AUTH.email);
    expect(hint).toHaveTextContent(MOCK_AUTH.password);
    expect(hint).toHaveTextContent(MOCK_AUTH.totp);
  });

  it.each(['production', 'development'])('não aparece no modo %s', (mode) => {
    const { container } = render(<DemoLoginHint mode={mode} />);
    expect(container).toBeEmptyDOMElement();
  });
});
