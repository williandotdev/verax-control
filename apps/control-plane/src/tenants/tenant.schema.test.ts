import { describe, expect, it } from 'vitest';
import { demoTenant } from '../../test/support/tenant-store-contract.js';
import { checkoutRequestSchema } from '../checkout/checkout.schema.js';
import {
  billingModeOf,
  COMPANY_NAME_MAX_LENGTH,
  companyNameSchema,
  isReservableSlug,
  slugSchema,
  tenantSchema,
} from './tenant.schema.js';

describe('nome da empresa (razão social)', () => {
  const longest = `Ação & "Filhos" ${'Comércio '.repeat(11)}Ltda.`;

  it('até 120 caracteres, o limite do nó (`Tenant.name`), sem espaço nas pontas', () => {
    expect(COMPANY_NAME_MAX_LENGTH).toBe(120);
    expect(longest).toHaveLength(120);
    expect(companyNameSchema.parse(longest)).toBe(longest);
    expect(companyNameSchema.parse(` ${longest}\u00a0`)).toBe(longest);
    expect(companyNameSchema.parse('AB')).toBe('AB');
  });

  it('recusa 121 caracteres, menos de 2, quebra de linha e outro controle, com a mensagem em português', () => {
    const tooLong = companyNameSchema.safeParse(`${longest}x`);
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.message).toBe('nome da empresa longo demais: no máximo 120 caracteres');
    const tooShort = companyNameSchema.safeParse(' A ');
    expect(tooShort.error?.issues[0]?.message).toBe('nome da empresa curto demais: no mínimo 2 caracteres');
    for (const name of ['Cliente\nDemo', 'Cliente\tDemo', 'Cliente\u0000Demo', 'Cliente\u007fDemo']) {
      expect(companyNameSchema.safeParse(name).error?.issues[0]?.message, JSON.stringify(name)).toBe(
        'caracteres inválidos',
      );
    }
  });

  it('o checkout usa a mesma regra', () => {
    expect(checkoutRequestSchema.shape.companyName).toBe(companyNameSchema);
  });
});

describe('subdomínio do cliente', () => {
  it('aceita 3 a 16 caracteres, começando por letra e sem terminar em traço', () => {
    for (const slug of ['abc', 'cliente-demo-a', 'a1-b2', 'abcdefghijklmnop']) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it('recusa formato errado', () => {
    for (const slug of ['ab', 'abcdefghijklmnopq', '1abc', 'abc-', 'Abc', 'ab_c', 'ab.c', '']) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });

  it('recusa traços nas posições 3 e 4 juntos (xn-- e afins), como o painel', () => {
    for (const slug of ['xn--abc', 'ab--cd', 'zz--']) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(false);
    }
    // Um traço só nessas posições, ou dois traços em outro lugar, continua valendo.
    for (const slug of ['ab-cd', 'abc-d', 'abc--d']) {
      expect(slugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it('a lista reservada fica de fora mesmo no formato certo', () => {
    expect(isReservableSlug('verax')).toBe(false);
    expect(isReservableSlug('cliente-demo-a')).toBe(true);
    expect(isReservableSlug('xn--abc')).toBe(false);
  });
});

describe('modo de cobrança (billing.mode)', () => {
  const at = new Date('2026-11-05T12:00:00.000Z');
  const base = { ...demoTenant(), state: 'pending', stateUpdatedAt: at, createdAt: at, updatedAt: at };

  it('sem o campo é stripe (os clientes de antes não mudam); contract é o contrato direto do console', () => {
    expect(billingModeOf(tenantSchema.parse(base))).toBe('stripe');
    const { consent: _consent, stripe: _stripe, ...contract } = base;
    const parsed = tenantSchema.parse({ ...contract, billing: { mode: 'contract' } });
    expect(billingModeOf(parsed)).toBe('contract');
    expect(parsed.stripe).toBeUndefined();
    expect(billingModeOf(tenantSchema.parse({ ...base, billing: { mode: 'stripe' } }))).toBe('stripe');
  });

  it('outro modo é recusado na leitura', () => {
    expect(tenantSchema.safeParse({ ...base, billing: { mode: 'boleto' } }).success).toBe(false);
  });
});
