import { agentIdOfRef, type FindingPeriod, type FindingSource, type FindingStatus } from '@verax/shared';
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
  wazuh_agent: 'Agente (instância)',
};

/**
 * De onde veio o achado, por extenso: `conta 111122223333` ou, nos alertas das instâncias do cliente, `agente 001`
 * (a origem `agent:<id>` do contrato).
 */
export function findingOriginLabel(origin: string): string {
  const agentId = agentIdOfRef(origin);
  return agentId === null ? `conta ${origin}` : `agente ${agentId}`;
}

/** A origem como identificador curto, sem a palavra: a conta como está, o agente como `agente 001`. */
export function findingOriginId(origin: string): string {
  const agentId = agentIdOfRef(origin);
  return agentId === null ? origin : `agente ${agentId}`;
}

export const FINDING_PERIOD_LABELS: Readonly<Record<FindingPeriod, string>> = {
  '24h': 'Últimas 24 horas',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
  '12m': 'Últimos 12 meses',
};
