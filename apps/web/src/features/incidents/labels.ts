import type { IncidentStatus } from '@verax/shared';
import { CircleCheck, CircleDot, type LucideIcon, Search } from 'lucide-react';

export const INCIDENT_STATUS_LABELS: Readonly<Record<IncidentStatus, { label: string; icon: LucideIcon }>> = {
  open: { label: 'Aberto', icon: CircleDot },
  investigating: { label: 'Em análise', icon: Search },
  resolved: { label: 'Resolvido', icon: CircleCheck },
};

/** Parâmetros da URL da lista (em português). */
export const INCIDENT_FILTER_PARAMS = {
  status: 'status',
  severity: 'severidade',
  unassigned: 'responsavel',
} as const;
