import { describe, expect, it } from 'vitest';
import {
  cloudAccountCreateSchema,
  cloudAccountRefSchema,
  cloudAccountSchema,
  cloudAccountUpdateSchema,
  fieldsOutsideProvider,
  isAwsRegion,
  isDomainName,
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
    pubsubSubscription: null,
    zones: [],
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

describe('provedores: AWS, GCP e Cloudflare', () => {
  const CLOUDFLARE_ID = '0123456789abcdef0123456789abcdef';

  it('cada provedor com o próprio formato de ID e os próprios campos', () => {
    expect(cloudAccountCreateSchema.safeParse({ provider: 'gcp', accountId: 'verax-prod-123' }).success).toBe(
      true,
    );
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'gcp',
        accountId: 'verax-prod-123',
        pubsubSubscription: 'verax-soc-logs',
      }).success,
    ).toBe(true);
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'cloudflare',
        accountId: CLOUDFLARE_ID,
        zones: ['exemplo.com.br', 'api.exemplo.com.br'],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['projeto da GCP com ID de conta AWS', { provider: 'gcp', accountId: '123456789012' }],
    ['projeto da GCP começando com número', { provider: 'gcp', accountId: '1verax-prod' }],
    ['projeto da GCP terminando em hífen', { provider: 'gcp', accountId: 'verax-prod-' }],
    ['projeto da GCP curto demais', { provider: 'gcp', accountId: 'vx-1' }],
    ['projeto da GCP com maiúscula', { provider: 'gcp', accountId: 'Verax-prod' }],
    ['Cloudflare com 31 caracteres', { provider: 'cloudflare', accountId: CLOUDFLARE_ID.slice(1) }],
    ['Cloudflare com maiúsculas', { provider: 'cloudflare', accountId: CLOUDFLARE_ID.toUpperCase() }],
    ['AWS com ID de projeto', { provider: 'aws', accountId: 'verax-prod-123', regions: ['sa-east-1'] }],
    ['provedor desconhecido', { provider: 'azure', accountId: 'verax-prod-123' }],
  ])('recusa %s', (_label, input) => {
    expect(cloudAccountCreateSchema.safeParse(input).success).toBe(false);
  });

  it('campos de outro provedor são recusados no cadastro, inclusive credencial', () => {
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'gcp',
        accountId: 'verax-prod-123',
        regions: ['sa-east-1'],
      }).success,
    ).toBe(false);
    expect(
      cloudAccountCreateSchema.safeParse({ provider: 'cloudflare', accountId: CLOUDFLARE_ID, apiToken: 'x' })
        .success,
    ).toBe(false);
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'gcp',
        accountId: 'verax-prod-123',
        credentialsJson: '{}',
      }).success,
    ).toBe(false);
  });

  it.each(['goog-logs', 'a', '1logs', 'logs com espaço', 'logs/../x'])(
    'assinatura do Pub/Sub inválida: %s',
    (name) => {
      expect(
        cloudAccountCreateSchema.safeParse({
          provider: 'gcp',
          accountId: 'verax-prod-123',
          pubsubSubscription: name,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ['exemplo.com.br', true],
    ['xn--exmplo-dva.com', true],
    ['localhost', false],
    ['Exemplo.com', false],
    ['-exemplo.com', false],
    ['exemplo..com', false],
    ['https://exemplo.com', false],
    [`${'a'.repeat(64)}.com`, false],
  ])('domínio %s: %s', (name, valid) => {
    expect(isDomainName(name)).toBe(valid);
  });

  it('zona repetida é recusada', () => {
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'cloudflare',
        accountId: CLOUDFLARE_ID,
        zones: ['exemplo.com.br', 'exemplo.com.br'],
      }).success,
    ).toBe(false);
  });

  it('a referência de conta aceita os três formatos, e nada além deles', () => {
    for (const id of ['123456789012', 'verax-prod-123', CLOUDFLARE_ID]) {
      expect(cloudAccountRefSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ['12345', 'Verax', `${CLOUDFLARE_ID}0`, "x' OR 1=1"]) {
      expect(cloudAccountRefSchema.safeParse(id).success).toBe(false);
    }
  });

  it('a alteração aponta os campos que não existem no provedor da conta', () => {
    const update = cloudAccountUpdateSchema.parse({ regions: ['sa-east-1'], zones: ['exemplo.com.br'] });
    expect(fieldsOutsideProvider('aws', update)).toEqual(['zones']);
    expect(fieldsOutsideProvider('gcp', update)).toEqual(['regions', 'zones']);
    expect(fieldsOutsideProvider('cloudflare', update)).toEqual(['regions']);
    expect(fieldsOutsideProvider('gcp', cloudAccountUpdateSchema.parse({ status: 'inactive' }))).toEqual([]);
  });
});
