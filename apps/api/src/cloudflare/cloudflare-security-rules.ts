import { isIP } from 'node:net';
import { type FindingDraft, severityOfLevel } from '../alerts/finding-draft.js';
import { type PathGroup, type SecurityGroup, securityEventId, type ZoneEvents } from './security-events.js';

/**
 * Regras dos eventos de segurança do Cloudflare (faixa 990330 a 990335, fase 2, PR-13), sobre os grupos de uma janela
 * de 15 min de uma zona (`firewallEventsAdaptiveGroups` por IP, ação, origem e host). Níveis e títulos da proposta do
 * coletor (`fase2/frente-cloudflare.md` §3, fora do repositório), na escala das outras regras: 12 ou mais é crítica,
 * 10 alta, 7 média, abaixo baixa.
 *
 * **Agregação:** uma rajada de requisições nunca vira um achado por requisição. Cada regra olha a contagem da janela:
 * por IP (990330, 990331, 990332, 990335) ou da zona inteira (990333, 990334), e vira no máximo um achado por regra,
 * zona, IP e janela, com a contagem no nome do evento. Um ataque distribuído também não: por regra, zona e janela,
 * só os 10 IPs com mais eventos viram achado próprio, e os demais acima do limite viram um achado de resumo
 * (IP `*`), com quantos IPs e quantos eventos.
 *
 * **Valores do Cloudflare:** a ação e a origem aparecem em grafias diferentes no GraphQL e no Logpush
 * (`managed_challenge`, `managedchallenge`; `firewallManaged`, `firewallmanaged`): a comparação usa só letras e números
 * em minúsculas. As contagens são estimadas pela amostragem do Cloudflare, e o corte por linhas por zona
 * (`truncated`) faz delas um piso: os limites são aproximados.
 */

/** Só letras e números, em minúsculas: `managed_challenge` e `managedChallenge` viram `managedchallenge`. */
export function normalizeValue(value: string): string {
  let out = '';
  for (const char of value.toLowerCase()) {
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) out += char;
  }
  return out;
}

/** Bloqueio de fato: a requisição não passou. */
const BLOCK_ACTIONS: ReadonlySet<string> = new Set(['block', 'connectionclose']);
/** Desafio apresentado (a requisição só passa se o visitante resolver). */
const CHALLENGE_ACTIONS: ReadonlySet<string> = new Set(['challenge', 'jschallenge', 'managedchallenge']);
/** Desafio resolvido. `challengebypassed` não conta: é quem já tinha resolvido antes. */
const SOLVED_ACTIONS: ReadonlySet<string> = new Set([
  'challengesolved',
  'jschallengesolved',
  'managedchallengenoninteractivesolved',
  'managedchallengeinteractivesolved',
]);
/** Ações que deixam passar sem mitigar: não contam como limite de taxa disparado. */
const PASS_ACTIONS: ReadonlySet<string> = new Set([
  'allow',
  'skip',
  'bypass',
  'challengebypassed',
  'jschallengebypassed',
  'managedchallengebypassed',
  ...SOLVED_ACTIONS,
]);
/** O WAF gerenciado (o conjunto de regras do Cloudflare e o WAF antigo). */
const WAF_SOURCES: ReadonlySet<string> = new Set(['firewallmanaged', 'waf']);
const RATE_LIMIT_SOURCES: ReadonlySet<string> = new Set(['ratelimit']);
const DDOS_SOURCES: ReadonlySet<string> = new Set(['l7ddos']);

/**
 * Trechos de rota de login (em minúsculas): telas e APIs de entrada, de senha e de token, e os alvos clássicos de
 * força bruta (WordPress, XML-RPC). Comparação por trecho do caminho, sem regex.
 */
const LOGIN_PATH_HINTS = [
  'login',
  'logon',
  'signin',
  'sign-in',
  'sign_in',
  'entrar',
  'auth',
  'session',
  'password',
  'senha',
  'token',
  'wp-login',
  'xmlrpc',
];

export function isLoginPath(path: string | null): boolean {
  if (path === null) return false;
  const query = path.indexOf('?');
  const lowered = (query >= 0 ? path.slice(0, query) : path).toLowerCase();
  return LOGIN_PATH_HINTS.some((hint) => lowered.includes(hint));
}

