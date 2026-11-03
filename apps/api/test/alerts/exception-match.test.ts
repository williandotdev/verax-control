import { describe, expect, it } from 'vitest';
import { type ActiveException, matchingException } from '../../src/alerts/exception-match.js';

const NOW = new Date('2026-11-03T12:00:00Z');

const finding = {
  ruleId: '80254',
  actorUser: 'arn:aws:iam::111122223333:user/ana',
  sourceIp: '203.0.113.50',
  resource: 's3:relatorios',
};

function exception(overrides: Partial<ActiveException>): ActiveException {
  return {
    id: 'e1',
    ruleId: '80254',
    field: 'user',
    value: finding.actorUser,
    expiresAt: null,
    ...overrides,
  };
}

describe('exceção de alerta no sync (T3.5)', () => {
  it.each([
    ['usuário igual', exception({})],
    ['recurso igual', exception({ field: 'resource', value: 's3:relatorios' })],
    ['IP igual', exception({ field: 'ip', value: '203.0.113.50' })],
    ['IP dentro da faixa', exception({ field: 'ip', value: '203.0.113.0/24' })],
    ['validade no futuro', exception({ expiresAt: new Date('2026-12-01T00:00:00Z') })],
  ])('marca: %s', (_label, rule) => {
    expect(matchingException(finding, [rule], NOW)).toBe(rule);
  });

  it.each([
    ['outra regra', exception({ ruleId: '80255' })],
    ['outro usuário', exception({ value: 'arn:aws:iam::111122223333:user/bruno' })],
    ['usuário só parecido (prefixo)', exception({ value: 'arn:aws:iam::111122223333:user/an' })],
    ['IP fora da faixa', exception({ field: 'ip', value: '203.0.114.0/24' })],
    ['faixa IPv6 para IP IPv4', exception({ field: 'ip', value: '2001:db8::/32' })],
    ['faixa com prefixo inválido', exception({ field: 'ip', value: '203.0.113.0/40' })],
    ['vencida', exception({ expiresAt: new Date('2026-11-03T12:00:00Z') })],
  ])('não marca: %s', (_label, rule) => {
    expect(matchingException(finding, [rule], NOW)).toBeNull();
  });

  it('achado sem IP não casa com exceção de IP', () => {
    expect(
      matchingException(
        { ...finding, sourceIp: null },
        [exception({ field: 'ip', value: '0.0.0.0/0' })],
        NOW,
      ),
    ).toBeNull();
  });

  it('IPv6 dentro da faixa', () => {
    expect(
      matchingException(
        { ...finding, sourceIp: '2001:db8::15' },
        [exception({ field: 'ip', value: '2001:db8::/32' })],
        NOW,
      ),
    ).not.toBeNull();
  });

  it('vale a primeira exceção que casa, na ordem recebida', () => {
    const first = exception({ id: 'primeira', field: 'ip', value: '203.0.113.0/24' });
    const second = exception({ id: 'segunda' });
    expect(matchingException(finding, [first, second], NOW)?.id).toBe('primeira');
  });
});
