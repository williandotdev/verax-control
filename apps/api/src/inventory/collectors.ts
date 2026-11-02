import {
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DescribeSecurityGroupsCommand,
  type EC2Client,
  type IpPermission,
} from '@aws-sdk/client-ec2';
import {
  GetAccessKeyLastUsedCommand,
  GetAccountSummaryCommand,
  GetLoginProfileCommand,
  ListAccessKeysCommand,
  ListMFADevicesCommand,
  ListUsersCommand,
  NoSuchEntityException,
  type IAMClient,
} from '@aws-sdk/client-iam';
import {
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { awsErrorCode } from './read-only-session.js';

/**
 * Coleta do inventário de uma conta (T5.9), só com chamadas de leitura cobertas pelo papel VeraxControlReadOnly
 * (SecurityAudit + ViewOnlyAccess, T4.3). Os clientes chegam prontos, já com a credencial temporária da conta.
 *
 * Só sai o que a tela usa: nomes, IDs, datas e flags de configuração. Políticas, tags e conteúdo de recursos não são
 * lidos. Cada conta tem um teto de itens por tipo, para uma conta enorme não travar o job.
 */

export const MAX_ITEMS = 1000;
const CONCURRENCY = 4;

type Sender<T extends { send: unknown }> = Pick<T, 'send'>;

const iso = (date: Date | undefined): string | null => (date === undefined ? null : date.toISOString());

/** Executa `task` para cada item, no máximo `CONCURRENCY` de cada vez, mantendo a ordem. */
async function mapLimited<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

// --- IAM ---

export interface IamAccessKey {
  id: string;
  status: 'Active' | 'Inactive';
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface IamUser {
  userName: string;
  arn: string;
  createdAt: string | null;
  consoleAccess: boolean;
  mfaEnabled: boolean;
  accessKeys: IamAccessKey[];
}

export interface RootAccount {
  mfaEnabled: boolean;
  accessKeysPresent: boolean;
}

export async function collectRootAccount(iam: Sender<IAMClient>): Promise<RootAccount> {
  const { SummaryMap: summary = {} } = await iam.send(new GetAccountSummaryCommand({}));
  return {
    mfaEnabled: summary['AccountMFAEnabled'] === 1,
    accessKeysPresent: (summary['AccountAccessKeysPresent'] ?? 0) > 0,
  };
}

async function hasConsoleAccess(iam: Sender<IAMClient>, userName: string): Promise<boolean> {
  try {
    await iam.send(new GetLoginProfileCommand({ UserName: userName }));
    return true;
  } catch (error) {
    if (error instanceof NoSuchEntityException) return false;
    throw error;
  }
}

async function accessKeysOf(iam: Sender<IAMClient>, userName: string): Promise<IamAccessKey[]> {
  const { AccessKeyMetadata: keys = [] } = await iam.send(new ListAccessKeysCommand({ UserName: userName }));
  return mapLimited(
    keys.filter((key) => key.AccessKeyId !== undefined),
    async (key) => {
      const id = key.AccessKeyId ?? '';
      const used = await iam.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: id }));
      return {
        id,
        status: key.Status === 'Active' ? 'Active' : 'Inactive',
        createdAt: iso(key.CreateDate),
        lastUsedAt: iso(used.AccessKeyLastUsed?.LastUsedDate),
      };
    },
  );
}

