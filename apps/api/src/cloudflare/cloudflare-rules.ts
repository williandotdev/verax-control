import { type FindingDraft, severityOfLevel } from '../alerts/finding-draft.js';
import {
  type AuditEntry,
  actorIp,
  cloudflareEventId,
  field,
  list,
  pathMatches,
  pathSegments,
  requestOf,
  responseOf,
  succeeded,
  verbOf,
} from './audit-entry.js';

/**
 * Regras de detecção da auditoria do Cloudflare (faixa 9903xx, fase 2, PR-12). Cada uma olha um tipo de chamada da
 * API do Cloudflare registrada na auditoria v2 e diz o nível (a escala das regras da GCP e do Wazuh: 12 ou mais é
 * crítica, 10 alta, 7 média, abaixo baixa), o título em português e as táticas e técnicas do MITRE ATT&CK.
 *
 * A regra casa pelo caminho da API (`raw.uri`, em partes, sem regex), pelo método (`raw.method`, ou o tipo da ação) e,
 * quando precisa, pelo corpo da requisição (`resource.request`). Os caminhos são os da API pública documentada; se
 * as ações feitas pelo painel aparecem com o mesmo caminho só os eventos reais confirmam (risco anotado no
 * `docs/STATUS.md`). A auditoria v2 ainda não traz o valor anterior: "desligado" quer dizer "gravado como desligado".
 *
 * `levelOf` devolve o nível do evento quando a regra casa, ou `null`: duas regras têm nível que depende do evento (a
 * 990307, zona pausada ou só um registro DNS fora do proxy, e a 990311, token com ou sem permissão de edição).
 */
export interface CloudflareRule {
  id: string;
  /** O nível de referência (o maior que a regra dá). */
  level: number;
  title: string;
  tactics: readonly string[];
  techniques: readonly string[];
  levelOf(entry: AuditEntry): number | null;
}

/** A regra que casou e o nível que ela deu a este evento. */
export interface Detection {
  rule: CloudflareRule;
  level: number;
}

type Verb = ReturnType<typeof verbOf>;

const WRITE_VERBS: ReadonlySet<Verb> = new Set(['POST', 'PUT', 'PATCH']);

/** O evento casa com algum dos caminhos. */
function onPath(entry: AuditEntry, ...patterns: string[]): boolean {
  const segments = pathSegments(entry);
  return patterns.some((pattern) => pathMatches(segments, pattern));
}

const isWrite = (entry: AuditEntry) => WRITE_VERBS.has(verbOf(entry));
const isDelete = (entry: AuditEntry) => verbOf(entry) === 'DELETE';
const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : undefined);

/** A requisição traz um objeto ou uma lista deles (as rotas do firewall antigo aceitam os dois). */
function requestItems(entry: AuditEntry): unknown[] {
  const request = requestOf(entry);
  return Array.isArray(request) ? request : request === undefined ? [] : [request];
}

// --- Rulesets (WAF, limite de taxa, redirecionamentos) ---

/** Fases dos rulesets que protegem: regras do WAF (próprias e gerenciadas), limite de taxa e Super Bot Fight Mode. */
const SECURITY_PHASES: ReadonlySet<string> = new Set([
  'http_request_firewall_custom',
  'http_request_firewall_managed',
  'http_response_firewall_managed',
  'http_ratelimit',
  'http_request_sbfm',
  'ddos_l7',
]);

/** Fases dos redirecionamentos: o da zona (Redirect Rules) e o da conta (Bulk Redirects). */
const REDIRECT_PHASES: ReadonlySet<string> = new Set([
  'http_request_dynamic_redirect',
  'http_request_redirect',
]);

const RULESET_PATHS = [
  'accounts|zones/*/rulesets',
  'accounts|zones/*/rulesets/*',
  'accounts|zones/*/rulesets/*/rules/**',
];
const ENTRYPOINT_PATH = 'accounts|zones/*/rulesets/phases/*/entrypoint';

/**
 * Fase do ruleset: no caminho do ponto de entrada (`rulesets/phases/<fase>/entrypoint`) ou no corpo (a API devolve o
 * ruleset inteiro, com a fase, ao criar, alterar ou apagar uma regra).
 */
