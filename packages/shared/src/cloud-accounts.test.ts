import { describe, expect, it } from 'vitest';
import {
  cloudAccountCreateSchema,
  cloudAccountSchema,
  isAwsRegion,
  readOnlyRoleArn,
} from './cloud-accounts.js';

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

describe('situação da conexão (T7.3)', () => {
  const account = {
    id: '018f2c1e-0000-7000-8000-0000000c0001',
    provider: 'aws',
    accountId: '111122223333',
    regions: ['sa-east-1'],
    roleArn: readOnlyRoleArn('111122223333'),
    externalId: null,
    buckets: { cloudtrail: null, guardduty: null, waf: null },
    status: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };

  it('conexão e último evento são opcionais até a persistência do E5', () => {
    expect(cloudAccountSchema.safeParse(account).success).toBe(true);
    expect(
      cloudAccountSchema.safeParse({ ...account, connection: 'ok', lastEventAt: '2026-11-02T12:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(
      cloudAccountSchema.safeParse({ ...account, connection: 'pending', lastEventAt: null }).success,
    ).toBe(true);
    expect(cloudAccountSchema.safeParse({ ...account, connection: 'talvez' }).success).toBe(false);
  });
});
