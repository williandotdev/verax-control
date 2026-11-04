import { describe, expect, it } from 'vitest';
import { errorKind } from './error-kind.js';

class AccessDeniedException extends Error {
  override name = 'AccessDeniedException';
}

describe('tipo do erro para log e banco', () => {
  it('é o nome da classe, nunca a mensagem', () => {
    const kind = errorKind(new AccessDeniedException('papel arn:aws:iam::111111111111:role/x negado'));
    expect(kind).toBe('AccessDeniedException');
    expect(errorKind(new TypeError('dado do cliente'))).toBe('TypeError');
    expect(errorKind(new DOMException('tempo esgotado', 'TimeoutError'))).toBe('TimeoutError');
  });

  it('o que não é Error, ou nome vazio, vira "Error"', () => {
    expect(errorKind('texto solto com segredo')).toBe('Error');
    expect(errorKind({ name: 'ParecidoComErro' })).toBe('Error');
    expect(errorKind(null)).toBe('Error');
    const unnamed = new Error('x');
    unnamed.name = '';
    expect(errorKind(unnamed)).toBe('Error');
  });

  it('nome forjado: fica só com caracteres seguros e cabe em 64', () => {
    const forged = new Error('x');
    forged.name = `Erro com espaço\n${'A'.repeat(100)} e "aspas"`;
    const kind = errorKind(forged);
    expect(kind).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
    expect(kind.startsWith('Errocomespao')).toBe(true);
  });
});