function rulesetPhase(entry: AuditEntry): string | undefined {
  const segments = pathSegments(entry);
  const phases = segments.findIndex((segment) => segment.toLowerCase() === 'phases');
  if (phases >= 0 && segments[phases - 1]?.toLowerCase() === 'rulesets') return lower(segments[phases + 1]);
  return lower(field(requestOf(entry), 'phase')) ?? lower(field(responseOf(entry), 'phase'));
}

/** Produtos que só existem na segurança: usados quando a fase não aparece no evento. */
const SECURITY_PRODUCT_HINTS = ['waf', 'firewall', 'ratelimit', 'rate_limit', 'security'];

function isSecurityRuleset(entry: AuditEntry): boolean {
  const phase = rulesetPhase(entry);
  if (phase !== undefined) return SECURITY_PHASES.has(phase);
  const product = entry.resource?.product?.toLowerCase() ?? '';
  return SECURITY_PRODUCT_HINTS.some((hint) => product.includes(hint));
}

/** Regras enviadas: a lista do ruleset inteiro (ponto de entrada, PUT do ruleset) ou a regra única (POST, PATCH). */
function rulesetRules(entry: AuditEntry): unknown[] {
  const request = requestOf(entry);
  const rules = field(request, 'rules');
  if (Array.isArray(rules)) return rules;
  return request === undefined ? [] : [request];
}

const isRulesetCall = (entry: AuditEntry) => onPath(entry, ENTRYPOINT_PATH, ...RULESET_PATHS);

// --- Configurações da zona ---

/** Configurações da zona alteradas: `PATCH /zones/<zona>/settings/<nome>` ou em lote (`PATCH /zones/<zona>/settings`). */
function zoneSettings(entry: AuditEntry): Map<string, unknown> {
  const settings = new Map<string, unknown>();
  if (!isWrite(entry)) return settings;
  const segments = pathSegments(entry);
  if (pathMatches(segments, 'zones/*/settings/*')) {
    const name = segments[3]?.toLowerCase();
    if (name !== undefined) settings.set(name, field(requestOf(entry), 'value'));
  } else if (pathMatches(segments, 'zones/*/settings')) {
    for (const item of list(field(requestOf(entry), 'items'))) {
      const name = lower(field(item, 'id'));
      if (name !== undefined) settings.set(name, field(item, 'value'));
    }
  }
  return settings;
}

/** Configuração da zona gravada com um destes valores. */
function settingIs(entry: AuditEntry, name: string, ...values: string[]): boolean {
  const value = zoneSettings(entry).get(name);
  return typeof value === 'string' && values.includes(value.toLowerCase());
}

function weakensZone(entry: AuditEntry): boolean {
  const settings = zoneSettings(entry);
  if (settings.size === 0) return false;
  const hsts = field(settings.get('security_header'), 'strict_transport_security', 'enabled');
  return (
    settingIs(entry, 'security_level', 'essentially_off', 'low') ||
    settingIs(entry, 'waf', 'off') ||
    settingIs(entry, 'always_use_https', 'off') ||
    settingIs(entry, 'min_tls_version', '1.0') ||
    hsts === false
  );
}

// --- DNS ---

const DNS_RECORD_PATHS = ['zones/*/dns_records', 'zones/*/dns_records/*'];
const DNS_BATCH_PATH = 'zones/*/dns_records/batch';
const PROXIABLE_TYPES: ReadonlySet<string> = new Set(['a', 'aaaa', 'cname']);

/** Registros enviados: o do corpo ou, no lote, os criados, trocados e alterados. */
function dnsRecordsWritten(entry: AuditEntry): unknown[] {
  if (!isWrite(entry)) return [];
  if (onPath(entry, DNS_BATCH_PATH)) {
    const request = requestOf(entry);
    return ['posts', 'puts', 'patches'].flatMap((key) => list(field(request, key)));
  }
  return onPath(entry, ...DNS_RECORD_PATHS) ? requestItems(entry) : [];
}

