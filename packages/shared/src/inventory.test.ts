import { describe, expect, it } from 'vitest';
import {
  accessKeyAssetSchema,
  assetListQuerySchema,
  bucketAssetSchema,
  instanceAssetSchema,
  inventorySummarySchema,
  securityGroupAssetSchema,
} from './inventory.js';

const account = '111122223333';

describe('inventário', () => {
  it('chave antiga com risco e motivo', () => {
    const key = {
      accountId: account,
      id: 'AKIAIOSFODNN7EXAMPLE',
      userName: 'deploy-bot',
      status: 'Active',
      createdAt: '2026-03-01T00:00:00.000Z',
      lastUsedAt: '2026-11-02T12:00:00.000Z',
      risk: 'high',
      reasons: ['old_access_key'],
    };
    expect(accessKeyAssetSchema.parse(key)).toEqual(key);
    expect(accessKeyAssetSchema.safeParse({ ...key, reasons: ['outro_motivo'] }).success).toBe(false);
    expect(accessKeyAssetSchema.safeParse({ ...key, id: 'chave' }).success).toBe(false);
  });

  it('instância, bucket e security group', () => {
    expect(
      instanceAssetSchema.safeParse({
        accountId: account,
        instanceId: 'i-0a1b2c3d4e5f67890',
        region: 'sa-east-1',
        state: 'running',
        publicIp: '198.51.100.5',
        imdsV2Required: false,
        securityGroupIds: ['sg-0123456789abcdef0'],
        risk: 'high',
        reasons: ['public_ip_imdsv1'],
      }).success,
    ).toBe(true);
    expect(
      bucketAssetSchema.safeParse({
        accountId: account,
        name: 'loja-exemplo-relatorios',
        region: 'sa-east-1',
        policyPublic: true,
        aclPublic: false,
        publicAccessBlocked: false,
        risk: 'critical',
        reasons: ['bucket_public', 'bucket_without_public_block'],
      }).success,
    ).toBe(true);
    expect(
      securityGroupAssetSchema.safeParse({
        accountId: account,
        groupId: 'sg-0123456789abcdef0',
        region: 'sa-east-1',
        name: 'acesso-ssh',
        vpcId: 'vpc-0abc1234def567890',
        openToWorld: [{ protocol: 'tcp', fromPort: 22, toPort: 22 }],
        risk: 'critical',
        reasons: ['admin_port_open'],
      }).success,
    ).toBe(true);
  });

  it('visão geral com a conta root e os contadores', () => {
    const count = { total: 3, atRisk: 1 };
    expect(
      inventorySummarySchema.safeParse({
        accounts: [
          {
            accountId: account,
            collectedAt: '2026-11-02T06:00:00.000Z',
            root: {
              mfaEnabled: false,
              accessKeysPresent: false,
              risk: 'critical',
              reasons: ['root_without_mfa'],
            },
          },
        ],
        counts: { users: count, keys: count, instances: count, buckets: count, 'security-groups': count },
      }).success,
    ).toBe(true);
  });

  it('filtros: conta e só os com risco', () => {
    expect(assetListQuerySchema.parse({ atRisk: 'true' })).toMatchObject({ atRisk: 'true', page: 1 });
    expect(assetListQuerySchema.safeParse({ atRisk: 'false' }).success).toBe(false);
    expect(assetListQuerySchema.safeParse({ accountId: '12' }).success).toBe(false);
  });
});
