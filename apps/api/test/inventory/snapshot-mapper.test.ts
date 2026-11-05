import { assetSchemas, inventoryRootSchema, parseInventoryError } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { collectInventory, type AccountInventory } from '../../src/inventory/inventory.js';
import { toSnapshot } from '../../src/inventory/snapshot-mapper.js';
import { ACCOUNT, fakeAccount, REFUSED_ACL } from './fake-account.js';
import { awsError } from './fake-aws.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const REGIONS = ['sa-east-1', 'us-east-1'];

function emptyInventory(overrides: Partial<AccountInventory> = {}): AccountInventory {
  return {
    accountId: ACCOUNT,
    collectedAt: NOW.toISOString(),
    regions: REGIONS,
    root: { mfaEnabled: true, accessKeysPresent: false },
    users: [],
    instances: [],
    securityGroups: [],
    buckets: [],
    truncated: [],
    errors: [],
    ...overrides,
  };
}

describe('retrato do inventário no formato do contrato (PR-14)', () => {
  it('a conta fictícia inteira: cada item no formato de assetSchemas, com o risco e o motivo', async () => {
    const { clients } = fakeAccount();
    const snapshot = toSnapshot(
      await collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW }),
    );
    expect(snapshot.accountId).toBe(ACCOUNT);
    expect(snapshot.collectedAt).toEqual(NOW);
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.dropped).toEqual({ users: 0, keys: 0, instances: 0, buckets: 0, 'security-groups': 0 });
    expect(inventoryRootSchema.parse(snapshot.root)).toEqual({
      mfaEnabled: false,
      accessKeysPresent: true,
      risk: 'critical',
      reasons: ['root_without_mfa', 'root_access_keys'],
    });
    // Tudo o que vai para o banco passa de novo pelo contrato, como a API confere ao ler.
    for (const [kind, items] of Object.entries(snapshot.items)) {
      for (const item of items)
        expect(assetSchemas[kind as keyof typeof assetSchemas].parse(item)).toEqual(item);
    }
    expect(snapshot.items.users).toEqual([
      {
        accountId: ACCOUNT,
        userName: 'ana',
        arn: `arn:aws:iam::${ACCOUNT}:user/ana`,
        createdAt: '2025-01-01T00:00:00.000Z',
        consoleAccess: true,
        mfaEnabled: false,
        activeKeys: 0,
        risk: 'high',
        reasons: ['console_without_mfa'],
      },
      expect.objectContaining({
        userName: 'bot',
        activeKeys: 1,
        risk: 'medium',
        reasons: ['old_access_key'],
      }),
    ]);
    // A chave sai do usuário, com o nome dele e o risco dela (criada há mais de 90 dias).
    expect(snapshot.items.keys).toEqual([
      {
        accountId: ACCOUNT,
        id: 'AKIABOT0000000000000',
        userName: 'bot',
        status: 'Active',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-10-30T00:00:00.000Z',
        risk: 'medium',
        reasons: ['old_access_key'],
      },
    ]);
    expect(snapshot.items.instances).toContainEqual({
      accountId: ACCOUNT,
      instanceId: 'i-0aaa1000000000000',
      region: 'sa-east-1',
      state: 'running',
      publicIp: '198.51.100.10',
      imdsV2Required: false,
      securityGroupIds: ['sg-0aaa0000000000000'],
      risk: 'medium',
      reasons: ['public_ip_imdsv1'],
    });
    expect(snapshot.items.buckets).toEqual([
      expect.objectContaining({
        name: 'site-publico',
        policyPublic: true,
        publicAccessBlocked: false,
        risk: 'high',
        reasons: ['bucket_public', 'bucket_without_public_block'],
      }),
      expect.objectContaining({ name: 'dados', aclPublic: true, publicAccessBlocked: false, risk: 'high' }),
      expect.objectContaining({
        name: 'restrito',
        aclPublic: false,
        publicAccessBlocked: true,
        risk: 'none',
        reasons: [],
      }),
    ]);
    expect(snapshot.items['security-groups']).toContainEqual(
      expect.objectContaining({ groupId: 'sg-0aaa0000000000000', region: 'us-east-1', risk: 'critical' }),
    );
  });

  it('bloqueio de acesso público: "não lido" quando a leitura dele foi recusada', () => {
    const snapshot = toSnapshot(
      emptyInventory({
        buckets: [
          {
            name: 'sem-leitura',
            region: 'sa-east-1',
            policyPublic: false,
            aclPublic: false,
            publicAccessBlock: null,
            unreadable: ['GetPublicAccessBlock: AccessDenied'],
          },
        ],
      }),
    );
    expect(snapshot.items.buckets).toEqual([
      expect.objectContaining({ publicAccessBlocked: null, reasons: ['bucket_unreadable'] }),
    ]);
  });

  it('zod por item: o item fora do formato fica de fora e é contado, sem derrubar o resto', () => {
    const instance = {
      region: 'sa-east-1',
      state: 'running',
      publicIp: null,
      imdsV2Required: true,
      securityGroupIds: [],
    };
    const snapshot = toSnapshot(
      emptyInventory({
        users: [
          {
            userName: 'u'.repeat(200),
            arn: `arn:aws:iam::${ACCOUNT}:user/longo`,
            createdAt: null,
            consoleAccess: false,
            mfaEnabled: false,
            accessKeys: [
              { id: 'chave-fora-do-formato', status: 'Active', createdAt: null, lastUsedAt: null },
            ],
          },
          {
            userName: 'certo',
            arn: `arn:aws:iam::${ACCOUNT}:user/certo`,
            createdAt: null,
            consoleAccess: false,
            mfaEnabled: false,
            accessKeys: [],
          },
        ],
        instances: [
          { ...instance, instanceId: 'i-0aaa1000000000000' },
          { ...instance, instanceId: 'I-FORA-DO-FORMATO' },
          { ...instance, instanceId: 'i-zzz', region: 'lua-1' },
        ],
        securityGroups: [
          {
            groupId: 'sg-0aaa0000000000000',
            region: 'us-east-1',
            name: 'regras-demais',
            vpcId: null,
            openToWorld: Array.from({ length: 201 }, (_, port) => ({
              protocol: 'tcp',
              fromPort: port,
              toPort: port,
            })),
          },
        ],
      }),
    );
    expect(snapshot.items.users).toEqual([expect.objectContaining({ userName: 'certo' })]);
    expect(snapshot.items.keys).toEqual([]);
    expect(snapshot.items.instances).toEqual([
      expect.objectContaining({ instanceId: 'i-0aaa1000000000000' }),
    ]);
    expect(snapshot.items['security-groups']).toEqual([]);
    expect(snapshot.dropped).toEqual({ users: 1, keys: 1, instances: 2, buckets: 0, 'security-groups': 1 });
    // A parte de cada item recusado vira coleta parcial (sem repetir), com a região quando ela é válida.
    expect(snapshot.errors).toEqual([
      'iam:invalid_items',
      'ec2:sa-east-1:invalid_items',
      'ec2:invalid_items',
      'sg:us-east-1:invalid_items',
    ]);
    for (const value of snapshot.errors) expect(parseInventoryError(value)).not.toBeNull();
    // Nada do item recusado vai para o retrato.
    expect(JSON.stringify(snapshot)).not.toMatch(/FORA-DO-FORMATO|chave-fora|uuuuuuuu|i-zzz|lua-1/);
  });

  it('parte recusada e teto de itens: o retrato sai parcial, com o código e sem a mensagem da AWS', async () => {
    const { clients } = fakeAccount({
      iam: {
        ListUsersCommand: () => {
          throw awsError('AccessDenied', 403);
        },
      },
      ec2: {
        'us-east-1': {
          DescribeSecurityGroupsCommand: () => {
            throw awsError('UnauthorizedOperation', 403);
          },
        },
      },
    });
    const inventory = await collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW });
    const snapshot = toSnapshot({ ...inventory, truncated: ['ec2:sa-east-1'] });
    expect(snapshot.errors).toEqual(['iam:AccessDenied', 'sg:us-east-1:UnauthorizedOperation']);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.items.users).toEqual([]);
    expect(snapshot.items.instances).toHaveLength(4);
    expect(JSON.stringify(snapshot)).not.toContain('detalhe-interno');
  });

  it('leitura recusada num bucket: o retrato sai parcial (s3:AccessDenied) e o bucket fica "não lido"', async () => {
    const { clients } = fakeAccount({ s3: REFUSED_ACL });
    const snapshot = toSnapshot(
      await collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW }),
    );
    expect(snapshot.errors).toEqual(['s3:AccessDenied']);
    expect(snapshot.items.buckets).toContainEqual(
      expect.objectContaining({
        name: 'restrito',
        aclPublic: null,
        risk: 'low',
        reasons: ['bucket_unreadable'],
      }),
    );
  });

  it('sem a conta root (parte recusada): root nulo', () => {
    expect(toSnapshot(emptyInventory({ root: null })).root).toBeNull();
  });
});
