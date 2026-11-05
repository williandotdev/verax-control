import {
  type AssetKind,
  type AssetRisk,
  type BucketAsset,
  INVENTORY_INVALID_ITEMS,
  type InventorySection,
  type InventorySectionError,
  type OpenRule,
  type RiskReason,
} from '@verax/shared';
import type { Severity } from '@/design/severity';

export const ASSET_KIND_LABELS: Readonly<Record<AssetKind, string>> = {
  users: 'Usuários IAM',
  keys: 'Chaves de acesso',
  instances: 'Instâncias EC2',
  buckets: 'Buckets S3',
  'security-groups': 'Security groups',
};

/** O risco do ativo na escala do painel; sem risco vira "Ok". */
export const RISK_SEVERITY: Readonly<Record<AssetRisk, Severity>> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  none: 'ok',
};

export const RISK_REASON_LABELS: Readonly<Record<RiskReason, string>> = {
  root_without_mfa: 'root sem MFA',
  root_access_keys: 'root com chave de acesso',
  console_without_mfa: 'console sem MFA',
  old_access_key: 'chave com mais de 90 dias',
  unused_access_key: 'chave sem uso há mais de 90 dias',
  all_traffic_open: 'todo o tráfego aberto para a internet',
  admin_port_open: 'porta de administração (SSH ou RDP) aberta para a internet',
  database_port_open: 'porta de banco de dados aberta para a internet',
  port_open: 'porta aberta para a internet',
  web_port_open: 'porta web aberta para a internet',
  icmp_open: 'ICMP aberto para a internet',
  public_ip_imdsv1: 'IP público e IMDSv1 aceito',
  imdsv1: 'IMDSv1 aceito',
  bucket_public: 'bucket público',
  bucket_without_public_block: 'sem bloqueio de acesso público',
  bucket_unreadable: 'configuração não pôde ser lida',
};

/** "TCP 22", "TCP 1000–2000", "Todo o tráfego". */
export function describeRule(rule: OpenRule): string {
  if (rule.protocol === '-1') return 'Todo o tráfego';
  const protocol = rule.protocol.toUpperCase();
  if (rule.fromPort === null || rule.toPort === null || rule.fromPort < 0) return protocol;
  return rule.fromPort === rule.toPort
    ? `${protocol} ${rule.fromPort}`
    : `${protocol} ${rule.fromPort}–${rule.toPort}`;
}

/** Público por política ou por ACL; desconhecido só quando nenhum dos dois pôde ser lido. */
export function bucketPublic(bucket: Pick<BucketAsset, 'policyPublic' | 'aclPublic'>): boolean | null {
  if (bucket.policyPublic === true || bucket.aclPublic === true) return true;
  if (bucket.policyPublic === null && bucket.aclPublic === null) return null;
  return false;
}

/** As partes da coleta do inventário, como a faixa de coleta parcial as nomeia. */
export const INVENTORY_SECTION_LABELS: Readonly<Record<InventorySection, string>> = {
  root: 'Conta root',
  iam: 'Usuários IAM e chaves de acesso',
  s3: 'Buckets S3',
  ec2: 'Instâncias EC2',
  sg: 'Security groups',
};

/** Permissão negada pela política do papel ou por uma SCP da organização. */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'UnauthorizedAccess',
  'AllAccessDisabled',
  'Blocked',
]);

/** A região não aceitou a sessão: desligada na conta ou fora do opt-in. */
const REGION_CODES: ReadonlySet<string> = new Set([
  'AuthFailure',
  'OptInRequired',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
]);

/**
 * Uma leitura que não entrou (do inventário ou da postura), em português: "Instâncias EC2 em us-east-1: a AWS recusou
 * a leitura (UnauthorizedOperation)". O código da AWS vai junto, para quem confere a política ou a SCP.
 */
export function describeReadError(label: string, region: string | null, code: string): string {
  const where = region === null ? label : `${label} em ${region}`;
  if (code === INVENTORY_INVALID_ITEMS) return `${where}: itens fora do formato esperado ficaram de fora`;
  if (REFUSED_CODES.has(code)) return `${where}: a AWS recusou a leitura (${code})`;
  if (REGION_CODES.has(code)) {
    return `${where}: a região não aceitou a sessão, desligada ou fora do opt-in (${code})`;
  }
  return `${where}: a leitura falhou (${code})`;
}

/** Uma parte que ficou de fora do inventário, em português (ver `describeReadError`). */
export function describeSectionError(error: InventorySectionError): string {
  return describeReadError(INVENTORY_SECTION_LABELS[error.section], error.region, error.code);
}

/** O teto de itens por tipo do inventário (o mesmo da coleta). */
export const INVENTORY_ITEM_CAP = 1000;
