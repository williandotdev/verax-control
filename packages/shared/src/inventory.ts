import { z } from 'zod';
import { awsAccountIdSchema, cloudAccountRefSchema } from './cloud-accounts.js';
import { withPagination } from './pagination.js';

/**
 * Inventário de ativos e identidades (T5.9): o que o papel de leitura lista em cada conta, com o risco de cada item.
 * As regras de risco estão em `apps/api/src/inventory/risk-rules.ts`; aqui fica só o formato.
 */

export const ASSET_RISKS = ['critical', 'high', 'medium', 'low', 'none'] as const;
export type AssetRisk = (typeof ASSET_RISKS)[number];

export const RISK_REASONS = [
  'root_without_mfa',
  'root_access_keys',
  'console_without_mfa',
  'old_access_key',
  'unused_access_key',
  'all_traffic_open',
  'admin_port_open',
  'database_port_open',
  'port_open',
  'web_port_open',
  'icmp_open',
  'public_ip_imdsv1',
  'imdsv1',
  'bucket_public',
  'bucket_without_public_block',
  'bucket_unreadable',
] as const;
export type RiskReason = (typeof RISK_REASONS)[number];

/** Tipos de ativo, também usados no caminho do endpoint (`/v1/assets/<tipo>`). */
export const ASSET_KINDS = ['users', 'keys', 'instances', 'buckets', 'security-groups'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

const assessed = {
  accountId: awsAccountIdSchema,
  risk: z.enum(ASSET_RISKS),
  reasons: z.array(z.enum(RISK_REASONS)).max(RISK_REASONS.length),
};
const text = (max = 2048) => z.string().max(max);

export const iamUserAssetSchema = z.strictObject({
  ...assessed,
  userName: text(128),
  arn: text(),
  createdAt: z.iso.datetime().nullable(),
  consoleAccess: z.boolean(),
  mfaEnabled: z.boolean(),
  activeKeys: z.number().int().min(0),
});
export type IamUserAsset = z.infer<typeof iamUserAssetSchema>;

export const accessKeyAssetSchema = z.strictObject({
  ...assessed,
  id: z.string().regex(/^[A-Z0-9]{16,128}$/),
  userName: text(128),
  status: z.enum(['Active', 'Inactive']),
  createdAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type AccessKeyAsset = z.infer<typeof accessKeyAssetSchema>;

export const instanceAssetSchema = z.strictObject({
  ...assessed,
  instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/),
  region: text(40),
  state: text(40).nullable(),
  publicIp: z.ipv4().nullable(),
  imdsV2Required: z.boolean(),
  securityGroupIds: z.array(text(64)).max(50),
});
export type InstanceAsset = z.infer<typeof instanceAssetSchema>;

export const bucketAssetSchema = z.strictObject({
  ...assessed,
  name: text(63),
  region: text(40).nullable(),
  /** Política ou ACL que libera acesso público; null quando não deu para ler. */
  policyPublic: z.boolean().nullable(),
  aclPublic: z.boolean().nullable(),
  /** As quatro travas do bloqueio de acesso público ligadas. */
  publicAccessBlocked: z.boolean().nullable(),
});
export type BucketAsset = z.infer<typeof bucketAssetSchema>;

export const openRuleSchema = z.strictObject({
  /** `-1` é todo protocolo. */
  protocol: text(16),
  fromPort: z.number().int().min(-1).max(65535).nullable(),
  toPort: z.number().int().min(-1).max(65535).nullable(),
});
export type OpenRule = z.infer<typeof openRuleSchema>;

export const securityGroupAssetSchema = z.strictObject({
  ...assessed,
  groupId: z.string().regex(/^sg-[0-9a-f]{8,17}$/),
  region: text(40),
  name: text(255).nullable(),
  vpcId: text(64).nullable(),
  /** Regras de entrada abertas para a internet inteira (0.0.0.0/0 ou ::/0). */
  openToWorld: z.array(openRuleSchema).max(200),
});
export type SecurityGroupAsset = z.infer<typeof securityGroupAssetSchema>;

export const assetSchemas = {
  users: iamUserAssetSchema,
  keys: accessKeyAssetSchema,
  instances: instanceAssetSchema,
  buckets: bucketAssetSchema,
  'security-groups': securityGroupAssetSchema,
} as const satisfies Record<AssetKind, z.ZodType>;

export const assetListQuerySchema = withPagination({
  accountId: cloudAccountRefSchema.optional(),
  /** `true`: só os itens com algum risco. */
  atRisk: z.enum(['true']).optional(),
});
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;

const kindCount = z.strictObject({ total: z.number().int().min(0), atRisk: z.number().int().min(0) });

/** Visão geral: a conta root de cada conta e quantos itens de cada tipo há, e quantos com risco. */
export const inventorySummarySchema = z.strictObject({
  accounts: z
    .array(
      z.strictObject({
        accountId: awsAccountIdSchema,
        collectedAt: z.iso.datetime().nullable(),
        root: z
          .strictObject({
            mfaEnabled: z.boolean(),
            accessKeysPresent: z.boolean(),
            risk: z.enum(ASSET_RISKS),
            reasons: z.array(z.enum(RISK_REASONS)),
          })
          .nullable(),
      }),
    )
    .max(200),
  counts: z.strictObject({
    users: kindCount,
    keys: kindCount,
    instances: kindCount,
    buckets: kindCount,
    'security-groups': kindCount,
  }),
});
export type InventorySummary = z.infer<typeof inventorySummarySchema>;
