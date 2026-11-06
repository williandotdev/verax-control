/**
 * Alertas de agentes do Wazuh (instâncias do cliente) como ficam no indexer, no formato do Wazuh 4.14: o agente em
 * `agent` (id e nome do registro, gravados pelo manager), o log decodificado em `data` e o próprio log em `full_log`.
 * Instâncias, IPs (faixas de documentação, RFC 5737) e usuários fictícios.
 */

let sequence = 0;

export interface AgentAlertOptions {
  /** Id do alerta; sem ele, um novo a cada chamada. */
  id?: string;
  agentId?: string;
  agentName?: string;
  /** Horário no formato do Wazuh (`+0000`). */
  timestamp?: string;
  rule?: { id: string; level: number; description: string; groups?: string[] };
  mitre?: { id: string[]; tactic: string[]; technique: string[] } | null;
  decoder?: string;
  /** Campos decodificados do log (`data`); `undefined` deixa o padrão da força bruta no SSH. */
  data?: Record<string, unknown>;
}

/** Força bruta no SSH de uma instância Linux (regra 5712 do Wazuh, nível 10). */
export function agentAlert(options: AgentAlertOptions = {}): Record<string, unknown> {
  sequence += 1;
  const agentName = options.agentName ?? 'web-01';
  return {
    id: options.id ?? `1793527300.${String(sequence).padStart(6, '0')}`,
    timestamp: options.timestamp ?? '2026-11-01T10:00:00.123+0000',
    rule: {
      firedtimes: 1,
      mail: false,
      frequency: 8,
      level: options.rule?.level ?? 10,
      description:
        options.rule?.description ??
        'sshd: brute force trying to get access to the system. Non existent user.',
      id: options.rule?.id ?? '5712',
      groups: options.rule?.groups ?? ['syslog', 'sshd', 'authentication_failures'],
      ...(options.mitre !== null && {
        mitre: options.mitre ?? { id: ['T1110'], tactic: ['Credential Access'], technique: ['Brute Force'] },
      }),
    },
    agent: { id: options.agentId ?? '001', name: agentName, ip: '10.0.0.5' },
    manager: { name: 'wazuh.manager' },
    predecoder: { program_name: 'sshd', timestamp: 'Nov  1 10:00:00', hostname: agentName },
    decoder: { parent: 'sshd', name: options.decoder ?? 'sshd' },
    location: '/var/log/auth.log',
    // Campos que a API nunca guarda: o log bruto e, nas correlações, os eventos anteriores.
    full_log: `Nov  1 10:00:00 ${agentName} sshd[1234]: Invalid user admin from 203.0.113.9 port 51234`,
    previous_output: 'eventos anteriores da correlação',
    data: options.data ?? { srcip: '203.0.113.9', srcport: '51234', srcuser: 'admin' },
  };
}

/** Arquivo monitorado alterado (FIM, regra 550, nível 7), sem IP nem usuário no log. */
export function fimAlert(options: AgentAlertOptions = {}): Record<string, unknown> {
  const alert = agentAlert({
    rule: {
      id: '550',
      level: 7,
      description: 'Integrity checksum changed.',
      groups: ['ossec', 'syscheck', 'syscheck_entry_modified', 'syscheck_file'],
    },
    mitre: { id: ['T1565.001'], tactic: ['Impact'], technique: ['Stored Data Manipulation'] },
    decoder: 'syscheck_integrity_changed',
    data: {},
    ...options,
  });
  const { data: _data, predecoder: _predecoder, ...rest } = alert;
  return {
    ...rest,
    location: 'syscheck',
    full_log: "File '/etc/sudoers' modified",
    syscheck: { path: '/etc/sudoers', event: 'modified', mode: 'scheduled', size_after: '755' },
  };
}