/** O que um IP fez na zona durante a janela. */
export interface IpTally {
  ip: string;
  total: number;
  /** Bloqueado (sem os da proteção DDoS, que contam na zona). */
  blocked: number;
  /** Barrado pelo WAF gerenciado (bloqueio ou desafio). */
  waf: number;
  /** Limite de taxa disparado (sem os eventos que só deixaram passar). */
  rateLimited: number;
  challenged: number;
  solved: number;
  /** O host com mais eventos do IP. */
  topHost: string | null;
}

/** O que a zona teve na janela. */
export interface ZoneTally {
  total: number;
  ddos: number;
  /** Média de eventos por janela de 15 min na base; `null` sem a base. */
  baselinePerWindow: number | null;
  topHost: string | null;
}

function topOf(hosts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const [host, count] of hosts) {
    if (count > bestCount || (count === bestCount && best !== null && host < best)) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}

/** Soma os grupos da janela por IP e na zona. */
export function tally(
  groups: readonly SecurityGroup[],
  baseline: { count: number; windows: number } | null,
): { ips: IpTally[]; zone: ZoneTally } {
  const byIp = new Map<string, IpTally & { hosts: Map<string, number> }>();
  const zoneHosts = new Map<string, number>();
  const zone: ZoneTally = {
    total: 0,
    ddos: 0,
    baselinePerWindow: baseline === null ? null : baseline.count / Math.max(baseline.windows, 1),
    topHost: null,
  };
  for (const group of groups) {
    const action = normalizeValue(group.action);
    const source = normalizeValue(group.source);
    const { count } = group;
    zone.total += count;
    if (DDOS_SOURCES.has(source)) zone.ddos += count;
    if (group.host !== null) zoneHosts.set(group.host, (zoneHosts.get(group.host) ?? 0) + count);
    const ip = group.clientIP;
    let entry = byIp.get(ip);
    if (entry === undefined) {
      entry = {
        ip,
        total: 0,
        blocked: 0,
        waf: 0,
        rateLimited: 0,
        challenged: 0,
        solved: 0,
        topHost: null,
        hosts: new Map(),
      };
      byIp.set(ip, entry);
    }
    entry.total += count;
    // O bloqueio da proteção DDoS fica na regra da zona (990333): um ataque distribuído não vira um achado por IP.
    if (BLOCK_ACTIONS.has(action) && !DDOS_SOURCES.has(source)) entry.blocked += count;
    if (WAF_SOURCES.has(source) && (BLOCK_ACTIONS.has(action) || CHALLENGE_ACTIONS.has(action))) {
      entry.waf += count;
    }
    if (RATE_LIMIT_SOURCES.has(source) && !PASS_ACTIONS.has(action)) entry.rateLimited += count;
    if (CHALLENGE_ACTIONS.has(action)) entry.challenged += count;
    if (SOLVED_ACTIONS.has(action)) entry.solved += count;
    if (group.host !== null) entry.hosts.set(group.host, (entry.hosts.get(group.host) ?? 0) + count);
  }
  zone.topHost = topOf(zoneHosts);
  const ips = [...byIp.values()].map(({ hosts, ...entry }) => ({ ...entry, topHost: topOf(hosts) }));
  return { ips, zone };
}

/** O que a regra achou: o nível, a contagem que a disparou e o nome do evento. */
export interface SecurityHit {
  level: number;
  count: number;
  eventName: string;
}

interface RuleBase {
  id: string;
  /** O nível de referência (o maior que a regra dá). */
  level: number;
  title: string;
  tactics: readonly string[];
  techniques: readonly string[];
  /** Regra desligada não é avaliada (a 990335 nasce assim). */
  enabled: boolean;
}

export interface IpRule extends RuleBase {
  scope: 'ip';
  evaluate(ip: IpTally, context: { loginIps: ReadonlySet<string> }): SecurityHit | null;
}

export interface ZoneRule extends RuleBase {
  scope: 'zone';
  evaluate(zone: ZoneTally): SecurityHit | null;
}

export type SecurityRule = IpRule | ZoneRule;

const WINDOW_TEXT = 'em 15 min';

