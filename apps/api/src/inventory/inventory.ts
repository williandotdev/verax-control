import { EC2Client } from '@aws-sdk/client-ec2';
import { IAMClient } from '@aws-sdk/client-iam';
import { S3Client } from '@aws-sdk/client-s3';
import type { STSClient } from '@aws-sdk/client-sts';
import {
  collectBuckets,
  collectIamUsers,
  collectInstances,
  collectRootAccount,
  collectSecurityGroups,
  enabledRegions,
  type BucketInfo,
  type Ec2Instance,
  type IamUser,
  type RootAccount,
  type SecurityGroupInfo,
} from './collectors.js';
import { assumeReadOnlyRole, awsErrorCode, type TemporaryCredentials } from './read-only-session.js';

/**
 * Inventário de uma conta (T5.9): assume o papel de leitura por 15 minutos e coleta identidades, chaves, instâncias,
 * security groups e buckets. Uma parte que falha (permissão, região desligada) não derruba as outras: fica em
 * `errors`, com o código da AWS, e o resto é gravado.
 */

type Sender<T extends { send: unknown }> = Pick<T, 'send'>;

export interface InventoryClients {
  iam: Sender<IAMClient>;
  s3: Sender<S3Client>;
  ec2: (region: string) => Sender<EC2Client>;
}

export type InventoryClientFactory = (credentials: TemporaryCredentials) => InventoryClients;

/** Região de partida para chamadas globais (IAM) e para descobrir as regiões habilitadas. */
const HOME_REGION = 'us-east-1';

export const awsInventoryClients: InventoryClientFactory = (credentials) => ({
  iam: new IAMClient({ region: HOME_REGION, credentials: credentials.identity() }),
  s3: new S3Client({ region: HOME_REGION, credentials: credentials.identity(), followRegionRedirects: true }),
  ec2: (region) => new EC2Client({ region, credentials: credentials.identity() }),
});

export interface AccountInventory {
  accountId: string;
  collectedAt: string;
  regions: string[];
  root: RootAccount | null;
  users: IamUser[];
  instances: Ec2Instance[];
  securityGroups: SecurityGroupInfo[];
  buckets: BucketInfo[];
  /** Partes que passaram do teto de itens. */
  truncated: string[];
  /** Partes que falharam, com o código da AWS. */
  errors: { section: string; code: string }[];
}

export async function collectInventory(
  target: { accountId: string; externalId: string; regions?: readonly string[] },
  deps: { sts: Sender<STSClient>; clients?: InventoryClientFactory; now?: () => Date },
): Promise<AccountInventory> {
  const credentials = await assumeReadOnlyRole(target, deps.sts);
  const clients = (deps.clients ?? awsInventoryClients)(credentials);
  const inventory: AccountInventory = {
    accountId: target.accountId,
    collectedAt: (deps.now ?? (() => new Date()))().toISOString(),
    regions: [],
    root: null,
    users: [],
    instances: [],
    securityGroups: [],
    buckets: [],
    truncated: [],
    errors: [],
  };

  async function section<T>(name: string, collect: () => Promise<T>): Promise<T | null> {
    try {
      return await collect();
    } catch (error) {
      inventory.errors.push({ section: name, code: awsErrorCode(error) });
      return null;
    }
  }

  inventory.root = await section('root', () => collectRootAccount(clients.iam));
  const iam = await section('iam', () => collectIamUsers(clients.iam));
  if (iam !== null) {
    inventory.users = iam.users;
    if (iam.truncated) inventory.truncated.push('iam');
  }
  const s3 = await section('s3', () => collectBuckets(clients.s3));
  if (s3 !== null) {
    inventory.buckets = s3.buckets;
    if (s3.truncated) inventory.truncated.push('s3');
  }

  inventory.regions = [
    ...(target.regions ?? (await section('regions', () => enabledRegions(clients.ec2(HOME_REGION)))) ?? []),
  ];
  for (const region of inventory.regions) {
    const ec2 = clients.ec2(region);
    const instances = await section(`ec2:${region}`, () => collectInstances(ec2, region));
    if (instances !== null) {
      inventory.instances.push(...instances.instances);
      if (instances.truncated) inventory.truncated.push(`ec2:${region}`);
    }
    const groups = await section(`sg:${region}`, () => collectSecurityGroups(ec2, region));
    if (groups !== null) {
      inventory.securityGroups.push(...groups.groups);
      if (groups.truncated) inventory.truncated.push(`sg:${region}`);
    }
  }
  return inventory;
}
