import { z } from 'zod';
import { awsAccountIdSchema, cloudAccountRefSchema, isAwsRegion } from './cloud-accounts.js';
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

/** A conta root de uma conta, com o risco: gravada no retrato e devolvida na visão geral. */
export const inventoryRootSchema = z.strictObject({
  mfaEnabled: z.boolean(),
  accessKeysPresent: z.boolean(),
  risk: z.enum(ASSET_RISKS),
  reasons: z.array(z.enum(RISK_REASONS)).max(RISK_REASONS.length),
});
export type InventoryRoot = z.infer<typeof inventoryRootSchema>;

/**
 * As partes da coleta do inventário (fase 2, PR-14'), cada uma lida (ou recusada) por inteiro: a conta root, o IAM
 * (usuários e chaves), o S3 e, em cada região monitorada, as instâncias do EC2 e os security groups.
 */
export const INVENTORY_SECTIONS = ['root', 'iam', 's3', 'ec2', 'sg'] as const;
export type InventorySection = (typeof INVENTORY_SECTIONS)[number];

/** O código de uma parte em que itens vieram fora do formato do contrato e ficaram de fora do retrato. */
export const INVENTORY_INVALID_ITEMS = 'invalid_items';

/** Até onde vai a lista de partes com erro de um retrato: 3 globais e 2 por região (até 40), com folga. */
export const MAX_INVENTORY_ERRORS = 100;

/** O código do erro de uma parte: o nome do erro da AWS (`AccessDenied`, `UnauthorizedOperation`), sem mensagem. */
export function isInventoryErrorCode(value: string): boolean {
  return /^[A-Za-z0-9._]{1,64}$/.test(value);
}

/**
 * Uma parte que não entrou inteira no retrato: recusada pela AWS (permissão, SCP, região desligada) ou com itens fora
 * do formato (`invalid_items`). A coleta continua nas outras partes, e o retrato fica marcado como parcial.
 */
export const inventorySectionErrorSchema = z.strictObject({
  section: z.enum(INVENTORY_SECTIONS),
  /** A região das partes regionais (`ec2`, `sg`); null nas globais e num item sem região válida. */
  region: z.string().max(32).refine(isAwsRegion, { error: 'região AWS inválida' }).nullable(),
  code: z.string().refine(isInventoryErrorCode, { error: 'código fora do formato' }),
});
export type InventorySectionError = z.infer<typeof inventorySectionErrorSchema>;

/** O que vai para `InventorySnapshot.errors`: `parte:código` ou, com região, `parte:região:código`. */
export function inventoryErrorValue(error: InventorySectionError): string {
  return error.region === null
    ? `${error.section}:${error.code}`
    : `${error.section}:${error.region}:${error.code}`;
}

/** A parte, a região e o código de um valor de `InventorySnapshot.errors`; null para um valor fora do formato. */
export function parseInventoryError(value: string): InventorySectionError | null {
  if (value.length > 128) return null;
  const parts = value.split(':');
  const candidate =
    parts.length === 2
      ? { section: parts[0], region: null, code: parts[1] }
      : parts.length === 3
        ? { section: parts[0], region: parts[1], code: parts[2] }
        : null;
  const parsed = inventorySectionErrorSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const kindCount = z.strictObject({ total: z.number().int().min(0), atRisk: z.number().int().min(0) });

/**
 * Visão geral: a conta root de cada conta e quantos itens de cada tipo há, e quantos com risco. Cada conta traz o
 * horário do retrato mais recente e se ele é parcial: as partes que não entraram (`errors`) e se alguma passou do teto
 * de itens por tipo (`truncated`). Sem retrato, `collectedAt` e `root` vêm nulos, sem erro.
 */
export const inventorySummarySchema = z.strictObject({
  accounts: z
    .array(
      z.strictObject({
        accountId: awsAccountIdSchema,
        collectedAt: z.iso.datetime().nullable(),
        root: inventoryRootSchema.nullable(),
        errors: z.array(inventorySectionErrorSchema).max(MAX_INVENTORY_ERRORS),
        truncated: z.boolean(),
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
