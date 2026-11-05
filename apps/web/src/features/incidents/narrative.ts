import {
  agentIdOfRef,
  type CorrelationKind,
  type Finding,
  type Incident,
  type IncidentDetail,
} from '@verax/shared';
import { SEVERITY_STYLES } from '@/design/severity';
import { formatList, plural } from '@/lib/format';

/**
 * Texto em português do incidente (T7.9, pendência 8): montado por modelo a partir dos dados, sem LLM. O dicionário
 * cobre as ações da AWS mais comuns nas regras do Wazuh; o que não estiver nele usa o título do achado.
 */

type Keys = Partial<Record<CorrelationKind, string[]>>;

export function parseKeys(keys: readonly string[]): Keys {
  const parsed: Keys = {};
  for (const key of keys) {
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator) as CorrelationKind;
    (parsed[kind] ??= []).push(key.slice(separator + 1));
  }
  return parsed;
}

/** Título curto: pelo elo mais forte do agrupamento (chave, usuário, IP e, por fim, recurso). */
export function incidentTitle(incident: Pick<Incident, 'keys'>): string {
  const keys = parseKeys(incident.keys);
  const [key] = keys.key ?? [];
  const [user] = keys.user ?? [];
  const [ip] = keys.ip ?? [];
  const [resource] = keys.resource ?? [];
  if (key) return `Atividade suspeita com a chave de acesso ${key}`;
  if (user)
    return user === 'root' ? 'Atividade suspeita do usuário root' : `Atividade suspeita do usuário ${user}`;
  if (ip) return `Ataque a partir do IP ${ip}`;
  return `Atividade suspeita no recurso ${resource ?? 'desconhecido'}`;
}

/** O que cada evento da AWS significa, no passado. */
const ACTIONS: Readonly<Record<string, string>> = {
  ConsoleLogin: 'fez login no console',
  StopLogging: 'tentou desligar a trilha do CloudTrail',
  DeleteTrail: 'tentou apagar a trilha do CloudTrail',
  UpdateTrail: 'alterou a trilha do CloudTrail',
  CreateAccessKey: 'criou uma chave de acesso',
  CreateUser: 'criou um usuário IAM',
  AttachUserPolicy: 'anexou uma política a um usuário',
  AttachRolePolicy: 'anexou uma política a um papel',
  PutUserPolicy: 'gravou uma política num usuário',
  PutBucketPolicy: 'alterou a política de um bucket',
  DeletePublicAccessBlock: 'removeu o bloqueio de acesso público de um bucket',
  PutBucketAcl: 'alterou a lista de acesso de um bucket',
  AuthorizeSecurityGroupIngress: 'liberou uma porta num grupo de segurança',
  DeleteLogGroup: 'apagou um grupo de log',
  DeleteDetector: 'tentou desativar o GuardDuty',
  DisableSecurityHub: 'tentou desativar o Security Hub',
  ListBuckets: 'listou os buckets da conta',
  DescribeInstances: 'listou as instâncias',
  GetSecretValue: 'leu um segredo do Secrets Manager',
};

/**
 * Tipos do GuardDuty pelo prefixo (o resto do nome varia por recurso). Sempre na voz ativa, com quem age como
 * sujeito: na força bruta, quem age é o IP de origem, e a instância atacada vai no complemento.
 */
const GUARDDUTY: readonly [string, (resource: string | null) => string][] = [
  ['UnauthorizedAccess:IAMUser', () => 'usou credenciais da AWS de forma suspeita'],
  [
    'UnauthorizedAccess:EC2/SSHBruteForce',
    (resource) => `tentou força bruta no SSH${resource ? ` da instância ${resource}` : ''}`,
  ],
  [
    'UnauthorizedAccess:EC2/RDPBruteForce',
    (resource) => `tentou força bruta no RDP${resource ? ` da instância ${resource}` : ''}`,
  ],
  ['CryptoCurrency:', () => 'consultou domínios de mineração de criptomoeda'],
  ['Recon:', () => 'fez reconhecimento da conta'],
  ['Backdoor:', () => 'mostrou sinais de porta dos fundos'],
  ['Trojan:', () => 'mostrou sinais de software malicioso'],
];