export async function collectIamUsers(
  iam: Sender<IAMClient>,
): Promise<{ users: IamUser[]; truncated: boolean }> {
  const listed: { UserName: string; Arn: string; CreateDate?: Date }[] = [];
  let marker: string | undefined;
  let truncated = false;
  do {
    const page = await iam.send(new ListUsersCommand({ Marker: marker, MaxItems: 100 }));
    for (const user of page.Users ?? []) {
      if (user.UserName !== undefined && user.Arn !== undefined) {
        listed.push({ UserName: user.UserName, Arn: user.Arn, CreateDate: user.CreateDate });
      }
    }
    marker = page.IsTruncated === true ? page.Marker : undefined;
    if (listed.length >= MAX_ITEMS && marker !== undefined) truncated = true;
  } while (marker !== undefined && !truncated);

  const users = await mapLimited(listed.slice(0, MAX_ITEMS), async (user) => {
    const [consoleAccess, mfa, accessKeys] = await Promise.all([
      hasConsoleAccess(iam, user.UserName),
      iam.send(new ListMFADevicesCommand({ UserName: user.UserName })),
      accessKeysOf(iam, user.UserName),
    ]);
    return {
      userName: user.UserName,
      arn: user.Arn,
      createdAt: iso(user.CreateDate),
      consoleAccess,
      mfaEnabled: (mfa.MFADevices ?? []).length > 0,
      accessKeys,
    };
  });
  return { users, truncated: truncated || listed.length > MAX_ITEMS };
}

// --- EC2 e security groups ---

export interface Ec2Instance {
  instanceId: string;
  region: string;
  state: string | null;
  publicIp: string | null;
  /** IMDSv2 obrigatório (`HttpTokens: required`). */
  imdsV2Required: boolean;
  securityGroupIds: string[];
}

export interface OpenRule {
  /** `-1` é todo protocolo. */
  protocol: string;
  fromPort: number | null;
  toPort: number | null;
}

export interface SecurityGroupInfo {
  groupId: string;
  region: string;
  name: string | null;
  vpcId: string | null;
  /** Regras de entrada abertas para a internet inteira (0.0.0.0/0 ou ::/0). */
  openToWorld: OpenRule[];
}

export async function enabledRegions(ec2: Sender<EC2Client>): Promise<string[]> {
  const { Regions: regions = [] } = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
  return regions.flatMap((region) => (region.RegionName === undefined ? [] : [region.RegionName])).sort();
}

export async function collectInstances(
  ec2: Sender<EC2Client>,
  region: string,
): Promise<{ instances: Ec2Instance[]; truncated: boolean }> {
  const instances: Ec2Instance[] = [];
  let token: string | undefined;
  do {
    const page = await ec2.send(new DescribeInstancesCommand({ NextToken: token, MaxResults: 500 }));
    for (const instance of (page.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? [])) {
      if (instance.InstanceId === undefined) continue;
      instances.push({
        instanceId: instance.InstanceId,
        region,
        state: instance.State?.Name ?? null,
        publicIp: instance.PublicIpAddress ?? null,
        imdsV2Required: instance.MetadataOptions?.HttpTokens === 'required',
        securityGroupIds: (instance.SecurityGroups ?? []).flatMap((group) =>
          group.GroupId === undefined ? [] : [group.GroupId],
        ),
      });
    }
    token = page.NextToken;
  } while (token !== undefined && instances.length < MAX_ITEMS);
  return {
    instances: instances.slice(0, MAX_ITEMS),
    truncated: token !== undefined || instances.length > MAX_ITEMS,
  };
}

function openRules(permissions: readonly IpPermission[]): OpenRule[] {
  return permissions
    .filter(
      (permission) =>
        (permission.IpRanges ?? []).some((range) => range.CidrIp === '0.0.0.0/0') ||
        (permission.Ipv6Ranges ?? []).some((range) => range.CidrIpv6 === '::/0'),
    )
    .map((permission) => ({
      protocol: permission.IpProtocol ?? '-1',
      fromPort: permission.FromPort ?? null,
      toPort: permission.ToPort ?? null,
    }));
}

export async function collectSecurityGroups(
  ec2: Sender<EC2Client>,
  region: string,
): Promise<{ groups: SecurityGroupInfo[]; truncated: boolean }> {
  const groups: SecurityGroupInfo[] = [];
  let token: string | undefined;
  do {
    const page = await ec2.send(new DescribeSecurityGroupsCommand({ NextToken: token, MaxResults: 1000 }));
    for (const group of page.SecurityGroups ?? []) {
      if (group.GroupId === undefined) continue;
      groups.push({
        groupId: group.GroupId,
        region,
        name: group.GroupName ?? null,
        vpcId: group.VpcId ?? null,
        openToWorld: openRules(group.IpPermissions ?? []),
      });
    }
    token = page.NextToken;
  } while (token !== undefined && groups.length < MAX_ITEMS);
  return { groups: groups.slice(0, MAX_ITEMS), truncated: token !== undefined || groups.length > MAX_ITEMS };
}

