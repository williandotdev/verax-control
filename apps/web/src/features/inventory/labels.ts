import type { AssetKind, AssetRisk, OpenRule, RiskReason } from '@verax/shared';
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
