import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_AUTH } from '@/mocks/auth-handlers';
import { CodeHint, SignInHint } from './demo-login-hint';
import { DemoCodeHint, DemoLoginHint } from './entry';

describe('acesso de demonstração no login', () => {
  it('mostra as credenciais do mock, as mesmas que o mock aceita', () => {
    render(<SignInHint onFill={() => {}} />);
    const hint = screen.getByRole('note');
    expect(hint).toHaveTextContent(MOCK_AUTH.email);
    expect(hint).toHaveTextContent(MOCK_AUTH.password);
    expect(hint).toHaveTextContent(MOCK_AUTH.totp);
    expect(hint).toHaveTextContent(MOCK_AUTH.temporaryPassword);
  });

  it('"Preencher acesso de demonstração" entrega o e-mail e a senha que o mock aceita e avisa o leitor de tela', async () => {
    const onFill = vi.fn();
    render(<SignInHint onFill={onFill} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    await userEvent.click(screen.getByRole('button', { name: 'Preencher acesso de demonstração' }));
    expect(onFill).toHaveBeenCalledExactlyOnceWith({ email: MOCK_AUTH.email, password: MOCK_AUTH.password });
    expect(screen.getByRole('status')).toHaveTextContent('E-mail e senha de demonstração preenchidos.');
  });

  it('"Preencher código de demonstração" entrega o código que o mock aceita', async () => {
    const onFill = vi.fn();
    render(<CodeHint onFill={onFill} />);
    expect(screen.getByRole('note')).toHaveTextContent(MOCK_AUTH.totp);
    await userEvent.click(screen.getByRole('button', { name: 'Preencher código de demonstração' }));
    expect(onFill).toHaveBeenCalledExactlyOnceWith(MOCK_AUTH.totp);
    expect(screen.getByRole('status')).toHaveTextContent('Código de demonstração preenchido.');
  });
});

describe('o acesso de demonstração só existe no modo mock', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('fora do modo mock, nem o acesso de exemplo nem os botões de preencher existem', () => {
    expect(import.meta.env.MODE).not.toBe('mock');
    const { container } = render(
      <>
        <DemoLoginHint onFill={() => {}} />
        <DemoCodeHint onFill={() => {}} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('no modo mock, os dois botões aparecem', async () => {
    vi.stubEnv('MODE', 'mock');
    vi.resetModules();
    const entry = await import('./entry');
    render(
      <>
        <entry.DemoLoginHint onFill={() => {}} />
        <entry.DemoCodeHint onFill={() => {}} />
      </>,
    );
    expect(
      await screen.findByRole('button', { name: 'Preencher acesso de demonstração' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Preencher código de demonstração' }),
    ).toBeInTheDocument();
  });
});
