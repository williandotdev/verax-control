import { DATABASE_PORTS } from '@verax/shared';
import type {
  BucketInfo,
  Ec2Instance,
  IamAccessKey,
  IamUser,
  OpenRule,
  RootAccount,
  SecurityGroupInfo,
} from './collectors.js';

/**
 * Risco de cada ativo do inventário (T5.9). Regras v1, explícitas e testadas; cada uma deixa um motivo para a tela
 * explicar o risco.
 */

export type AssetRisk = 'critical' | 'high' | 'medium' | 'low' | 'none';

export type RiskReason =
  | 'root_without_mfa'
  | 'root_access_keys'
  | 'console_without_mfa'
  | 'old_access_key'
  | 'unused_access_key'
  | 'all_traffic_open'
  | 'admin_port_open'
  | 'database_port_open'
  | 'port_open'
  | 'web_port_open'
  | 'icmp_open'
  | 'public_ip_imdsv1'
  | 'imdsv1'
  | 'bucket_public'
  | 'bucket_without_public_block'
  | 'bucket_unreadable';

export interface AssessedRisk {
  risk: AssetRisk;
  reasons: RiskReason[];
}

const ORDER: readonly AssetRisk[] = ['none', 'low', 'medium', 'high', 'critical'];
const DAY = 24 * 60 * 60 * 1000;

/** Chaves de acesso: idade máxima e tempo sem uso antes de virar risco. */
export const KEY_MAX_AGE_DAYS = 90;
export const KEY_UNUSED_DAYS = 90;

const ADMIN_PORTS = [22, 3389];
const WEB_PORTS = [80, 443];
const ICMP = new Set(['icmp', '1', 'icmpv6', '58']);

function assess(found: readonly (readonly [AssetRisk, RiskReason])[]): AssessedRisk {
  const risk = found.reduce<AssetRisk>(
    (highest, [level]) => (ORDER.indexOf(level) > ORDER.indexOf(highest) ? level : highest),
    'none',
  );
  return { risk, reasons: [...new Set(found.map(([, reason]) => reason))] };
}

export function rootRisk(root: RootAccount): AssessedRisk {
  return assess([
    ...(root.mfaEnabled ? [] : ([['critical', 'root_without_mfa']] as const)),
    ...(root.accessKeysPresent ? ([['critical', 'root_access_keys']] as const) : []),
  ]);
}

/** Os riscos de uma chave de acesso: só a ativa conta. */
function accessKeyFindings(key: IamAccessKey, now: Date): [AssetRisk, RiskReason][] {
  if (key.status !== 'Active') return [];
  const found: [AssetRisk, RiskReason][] = [];
  const created = key.createdAt === null ? null : Date.parse(key.createdAt);
  if (created !== null && now.getTime() - created > KEY_MAX_AGE_DAYS * DAY)
    found.push(['medium', 'old_access_key']);
  // Chave nova que ainda não foi usada não é "parada": conta a partir da criação.
  const reference = key.lastUsedAt ?? key.createdAt;
  if (reference !== null && now.getTime() - Date.parse(reference) > KEY_UNUSED_DAYS * DAY) {
    found.push(['low', 'unused_access_key']);
  }
  return found;
}

/** O risco de uma chave de acesso na aba Chaves: a idade e o tempo sem uso, as mesmas regras do usuário dela. */
export function accessKeyRisk(key: IamAccessKey, now: Date): AssessedRisk {
  return assess(accessKeyFindings(key, now));
}

export function iamUserRisk(user: IamUser, now: Date): AssessedRisk {
  const found: [AssetRisk, RiskReason][] = [];
  if (user.consoleAccess && !user.mfaEnabled) found.push(['high', 'console_without_mfa']);
  for (const key of user.accessKeys) found.push(...accessKeyFindings(key, now));
  return assess(found);
}

function includesPort(rule: OpenRule, port: number): boolean {
  if (rule.fromPort === null || rule.toPort === null) return true;
  return rule.fromPort <= port && port <= rule.toPort;
}

function openRuleRisk(rule: OpenRule): readonly [AssetRisk, RiskReason] {
  if (rule.protocol === '-1') return ['critical', 'all_traffic_open'];
  if (ICMP.has(rule.protocol)) return ['low', 'icmp_open'];
  if (ADMIN_PORTS.some((port) => includesPort(rule, port))) return ['critical', 'admin_port_open'];
  if (DATABASE_PORTS.some((port) => includesPort(rule, port))) return ['high', 'database_port_open'];
  const onlyWeb =
    rule.fromPort !== null &&
    rule.toPort !== null &&
    WEB_PORTS.includes(rule.fromPort) &&
    rule.fromPort === rule.toPort;
  return onlyWeb ? ['low', 'web_port_open'] : ['medium', 'port_open'];
}

export function securityGroupRisk(group: SecurityGroupInfo): AssessedRisk {
  return assess(group.openToWorld.map(openRuleRisk));
}

export function instanceRisk(instance: Ec2Instance): AssessedRisk {
  if (instance.state === 'terminated' || instance.imdsV2Required) return assess([]);
  return assess([instance.publicIp === null ? ['low', 'imdsv1'] : ['medium', 'public_ip_imdsv1']]);
}

/**
 * Bucket público: política pública que o bloqueio do bucket não restringe, ou ACL pública que ele não ignora. Fica
 * "alto", e não "crítico", porque o bloqueio no nível da conta não entra no retrato; a postura nativa (PR-15', a
 * checagem `s3_bucket_public_access`) junta os dois.
 */
export function bucketRisk(bucket: BucketInfo): AssessedRisk {
  const block = bucket.publicAccessBlock;
  const found: [AssetRisk, RiskReason][] = [];
  const publicByPolicy = bucket.policyPublic === true && block?.restrictPublicBuckets !== true;
  const publicByAcl = bucket.aclPublic === true && block?.ignorePublicAcls !== true;
  if (publicByPolicy || publicByAcl) found.push(['high', 'bucket_public']);
  const blockUnreadable = bucket.unreadable.some((entry) => entry.startsWith('GetPublicAccessBlock:'));
  if (block === null && !blockUnreadable) found.push(['low', 'bucket_without_public_block']);
  if (bucket.unreadable.length > 0) found.push(['low', 'bucket_unreadable']);
  return assess(found);
}
