import { describe, expect, it } from 'vitest';
import type { BucketInfo, IamUser, SecurityGroupInfo } from '../../src/inventory/collectors.js';
import {
  accessKeyRisk,
  bucketRisk,
  iamUserRisk,
  instanceRisk,
  rootRisk,
  securityGroupRisk,
} from '../../src/inventory/risk-rules.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function user(overrides: Partial<IamUser> = {}): IamUser {
  return {
    userName: 'ana',
    arn: 'arn:aws:iam::111122223333:user/ana',
    createdAt: daysAgo(400),
    consoleAccess: false,
    mfaEnabled: false,
    accessKeys: [],
    ...overrides,
  };
}

function group(rules: SecurityGroupInfo['openToWorld']): SecurityGroupInfo {
  return { groupId: 'sg-1', region: 'sa-east-1', name: 'x', vpcId: null, openToWorld: rules };
}

function bucket(overrides: Partial<BucketInfo> = {}): BucketInfo {
  return {
    name: 'dados',
    region: 'sa-east-1',
    policyPublic: false,
    aclPublic: false,
    publicAccessBlock: {
      blockPublicAcls: true,
      ignorePublicAcls: true,
      blockPublicPolicy: true,
      restrictPublicBuckets: true,
    },
    unreadable: [],
    ...overrides,
  };
}

