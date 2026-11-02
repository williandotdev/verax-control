import type { EC2Client } from '@aws-sdk/client-ec2';
import { NoSuchEntityException, type IAMClient } from '@aws-sdk/client-iam';
import type { S3Client } from '@aws-sdk/client-s3';
import type { STSClient } from '@aws-sdk/client-sts';
import { describe, expect, it } from 'vitest';
import { MAX_ITEMS, collectBuckets, collectIamUsers } from '../../src/inventory/collectors.js';
import { collectInventory, type InventoryClients } from '../../src/inventory/inventory.js';
import { InventoryError, type TemporaryCredentials } from '../../src/inventory/read-only-session.js';
import { awsError, fakeClient } from './fake-aws.js';

const ACCOUNT = '111122223333';
const EXTERNAL_ID = 'exemplo-external-id-conta-a-0000000000';
const SECRET = 'segredo-temporario-de-teste-0000000000';

const stsOk = () =>
  fakeClient<STSClient>({
    AssumeRoleCommand: () => ({
      Credentials: { AccessKeyId: 'ASIAEXEMPLO000000000', SecretAccessKey: SECRET, SessionToken: 'token' },
    }),
  });

function iam(overrides: Record<string, (input: Record<string, unknown>) => unknown> = {}) {
  return fakeClient<IAMClient>({
    GetAccountSummaryCommand: () => ({ SummaryMap: { AccountMFAEnabled: 0, AccountAccessKeysPresent: 1 } }),
    ListUsersCommand: (input) =>
      input['Marker'] === undefined
        ? {
            Users: [
              {
                UserName: 'ana',
                Arn: `arn:aws:iam::${ACCOUNT}:user/ana`,
                CreateDate: new Date('2025-01-01'),
              },
            ],
            IsTruncated: true,
            Marker: 'pagina-2',
          }
        : { Users: [{ UserName: 'bot', Arn: `arn:aws:iam::${ACCOUNT}:user/bot` }], IsTruncated: false },
    GetLoginProfileCommand: (input) => {
      if (input['UserName'] === 'bot')
        throw new NoSuchEntityException({ message: 'sem perfil', $metadata: {} });
      return { LoginProfile: { UserName: 'ana' } };
    },
    ListMFADevicesCommand: (input) => ({
      MFADevices: input['UserName'] === 'ana' ? [] : [{ SerialNumber: 'mfa' }],
    }),
    ListAccessKeysCommand: (input) => ({
      AccessKeyMetadata:
        input['UserName'] === 'bot'
          ? [{ AccessKeyId: 'AKIABOT0000000000000', Status: 'Active', CreateDate: new Date('2026-01-01') }]
          : [],
    }),
    GetAccessKeyLastUsedCommand: () => ({ AccessKeyLastUsed: { LastUsedDate: new Date('2026-10-30') } }),
    ...overrides,
  });
}

function ec2(region: string, failing = false) {
  return fakeClient<EC2Client>({
    DescribeRegionsCommand: () => ({ Regions: [{ RegionName: 'us-east-1' }, { RegionName: 'sa-east-1' }] }),
    DescribeInstancesCommand: (input) => {
      if (failing) throw awsError('UnauthorizedOperation');
      return input['NextToken'] === undefined
        ? {
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: `i-0aaa${region === 'sa-east-1' ? '1' : '2'}000000000000`,
                    State: { Name: 'running' },
                    PublicIpAddress: '198.51.100.10',
                    MetadataOptions: { HttpTokens: 'optional' },
                    SecurityGroups: [{ GroupId: 'sg-0aaa0000000000000' }],
                  },
                ],
              },
            ],
            NextToken: 'proxima',
          }
        : {
            Reservations: [
              {
                Instances: [
                  { InstanceId: 'i-0bbb0000000000000', MetadataOptions: { HttpTokens: 'required' } },
                ],
              },
            ],
          };
    },
    DescribeSecurityGroupsCommand: () => ({
      SecurityGroups: [
        {
          GroupId: 'sg-0aaa0000000000000',
          GroupName: 'web',
          VpcId: 'vpc-1',
          IpPermissions: [
            { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
            { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, Ipv6Ranges: [{ CidrIpv6: '::/0' }] },
            { IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: '10.0.0.0/16' }] },
          ],
        },
      ],
    }),
  });
}