export function describeFinding(
  finding: Pick<Finding, 'source' | 'eventName' | 'title' | 'resource'>,
): string {
  const event = finding.eventName ?? '';
  const known = ACTIONS[event];
  if (known) return known;
  if (finding.source === 'guardduty') {
    const match = GUARDDUTY.find(([prefix]) => event.startsWith(prefix));
    if (match) return match[1](finding.resource);
  }
  if (finding.source === 'waf') return 'teve requisições bloqueadas pelo WAF';
  return finding.title.charAt(0).toLowerCase() + finding.title.slice(1);
}

const time = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function subject(keys: Keys): string {
  const [key] = keys.key ?? [];
  const [user] = keys.user ?? [];
  const [ip] = keys.ip ?? [];
  const main = key
    ? `A chave de acesso ${key}`
    : user
      ? `O usuário ${user}`
      : ip
        ? `O IP ${ip}`
        : `O recurso ${(keys.resource ?? [])[0] ?? 'envolvido'}`;
  const details = [
    ...(key && user ? [`do usuário ${user}`] : []),
    ...(ip && (key || user) ? [`a partir do IP ${ip}`] : []),
  ];
  return details.length > 0 ? `${main}, ${details.join(', ')},` : main;
}

/**
 * Onde aconteceu: as contas e, nos alertas das instâncias do cliente, os agentes do Wazuh (origem `agent:<id>`), cada
 * grupo com o próprio artigo (`na conta 1111...`, `nos agentes 001 e 002`).
 */
export function originsPhrase(origins: readonly string[]): string {
  const accounts = origins.filter((origin) => agentIdOfRef(origin) === null);
  const agents = origins.map(agentIdOfRef).filter((agentId): agentId is string => agentId !== null);
  const parts: string[] = [];
  if (accounts.length === 1) parts.push(`na conta ${accounts[0]}`);
  if (accounts.length > 1) parts.push(`nas contas ${formatList(accounts)}`);
  if (agents.length === 1) parts.push(`no agente ${agents[0]}`);
  if (agents.length > 1) parts.push(`nos agentes ${formatList(agents)}`);
  return parts.join(' e ');
}

/** Resumo do incidente em português: quem, o que fez (na ordem), quando, onde e quão grave. */
export function incidentSummary(incident: IncidentDetail): string {
  const keys = parseKeys(incident.keys);
  const actions = [...new Set(incident.findings.map(describeFinding))];
  const accounts = originsPhrase(incident.accounts);
  const first = time.format(new Date(incident.firstSeenAt));
  const last = time.format(new Date(incident.lastSeenAt));
  const period = first === last ? `em ${first}` : `entre ${first} e ${last}`;
  return [
    `${subject(keys)} ${formatList(actions)}.`,
    `${plural(incident.findingCount, 'achado', 'achados')} ${period}, ${accounts}.`,
    `O mais grave é ${SEVERITY_STYLES[incident.severity].label.toLowerCase()}, e a nota de risco é ${incident.riskScore} de 100.`,
  ].join(' ');
}

/** O primeiro passo recomendado, pelo elo do agrupamento. */
export function incidentRecommendation(incident: Pick<Incident, 'keys'>): string {
  const keys = parseKeys(incident.keys);
  if (keys.key?.length) {
    return 'Desative a chave de acesso, crie outra para quem de fato a usa e revise tudo o que ela criou ou alterou no período.';
  }
  if (keys.user?.includes('root')) {
    return 'Confirme com o dono da conta se o acesso foi dele. Se não foi, troque a senha do root e revise o MFA.';
  }
  if (keys.user?.length) {
    return 'Confirme com o usuário se as ações foram dele. Se não foram, encerre as sessões, troque a senha e revise as permissões.';
  }
  if (keys.ip?.length) {
    return 'Bloqueie o IP no WAF ou no grupo de segurança e confira se alguma requisição passou.';
  }
  return 'Revise a configuração do recurso e desfaça o que não foi planejado.';
}
