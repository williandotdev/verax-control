/**
 * As 14 táticas do MITRE ATT&CK (Enterprise), na ordem da cadeia de ataque. O nome é o que vem nos alertas. Ficam num
 * módulo à parte porque os filtros dos achados e os relatórios usam as duas (sem import circular).
 */
export const MITRE_TACTICS = [
  { id: 'TA0043', name: 'Reconnaissance' },
  { id: 'TA0042', name: 'Resource Development' },
  { id: 'TA0001', name: 'Initial Access' },
  { id: 'TA0002', name: 'Execution' },
  { id: 'TA0003', name: 'Persistence' },
  { id: 'TA0004', name: 'Privilege Escalation' },
  { id: 'TA0005', name: 'Defense Evasion' },
  { id: 'TA0006', name: 'Credential Access' },
  { id: 'TA0007', name: 'Discovery' },
  { id: 'TA0008', name: 'Lateral Movement' },
  { id: 'TA0009', name: 'Collection' },
  { id: 'TA0011', name: 'Command and Control' },
  { id: 'TA0010', name: 'Exfiltration' },
  { id: 'TA0040', name: 'Impact' },
] as const;

export type MitreTacticName = (typeof MITRE_TACTICS)[number]['name'];

/** Os nomes das táticas, na mesma ordem (o filtro por tática aceita só estes). */
export const MITRE_TACTIC_NAMES = MITRE_TACTICS.map((tactic) => tactic.name) as unknown as readonly [
  MitreTacticName,
  ...MitreTacticName[],
];

/** Técnica ou subtécnica do MITRE ATT&CK: `T1078` ou `T1078.004`. */
export const MITRE_TECHNIQUE_PATTERN = /^T\d{4}$|^T\d{4}\.\d{3}$/;