function s3() {
  return fakeClient<S3Client>({
    ListBucketsCommand: () => ({
      Buckets: [
        { Name: 'site-publico', BucketRegion: 'sa-east-1' },
        { Name: 'dados', BucketRegion: 'us-east-1' },
        { Name: 'restrito' },
      ],
    }),
    GetBucketPolicyStatusCommand: (input) => {
      if (input['Bucket'] === 'dados') throw awsError('NoSuchBucketPolicy');
      return { PolicyStatus: { IsPublic: input['Bucket'] === 'site-publico' } };
    },
    GetBucketAclCommand: (input) => {
      if (input['Bucket'] === 'restrito') throw awsError('AccessDenied');
      return {
        Grants:
          input['Bucket'] === 'dados'
            ? [{ Grantee: { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AllUsers' } }]
            : [],
      };
    },
    GetPublicAccessBlockCommand: (input) => {
      if (input['Bucket'] !== 'restrito') throw awsError('NoSuchPublicAccessBlockConfiguration');
      return {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      };
    },
  });
}

describe('coleta do inventário (T5.9)', () => {
  it('IAM: páginas de usuários, console, MFA e chaves com último uso', async () => {
    const { users, truncated } = await collectIamUsers(iam().client);
    expect(truncated).toBe(false);
    expect(users).toEqual([
      {
        userName: 'ana',
        arn: `arn:aws:iam::${ACCOUNT}:user/ana`,
        createdAt: '2025-01-01T00:00:00.000Z',
        consoleAccess: true,
        mfaEnabled: false,
        accessKeys: [],
      },
      {
        userName: 'bot',
        arn: `arn:aws:iam::${ACCOUNT}:user/bot`,
        createdAt: null,
        consoleAccess: false,
        mfaEnabled: true,
        accessKeys: [
          {
            id: 'AKIABOT0000000000000',
            status: 'Active',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: '2026-10-30T00:00:00.000Z',
          },
        ],
      },
    ]);
  });

  it('IAM: erro que não é "sem perfil de console" sobe, em vez de virar "sem console"', async () => {
    const failing = iam({
      GetLoginProfileCommand: () => {
        throw awsError('AccessDenied');
      },
    });
    await expect(collectIamUsers(failing.client)).rejects.toThrow('AccessDenied');
  });

  it('IAM: conta enorme para no teto de itens e avisa', async () => {
    let page = 0;
    const huge = iam({
      ListUsersCommand: () => {
        page += 1;
        return {
          Users: Array.from({ length: 100 }, (_, n) => ({
            UserName: `u${page}-${n}`,
            Arn: `arn:${page}:${n}`,
          })),
          IsTruncated: true,
          Marker: `m${page}`,
        };
      },
    });
    const { users, truncated } = await collectIamUsers(huge.client);
    expect(users).toHaveLength(MAX_ITEMS);
    expect(truncated).toBe(true);
    expect(huge.calls.filter((call) => call.command === 'ListUsersCommand')).toHaveLength(MAX_ITEMS / 100);
  });

  it('S3: política e ACL públicas, bloqueio ausente e leitura recusada', async () => {
    const { buckets } = await collectBuckets(s3().client);
    expect(buckets).toEqual([
      {
        name: 'site-publico',
        region: 'sa-east-1',
        policyPublic: true,
        aclPublic: false,
        publicAccessBlock: null,
        unreadable: [],
      },
      {
        name: 'dados',
        region: 'us-east-1',
        policyPublic: false,
        aclPublic: true,
        publicAccessBlock: null,
        unreadable: [],
      },
      {
        name: 'restrito',
        region: null,
        policyPublic: false,
        aclPublic: null,
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
        unreadable: ['GetBucketAcl: AccessDenied'],
      },
    ]);
  });

  it('conta inteira: regiões habilitadas, uma parte com erro não derruba as outras', async () => {
    const iamFake = iam();
    const s3Fake = s3();
    const ec2ByRegion = new Map([
      ['us-east-1', ec2('us-east-1')],
      ['sa-east-1', ec2('sa-east-1', true)],
    ]);
    let received: TemporaryCredentials | null = null;
    const inventory = await collectInventory(
      { accountId: ACCOUNT, externalId: EXTERNAL_ID },
      {
        sts: stsOk().client,
        now: () => new Date('2026-11-02T12:00:00.000Z'),
        clients: (credentials): InventoryClients => {
          received = credentials;
          return {
            iam: iamFake.client,
            s3: s3Fake.client,
            ec2: (region) => (ec2ByRegion.get(region) ?? ec2(region)).client,
          };
        },
      },
    );
    expect(received).not.toBeNull();
    expect(inventory).toMatchObject({
      accountId: ACCOUNT,
      collectedAt: '2026-11-02T12:00:00.000Z',
      regions: ['sa-east-1', 'us-east-1'],
      root: { mfaEnabled: false, accessKeysPresent: true },
      truncated: [],
      errors: [{ section: 'ec2:sa-east-1', code: 'UnauthorizedOperation' }],
    });
    expect(inventory.users).toHaveLength(2);
    expect(inventory.buckets).toHaveLength(3);
    expect(inventory.instances.map((instance) => instance.instanceId)).toEqual([
      'i-0aaa2000000000000',
      'i-0bbb0000000000000',
    ]);
    expect(inventory.securityGroups).toEqual([
      {
        groupId: 'sg-0aaa0000000000000',
        region: 'sa-east-1',
        name: 'web',
        vpcId: 'vpc-1',
        openToWorld: [
          { protocol: 'tcp', fromPort: 22, toPort: 22 },
          { protocol: 'tcp', fromPort: 443, toPort: 443 },
        ],
      },
      expect.objectContaining({ groupId: 'sg-0aaa0000000000000', region: 'us-east-1' }),
    ]);
    // Nada da credencial temporária no inventário que vai ser gravado.
    expect(JSON.stringify(inventory)).not.toContain(SECRET);
  });

  it('regiões informadas no cadastro dispensam a descoberta', async () => {
    const regional = ec2('sa-east-1');
    const inventory = await collectInventory(
      { accountId: ACCOUNT, externalId: EXTERNAL_ID, regions: ['sa-east-1'] },
      {
        sts: stsOk().client,
        clients: () => ({ iam: iam().client, s3: s3().client, ec2: () => regional.client }),
      },
    );
    expect(inventory.regions).toEqual(['sa-east-1']);
    expect(regional.calls.some((call) => call.command === 'DescribeRegionsCommand')).toBe(false);
  });

  it('sem conseguir assumir o papel, nada é coletado', async () => {
    const denied = fakeClient<STSClient>({
      AssumeRoleCommand: () => {
        throw awsError('AccessDenied');
      },
    });
    let factoryCalled = false;
    await expect(
      collectInventory(
        { accountId: ACCOUNT, externalId: EXTERNAL_ID },
        {
          sts: denied.client,
          clients: () => {
            factoryCalled = true;
            return { iam: iam().client, s3: s3().client, ec2: () => ec2('x').client };
          },
        },
      ),
    ).rejects.toThrow(InventoryError);
    expect(factoryCalled).toBe(false);
  });
});
