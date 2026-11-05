import { describe, expect, it } from 'vitest';
import {
  cnpjSchema,
  isValidCnpj,
  tenantCreatedSchema,
  tenantCreateSchema,
  tenantUpdateSchema,
} from './tenants.js';

const valid = {
  name: 'Cliente Demo',
  cnpj: '11.222.333/0001-81',
  plan: 'Essencial',
  escalationContact: { name: 'Ana', email: 'ana@cliente.example', phone: '+55 11 91234-5678' },
  firstAdmin: { name: 'Bia', email: 'bia@cliente.example' },
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

  it('telefone cabe na coluna do banco (até 20 caracteres)', () => {
    const contact = (phone: string) => ({
      ...valid,
      escalationContact: { ...valid.escalationContact, phone },
    });
    expect(tenantCreateSchema.safeParse(contact(`+${'1'.repeat(19)}`)).success).toBe(true);
    expect(tenantCreateSchema.safeParse(contact(`+${'1'.repeat(20)}`)).success).toBe(false);
  });

  it('plano tem no máximo 60 caracteres', () => {
    expect(tenantCreateSchema.safeParse({ ...valid, plan: 'x'.repeat(61) }).success).toBe(false);
  });

  it('alteração parcial, com ao menos um campo', () => {
    expect(tenantUpdateSchema.parse({ status: 'inactive' })).toEqual({ status: 'inactive' });
    expect(tenantUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe('primeiro administrador do cliente', () => {
  const { firstAdmin: _omitted, ...withoutAdmin } = valid;

  it('é obrigatório no cadastro, com nome e e-mail válidos', () => {
    expect(tenantCreateSchema.parse(valid).firstAdmin).toEqual({ name: 'Bia', email: 'bia@cliente.example' });
    expect(tenantCreateSchema.safeParse(withoutAdmin).success).toBe(false);
    expect(
      tenantCreateSchema.safeParse({ ...valid, firstAdmin: { name: 'Bia', email: 'bia' } }).success,
    ).toBe(false);
    expect(
      tenantCreateSchema.safeParse({ ...valid, firstAdmin: { name: '  ', email: 'bia@x.example' } }).success,
    ).toBe(false);
  });

  it('o papel e o cliente não vêm do corpo', () => {
    for (const extra of [{ role: 'admin_verax' }, { tenantId: 'x' }, { password: 'x' }]) {
      const body = { ...valid, firstAdmin: { ...valid.firstAdmin, ...extra } };
      expect(tenantCreateSchema.safeParse(body).success).toBe(false);
    }
  });

  it('não entra na alteração', () => {
    expect(tenantUpdateSchema.safeParse({ firstAdmin: valid.firstAdmin }).success).toBe(false);
    expect(tenantUpdateSchema.safeParse({ ...withoutAdmin, status: 'active' }).success).toBe(true);
  });

  it('a resposta do cadastro traz o cliente e o administrador com a senha temporária', () => {
    const tenant = {
      id: '018f0000-0000-7000-8000-000000000001',
      name: 'Cliente Demo',
      status: 'active',
      cnpj: '11222333000181',
      plan: 'Essencial',
      escalationContact: {
        name: 'Ana',
        email: 'ana@cliente.example',
        phone: null,
        status: 'pending',
        confirmedAt: null,
        unsubscribedAt: null,
        confirmationEmail: { status: 'queued', at: '2026-11-04T12:00:00.000Z' },
      },
      createdAt: '2026-11-04T12:00:00.000Z',
      updatedAt: '2026-11-04T12:00:00.000Z',
    };
    const firstAdmin = {
      id: 'usr_1',
      name: 'Bia',
      email: 'bia@cliente.example',
      temporaryPassword: 'abcde-fghjk-mnpqr-stuvw',
      expiresAt: '2026-11-07T12:00:00.000Z',
    };
    expect(tenantCreatedSchema.parse({ tenant, firstAdmin })).toEqual({ tenant, firstAdmin });
    const { temporaryPassword: _password, ...withoutPassword } = firstAdmin;
    expect(tenantCreatedSchema.safeParse({ tenant, firstAdmin: withoutPassword }).success).toBe(false);
    expect(
      tenantCreatedSchema.safeParse({ tenant, firstAdmin: { ...firstAdmin, role: 'leitura' } }).success,
    ).toBe(false);
  });
});
