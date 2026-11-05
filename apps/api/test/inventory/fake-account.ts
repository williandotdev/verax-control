import type { EC2Client } from '@aws-sdk/client-ec2';
import { NoSuchEntityException, type IAMClient } from '@aws-sdk/client-iam';
import type { S3Client } from '@aws-sdk/client-s3';
import type { InventoryClientFactory, InventoryClients } from '../../src/inventory/inventory.js';
import { awsError, type FakeClient, fakeClient } from './fake-aws.js';

/**
 * Uma conta AWS fictícia para o inventário (`111122223333`), com os clientes falsos de `fake-aws.ts`: dois usuários IAM
 * em duas páginas (a `ana`, com console e sem MFA; o `bot`, só com uma chave), três buckets (um com política pública,
 * um com ACL pública e um com a ACL recusada) e, em cada região, uma instância com IMDSv1 e IP público, outra com
 * IMDSv2 na segunda página, e um security group com SSH aberto para a internet.
 */

export const ACCOUNT = '111122223333';

type Handlers = Record<string, (input: Record<string, unknown>) => unknown>;

export function fakeIam(overrides: Handlers = {}): FakeClient<IAMClient> {
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

export function fakeEc2(region: string, overrides: Handlers = {}): FakeClient<EC2Client> {
  return fakeClient<EC2Client>({
    DescribeInstancesCommand: (input) =>
      input['NextToken'] === undefined
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
                  {
                    InstanceId: `i-0bbb${region === 'sa-east-1' ? '1' : '2'}000000000000`,
                    MetadataOptions: { HttpTokens: 'required' },
                  },
                ],
              },
            ],
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
    ...overrides,
  });
}

export function fakeS3(overrides: Handlers = {}): FakeClient<S3Client> {
  return fakeClient<S3Client>({
    ListBucketsCommand: () => ({
      Buckets: [
        { Name: 'site-publico', BucketRegion: 'sa-east-1' },
        { Name: 'dados', BucketRegion: 'us-east-1' },
        { Name: 'restrito' },
      ],
    }),
    GetBucketPolicyStatusCommand: (input) => {
      if (input['Bucket'] === 'dados') throw awsError('NoSuchBucketPolicy', 404);
      return { PolicyStatus: { IsPublic: input['Bucket'] === 'site-publico' } };
    },
    GetBucketAclCommand: (input) => {
      if (input['Bucket'] === 'restrito') throw awsError('AccessDenied', 403);
      return {
        Grants:
          input['Bucket'] === 'dados'
            ? [{ Grantee: { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AllUsers' } }]
            : [],
      };
    },
    GetPublicAccessBlockCommand: (input) => {
      if (input['Bucket'] !== 'restrito') throw awsError('NoSuchPublicAccessBlockConfiguration', 404);
      return {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      };
    },
    ...overrides,
  });
}

/** Uma chamada de qualquer cliente da conta, com o serviço e a região dele. */
export interface AccountCall {
  service: 'iam' | 's3' | 'ec2';
  region: string | null;
  command: string;
  input: Record<string, unknown>;
}

export interface FakeAccountOptions {
  iam?: Handlers;
  s3?: Handlers;
  /** Os handlers do EC2 de cada região (os que faltarem são os da conta fictícia). */
  ec2?: Record<string, Handlers>;
}

/**
 * Os clientes da conta fictícia para `collectInventory` (com um S3 por região, que divide os handlers) e todas as
 * chamadas, na ordem, com o serviço e a região.
 */
export function fakeAccount(options: FakeAccountOptions = {}): {
  clients: InventoryClients;
  calls: () => AccountCall[];
} {
  const log: AccountCall[] = [];
  const record =
    <T extends { send: unknown }>(
      service: AccountCall['service'],
      region: string | null,
      fake: FakeClient<T>,
    ) =>
    (): Pick<T, 'send'> => {
      const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        log.push({ service, region, command: command.constructor.name, input: command.input });
        return (fake.client as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
      };
      return { send };
    };
  const iam = record('iam', null, fakeIam(options.iam));
  const s3ByRegion = new Map<string | null, () => Pick<S3Client, 'send'>>();
  const ec2ByRegion = new Map<string, () => Pick<EC2Client, 'send'>>();
  return {
    clients: {
      iam,
      s3: (region) => {
        let client = s3ByRegion.get(region);
        if (client === undefined) {
          client = record('s3', region, fakeS3(options.s3));
          s3ByRegion.set(region, client);
        }
        return client();
      },
      ec2: (region) => {
        let client = ec2ByRegion.get(region);
        if (client === undefined) {
          client = record('ec2', region, fakeEc2(region, options.ec2?.[region]));
          ec2ByRegion.set(region, client);
        }
        return client();
      },
    },
    calls: () => [...log],
  };
}

/**
 * A fábrica de clientes da tarefa com a conta fictícia: cada cliente com `destroy` contado e o segundo argumento do
 * `send` (o sinal) guardado. A região de partida vem da tarefa.
 */
export function fakeFactory(options: FakeAccountOptions = {}): {
  factory: InventoryClientFactory;
  calls: () => AccountCall[];
  destroyed: () => number;
  homeRegions: string[];
  signals: unknown[];
} {
  const account = fakeAccount(options);
  let destroyed = 0;
  const homeRegions: string[] = [];
  const signals: unknown[] = [];
  const withDestroy = <T extends { send: unknown }>(client: Pick<T, 'send'>) => ({
    send: ((command: unknown, sendOptions: unknown) => {
      signals.push(sendOptions);
      return (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
    }) as unknown as T['send'],
    destroy: () => {
      destroyed += 1;
    },
  });
  const factory: InventoryClientFactory = (_credentials, homeRegion) => {
    homeRegions.push(homeRegion);
    return {
      iam: () => withDestroy<IAMClient>(account.clients.iam()),
      s3: (region) => withDestroy<S3Client>(account.clients.s3(region)),
      ec2: (region) => withDestroy<EC2Client>(account.clients.ec2(region)),
    };
  };
  return { factory, calls: account.calls, destroyed: () => destroyed, homeRegions, signals };
}