// --- S3 ---

export interface PublicAccessBlock {
  blockPublicAcls: boolean;
  ignorePublicAcls: boolean;
  blockPublicPolicy: boolean;
  restrictPublicBuckets: boolean;
}

export interface BucketInfo {
  name: string;
  region: string | null;
  /** Política que dá acesso público (`null`: não foi possível ler). */
  policyPublic: boolean | null;
  /** ACL que concede a todos ou a qualquer conta da AWS (`null`: não foi possível ler). */
  aclPublic: boolean | null;
  /** Bloqueio de acesso público do bucket (`null`: não configurado ou ilegível; ver `unreadable`). */
  publicAccessBlock: PublicAccessBlock | null;
  /** Leituras recusadas, pelo código da AWS (ex.: `GetBucketAcl: AccessDenied`). */
  unreadable: string[];
}

const PUBLIC_GRANTEES = new Set([
  'http://acs.amazonaws.com/groups/global/AllUsers',
  'http://acs.amazonaws.com/groups/global/AuthenticatedUsers',
]);

/** Lê uma configuração do bucket; "não existe" vira o valor padrão e outros erros vão para `unreadable`. */
async function readBucket<T>(
  operation: string,
  missingCode: string | null,
  missing: T,
  read: () => Promise<T>,
  unreadable: string[],
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    const code = awsErrorCode(error);
    if (code === missingCode) return missing;
    unreadable.push(`${operation}: ${code}`);
    return null;
  }
}

/** O cliente precisa de `followRegionRedirects`, porque os buckets ficam em regiões diferentes. */
export async function collectBuckets(
  s3: Sender<S3Client>,
): Promise<{ buckets: BucketInfo[]; truncated: boolean }> {
  const listed: { name: string; region: string | null }[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListBucketsCommand({ ContinuationToken: token, MaxBuckets: 1000 }));
    for (const bucket of page.Buckets ?? []) {
      if (bucket.Name !== undefined) listed.push({ name: bucket.Name, region: bucket.BucketRegion ?? null });
    }
    token = page.ContinuationToken;
  } while (token !== undefined && listed.length < MAX_ITEMS);

  const buckets = await mapLimited(listed.slice(0, MAX_ITEMS), async ({ name, region }) => {
    const unreadable: string[] = [];
    const [policyPublic, aclPublic, publicAccessBlock] = await Promise.all([
      readBucket(
        'GetBucketPolicyStatus',
        'NoSuchBucketPolicy',
        false,
        async () => {
          const status = await s3.send(new GetBucketPolicyStatusCommand({ Bucket: name }));
          return status.PolicyStatus?.IsPublic === true;
        },
        unreadable,
      ),
      readBucket(
        'GetBucketAcl',
        null,
        false,
        async () => {
          const acl = await s3.send(new GetBucketAclCommand({ Bucket: name }));
          return (acl.Grants ?? []).some((grant) => PUBLIC_GRANTEES.has(grant.Grantee?.URI ?? ''));
        },
        unreadable,
      ),
      readBucket<PublicAccessBlock | null>(
        'GetPublicAccessBlock',
        'NoSuchPublicAccessBlockConfiguration',
        null,
        async () => {
          const block = await s3.send(new GetPublicAccessBlockCommand({ Bucket: name }));
          const config = block.PublicAccessBlockConfiguration;
          return {
            blockPublicAcls: config?.BlockPublicAcls === true,
            ignorePublicAcls: config?.IgnorePublicAcls === true,
            blockPublicPolicy: config?.BlockPublicPolicy === true,
            restrictPublicBuckets: config?.RestrictPublicBuckets === true,
          };
        },
        unreadable,
      ),
    ]);
    return { name, region, policyPublic, aclPublic, publicAccessBlock, unreadable };
  });
  return { buckets, truncated: token !== undefined || listed.length > MAX_ITEMS };
}
