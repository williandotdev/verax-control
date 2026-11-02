import { describe, expect, it } from 'vitest';
import { cloudAccountCreateSchema, isAwsRegion, readOnlyRoleArn } from './cloud-accounts.js';

describe('contas cloud (T3.3)', () => {
  it.each(['sa-east-1', 'us-east-1', 'ap-southeast-4', 'us-gov-west-1', 'us-isob-east-1'])(
    'região válida: %s',
    (region) => {
      expect(isAwsRegion(region)).toBe(true);
    },
  );

  it.each(['marte-1', 'sa-east', 'SA-EAST-1', 'sa-east-10', 'us-xyz-west-1', 'sa--1', 'a-east-1'])(
    'região inválida: %s',
    (region) => {
      expect(isAwsRegion(region)).toBe(false);
    },
  );

  it('o papel de leitura é sempre o do conector, na conta informada', () => {
    expect(readOnlyRoleArn('123456789012')).toBe('arn:aws:iam::123456789012:role/VeraxControlReadOnly');
  });

  it.each([
    ['bucket com maiúscula', { cloudtrail: 'Trilha' }],
    ['bucket com formato de IP', { cloudtrail: '192.168.0.1' }],
    ['bucket com pontos seguidos', { cloudtrail: 'trilha..logs' }],
    ['WAF sem o prefixo da AWS', { waf: 'logs-waf' }],
  ])('recusa %s', (_label, buckets) => {
    const result = cloudAccountCreateSchema.safeParse({
      provider: 'aws',
      accountId: '123456789012',
      regions: ['sa-east-1'],
      buckets,
    });
    expect(result.success).toBe(false);
  });
});