/** O nome do registro é o domínio raiz da zona (`@`, o nome da zona, com ou sem o ponto final). */
function isApex(entry: AuditEntry, name: unknown): boolean {
  const value = lower(name);
  if (value === undefined) return false;
  const zone = entry.zone?.name?.toLowerCase();
  return value === '@' || (zone !== undefined && (value === zone || value === `${zone}.`));
}

function deletesDnsRecord(entry: AuditEntry): boolean {
  if (isDelete(entry) && onPath(entry, 'zones/*/dns_records/*')) return true;
  return (
    isWrite(entry) && onPath(entry, DNS_BATCH_PATH) && list(field(requestOf(entry), 'deletes')).length > 0
  );
}

function changesCriticalRecord(entry: AuditEntry): boolean {
  return dnsRecordsWritten(entry).some((record) => {
    const type = lower(field(record, 'type'));
    if (type === 'ns') return true;
    return (type === 'mx' || type === 'cname') && isApex(entry, field(record, 'name'));
  });
}

/** Registro posto fora do proxy (`proxied: false`) num tipo que o proxy atende. Criar um registro só de DNS é normal. */
function unproxiesRecord(entry: AuditEntry): boolean {
  const verb = verbOf(entry);
  if (verb === 'POST' && !onPath(entry, DNS_BATCH_PATH)) return false;
  const records = onPath(entry, DNS_BATCH_PATH)
    ? ['puts', 'patches'].flatMap((key) => list(field(requestOf(entry), key)))
    : dnsRecordsWritten(entry);
  return records.some((record) => {
    const type = lower(field(record, 'type'));
    return field(record, 'proxied') === false && (type === undefined || PROXIABLE_TYPES.has(type));
  });
}

// --- Tokens e membros ---

/** Permissão de escrita num token: o nome do grupo (`DNS Write`, `Zone Settings Edit`) ou a chave (`dns_records:edit`). */
function grantsWrite(entry: AuditEntry): boolean {
  const policies = [requestOf(entry), responseOf(entry)].flatMap((body) => list(field(body, 'policies')));
  return policies.some((policy) =>
    list(field(policy, 'permission_groups')).some((group) => {
      const name = lower(field(group, 'name')) ?? '';
      const key = lower(field(group, 'key')) ?? '';
      return ['write', 'edit'].some((word) => name.includes(word) || key.endsWith(`:${word}`));
    }),
  );
}

/** Papéis que dão controle da conta inteira. O "Administrator Read Only" fica de fora. */
const ADMIN_ROLES: ReadonlySet<string> = new Set(['administrator', 'super administrator - all privileges']);

/** Nomes de papel no corpo ou na resposta (`roles` como nomes ou como objetos com `name`). */
function grantsAdmin(entry: AuditEntry): boolean {
  const roles = [requestOf(entry), responseOf(entry)].flatMap((body) => list(field(body, 'roles')));
  return roles.some((role) => {
    const name = typeof role === 'string' ? role : field(role, 'name');
    return typeof name === 'string' && ADMIN_ROLES.has(name.toLowerCase());
  });
}

// --- Access (Zero Trust) ---

const ACCESS_POLICY_PATHS = [
  'accounts|zones/*/access/apps/*/policies',
  'accounts|zones/*/access/apps/*/policies/*',
  'accounts/*/access/policies',
  'accounts/*/access/policies/*',
];
const ACCESS_APP_PATHS = ['accounts|zones/*/access/apps', 'accounts|zones/*/access/apps/*'];

/** Política que deixa passar sem login (`bypass`) ou que inclui todo mundo (`everyone`). */
function opensPolicy(policy: unknown): boolean {
  if (lower(field(policy, 'decision')) === 'bypass') return true;
  return list(field(policy, 'include')).some((rule) => field(rule, 'everyone') !== undefined);
}

function opensAccess(entry: AuditEntry): boolean {
  if (!isWrite(entry)) return false;
  if (onPath(entry, ...ACCESS_POLICY_PATHS)) return requestItems(entry).some(opensPolicy);
  if (onPath(entry, ...ACCESS_APP_PATHS)) return list(field(requestOf(entry), 'policies')).some(opensPolicy);
  return false;
}

// --- Tabela ---

