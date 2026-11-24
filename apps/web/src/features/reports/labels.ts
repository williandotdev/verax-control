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

/**
 * O nome de cada tática no gráfico em tela estreita, já em linhas curtas (o nome inteiro está na dica, na lista e na
 * tabela).
 */
export const TACTIC_SHORT_LINES: Readonly<Record<string, readonly string[]>> = {
  Reconnaissance: ['Reconhec.'],
  'Resource Development': ['Preparação', 'de recursos'],
  'Initial Access': ['Acesso', 'inicial'],
  Execution: ['Execução'],
  Persistence: ['Persis-', 'tência'],
  'Privilege Escalation': ['Escalada', 'de privil.'],
  'Defense Evasion': ['Evasão de', 'defesas'],
  'Credential Access': ['Acesso a', 'credenciais'],
  Discovery: ['Descoberta'],
  'Lateral Movement': ['Movimento', 'lateral'],
  Collection: ['Coleta'],
  'Command and Control': ['Comando', 'e contr.'],
  Exfiltration: ['Exfil-', 'tração'],
  Impact: ['Impacto'],
};

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
