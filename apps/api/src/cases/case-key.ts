import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { AWS_FINDING_RULES } from '../aws/findings/finding-rules.js';
import type { CaseQueue } from '../generated/prisma/client.js';

/**
 * A chave de agrupamento de um alerta: que alertas formam o mesmo caso.
 *
 * Pura e versionada: só lê colunas gravadas do `Finding`, então o alerta que acabou de chegar e o histórico dão a mesma
 * chave. Mudar a chave de um alerta qualquer parte os casos abertos: só com outra versão (`CASE_KEY_VERSION`).
 *
 * `groupKey = sha256(JSON.stringify(["v1", fila, família, faixa, conta, [nome, valor], ...]))`. O array JSON escapa
 * cada valor: nenhum texto do evento passa para a parte vizinha. O cliente não entra: a unicidade é por cliente, no
 * banco (`AlertCase`, `@@unique([tenantId, openKey])`).
 *
 * **O que quem ataca escolhe não é parte da chave**, senão cada valor novo abriria um caso: o nome da sessão do papel
 * (vale o papel), o nome do usuário federado, o usuário digitado num login, o endereço exato (vale a rede pública). E o
 * que separa o grave do ruído é: a conta, a faixa de severidade e, quando existe, o alvo ou quem agiu. A única exceção é
 * o endereço privado, que fica exato (a rede interna do cliente não é rotativa).
 *
 * **Faixa** (`tier`), nas filas de detecção e de postura: `hc` (crítica e alta) usa as partes da tabela abaixo; `ml`
 * (média e baixa), só a família, a conta e a regra. Assim o ruído cabe em poucos casos e nunca engole um alerta grave. É
 * a severidade na primeira atribuição: o alerta que muda de severidade depois continua no caso dele. A fila de
 * vulnerabilidade não tem faixa (`any`).
 *
 * | Fonte                                     | Fila            | Partes (hc)                                        |
 * | ----------------------------------------- | --------------- | -------------------------------------------------- |
 * | `cloudtrail`                              | detecção        | regra + ator; sem ele, o recurso                   |
 * | `cloudtrail` 80254 e 80255                | detecção        | rede de origem                                     |
 * | `guardduty` e a cópia no Security Hub     | detecção        | tipo + recurso; sem ele, o ator. Nunca o IP remoto |
 * | `waf`, `cloudflare_waf`                   | detecção        | regra + ACL ou zona; nas regras por IP, + rede     |
 * | `vpc_flow`                                | detecção        | regra + rede                                       |
 * | `cloudwatch_logs`                         | detecção        | regra + rede; sem ela, o usuário                   |
 * | `gcp_audit`, `cloudflare_audit`           | detecção        | regra + ator; sem ele, o recurso                   |
 * | `wazuh_agent`                             | detecção        | regra + instância; nas regras de login, + rede     |
 * | `wazuh_agent` 23501 a 23508               | vulnerabilidade | pacote + instância                                 |
 * | `wazuh_agent` 19000 a 19015               | postura         | regra + instância                                  |
 * | `inspector` 990511 e a cópia do Inspector | vulnerabilidade | pacote (sem ele, o CVE) + recurso                  |
 * | `inspector` 990512                        | postura         | recurso                                            |
 * | `inspector` 990513                        | vulnerabilidade | recurso                                            |
 * | `security_hub` 990501                     | postura         | controle (ml: o serviço dele)                      |
 * | `security_hub` 990502                     | pelo tipo       | produto + tipo                                     |
 * | `access_analyzer`                         | postura         | 990521: regra + recurso; as outras, a regra        |
 * | qualquer outra coisa                      | detecção        | regra + recurso; sem ele, o ator                   |
 *
 * O desconhecido (fonte, regra ou tipo) vai sempre para a fila de detecção, a que avisa.
 */
export const CASE_KEY_VERSION = 1;

/** O tamanho da coluna `Finding.caseGroup`, em caracteres. */
export const CASE_GROUP_MAX = 128;

/** O quanto de cada parte é guardado para mostrar (`AlertCase.keyParts`), em caracteres. */
const PART_MAX = 256;

export const CASE_FAMILIES = [
  'cloudtrail',
  'console-login',
  'guardduty',
  'waf',
  'vpc-flow',
  'cloudwatch-logs',
  'gcp-audit',
  'cloudflare-audit',
  'host',
  'host-login',
  'security-hub-finding',
  'package',
  'code',
  'control',
  'network-exposure',
  'access-analyzer',
  'security-hub-check',
  'host-configuration',
  'other',
] as const;
export type CaseFamily = (typeof CASE_FAMILIES)[number];