describe('risco dos ativos (T5.9)', () => {
  it('chave de acesso (aba Chaves, PR-14): a mesma regra do usuário, chave por chave; inativa não tem risco', () => {
    const key = (overrides: object) => ({
      id: 'AKIAEXEMPLO000000001',
      status: 'Active' as const,
      createdAt: daysAgo(10),
      lastUsedAt: daysAgo(1),
      ...overrides,
    });
    expect(accessKeyRisk(key({}), NOW)).toEqual({ risk: 'none', reasons: [] });
    expect(accessKeyRisk(key({ createdAt: daysAgo(200) }), NOW)).toEqual({
      risk: 'medium',
      reasons: ['old_access_key'],
    });
    expect(accessKeyRisk(key({ createdAt: daysAgo(200), lastUsedAt: daysAgo(120) }), NOW)).toEqual({
      risk: 'medium',
      reasons: ['old_access_key', 'unused_access_key'],
    });
    // Nunca usada conta da criação: a nova não é "parada".
    expect(accessKeyRisk(key({ lastUsedAt: null }), NOW)).toEqual({ risk: 'none', reasons: [] });
    expect(
      accessKeyRisk(key({ status: 'Inactive', createdAt: daysAgo(500), lastUsedAt: null }), NOW),
    ).toEqual({
      risk: 'none',
      reasons: [],
    });
    // O usuário soma os motivos das chaves dele.
    expect(
      iamUserRisk(
        user({ accessKeys: [key({ createdAt: daysAgo(200) }), key({ lastUsedAt: daysAgo(100) })] }),
        NOW,
      ),
    ).toEqual({ risk: 'medium', reasons: ['old_access_key', 'unused_access_key'] });
  });

  it('root sem MFA ou com chave de acesso é crítico', () => {
    expect(rootRisk({ mfaEnabled: true, accessKeysPresent: false })).toEqual({ risk: 'none', reasons: [] });
    expect(rootRisk({ mfaEnabled: false, accessKeysPresent: true })).toEqual({
      risk: 'critical',
      reasons: ['root_without_mfa', 'root_access_keys'],
    });
  });

  it('usuário: console sem MFA é alto; chave ativa velha é média; chave parada é baixa', () => {
    expect(iamUserRisk(user({ consoleAccess: true }), NOW)).toEqual({
      risk: 'high',
      reasons: ['console_without_mfa'],
    });
    expect(iamUserRisk(user({ consoleAccess: true, mfaEnabled: true }), NOW).risk).toBe('none');

    const oldKey = {
      id: 'AKIA1',
      status: 'Active' as const,
      createdAt: daysAgo(120),
      lastUsedAt: daysAgo(1),
    };
    expect(iamUserRisk(user({ accessKeys: [oldKey] }), NOW)).toEqual({
      risk: 'medium',
      reasons: ['old_access_key'],
    });

    const idleKey = { id: 'AKIA2', status: 'Active' as const, createdAt: daysAgo(60), lastUsedAt: null };
    expect(iamUserRisk(user({ accessKeys: [idleKey] }), NOW).risk).toBe('none');
    // Criada há mais de 90 dias e nunca usada: velha e parada.
    const neverUsed = { id: 'AKIA4', status: 'Active' as const, createdAt: daysAgo(100), lastUsedAt: null };
    expect(iamUserRisk(user({ accessKeys: [neverUsed] }), NOW)).toEqual({
      risk: 'medium',
      reasons: ['old_access_key', 'unused_access_key'],
    });
    const staleKey = {
      id: 'AKIA3',
      status: 'Active' as const,
      createdAt: daysAgo(80),
      lastUsedAt: daysAgo(91),
    };
    expect(iamUserRisk(user({ accessKeys: [staleKey] }), NOW)).toEqual({
      risk: 'low',
      reasons: ['unused_access_key'],
    });

    const inactive = { ...oldKey, status: 'Inactive' as const };
    expect(iamUserRisk(user({ accessKeys: [inactive] }), NOW).risk).toBe('none');
  });

  it('security group aberto para a internet: pela porta exposta', () => {
    const cases: [SecurityGroupInfo['openToWorld'], string, string][] = [
      [[{ protocol: '-1', fromPort: null, toPort: null }], 'critical', 'all_traffic_open'],
      [[{ protocol: 'tcp', fromPort: 22, toPort: 22 }], 'critical', 'admin_port_open'],
      [[{ protocol: 'tcp', fromPort: 0, toPort: 65535 }], 'critical', 'admin_port_open'],
      [[{ protocol: 'tcp', fromPort: 3389, toPort: 3389 }], 'critical', 'admin_port_open'],
      [[{ protocol: 'tcp', fromPort: 5432, toPort: 5432 }], 'high', 'database_port_open'],
      [[{ protocol: 'tcp', fromPort: 6000, toPort: 6400 }], 'high', 'database_port_open'],
      [[{ protocol: 'tcp', fromPort: 8080, toPort: 8080 }], 'medium', 'port_open'],
      [[{ protocol: 'tcp', fromPort: 443, toPort: 443 }], 'low', 'web_port_open'],
      [[{ protocol: 'icmp', fromPort: -1, toPort: -1 }], 'low', 'icmp_open'],
    ];
    for (const [rules, risk, reason] of cases) {
      expect(securityGroupRisk(group(rules))).toEqual({ risk, reasons: [reason] });
    }
    expect(securityGroupRisk(group([]))).toEqual({ risk: 'none', reasons: [] });
    expect(
      securityGroupRisk(
        group([
          { protocol: 'tcp', fromPort: 443, toPort: 443 },
          { protocol: 'tcp', fromPort: 22, toPort: 22 },
        ]),
      ).risk,
    ).toBe('critical');
  });

  it('instância: IMDSv1 com IP público é médio, sem IP é baixo; IMDSv2 ou encerrada não tem risco', () => {
    const base = { instanceId: 'i-1', region: 'sa-east-1', state: 'running', securityGroupIds: [] };
    expect(instanceRisk({ ...base, publicIp: '198.51.100.1', imdsV2Required: false })).toEqual({
      risk: 'medium',
      reasons: ['public_ip_imdsv1'],
    });
    expect(instanceRisk({ ...base, publicIp: null, imdsV2Required: false })).toEqual({
      risk: 'low',
      reasons: ['imdsv1'],
    });
    expect(instanceRisk({ ...base, publicIp: '198.51.100.1', imdsV2Required: true }).risk).toBe('none');
    expect(instanceRisk({ ...base, state: 'terminated', publicIp: null, imdsV2Required: false }).risk).toBe(
      'none',
    );
  });

  it('bucket: público só se o bloqueio do bucket não impedir', () => {
    expect(bucketRisk(bucket())).toEqual({ risk: 'none', reasons: [] });
    // Política pública, mas o bloqueio restringe buckets públicos.
    expect(bucketRisk(bucket({ policyPublic: true })).risk).toBe('none');
    expect(bucketRisk(bucket({ policyPublic: true, publicAccessBlock: null }))).toEqual({
      risk: 'high',
      reasons: ['bucket_public', 'bucket_without_public_block'],
    });
    // ACL pública com o bloqueio ignorando ACLs.
    expect(bucketRisk(bucket({ aclPublic: true })).risk).toBe('none');
    const aclOnly = bucket({
      aclPublic: true,
      publicAccessBlock: {
        blockPublicAcls: false,
        ignorePublicAcls: false,
        blockPublicPolicy: true,
        restrictPublicBuckets: true,
      },
    });
    expect(bucketRisk(aclOnly)).toEqual({ risk: 'high', reasons: ['bucket_public'] });
  });

  it('bucket: sem bloqueio é baixo; leitura recusada é sinalizada', () => {
    expect(bucketRisk(bucket({ publicAccessBlock: null }))).toEqual({
      risk: 'low',
      reasons: ['bucket_without_public_block'],
    });
    expect(
      bucketRisk(bucket({ publicAccessBlock: null, unreadable: ['GetPublicAccessBlock: AccessDenied'] })),
    ).toEqual({ risk: 'low', reasons: ['bucket_unreadable'] });
  });
});
