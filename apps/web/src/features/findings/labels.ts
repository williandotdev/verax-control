import type { FindingPeriod, FindingSource, FindingStatus } from '@verax/shared';
import { CircleCheck, CircleDot, type LucideIcon, Search, ShieldCheck } from 'lucide-react';

export const FINDING_STATUS_LABELS: Readonly<Record<FindingStatus, { label: string; icon: LucideIcon }>> = {
  new: { label: 'Novo', icon: CircleDot },
  investigating: { label: 'Em análise', icon: Search },
  legitimate: { label: 'Legítimo', icon: ShieldCheck },
  resolved: { label: 'Resolvido', icon: CircleCheck },
};

export const FINDING_SOURCE_LABELS: Readonly<Record<FindingSource, string>> = {
  cloudtrail: 'CloudTrail',
  guardduty: 'GuardDuty',
  waf: 'WAF',
  gcp_audit: 'GCP (auditoria)',
  cloudflare_audit: 'Cloudflare (auditoria)',
};

export const FINDING_PERIOD_LABELS: Readonly<Record<FindingPeriod, string>> = {
  '24h': 'Últimas 24 horas',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
};