const fixed =
  (level: number, matches: (entry: AuditEntry) => boolean) =>
  (entry: AuditEntry): number | null =>
    matches(entry) ? level : null;

/** Só o que de fato aconteceu: a ação sem falha. */
const done =
  (level: number, matches: (entry: AuditEntry) => boolean) =>
  (entry: AuditEntry): number | null =>
    succeeded(entry) && matches(entry) ? level : null;

export const CLOUDFLARE_RULES: readonly CloudflareRule[] = [
  {
    id: '990301',
    level: 12,
    title: 'Logpush apagado, desligado ou apontado para outro destino (logs desviados)',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.008'],
    levelOf: done(12, (entry) => {
      if (onPath(entry, 'accounts|zones/*/logpush/jobs/*') && isDelete(entry)) return true;
      if (
        !isWrite(entry) ||
        !onPath(entry, 'accounts|zones/*/logpush/jobs', 'accounts|zones/*/logpush/jobs/*')
      ) {
        return false;
      }
      const request = requestOf(entry);
      return field(request, 'enabled') === false || field(request, 'destination_conf') !== undefined;
    }),
  },
  {
    id: '990302',
    level: 10,
    title: 'Regra do WAF ou do firewall desativada ou apagada',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.007'],
    levelOf: done(10, (entry) => {
      if (isRulesetCall(entry) && isSecurityRuleset(entry)) {
        if (isDelete(entry)) return true;
        return isWrite(entry) && rulesetRules(entry).some((rule) => field(rule, 'enabled') === false);
      }
      // Firewall antigo: regras, bloqueio por URL (lockdown), bloqueio por User-Agent e limite de taxa.
      if (onPath(entry, 'zones/*/firewall/rules', 'zones/*/firewall/rules/*')) {
        return (
          isDelete(entry) ||
          (isWrite(entry) && requestItems(entry).some((rule) => field(rule, 'paused') === true))
        );
      }
      if (onPath(entry, 'zones/*/firewall/lockdowns/*', 'zones/*/firewall/ua_rules/*')) {
        return isDelete(entry) || (isWrite(entry) && field(requestOf(entry), 'paused') === true);
      }
      if (onPath(entry, 'zones/*/rate_limits/*')) {
        return isDelete(entry) || (isWrite(entry) && field(requestOf(entry), 'disabled') === true);
      }
      return false;
    }),
  },
  {
    id: '990303',
    level: 10,
    title: 'IP, ASN ou país liberado no firewall (regra de acesso "whitelist" ou regra com ação "skip")',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.007'],
    levelOf: done(10, (entry) => {
      if (!isWrite(entry)) return false;
      if (
        onPath(
          entry,
          'accounts|zones/*/firewall/access_rules/rules',
          'accounts|zones/*/firewall/access_rules/rules/*',
        )
      ) {
        return lower(field(requestOf(entry), 'mode')) === 'whitelist';
      }
      if (isRulesetCall(entry) && isSecurityRuleset(entry)) {
        return rulesetRules(entry).some(
          (rule) => lower(field(rule, 'action')) === 'skip' && field(rule, 'enabled') !== false,
        );
      }
      if (onPath(entry, 'zones/*/firewall/rules', 'zones/*/firewall/rules/*')) {
        return requestItems(entry).some((rule) => {
          const action = lower(field(rule, 'action'));
          return action === 'allow' || action === 'bypass';
        });
      }
      return false;
    }),
  },
  {
    id: '990304',
    level: 7,
    title:
      'Proteção da zona reduzida (nível de segurança baixo, WAF, HTTPS obrigatório ou HSTS desligados, TLS mínimo 1.0)',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.007', 'T1600'],
    levelOf: done(7, weakensZone),
  },
  {
    id: '990305',
    level: 10,
    title: 'Modo SSL da zona rebaixado para "off" ou "flexible"',
    tactics: ['Defense Evasion', 'Credential Access'],
    techniques: ['T1557', 'T1600'],
    levelOf: done(10, (entry) => settingIs(entry, 'ssl', 'off', 'flexible')),
  },
  {
    id: '990306',
    level: 12,
    title: 'Zona apagada',
    tactics: ['Impact'],
    techniques: ['T1485'],
    levelOf: done(12, (entry) => isDelete(entry) && onPath(entry, 'zones/*')),
  },
  {
    id: '990307',
    level: 10,
    title: 'Proxy do Cloudflare desligado: zona pausada (nível 10) ou registro DNS fora do proxy (nível 7)',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.007'],
    levelOf: (entry) => {
      if (!succeeded(entry)) return null;
      if (isWrite(entry) && onPath(entry, 'zones/*') && field(requestOf(entry), 'paused') === true) return 10;
      return unproxiesRecord(entry) ? 7 : null;
    },
  },
  {
    id: '990308',
    level: 10,
    title: 'Registro DNS apagado, ou registro NS, MX ou CNAME do domínio raiz alterado',
    tactics: ['Resource Development'],
    techniques: ['T1584.001'],
    levelOf: done(10, (entry) => deletesDnsRecord(entry) || changesCriticalRecord(entry)),
  },
  {
    id: '990309',
    level: 4,
    title: 'Registro DNS criado ou alterado',
    tactics: ['Resource Development'],
    techniques: ['T1584.001'],
    levelOf: done(
      4,
      (entry) =>
        isWrite(entry) && onPath(entry, ...DNS_RECORD_PATHS, DNS_BATCH_PATH, 'zones/*/dns_records/import'),
    ),
  },
  {
    id: '990310',
    level: 10,
    title: 'DNSSEC desativado na zona',
    tactics: ['Defense Evasion', 'Resource Development'],
    techniques: ['T1562', 'T1584.001'],
    levelOf: done(10, (entry) => {
      if (!onPath(entry, 'zones/*/dnssec')) return false;
      return isDelete(entry) || (isWrite(entry) && lower(field(requestOf(entry), 'status')) === 'disabled');
    }),
  },
  {
    id: '990311',
    level: 10,
    title: 'Token de API criado, renovado ou com permissões alteradas (nível 10 com permissão de edição)',
    tactics: ['Persistence'],
    techniques: ['T1098.001'],
    levelOf: (entry) => {
      if (!succeeded(entry)) return null;
      const verb = verbOf(entry);
      const created = verb === 'POST' && onPath(entry, 'accounts/*/tokens', 'user/tokens');
      const rolled = verb === 'PUT' && onPath(entry, 'accounts/*/tokens/*/value', 'user/tokens/*/value');
      const changed =
        verb === 'PUT' &&
        onPath(entry, 'accounts/*/tokens/*', 'user/tokens/*') &&
        field(requestOf(entry), 'policies') !== undefined;
      if (!created && !rolled && !changed) return null;
      return grantsWrite(entry) ? 10 : 7;
    },
  },
  {
    id: '990312',
    level: 7,
    title: 'Membro adicionado ou convidado na conta',
    tactics: ['Persistence'],
    techniques: ['T1136.003'],
    levelOf: done(7, (entry) => verbOf(entry) === 'POST' && onPath(entry, 'accounts/*/members')),
  },
  {
    id: '990313',
    level: 12,
    title: 'Papel de administrador ou Super Administrator concedido a um membro da conta',
    tactics: ['Privilege Escalation', 'Persistence'],
    techniques: ['T1098.003'],
    levelOf: done(
      12,
      (entry) =>
        isWrite(entry) && onPath(entry, 'accounts/*/members', 'accounts/*/members/*') && grantsAdmin(entry),
    ),
  },
  {
    id: '990314',
    level: 12,
    title: 'Exigência de autenticação em dois fatores desligada na conta',
    tactics: ['Defense Evasion', 'Persistence', 'Credential Access'],
    techniques: ['T1556.006'],
    levelOf: done(
      12,
      (entry) =>
        isWrite(entry) &&
        onPath(entry, 'accounts/*') &&
        field(requestOf(entry), 'settings', 'enforce_twofactor') === false,
    ),
  },
  {
    id: '990315',
    level: 10,
    title: 'Aplicação ou política do Cloudflare Access apagada ou aberta ("everyone" ou "bypass")',
    tactics: ['Defense Evasion', 'Persistence', 'Credential Access'],
    techniques: ['T1556'],
    levelOf: done(10, (entry) => {
      if (isDelete(entry)) {
        return onPath(
          entry,
          'accounts|zones/*/access/apps/*',
          'accounts|zones/*/access/apps/*/policies/*',
          'accounts/*/access/policies/*',
        );
      }
      return opensAccess(entry);
    }),
  },
  {
    id: '990316',
    level: 7,
    title: 'Redirecionamento criado (Page Rule de encaminhamento, Redirect Rule ou Bulk Redirect)',
    tactics: ['Impact'],
    techniques: ['T1491.002'],
    levelOf: done(7, (entry) => {
      if (!isWrite(entry)) return false;
      if (onPath(entry, 'zones/*/pagerules', 'zones/*/pagerules/*')) {
        return list(field(requestOf(entry), 'actions')).some(
          (action) => lower(field(action, 'id')) === 'forwarding_url',
        );
      }
      if (isRulesetCall(entry)) {
        const phase = rulesetPhase(entry);
        if (phase !== undefined && REDIRECT_PHASES.has(phase)) return true;
        return rulesetRules(entry).some((rule) => lower(field(rule, 'action')) === 'redirect');
      }
      if (onPath(entry, 'accounts/*/rules/lists/*/items')) {
        return requestItems(entry).some((item) => field(item, 'redirect') !== undefined);
      }
      return false;
    }),
  },
  {
    id: '990317',
    level: 7,
    title: 'Worker publicado ou rota de Worker alterada',
    tactics: ['Persistence'],
    techniques: ['T1505'],
    levelOf: done(7, (entry) => {
      const verb = verbOf(entry);
      if (
        verb === 'PUT' &&
        onPath(entry, 'accounts/*/workers/scripts/*', 'accounts/*/workers/scripts/*/content')
      ) {
        return true;
      }
      if (verb === 'POST' && onPath(entry, 'accounts/*/workers/scripts/*/deployments')) return true;
      if (verb === 'PUT' && onPath(entry, 'accounts/*/workers/domains')) return true;
      return (
        (isWrite(entry) || isDelete(entry)) &&
        onPath(entry, 'zones/*/workers/routes', 'zones/*/workers/routes/*')
      );
    }),
  },
  {
    id: '990318',
    level: 7,
    title: 'Certificado enviado ou emitido (certificado próprio, Origin CA ou mTLS)',
    tactics: ['Resource Development'],
    techniques: ['T1588.004'],
    levelOf: done(
      7,
      (entry) =>
        verbOf(entry) === 'POST' &&
        onPath(
          entry,
          'zones/*/custom_certificates',
          'certificates',
          'accounts/*/mtls_certificates',
          'zones/*/client_certificates',
          'accounts|zones/*/access/certificates',
          'zones/*/origin_tls_client_auth',
          'zones/*/origin_tls_client_auth/hostnames/certificates',
        ),
    ),
  },
  {
    id: '990319',
    level: 7,
    title: 'Authenticated Origin Pulls desligado',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.007'],
    levelOf: done(7, (entry) => {
      if (settingIs(entry, 'tls_client_auth', 'off')) return true;
      if (!isWrite(entry)) {
        return isDelete(entry) && onPath(entry, 'zones/*/origin_tls_client_auth/*');
      }
      if (onPath(entry, 'zones/*/origin_tls_client_auth/settings')) {
        return field(requestOf(entry), 'enabled') === false;
      }
      if (onPath(entry, 'zones/*/origin_tls_client_auth/hostnames')) {
        return list(field(requestOf(entry), 'config')).some((item) => field(item, 'enabled') === false);
      }
      return false;
    }),
  },
  {
    id: '990320',
    level: 7,
    title: 'Túnel do Cloudflare criado',
    tactics: ['Command and Control'],
    techniques: ['T1572'],
    levelOf: done(
      7,
      (entry) =>
        verbOf(entry) === 'POST' &&
        onPath(entry, 'accounts/*/cfd_tunnel', 'accounts/*/tunnels', 'accounts/*/warp_connector'),
    ),
  },
  {
    id: '990321',
    level: 7,
    title: 'Notificação do Cloudflare desativada ou apagada',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.006'],
    levelOf: done(7, (entry) => {
      if (isDelete(entry)) {
        return onPath(
          entry,
          'accounts/*/alerting/v3/policies/*',
          'accounts/*/alerting/v3/destinations/webhooks/*',
        );
      }
      return (
        isWrite(entry) &&
        onPath(entry, 'accounts/*/alerting/v3/policies/*') &&
        field(requestOf(entry), 'enabled') === false
      );
    }),
  },
  {
    id: '990322',
    level: 12,
    title: 'Bloqueio de transferência do domínio desligado ou nameservers do registrador trocados',
    tactics: ['Resource Development'],
    techniques: ['T1584.001'],
    levelOf: done(12, (entry) => {
      if (!isWrite(entry) || !onPath(entry, 'accounts/*/registrar/domains/*')) return false;
      const request = requestOf(entry);
      return field(request, 'locked') === false || field(request, 'name_servers') !== undefined;
    }),
  },
  {
    id: '990323',
    level: 4,
    title: 'Configuração da conta do Cloudflare alterada',
    tactics: ['Persistence'],
    techniques: ['T1098'],
    levelOf: done(4, (entry) => isWrite(entry) && onPath(entry, 'accounts/*')),
  },
  {
    id: '990324',
    level: 4,
    title: 'Ação feita pela equipe do Cloudflare na conta',
    tactics: ['Initial Access'],
    techniques: ['T1199'],
    levelOf: fixed(4, (entry) => entry.actor?.type?.toLowerCase() === 'cloudflare_admin'),
  },
];

