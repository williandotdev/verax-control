import { describe, expect, it } from 'vitest';
import { cnpjSchema, isValidCnpj, tenantCreateSchema, tenantUpdateSchema } from './tenants.js';

const valid = {
  name: 'Cliente Demo',
  cnpj: '11.222.333/0001-81',
  plan: 'Essencial',
  escalationContact: { name: 'Ana', email: 'ana@cliente.example', phone: '+55 11 91234-5678' },
};

describe('CNPJ (T3.1)', () => {
  it('aceita o numérico e o alfanumérico (desde julho de 2026), com ou sem máscara', () => {
    expect(cnpjSchema.parse('11.222.333/0001-81')).toBe('11222333000181');
    expect(cnpjSchema.parse('11222333000181')).toBe('11222333000181');
    expect(cnpjSchema.parse('12.abc.345/01de-35')).toBe('12ABC34501DE35');
  });

  it.each([
    ['dígito verificador errado', '11222333000182'],
    ['alfanumérico com dígito errado', '12ABC34501DE36'],
    ['letra nos dígitos verificadores', '12ABC34501DE3A'],
    ['tamanho errado', '1122233300018'],
    ['todos iguais', '00000000000000'],
    ['caractere fora do alfabeto', '12ABC34501D!35'],
  ])('recusa %s', (_label, value) => {
    expect(isValidCnpj(value)).toBe(false);
    expect(cnpjSchema.safeParse(value).success).toBe(false);
  });
});

describe('cadastro de cliente', () => {
  it('aceita o cadastro completo e normaliza o CNPJ', () => {
    expect(tenantCreateSchema.parse(valid).cnpj).toBe('11222333000181');
  });

  it('recusa campo desconhecido (status e id não vêm do corpo na criação)', () => {
    expect(tenantCreateSchema.safeParse({ ...valid, status: 'active' }).success).toBe(false);
    expect(tenantCreateSchema.safeParse({ ...valid, id: 'x' }).success).toBe(false);
  });

  it('plano tem no máximo 60 caracteres', () => {
    expect(tenantCreateSchema.safeParse({ ...valid, plan: 'x'.repeat(61) }).success).toBe(false);
  });

  it('alteração parcial, com ao menos um campo', () => {
    expect(tenantUpdateSchema.parse({ status: 'inactive' })).toEqual({ status: 'inactive' });
    expect(tenantUpdateSchema.safeParse({}).success).toBe(false);
  });
});