/** `hc`: crítica e alta; `ml`: média e baixa; `any`: a fila não separa por severidade. */
export type CaseTier = 'hc' | 'ml' | 'any';

/** As colunas do `Finding` de que a chave sai. Os textos são os do banco, sem confiança nenhuma no conteúdo. */
export interface CaseKeyInput {
  accountId: string;
  logSource: string;
  severity: string;
  ruleId: string;
  title: string;
  eventName: string | null;
  resource: string | null;
  actorUser: string | null;
  sourceIp: string | null;
  caseGroup: string | null;
}

/** Uma parte da chave, cortada, para mostrar. O valor pode vir do evento: é texto, nunca HTML nem consulta. */
export interface CaseKeyPart {
  name: string;
  value: string;
}

export interface CaseKey {
  version: typeof CASE_KEY_VERSION;
  queue: CaseQueue;
  family: CaseFamily;
  tier: CaseTier;
  /** SHA-256 em hexadecimal minúsculo. */
  groupKey: string;
  parts: CaseKeyPart[];
  /** O subgrupo do alerta dentro do caso (`Finding.caseGroup`): o pacote, ou o recurso do controle reprovado. */
  group: string | null;
}

type Dimension = readonly [name: string, value: string];

interface Grouping {
  queue: CaseQueue;
  family: CaseFamily;
  /** As partes da faixa `hc` (ou de toda severidade, na fila de vulnerabilidade). */
  fine: readonly Dimension[];
  /** As partes da faixa `ml`, quando não são só a regra. */
  coarse?: readonly Dimension[];
  group?: string | null;
}

/**
 * O texto como o banco o guarda (o surrogate solto vira U+FFFD na gravação), ou ausente se não há nada nele. Sem
 * normalização de unicode nem de maiúsculas: parecer igual não pode juntar dois nomes.
 */
function present(value: string | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  return value.toWellFormed();
}

/** Os primeiros `max` caracteres (pontos de código, como conta o banco), sem partir nenhum. */
export function firstCharacters(value: string, max: number): string {
  if (value.length <= max) return value;
  // Um caractere ocupa até duas unidades: basta olhar o começo.
  return Array.from(value.slice(0, max * 2))
    .slice(0, max)
    .join('')
    .toWellFormed();
}

/**
 * Um subgrupo que cabe na coluna sem juntar dois valores: o que passa do tamanho fica com o começo e o resumo SHA-256 do
 * valor inteiro. Tratar um subgrupo alcança exatamente um valor.
 */
export function boundedCaseGroup(value: string): string {
  const whole = value.toWellFormed();
  if (whole.length <= CASE_GROUP_MAX || Array.from(whole).length <= CASE_GROUP_MAX) return whole;
  const digest = createHash('sha256').update(whole).digest('hex').slice(0, 40);
  return `${firstCharacters(whole, CASE_GROUP_MAX - digest.length - 1)}~${digest}`;
}

// ---------------------------------------------------------------------------------------------------
// Rede de um IP
// ---------------------------------------------------------------------------------------------------