export const CLOUDFLARE_SECURITY_RULES: readonly SecurityRule[] = [
  {
    id: '990330',
    scope: 'ip',
    level: 10,
    title: 'Rajada de bloqueios de um mesmo IP na zona (500 ou mais em 15 min; nível 10 a partir de 5000)',
    tactics: ['Reconnaissance'],
    techniques: ['T1595'],
    enabled: true,
    evaluate: (ip) =>
      ip.blocked >= 500
        ? {
            level: ip.blocked >= 5000 ? 10 : 7,
            count: ip.blocked,
            eventName: `${ip.blocked} requisições bloqueadas ${WINDOW_TEXT}`,
          }
        : null,
  },
  {
    id: '990331',
    scope: 'ip',
    level: 7,
    title: 'Ataques barrados pelo WAF gerenciado vindos de um mesmo IP (20 ou mais em 15 min)',
    tactics: ['Initial Access', 'Reconnaissance'],
    techniques: ['T1190', 'T1595.002'],
    enabled: true,
    evaluate: (ip) =>
      ip.waf >= 20
        ? {
            level: 7,
            count: ip.waf,
            eventName: `${ip.waf} requisições barradas pelo WAF gerenciado ${WINDOW_TEXT}`,
          }
        : null,
  },
  {
    id: '990332',
    scope: 'ip',
    level: 10,
    title: 'Limite de taxa disparado por um mesmo IP (nível 10 contra rota de login)',
    tactics: ['Credential Access'],
    techniques: ['T1110.004'],
    enabled: true,
    evaluate: (ip, { loginIps }) => {
      if (ip.rateLimited < 1) return null;
      const login = loginIps.has(ip.ip);
      return {
        level: login ? 10 : 7,
        count: ip.rateLimited,
        eventName: `${ip.rateLimited} requisições acima do limite de taxa ${WINDOW_TEXT}${login ? ' (rota de login)' : ''}`,
      };
    },
  },
  {
    id: '990333',
    scope: 'zone',
    level: 10,
    title: 'Ataque DDoS de camada 7 mitigado na zona (1000 ou mais requisições em 15 min)',
    tactics: ['Impact'],
    techniques: ['T1499.002'],
    enabled: true,
    evaluate: (zone) =>
      zone.ddos >= 1000
        ? {
            level: 10,
            count: zone.ddos,
            eventName: `${zone.ddos} requisições mitigadas pela proteção DDoS ${WINDOW_TEXT}`,
          }
        : null,
  },
  {
    id: '990334',
    scope: 'zone',
    level: 7,
    title:
      'Pico de eventos de segurança na zona (10 vezes a média das 24 h anteriores e 500 ou mais em 15 min)',
    tactics: ['Reconnaissance', 'Impact'],
    techniques: ['T1595', 'T1499'],
    enabled: true,
    evaluate: (zone) => {
      if (zone.baselinePerWindow === null || zone.total < 500) return null;
      if (zone.total < 10 * zone.baselinePerWindow) return null;
      const average = Math.round(zone.baselinePerWindow);
      return {
        level: 7,
        count: zone.total,
        eventName: `${zone.total} eventos de segurança ${WINDOW_TEXT} (média de ${average} por 15 min nas 24 h anteriores)`,
      };
    },
  },
  {
    id: '990335',
    scope: 'ip',
    level: 4,
    title: 'Muitos desafios resolvidos por um mesmo IP (50 ou mais, com 90% ou mais de acerto)',
    tactics: ['Reconnaissance'],
    techniques: ['T1595'],
    // Baixa confiança: ligar só depois de ver dados reais (plano da fase 2).
    enabled: false,
    evaluate: (ip) => {
      if (ip.solved < 50 || ip.challenged === 0 || ip.solved < 0.9 * ip.challenged) return null;
      return {
        level: 4,
        count: ip.solved,
        eventName: `${ip.solved} desafios resolvidos de ${ip.challenged} apresentados ${WINDOW_TEXT}`,
      };
    },
  },
];

/** Por regra, zona e janela, quantos IPs viram achado próprio; os demais acima do limite viram um resumo. */
export const SECURITY_MAX_IP_FINDINGS = 10;

/** Uma detecção na janela de uma zona, antes de virar achado. */
export interface SecurityDetection {
  rule: SecurityRule;
  hit: SecurityHit;
  /** O IP (achado por IP), `''` (zona inteira) ou `*` (resumo dos IPs além do teto). */
  ip: string;
  host: string | null;
}

