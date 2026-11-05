import type { ReportKind, ReportPeriod } from '@verax/shared';

/** Nome em português de cada tática do MITRE ATT&CK, pelo nome em inglês que vem nos alertas. */
export const TACTIC_LABELS: Readonly<Record<string, string>> = {
  Reconnaissance: 'Reconhecimento',
  'Resource Development': 'Preparação de recursos',
  'Initial Access': 'Acesso inicial',
  Execution: 'Execução',
  Persistence: 'Persistência',
  'Privilege Escalation': 'Escalada de privilégio',
  'Defense Evasion': 'Evasão de defesas',
  'Credential Access': 'Acesso a credenciais',
  Discovery: 'Descoberta',
  'Lateral Movement': 'Movimento lateral',
  Collection: 'Coleta',
  'Command and Control': 'Comando e controle',
  Exfiltration: 'Exfiltração',
  Impact: 'Impacto',
};

export const PERIOD_LABELS: Readonly<Record<ReportPeriod, string>> = {
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
  '12m': 'Últimos 12 meses',
};

/** Abas do menu Relatórios: o caminho na URL (`?aba=`) e o título. */
export const REPORT_TABS: readonly { kind: ReportKind; slug: string; label: string }[] = [
  { kind: 'summary', slug: 'resumo', label: 'Resumo do período' },
  { kind: 'mitre', slug: 'mitre', label: 'MITRE ATT&CK' },
  { kind: 'rules', slug: 'deteccoes', label: 'Detecções' },
  { kind: 'entities', slug: 'entidades', label: 'Entidades' },
  { kind: 'incidents', slug: 'incidentes', label: 'Incidentes' },
  { kind: 'coverage', slug: 'cobertura', label: 'Cobertura das fontes' },
  { kind: 'exceptions', slug: 'excecoes', label: 'Exceções' },
];

/** Minutos em texto curto: "45 min", "3 h 20 min", "2 d 4 h". */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return '—';
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  if (hours < 24) return total % 60 === 0 ? `${hours} h` : `${hours} h ${total % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}