/** Os endereços IPv4 que não são da internet: privados, CGNAT, loopback, link-local e `0.0.0.0/8`. */
function isInternalV4([a, b]: readonly [number, number, number, number]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function networkOfV4(octets: readonly [number, number, number, number]): string {
  const [a, b, c, d] = octets;
  return isInternalV4(octets) ? `ipv4:${a}.${b}.${c}.${d}` : `ipv4:${a}.${b}.${c}.0/24`;
}

function octetsOf(ip: string): [number, number, number, number] {
  const [a = 0, b = 0, c = 0, d = 0] = ip.split('.').map(Number);
  return [a, b, c, d];
}

/** Os oito grupos de 16 bits de um IPv6 já conferido (`isIP` = 6), sem a zona. */
function groupsOf(ip: string): number[] {
  const [address = ''] = ip.split('%');
  // O IPv4 no fim (`::ffff:203.0.113.7`) vira os dois últimos grupos.
  const tail = address.slice(address.lastIndexOf(':') + 1);
  let hex = address;
  if (tail.includes('.')) {
    const [a, b, c, d] = octetsOf(tail);
    const last = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    hex = address.slice(0, address.length - tail.length) + last;
  }
  const [left = '', right] = hex.split('::');
  const numbers = (part: string) => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  const head = numbers(left);
  if (right === undefined) return head;
  const end = numbers(right);
  return [...head, ...Array<number>(8 - head.length - end.length).fill(0), ...end];
}

function networkOfV6(ip: string): string {
  const groups = groupsOf(ip);
  const [first = 0, second = 0, , , , sixth = 0, seventh = 0, eighth = 0] = groups;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  // O IPv4 dentro de um IPv6 (mapeado, `::ffff:0:0/96`, ou NAT64, `64:ff9b::/96`) é o IPv4: o /64 dele seria um só para
  // a internet inteira.
  if ((zeros(0, 5) && sixth === 0xffff) || (first === 0x64 && second === 0xff9b && zeros(2, 6))) {
    return networkOfV4([seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff]);
  }
  // Privado (`fc00::/7`), link-local (`fe80::/10`), loopback e não especificado (os dois em `::/127`): o exato.
  const internal = (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (zeros(0, 7) && eighth <= 1);
  const written = groups.map((group) => group.toString(16));
  return internal ? `ipv6:${written.join(':')}` : `ipv6:${written.slice(0, 4).join(':')}::/64`;
}

/**
 * A rede de um IP: o /24 (IPv4) ou o /64 (IPv6) do endereço público, e o próprio endereço do privado. Numa grafia só,
 * seja qual for a do evento. Ausente se o texto não é um IP.
 */
export function networkOf(ip: string | null): string | null {
  if (ip === null) return null;
  switch (isIP(ip)) {
    case 4:
      return networkOfV4(octetsOf(ip));
    case 6:
      return networkOfV6(ip);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Quem agiu e o recurso
// ---------------------------------------------------------------------------------------------------

/**
 * Quem agiu, sem o que a própria pessoa escolhe na hora: do papel assumido, só o papel e a conta dele (o nome da sessão
 * é de quem chama); do usuário federado, só a conta (o nome também é); do `principalId` do papel, só o id. O ARN do
 * próprio papel é o mesmo ator que a sessão dele. O resto fica como está. Cada forma tem o próprio nome na chave: um
 * ator que se chame como a forma reduzida de outro não cai no caso dele.
 */
function actorOf(value: string | null): Dimension[] {
  const actor = present(value);
  if (actor === null) return [];
  if (actor.startsWith('arn:')) {
    const [, , service, , account = '', ...rest] = actor.split(':');
    const resource = rest.join(':');
    const [kind = '', name = ''] = resource.split('/');
    if (service === 'sts' && kind === 'assumed-role' && name !== '') return [['role', `${account}/${name}`]];
    if (service === 'sts' && kind === 'federated-user') return [['federated', account]];
    if (service === 'iam' && kind === 'role' && name !== '') {
      return [['role', `${account}/${resource.slice(resource.lastIndexOf('/') + 1)}`]];
    }
    return [['actor', actor]];
  }
  // O `principalId` do GuardDuty: `AROA...:<sessão>` (papel) ou `<conta>:<nome>` (usuário federado).
  const colon = actor.indexOf(':');
  const principal = colon > 0 ? actor.slice(0, colon) : '';
  if (/^AROA[A-Z0-9]{1,124}$/.test(principal)) return [['principal', principal]];
  if (/^\d{12}$/.test(principal)) return [['federated', principal]];
  return [['actor', actor]];
}

const IMAGE_DIGEST = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_MARK = '/sha256:';

/**
 * O recurso sem o que muda a cada publicação: a imagem do ECR sem o digest (o repositório), a função e a camada do
 * Lambda sem a versão. O resto fica como está.
 */
function resourceOf(value: string | null): string | null {
  const resource = present(value);
  if (resource === null || !resource.startsWith('arn:')) return resource;
  const parts = resource.split(':');
  if (parts[2] === 'ecr') {
    const mark = resource.lastIndexOf(IMAGE_DIGEST_MARK);
    const digest = resource.slice(mark + IMAGE_DIGEST_MARK.length);
    return mark > 0 && IMAGE_DIGEST.test(digest) ? resource.slice(0, mark) : resource;
  }
  if (parts[2] === 'lambda' && (parts[5] === 'function' || parts[5] === 'layer') && parts.length === 8) {
    return parts.slice(0, 7).join(':');
  }
  return resource;
}

// ---------------------------------------------------------------------------------------------------
// O que sai do título gravado
// ---------------------------------------------------------------------------------------------------

const VULNERABILITY_ID = /^[A-Z][A-Z0-9]{2,15}-[A-Za-z0-9:._-]{1,64}$/;
const AND_MORE = / and \d{1,6} more$/;

interface VulnerabilityTitle {
  id: string | null;
  packageName: string | null;
}
const NO_VULNERABILITY: VulnerabilityTitle = { id: null, packageName: null };

/**
 * O título do Inspector: `CVE-2026-0001 - openssl, openssl-libs and 3 more`. O pacote é o primeiro, como o gravado na
 * chegada.
 */
function inspectorTitle(text: string): VulnerabilityTitle {
  const separator = text.indexOf(' - ');
  const id = separator < 0 ? text.trim() : text.slice(0, separator);
  if (!VULNERABILITY_ID.test(id)) return NO_VULNERABILITY;
  if (separator < 0) return { id, packageName: null };
  const [first = ''] = text.slice(separator + 3).split(',');
  return { id, packageName: present(first.replace(AND_MORE, '').trim()) };
}

const AGENT_PENDING = ' (Missing information, CVE awaiting analysis)';
const AGENT_SOLVED = ' was solved due to an update in the agent or feed.';

/** O título do detector de vulnerabilidades do Wazuh (regras 23501 a 23508 do 4.14.9). */
function agentVulnerabilityTitle(title: string): VulnerabilityTitle {
  const solved = title.startsWith('The ') && title.endsWith(AGENT_SOLVED);
  const text = solved
    ? title.slice('The '.length, -AGENT_SOLVED.length)
    : title.endsWith(AGENT_PENDING)
      ? title.slice(0, -AGENT_PENDING.length)
      : title;
  const verb = solved ? ' that affected ' : ' affects ';
  const at = text.indexOf(verb);
  if (at < 0) return NO_VULNERABILITY;
  const id = text.slice(0, at);
  if (!VULNERABILITY_ID.test(id)) return NO_VULNERABILITY;
  return { id, packageName: present(text.slice(at + verb.length).trim()) };
}

const SECURITY_HUB_PRODUCT = `${AWS_FINDING_RULES.securityHubProduct.title} (`;

/** O produto de um achado do Security Hub e o título na origem: `Achado do Security Hub (Macie): ...`. */
function securityHubTitle(title: string): { product: string | null; rest: string } {
  if (!title.startsWith(SECURITY_HUB_PRODUCT)) return { product: null, rest: '' };
  const text = title.slice(SECURITY_HUB_PRODUCT.length);
  const end = text.indexOf('): ');
  if (end >= 0) return { product: present(text.slice(0, end)), rest: text.slice(end + 3) };
  return { product: text.endsWith(')') ? present(text.slice(0, -1)) : null, rest: '' };
}

// ---------------------------------------------------------------------------------------------------
// As famílias
// ---------------------------------------------------------------------------------------------------

const dimension = (name: string, value: string | null): Dimension[] =>
  value === null ? [] : [[name, value]];
/** O nome da parte que leva a rede de origem (`networkOf`). */
export const NETWORK_PART = 'network';
/** O nome da parte que leva a regra. */
export const RULE_PART = 'rule';
const ruleOf = (finding: CaseKeyInput): Dimension => [RULE_PART, finding.ruleId.toWellFormed()];
/** A primeira alternativa que existe. */
const firstOf = (...options: readonly Dimension[][]): Dimension[] =>
  options.find((option) => option.length > 0) ?? [];
/** A regra, quando não há mais nada. */
const orRule = (finding: CaseKeyInput, dimensions: readonly Dimension[]): readonly Dimension[] =>
  dimensions.length > 0 ? dimensions : [ruleOf(finding)];

/** As regras do CloudTrail em que o usuário é o que alguém digitou na tela de login do console. */
const CONSOLE_LOGIN_RULES: ReadonlySet<string> = new Set(['80254', '80255']);

/** As regras de WAF que contam por endereço: a rajada (80443, na AWS) e as por IP do Cloudflare. */
const WAF_PER_IP_RULES: ReadonlySet<string> = new Set(['80443', '990330', '990331', '990332', '990335']);

/**
 * As regras de falha de login do Wazuh que entram na faixa alta ou crítica (nível 10 ou mais, grupos
 * `authentication_failed` e `authentication_failures` do 4.14.9): nelas a rede de origem separa. As de nível menor são
 * da faixa `ml`, em que só a regra conta.
 */
const HOST_LOGIN_RULES: ReadonlySet<string> = new Set([
  ...['2502', '3357', '3651', '3910', '4386', '5551', '5712', '5720', '5763', '9351', '9403', '9551'],
  ...['9750', '9751', '9820', '9951', '9952', '9953', '11109', '11210', '11251', '11306', '11451'],
  ...['11510', '14251', '18156', '18157', '18170', '18171', '19152', '19153', '30310', '31316'],
  ...['40111', '40112', '51007', '51011', '60195', '60196', '60204', '64033', '64109', '64110'],
  ...['80102', '80140', '80506', '81710', '81904', '85006', '85502', '85760', '87202', '87302'],
  ...['87503', '87602', '87610', '88203'],
]);

/** As regras do detector de vulnerabilidades do Wazuh 4.14.9 (`0520-vulnerability-detector_rules.xml`). */
const HOST_VULNERABILITY_RULE = /^2350[1-8]$/;
/** As da avaliação de configuração (`0570-sca_rules.xml`): 19000 a 19015. As 191xx são do VMware. */
const HOST_CONFIGURATION_RULE = /^190(?:0\d|1[0-5])$/;

/** Os tipos do ASFF que descrevem uma condição, e não um ataque. Todo o resto (ou nenhum) é detecção. */
const POSTURE_NAMESPACES: ReadonlySet<string> = new Set([
  'Software and Configuration Checks',
  'Sensitive Data Identifications',
]);
const VULNERABILITY_TYPE = 'Software and Configuration Checks/Vulnerabilities';

/** `S3.1`, `EC2.19`: o serviço do controle. */
const CONTROL_ID = /^([A-Za-z][A-Za-z0-9]{0,31})\.\d{1,4}$/;
/** O tipo do GuardDuty na cópia do Security Hub, com traço no lugar da barra: `Recon:EC2-Portscan`. */
const COPIED_GUARDDUTY_TYPE = /^([A-Za-z]{1,64}:[A-Za-z0-9]{1,64})-(.{1,200})$/;

function guardDuty(finding: CaseKeyInput, type: string | null): Grouping {
  return {
    queue: 'detection',
    family: 'guardduty',
    fine: [
      ...orRule(finding, dimension('type', type)),
      ...firstOf(dimension('resource', resourceOf(finding.resource)), actorOf(finding.actorUser)),
    ],
  };
}

/** O tipo do GuardDuty escrito pelo Security Hub, na forma do próprio GuardDuty. */
function copiedGuardDutyType(eventName: string | null): string | null {
  const type = present(eventName);
  if (type === null) return null;
  const last = type.slice(type.lastIndexOf('/') + 1);
  const copied = COPIED_GUARDDUTY_TYPE.exec(last);
  return copied === null ? type : `${copied[1] ?? ''}/${copied[2] ?? ''}`;
}

/**
 * A vulnerabilidade de pacote: o pacote e o recurso, literais (decisão D1 de 24/11/2026). Sem pacote, o CVE. A parte é a
 * mesma coluna gravada (`caseGroup`), então gravar o subgrupo calculado não muda a chave.
 */
function packageVulnerability(finding: CaseKeyInput, title: VulnerabilityTitle, id: string | null): Grouping {
  const name = present(finding.caseGroup) ?? title.packageName ?? title.id ?? id;
  const group = name === null ? null : boundedCaseGroup(name);
  return {
    queue: 'vulnerability',
    family: 'package',
    fine: orRule(finding, [
      ...dimension('package', group),
      ...dimension('resource', resourceOf(finding.resource)),
    ]),
    group,
  };
}

function inspector(finding: CaseKeyInput): Grouping {
  switch (finding.ruleId) {
    case AWS_FINDING_RULES.inspectorPackage.id: {
      const prefix = `${AWS_FINDING_RULES.inspectorPackage.title}: `;
      const title = finding.title.startsWith(prefix)
        ? inspectorTitle(finding.title.slice(prefix.length))
        : NO_VULNERABILITY;
      return packageVulnerability(finding, title, present(finding.eventName));
    }
    case AWS_FINDING_RULES.inspectorNetwork.id:
      return {
        queue: 'posture',
        family: 'network-exposure',
        fine: orRule(finding, dimension('resource', resourceOf(finding.resource))),
      };
    case AWS_FINDING_RULES.inspectorCode.id:
      return {
        queue: 'vulnerability',
        family: 'code',
        fine: orRule(finding, dimension('resource', resourceOf(finding.resource))),
      };
    default:
      return other(finding);
  }
}

function securityHub(finding: CaseKeyInput): Grouping {
  const type = present(finding.eventName);
  if (finding.ruleId === AWS_FINDING_RULES.securityHubControl.id) {
    const resource = resourceOf(finding.resource);
    const service = type === null ? undefined : CONTROL_ID.exec(type)?.[1];
    return {
      queue: 'posture',
      family: 'control',
      fine: orRule(finding, dimension('control', type)),
      coarse: orRule(finding, dimension('service', service ?? null)),
      group: resource === null ? null : boundedCaseGroup(resource),
    };
  }
  if (finding.ruleId !== AWS_FINDING_RULES.securityHubProduct.id) return other(finding);
  const { product, rest } = securityHubTitle(finding.title);
  // As cópias do GuardDuty e do Inspector caem no caso do achado do próprio serviço.
  if (product === 'GuardDuty') return guardDuty(finding, copiedGuardDutyType(finding.eventName));
  if (
    product === 'Inspector' &&
    type !== null &&
    (type === VULNERABILITY_TYPE || type.startsWith(`${VULNERABILITY_TYPE}/`))
  ) {
    return packageVulnerability(finding, inspectorTitle(rest), null);
  }
  const posture = type !== null && POSTURE_NAMESPACES.has(type.split('/')[0] ?? '');
  return {
    queue: posture ? 'posture' : 'detection',
    family: posture ? 'security-hub-check' : 'security-hub-finding',
    fine: orRule(finding, [...dimension('product', product), ...dimension('type', type)]),
  };
}

function host(finding: CaseKeyInput): Grouping {
  const resource = resourceOf(finding.resource);
  if (HOST_VULNERABILITY_RULE.test(finding.ruleId)) {
    return packageVulnerability(finding, agentVulnerabilityTitle(finding.title), null);
  }
  const fine = [ruleOf(finding), ...dimension('resource', resource)];
  if (HOST_CONFIGURATION_RULE.test(finding.ruleId)) {
    return { queue: 'posture', family: 'host-configuration', fine };
  }
  if (HOST_LOGIN_RULES.has(finding.ruleId)) {
    return {
      queue: 'detection',
      family: 'host-login',
      fine: [...fine, ...dimension(NETWORK_PART, networkOf(finding.sourceIp))],
    };
  }
  return { queue: 'detection', family: 'host', fine };
}

/** O que não se conhece: detecção, a fila que avisa. */
function other(finding: CaseKeyInput): Grouping {
  return {
    queue: 'detection',
    family: 'other',
    fine: [
      ruleOf(finding),
      ...firstOf(dimension('resource', resourceOf(finding.resource)), actorOf(finding.actorUser)),
    ],
  };
}

/** A regra e quem agiu; sem ele, o recurso. */
function byActor(finding: CaseKeyInput, family: CaseFamily): Grouping {
  return {
    queue: 'detection',
    family,
    fine: [
      ruleOf(finding),
      ...firstOf(actorOf(finding.actorUser), dimension('resource', resourceOf(finding.resource))),
    ],
  };
}

function groupingOf(finding: CaseKeyInput): Grouping {
  const rule = ruleOf(finding);
  const network = dimension(NETWORK_PART, networkOf(finding.sourceIp));
  switch (finding.logSource) {
    case 'cloudtrail':
      if (CONSOLE_LOGIN_RULES.has(finding.ruleId)) {
        return { queue: 'detection', family: 'console-login', fine: orRule(finding, network) };
      }
      return byActor(finding, 'cloudtrail');
    case 'guardduty':
      return guardDuty(finding, present(finding.eventName));
    case 'waf':
    case 'cloudflare_waf':
      return {
        queue: 'detection',
        family: 'waf',
        fine: [
          rule,
          ...dimension('resource', resourceOf(finding.resource)),
          ...(WAF_PER_IP_RULES.has(finding.ruleId) ? network : []),
        ],
      };
    case 'vpc_flow':
      return { queue: 'detection', family: 'vpc-flow', fine: [rule, ...network] };
    case 'cloudwatch_logs':
      return {
        queue: 'detection',
        family: 'cloudwatch-logs',
        fine: [rule, ...firstOf(network, actorOf(finding.actorUser))],
      };
    case 'gcp_audit':
      return byActor(finding, 'gcp-audit');
    case 'cloudflare_audit':
      return byActor(finding, 'cloudflare-audit');
    case 'wazuh_agent':
      return host(finding);
    case 'inspector':
      return inspector(finding);
    case 'security_hub':
      return securityHub(finding);
    case 'access_analyzer':
      return {
        queue: 'posture',
        family: 'access-analyzer',
        fine: [
          rule,
          ...(finding.ruleId === AWS_FINDING_RULES.accessAnalyzerPublic.id
            ? dimension('resource', resourceOf(finding.resource))
            : []),
        ],
      };
    default:
      return other(finding);
  }
}

/** As partes da chave de um alerta, inteiras. */
function dimensionsOf(finding: CaseKeyInput) {
  const { queue, family, fine, coarse, group } = groupingOf(finding);
  // Só a média e a baixa vão para a chave grossa: uma severidade que não se conhece vale como grave.
  const noisy = finding.severity === 'medium' || finding.severity === 'low';
  const tier: CaseTier = queue === 'vulnerability' ? 'any' : noisy ? 'ml' : 'hc';
  const dimensions = tier === 'ml' ? (coarse ?? [ruleOf(finding)]) : fine;
  return { queue, family, tier, dimensions, group: group ?? null };
}

function hashOf(
  queue: CaseQueue,
  family: string,
  tier: CaseTier | CaseFold,
  accountId: string,
  dimensions: readonly Dimension[],
): string {
  const encoded = JSON.stringify([
    `v${CASE_KEY_VERSION}`,
    queue,
    family,
    tier,
    accountId.toWellFormed(),
    ...dimensions,
  ]);
  return createHash('sha256').update(encoded).digest('hex');
}

const shown = (dimensions: readonly Dimension[]): CaseKeyPart[] =>
  dimensions.map(([name, value]) => ({ name, value: firstCharacters(value, PART_MAX) }));

/** A chave de um alerta, pelas colunas gravadas dele. Nunca lança. */
export function caseKeyOf(finding: CaseKeyInput): CaseKey {
  const { queue, family, tier, dimensions, group } = dimensionsOf(finding);
  return {
    version: CASE_KEY_VERSION,
    queue,
    family,
    tier,
    groupKey: hashOf(queue, family, tier, finding.accountId, dimensions),
    parts: shown(dimensions),
    group,
  };
}

/**
 * Os casos que reúnem alertas de várias chaves, só na hora de abrir um caso e só além dos limites (`case-limits.ts`):
 * - `distributed`: a mesma família, conta e alvo, com redes de origem demais: um caso só, sem a rede;
 * - `overflow`: o mesmo, dos críticos que passaram do teto próprio deles (nunca dividem caso com os altos);
 * - `rollup`: os de severidade média e baixa além do teto da fila, um caso por fonte.
 */
export type CaseFold = 'distributed' | 'overflow' | 'rollup';

/** A família do caso que reúne as médias e baixas de uma fonte. */
export const ROLLUP_FAMILY = 'rollup';

export interface FoldedCaseKey extends Omit<CaseKey, 'family' | 'tier' | 'group'> {
  family: CaseFamily | typeof ROLLUP_FAMILY;
  fold: CaseFold;
}

/**
 * A chave do caso que reúne o alerta. O nome da reunião fica no lugar da faixa, então ela nunca é igual à chave de um
 * caso comum. O `rollup` é por fonte, sem a conta (é o desenho: só ruído entra nele, e as contas ficam na amostra).
 */
export function foldedCaseKey(finding: CaseKeyInput, fold: CaseFold): FoldedCaseKey {
  const { queue, family, dimensions } = dimensionsOf(finding);
  const rollup = fold === 'rollup';
  const kept: readonly Dimension[] = rollup
    ? [['source', finding.logSource.toWellFormed()]]
    : dimensions.filter(([name]) => name !== NETWORK_PART);
  const name = rollup ? ROLLUP_FAMILY : family;
  return {
    version: CASE_KEY_VERSION,
    queue,
    family: name,
    fold,
    groupKey: hashOf(queue, name, fold, rollup ? '' : finding.accountId, kept),
    parts: [...shown(kept), { name: 'fold', value: fold }],
  };
}
