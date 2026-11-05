import { describe, expect, it } from 'vitest';
import { deletionTenantName } from './deletion-steps.js';

describe('nome do cliente no destroy', () => {
  it('até 120 caracteres, o nome inteiro', () => {
    const name = 'Empresa Exemplo Ltda';
    expect(deletionTenantName(name)).toBe(name);
    expect(deletionTenantName('a'.repeat(120))).toBe('a'.repeat(120));
  });

  it('um cliente gravado antes do limite (até 200) é cortado em 120, sem partir caractere nem deixar espaço no fim', () => {
    expect(deletionTenantName('a'.repeat(200))).toHaveLength(120);
    expect(deletionTenantName(`${'a'.repeat(119)}😀b`)).toBe('a'.repeat(119));
    expect(deletionTenantName(`${'a'.repeat(119)} bcd`)).toBe('a'.repeat(119));
  });
});