export interface ZoneWindow {
  zone: ZoneEvents;
  /** Base em janelas de 15 min (para a média da regra de pico). */
  baselineWindows: number;
  /** IPs que dispararam o limite de taxa numa rota de login. */
  loginIps: ReadonlySet<string>;
}

/**
 * As detecções da janela de uma zona, com o teto por regra: os 10 IPs com mais eventos e, se houver mais, um resumo
 * deles (o maior nível entre eles, a soma dos eventos). Devolve também quantos IPs entraram no resumo.
 */
export function detectWindow(
  input: ZoneWindow,
  rules: readonly SecurityRule[] = CLOUDFLARE_SECURITY_RULES,
): { detections: SecurityDetection[]; folded: number } {
  const baseline =
    input.zone.baselineCount === null
      ? null
      : { count: input.zone.baselineCount, windows: input.baselineWindows };
  const { ips, zone } = tally(input.zone.groups, baseline);
  const detections: SecurityDetection[] = [];
  let folded = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.scope === 'zone') {
      const hit = rule.evaluate(zone);
      if (hit !== null) detections.push({ rule, hit, ip: '', host: zone.topHost });
      continue;
    }
    const hits = ips
      .flatMap((ip) => {
        const hit = rule.evaluate(ip, { loginIps: input.loginIps });
        return hit === null ? [] : [{ ip, hit }];
      })
      .sort((a, b) => b.hit.count - a.hit.count || (a.ip.ip < b.ip.ip ? -1 : 1));
    for (const { ip, hit } of hits.slice(0, SECURITY_MAX_IP_FINDINGS)) {
      detections.push({ rule, hit, ip: ip.ip, host: ip.topHost });
    }
    const rest = hits.slice(SECURITY_MAX_IP_FINDINGS);
    if (rest.length > 0) {
      folded += rest.length;
      const count = rest.reduce((sum, { hit }) => sum + hit.count, 0);
      detections.push({
        rule,
        hit: {
          level: Math.max(...rest.map(({ hit }) => hit.level)),
          count,
          eventName: `mais ${rest.length} IPs acima do limite: ${count} eventos ${WINDOW_TEXT}`,
        },
        ip: '*',
        host: zone.topHost,
      });
    }
  }
  return { detections, folded };
}

/** Os IPs que dispararam o limite de taxa numa rota de login, pelas rotas da janela. */
export function loginIpsOf(paths: readonly PathGroup[]): Set<string> {
  const ips = new Set<string>();
  for (const group of paths) {
    if (RATE_LIMIT_SOURCES.has(normalizeValue(group.source)) && isLoginPath(group.path))
      ips.add(group.clientIP);
  }
  return ips;
}

/** Os IPs da janela com limite de taxa disparado (para a consulta das rotas). */
export function rateLimitedIps(groups: readonly SecurityGroup[]): string[] {
  const ips = new Set<string>();
  for (const group of groups) {
    const source = normalizeValue(group.source);
    if (RATE_LIMIT_SOURCES.has(source) && !PASS_ACTIONS.has(normalizeValue(group.action)))
      ips.add(group.clientIP);
  }
  return [...ips].sort();
}

/** De detecção a achado, com o cliente decidido pela conta cadastrada (o dono do token e das zonas). */
export function toSecurityFindingDraft(
  detection: SecurityDetection,
  owner: { tenantId: string; accountId: string },
  zone: { tag: string; name: string },
  windowStart: Date,
): FindingDraft {
  const { rule, hit, ip, host } = detection;
  return {
    tenantId: owner.tenantId,
    accountId: owner.accountId,
    source: 'cloudflare',
    sourceEventId: securityEventId(owner.accountId, rule.id, zone.tag, ip, windowStart),
    occurredAt: windowStart.toISOString(),
    severity: severityOfLevel(hit.level),
    ruleId: rule.id,
    ruleLevel: hit.level,
    title: rule.title,
    logSource: 'cloudflare_waf',
    eventName: host === null || host === zone.name ? hit.eventName : `${hit.eventName} em ${host}`,
    region: null,
    // A zona (como na auditoria): é por ela que o cliente cadastra exceção e lista de proteção.
    resource: zone.name,
    actorUser: null,
    actorType: null,
    accessKeyId: null,
    sourceIp: isIP(ip) === 0 ? null : ip,
    mitreTactics: [...new Set(rule.tactics)].sort(),
    mitreTechniques: [...new Set(rule.techniques)].sort(),
  };
}
