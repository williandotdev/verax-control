import {
  ASSET_KINDS,
  type AssetKind,
  assetSchemas,
  INVENTORY_INVALID_ITEMS,
  type InventoryRoot,
  inventoryErrorValue,
  inventoryRootSchema,
  type InventorySection,
  type InventorySectionError,
  isAwsRegion,
  MAX_INVENTORY_ERRORS,
} from '@verax/shared';
import type { BucketInfo, IamUser } from './collectors.js';
import type { AccountInventory } from './inventory.js';
import {
  accessKeyRisk,
  bucketRisk,
  iamUserRisk,
  instanceRisk,
  rootRisk,
  securityGroupRisk,
} from './risk-rules.js';

/**
 * O retrato que vai para `InventorySnapshot` (fase 2, PR-14'): o `AccountInventory` da coleta no formato do contrato
 * compartilhado (`assetSchemas`, o mesmo que a API confere ao ler), com o risco de cada item pelas regras v1.
 *
 * Cada item passa pelo zod antes de entrar. Um item fora do formato (um ID que a AWS mudou, um campo grande demais) fica
 * de fora e é contado, sem derrubar o resto: a parte dele entra em `errors` com `invalid_items`, e o painel mostra a
 * coleta como parcial. Nada do que não está no contrato chega ao banco (o schema é estrito).
 */

export interface InventorySnapshotData {
  accountId: string;
  /** O início da coleta: com a conta e o cliente, a chave única do retrato (a gravação é idempotente). */
  collectedAt: Date;
  root: InventoryRoot | null;
  /** Os itens válidos de cada tipo, no formato do contrato. */
  items: Record<AssetKind, unknown[]>;
  /** As partes que não entraram inteiras, no formato gravado (`ec2:sa-east-1:UnauthorizedOperation`). */
  errors: string[];
  truncated: boolean;
  /** Itens recusados pelo contrato, por tipo (só para o relatório da tarefa; nenhum dado do item). */
  dropped: Record<AssetKind, number>;
}

/** A parte da coleta de onde vem cada tipo de ativo. */
const SECTION_OF: Readonly<Record<AssetKind, InventorySection>> = {
  users: 'iam',
  keys: 'iam',
  instances: 'ec2',
  buckets: 's3',
  'security-groups': 'sg',
};

const allFour = (bucket: BucketInfo): boolean | null => {
  const block = bucket.publicAccessBlock;
  if (block === null) {
    // Sem a configuração do bloqueio (o bucket não tem) é "não"; sem conseguir ler, "não lido".
    return bucket.unreadable.some((entry) => entry.startsWith('GetPublicAccessBlock:')) ? null : false;
  }
  return (
    block.blockPublicAcls && block.ignorePublicAcls && block.blockPublicPolicy && block.restrictPublicBuckets
  );
};

/** Os candidatos de cada tipo, antes do zod. */
function candidates(inventory: AccountInventory, now: Date): Record<AssetKind, unknown[]> {
  const accountId = inventory.accountId;
  const users = inventory.users.map((user: IamUser) => ({
    accountId,
    ...iamUserRisk(user, now),
    userName: user.userName,
    arn: user.arn,
    createdAt: user.createdAt,
    consoleAccess: user.consoleAccess,
    mfaEnabled: user.mfaEnabled,
    activeKeys: user.accessKeys.filter((key) => key.status === 'Active').length,
  }));
  const keys = inventory.users.flatMap((user) =>
    user.accessKeys.map((key) => ({
      accountId,
      ...accessKeyRisk(key, now),
      id: key.id,
      userName: user.userName,
      status: key.status,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
    })),
  );
  const instances = inventory.instances.map((instance) => ({
    accountId,
    ...instanceRisk(instance),
    instanceId: instance.instanceId,
    region: instance.region,
    state: instance.state,
    publicIp: instance.publicIp,
    imdsV2Required: instance.imdsV2Required,
    securityGroupIds: instance.securityGroupIds,
  }));
  const buckets = inventory.buckets.map((bucket) => ({
    accountId,
    ...bucketRisk(bucket),
    name: bucket.name,
    region: bucket.region,
    policyPublic: bucket.policyPublic,
    aclPublic: bucket.aclPublic,
    publicAccessBlocked: allFour(bucket),
  }));
  const groups = inventory.securityGroups.map((group) => ({
    accountId,
    ...securityGroupRisk(group),
    groupId: group.groupId,
    region: group.region,
    name: group.name,
    vpcId: group.vpcId,
    openToWorld: group.openToWorld,
  }));
  return { users, keys, instances, buckets, 'security-groups': groups };
}

/** A região de um item recusado, para o aviso da parte regional: só se for uma região válida. */
function regionOf(item: unknown): string | null {
  const region = (item as { region?: unknown } | null)?.region;
  return typeof region === 'string' && isAwsRegion(region) ? region : null;
}

export function toSnapshot(inventory: AccountInventory): InventorySnapshotData {
  const collectedAt = new Date(inventory.collectedAt);
  const raw = candidates(inventory, collectedAt);
  const errors: InventorySectionError[] = [...inventory.errors];
  const items = {} as Record<AssetKind, unknown[]>;
  const dropped = {} as Record<AssetKind, number>;
  for (const kind of ASSET_KINDS) {
    items[kind] = [];
    dropped[kind] = 0;
    for (const candidate of raw[kind]) {
      const parsed = assetSchemas[kind].safeParse(candidate);
      if (parsed.success) {
        items[kind].push(parsed.data);
        continue;
      }
      dropped[kind] += 1;
      const section = SECTION_OF[kind];
      const region = section === 'ec2' || section === 'sg' ? regionOf(candidate) : null;
      errors.push({ section, region, code: INVENTORY_INVALID_ITEMS });
    }
  }
  const root =
    inventory.root === null
      ? null
      : inventoryRootSchema.safeParse({ ...inventory.root, ...rootRisk(inventory.root) });
  if (root !== null && !root.success)
    errors.push({ section: 'root', region: null, code: INVENTORY_INVALID_ITEMS });
  return {
    accountId: inventory.accountId,
    collectedAt,
    root: root?.success === true ? root.data : null,
    items,
    errors: [...new Set(errors.map(inventoryErrorValue))].slice(0, MAX_INVENTORY_ERRORS),
    truncated: inventory.truncated.length > 0,
    dropped,
  };
}