/** A regra que vale para o evento: a de nível mais alto entre as que casam (a primeira da tabela, no empate). */
export function detect(
  entry: AuditEntry,
  rules: readonly CloudflareRule[] = CLOUDFLARE_RULES,
): Detection | null {
  let best: Detection | null = null;
  for (const rule of rules) {
    const level = rule.levelOf(entry);
    if (level !== null && (best === null || level > best.level)) best = { rule, level };
  }
  return best;
}

/** O nome do evento: a descrição do próprio Cloudflare ("Add Member") ou, sem ela, o método e o caminho. */
function eventNameOf(entry: AuditEntry): string | null {
  if (entry.action.description) return entry.action.description;
  const segments = pathSegments(entry);
  if (segments.length === 0) return entry.action.type ?? null;
  return `${verbOf(entry)} /${segments.join('/')}`;
}

/** O recurso tocado: a zona, quando há, ou o produto e o ID do recurso. */
function resourceOf(entry: AuditEntry): string | null {
  if (entry.zone?.name) return entry.zone.name;
  const { id, product, type } = entry.resource ?? {};
  if (id) return `${product ?? type ?? 'recurso'}:${id}`;
  return null;
}

/** De entrada da auditoria a achado, com o cliente decidido pela conta cadastrada (o dono do token). */
export function toCloudflareFindingDraft(
  entry: AuditEntry,
  owner: { tenantId: string; accountId: string },
  detection: Detection,
): FindingDraft {
  const { rule, level } = detection;
  const actor = entry.actor;
  return {
    tenantId: owner.tenantId,
    accountId: owner.accountId,
    source: 'cloudflare',
    sourceEventId: cloudflareEventId(owner.accountId, entry.id),
    occurredAt: new Date(entry.action.time).toISOString(),
    severity: severityOfLevel(level),
    ruleId: rule.id,
    ruleLevel: level,
    title: rule.title,
    logSource: 'cloudflare_audit',
    eventName: eventNameOf(entry),
    region: null,
    resource: resourceOf(entry),
    actorUser: actor?.email ?? actor?.token_name ?? actor?.id ?? null,
    actorType: actor?.type ?? null,
    // O ID do token (não é segredo): junta as ações do mesmo token num incidente.
    accessKeyId: actor?.token_id ?? null,
    sourceIp: actorIp(entry),
    mitreTactics: [...new Set(rule.tactics)].sort(),
    mitreTechniques: [...new Set(rule.techniques)].sort(),
  };
}
