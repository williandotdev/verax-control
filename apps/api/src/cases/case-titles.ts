import { FINDING_SOURCES, type FindingSource } from '@verax/shared';
import { AWS_RULE_TITLES } from '../alerts/aws-rule-titles.js';
import { AWS_FINDING_RULES } from '../aws/findings/finding-rules.js';
import { CLOUDFLARE_RULES } from '../cloudflare/cloudflare-rules.js';
import { CLOUDFLARE_SECURITY_RULES } from '../cloudflare/cloudflare-security-rules.js';
import { GCP_RULES } from '../gcp/gcp-rules.js';
import { WEB_RULES } from '../weblogs/rules.js';
import { type CaseFamily, type CaseFold, type CaseKeyPart, RULE_PART } from './case-key.js';

/**
 * O título de um caso: sempre deste dicionário, em português. Nunca leva texto do evento: o título do alerta, o usuário,
 * o recurso e o tipo ficam nas partes da chave e nas amostras, que a tela mostra como dado.
 */
const FAMILY_TITLES: Readonly<Record<CaseFamily, string>> = {
  cloudtrail: 'Atividade suspeita na conta da AWS',
  'console-login': 'Falhas de login no console da AWS',
  guardduty: 'Ameaça acusada pelo GuardDuty',
  waf: 'Ataques web acusados pelo WAF',
  web: 'Ataque web visto nos logs do balanceador',
  'web-login': 'Ataque ao login da aplicação',
  'vpc-flow': 'Tráfego de rede suspeito',
  'cloudwatch-logs': 'Alertas nos logs das aplicações',
  'gcp-audit': 'Atividade suspeita no projeto da GCP',
  'cloudflare-audit': 'Mudança sensível na conta do Cloudflare',
  host: 'Atividade suspeita numa instância',
  'host-login': 'Falhas de login numa instância',
  'security-hub-finding': 'Ameaça acusada pelo Security Hub',
  package: 'Vulnerabilidade em pacote',
  code: 'Vulnerabilidade no código',
  control: 'Controle de segurança reprovado',
  'network-exposure': 'Porta alcançável de fora da rede',
  'access-analyzer': 'Acesso externo a recurso',
  'security-hub-check': 'Verificação do Security Hub reprovada',
  'host-configuration': 'Configuração insegura numa instância',
  other: 'Alerta de uma fonte não reconhecida',
};

const SOURCE_TITLES: Readonly<Record<FindingSource, string>> = {
  cloudtrail: 'CloudTrail',
  guardduty: 'GuardDuty',
  waf: 'WAF da AWS',
  security_hub: 'Security Hub',
  inspector: 'Inspector',
  access_analyzer: 'Access Analyzer',
  vpc_flow: 'logs de fluxo da VPC',
  cloudwatch_logs: 'logs do CloudWatch',
  gcp_audit: 'auditoria da GCP',
  cloudflare_audit: 'auditoria do Cloudflare',
  cloudflare_waf: 'WAF do Cloudflare',
  wazuh_agent: 'instâncias',
  alb: 'logs do balanceador da AWS',
};

const titlesOf = (rules: readonly { id: string; title: string }[]): ReadonlyMap<string, string> =>
  new Map(rules.map((rule) => [rule.id, rule.title]));

/** As regras com título fixo do projeto, por família: o número de regra de outra fonte (a do agente) não vale aqui. */
const RULE_TITLES: Readonly<Partial<Record<CaseFamily, ReadonlyMap<string, string>>>> = {
  cloudtrail: AWS_RULE_TITLES,
  waf: new Map([...AWS_RULE_TITLES, ...titlesOf(CLOUDFLARE_SECURITY_RULES)]),
  web: new Map(Object.entries(WEB_RULES).map(([id, rule]) => [id, rule.title])),
  'vpc-flow': AWS_RULE_TITLES,
  'gcp-audit': titlesOf(GCP_RULES),
  'cloudflare-audit': titlesOf(CLOUDFLARE_RULES),
  'access-analyzer': titlesOf(Object.values(AWS_FINDING_RULES)),
};

const FOLD_SUFFIX: Readonly<Record<Exclude<CaseFold, 'rollup'>, string>> = {
  distributed: ' (muitas redes de origem)',
  overflow: ' (críticos além do limite diário de casos)',
};

/** O tamanho da coluna `AlertCase.title`. */
export const CASE_TITLE_MAX = 200;

/**
 * O título do caso de uma chave. Se a regra é parte da chave (todo alerta do caso é dela) e tem título fixo, vale o dela;
 * senão, o da família.
 */
export function caseTitle(
  key: { family: CaseFamily; parts: readonly CaseKeyPart[] },
  ruleId: string,
): string {
  const byRule = key.parts.some((part) => part.name === RULE_PART);
  const title = byRule ? RULE_TITLES[key.family]?.get(ruleId) : undefined;
  return (title ?? FAMILY_TITLES[key.family]).slice(0, CASE_TITLE_MAX);
}

/** O título do caso que reúne várias chaves: o da família (o da regra fala de uma origem só) ou o da fonte. */
export function foldedCaseTitle(fold: CaseFold, family: CaseFamily, logSource: string): string {
  if (fold !== 'rollup') return `${FAMILY_TITLES[family]}${FOLD_SUFFIX[fold]}`;
  const source = isKnownSource(logSource) ? SOURCE_TITLES[logSource] : 'outras fontes';
  return `Alertas médios e baixos reunidos: ${source}`;
}

function isKnownSource(source: string): source is FindingSource {
  return (FINDING_SOURCES as readonly string[]).includes(source);
}
