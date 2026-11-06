import { describe, expect, it } from 'vitest';
import {
  auditEntrySchema,
  cloudflareEventId,
  field,
  invalidEntryId,
  parseAuditEntry,
  pathMatches,
  pathSegments,
  verbOf,
} from '../../src/cloudflare/audit-entry.js';
import { CLOUDFLARE_RULES, detect, toCloudflareFindingDraft } from '../../src/cloudflare/cloudflare-rules.js';
import { type AuditFixture, auditLogEntry, hex } from './fixtures.js';

const ACCOUNT = hex(16);
const ZONE = hex(16);
const RULESET = hex(16);
const RULE = hex(16);
const RECORD = hex(16);

type Case = Omit<AuditFixture, 'accountId'>;

const parse = (fixture: Case) => auditEntrySchema.parse(auditLogEntry({ ...fixture, accountId: ACCOUNT }));
const detected = (fixture: Case) => {
  const detection = detect(parse(fixture));
  return detection === null ? null : `${detection.rule.id}@${detection.level}`;
};

/** T1234 ou T1234.567, conferido sem regex com grupo opcional. */
function isTechniqueId(value: string): boolean {
  const [base = '', sub] = value.split('.');
  return /^T\d{4}$/.test(base) && (sub === undefined || /^\d{3}$/.test(sub));
}

describe('regras da auditoria do Cloudflare (990301 a 990324)', () => {
  it('as 24 regras do plano, IDs únicos na faixa 9903xx, com MITRE e título em português', () => {
    const ids = CLOUDFLARE_RULES.map((rule) => rule.id);
    expect(ids).toEqual(Array.from({ length: 24 }, (_, index) => String(990301 + index)));
    for (const rule of CLOUDFLARE_RULES) {
      expect(rule.tactics.length).toBeGreaterThan(0);
      expect(rule.techniques.length).toBeGreaterThan(0);
      expect(rule.techniques.every(isTechniqueId)).toBe(true);
      expect(rule.title.length).toBeLessThanOrEqual(500);
      expect([12, 10, 7, 4]).toContain(rule.level);
    }
  });

  const zone = `/zones/${ZONE}`;
  const account = `/accounts/${ACCOUNT}`;

  it.each<[string, Case, string | null]>([
    // 990301: Logpush
    ['job do Logpush apagado', { method: 'DELETE', uri: `${zone}/logpush/jobs/123` }, '990301@12'],
    [
      'job do Logpush desligado',
      { method: 'PUT', uri: `${account}/logpush/jobs/9`, request: { enabled: false } },
      '990301@12',
    ],
    [
      'destino do Logpush trocado',
      { method: 'PUT', uri: `${zone}/logpush/jobs/9`, request: { destination_conf: 's3://fora/logs' } },
      '990301@12',
    ],
    [
      'Logpush criado para outro destino',
      {
        method: 'POST',
        uri: `${zone}/logpush/jobs`,
        request: { destination_conf: 'r2://outro', enabled: true },
      },
      '990301@12',
    ],
    [
      'Logpush só com o filtro trocado não conta',
      { method: 'PUT', uri: `${zone}/logpush/jobs/9`, request: { filter: '{}' } },
      null,
    ],
    // 990302: WAF e firewall
    [
      'regra do WAF desativada (ruleset de fase de segurança)',
      {
        method: 'PATCH',
        uri: `${zone}/rulesets/${RULESET}/rules/${RULE}`,
        request: { enabled: false },
        response: { result: { phase: 'http_request_firewall_custom' } },
      },
      '990302@10',
    ],
    [
      'regra do WAF apagada',
      {
        method: 'DELETE',
        uri: `${zone}/rulesets/${RULESET}/rules/${RULE}`,
        response: { result: { phase: 'http_request_firewall_managed' } },
      },
      '990302@10',
    ],
    [
      'ponto de entrada do limite de taxa com regra desligada',
      {
        method: 'PUT',
        uri: `${zone}/rulesets/phases/http_ratelimit/entrypoint`,
        request: { rules: [{ expression: 'true', action: 'block', enabled: false }] },
      },
      '990302@10',
    ],
    [
      'regra de cache apagada não é do WAF',
      {
        method: 'DELETE',
        uri: `${zone}/rulesets/${RULESET}/rules/${RULE}`,
        response: { result: { phase: 'http_request_cache_settings' } },
      },
      null,
    ],
    [
      'regra apagada sem fase, mas produto do WAF',
      { method: 'DELETE', uri: `${zone}/rulesets/${RULESET}`, product: 'waf' },
      '990302@10',
    ],
    [
      'regra do firewall antigo apagada',
      { method: 'DELETE', uri: `${zone}/firewall/rules/${RULE}` },
      '990302@10',
    ],
    [
      'regra do firewall antigo pausada (lote)',
      { method: 'PUT', uri: `${zone}/firewall/rules`, request: [{ id: RULE, paused: true }] },
      '990302@10',
    ],
    [
      'lockdown pausado',
      { method: 'PUT', uri: `${zone}/firewall/lockdowns/${RULE}`, request: { paused: true } },
      '990302@10',
    ],
    [
      'limite de taxa antigo desligado',
      { method: 'PUT', uri: `${zone}/rate_limits/${RULE}`, request: { disabled: true } },
      '990302@10',
    ],
    [
      'regra do WAF que falhou não conta',
      {
        method: 'DELETE',
        uri: `${zone}/rulesets/${RULESET}/rules/${RULE}`,
        result: 'failure',
        statusCode: 403,
        response: { result: { phase: 'http_request_firewall_custom' } },
      },
      null,
    ],
    // 990303: liberação
    [
      'IP liberado por regra de acesso',
      {
        method: 'POST',
        uri: `${account}/firewall/access_rules/rules`,
        request: { mode: 'whitelist', configuration: { target: 'ip', value: '198.51.100.7' } },
      },
      '990303@10',
    ],
    [
      'bloqueio por regra de acesso não é liberação',
      {
        method: 'POST',
        uri: `${zone}/firewall/access_rules/rules`,
        request: { mode: 'block', configuration: { target: 'country', value: 'XX' } },
      },
      null,
    ],
    [
      'regra "skip" criada no WAF',
      {
        method: 'POST',
        uri: `${zone}/rulesets/${RULESET}/rules`,
        request: {
          action: 'skip',
          expression: 'ip.src eq 198.51.100.7',
          action_parameters: { ruleset: 'current' },
        },
        response: { result: { phase: 'http_request_firewall_custom' } },
      },
      '990303@10',
    ],
    [
      'regra "allow" no firewall antigo',
      { method: 'POST', uri: `${zone}/firewall/rules`, request: [{ action: 'allow', filter: { id: RULE } }] },
      '990303@10',
    ],
    // 990304 e 990305: configurações da zona
    [
      'nível de segurança "essentially_off"',
      { method: 'PATCH', uri: `${zone}/settings/security_level`, request: { value: 'essentially_off' } },
      '990304@7',
    ],
    [
      'WAF desligado na zona',
      { method: 'PATCH', uri: `${zone}/settings/waf`, request: { value: 'off' } },
      '990304@7',
    ],
    [
      'TLS mínimo 1.0',
      { method: 'PATCH', uri: `${zone}/settings/min_tls_version`, request: { value: '1.0' } },
      '990304@7',
    ],
    [
      'HSTS desligado',
      {
        method: 'PATCH',
        uri: `${zone}/settings/security_header`,
        request: { value: { strict_transport_security: { enabled: false, max_age: 0 } } },
      },
      '990304@7',
    ],
    [
      'nível de segurança "high" não reduz',
      { method: 'PATCH', uri: `${zone}/settings/security_level`, request: { value: 'high' } },
      null,
    ],
    [
      'em lote: "always_use_https" desligado e SSL "flexible" (a regra mais alta vale)',
      {
        method: 'PATCH',
        uri: `${zone}/settings`,
        request: {
          items: [
            { id: 'always_use_https', value: 'off' },
            { id: 'ssl', value: 'flexible' },
          ],
        },
      },
      '990305@10',
    ],
    ['SSL "off"', { method: 'PATCH', uri: `${zone}/settings/ssl`, request: { value: 'off' } }, '990305@10'],
    [
      'SSL "strict" não rebaixa',
      { method: 'PATCH', uri: `${zone}/settings/ssl`, request: { value: 'strict' } },
      null,
    ],
    // 990306 e 990307: zona
    ['zona apagada', { method: 'DELETE', uri: zone }, '990306@12'],
    ['zona pausada', { method: 'PATCH', uri: zone, request: { paused: true } }, '990307@10'],
    [
      'registro DNS tirado do proxy (nível 7)',
      { method: 'PATCH', uri: `${zone}/dns_records/${RECORD}`, request: { proxied: false } },
      '990307@7',
    ],
    [
      'registro DNS novo só de DNS não é tirar do proxy',
      {
        method: 'POST',
        uri: `${zone}/dns_records`,
        request: { type: 'A', name: 'interno', content: '192.0.2.1', proxied: false },
      },
      '990309@4',
    ],
    // 990308 e 990309: DNS
    ['registro DNS apagado', { method: 'DELETE', uri: `${zone}/dns_records/${RECORD}` }, '990308@10'],
    [
      'lote com registro apagado',
      { method: 'POST', uri: `${zone}/dns_records/batch`, request: { deletes: [{ id: RECORD }] } },
      '990308@10',
    ],
    [
      'MX do domínio raiz trocado',
      {
        method: 'PUT',
        uri: `${zone}/dns_records/${RECORD}`,
        request: { type: 'MX', name: 'loja.exemplo.com.br', content: 'mx.exemplo.net', priority: 10 },
      },
      '990308@10',
    ],
    [
      'NS criado num subdomínio (delegação)',
      {
        method: 'POST',
        uri: `${zone}/dns_records`,
        request: { type: 'NS', name: 'sub', content: 'ns.exemplo.net' },
      },
      '990308@10',
    ],
    [
      'CNAME num subdomínio é só alteração',
      {
        method: 'POST',
        uri: `${zone}/dns_records`,
        request: { type: 'CNAME', name: 'www', content: 'loja' },
      },
      '990309@4',
    ],
    ['importação de zona', { method: 'POST', uri: `${zone}/dns_records/import` }, '990309@4'],
    // 990310: DNSSEC
    [
      'DNSSEC desativado',
      { method: 'PATCH', uri: `${zone}/dnssec`, request: { status: 'disabled' } },
      '990310@10',
    ],
    ['DNSSEC apagado', { method: 'DELETE', uri: `${zone}/dnssec` }, '990310@10'],
    [
      'DNSSEC ativado não conta',
      { method: 'PATCH', uri: `${zone}/dnssec`, request: { status: 'active' } },
      null,
    ],
    // 990311: tokens
    [
      'token de leitura criado (nível 7)',
      {
        method: 'POST',
        uri: `${account}/tokens`,
        zone: null,
        request: { name: 'leitura', policies: [{ permission_groups: [{ id: hex(16), name: 'Zone Read' }] }] },
      },
      '990311@7',
    ],
    [
      'token com permissão de edição (nível 10)',
      {
        method: 'POST',
        uri: `${account}/tokens`,
        zone: null,
        request: { name: 'deploy', policies: [{ permission_groups: [{ id: hex(16), name: 'DNS Write' }] }] },
      },
      '990311@10',
    ],
    [
      'token renovado (roll)',
      { method: 'PUT', uri: `${account}/tokens/${hex(16)}/value`, zone: null },
      '990311@7',
    ],
    // 990312 e 990313: membros
    [
      'membro convidado',
      { method: 'POST', uri: `${account}/members`, zone: null, request: { email: 'nova@exemplo.com.br' } },
      '990312@7',
    ],
    [
      'membro convidado como Super Administrator',
      {
        method: 'POST',
        uri: `${account}/members`,
        zone: null,
        request: { email: 'nova@exemplo.com.br', roles: [hex(16)] },
        response: { result: { roles: [{ id: hex(16), name: 'Super Administrator - All Privileges' }] } },
      },
      '990313@12',
    ],
    [
      'papel de administrador dado a um membro',
      {
        method: 'PUT',
        uri: `${account}/members/${hex(16)}`,
        zone: null,
        request: { roles: [{ id: hex(16), name: 'Administrator' }] },
      },
      '990313@12',
    ],
    [
      'papel "Administrator Read Only" não é de administrador',
      {
        method: 'PUT',
        uri: `${account}/members/${hex(16)}`,
        zone: null,
        request: { roles: [{ id: hex(16), name: 'Administrator Read Only' }] },
      },
      null,
    ],
    // 990314 e 990323: conta
    [
      'exigência de 2FA desligada',
      { method: 'PUT', uri: account, zone: null, request: { settings: { enforce_twofactor: false } } },
      '990314@12',
    ],
    [
      'outra configuração da conta',
      { method: 'PUT', uri: account, zone: null, request: { name: 'Conta fictícia 2' } },
      '990323@4',
    ],
    // 990315: Access
    [
      'aplicação do Access apagada',
      { method: 'DELETE', uri: `${account}/access/apps/${hex(16)}`, zone: null },
      '990315@10',
    ],
    [
      'política do Access com "bypass"',
      {
        method: 'POST',
        uri: `${account}/access/apps/${hex(16)}/policies`,
        zone: null,
        request: { decision: 'bypass', include: [{ ip: { ip: '198.51.100.0/24' } }] },
      },
      '990315@10',
    ],
    [
      'política reutilizável aberta para todos',
      {
        method: 'PUT',
        uri: `${account}/access/policies/${hex(16)}`,
        zone: null,
        request: { decision: 'allow', include: [{ everyone: {} }] },
      },
      '990315@10',
    ],
    [
      'política do Access restrita a um e-mail não conta',
      {
        method: 'POST',
        uri: `${account}/access/apps/${hex(16)}/policies`,
        zone: null,
        request: { decision: 'allow', include: [{ email: { email: 'pessoa@exemplo.com.br' } }] },
      },
      null,
    ],
    // 990316: redirecionamentos
    [
      'Page Rule de encaminhamento',
      {
        method: 'POST',
        uri: `${zone}/pagerules`,
        request: {
          actions: [{ id: 'forwarding_url', value: { url: 'https://exemplo.net', status_code: 301 } }],
        },
      },
      '990316@7',
    ],
    [
      'Redirect Rule (ponto de entrada da fase de redirecionamento)',
      {
        method: 'PUT',
        uri: `${zone}/rulesets/phases/http_request_dynamic_redirect/entrypoint`,
        request: { rules: [] },
      },
      '990316@7',
    ],
    [
      'Bulk Redirect (itens da lista)',
      {
        method: 'POST',
        uri: `${account}/rules/lists/${hex(16)}/items`,
        zone: null,
        request: [{ redirect: { source_url: 'loja.exemplo.com.br/', target_url: 'https://exemplo.net' } }],
      },
      '990316@7',
    ],
    // 990317 a 990322
    [
      'Worker publicado',
      { method: 'PUT', uri: `${account}/workers/scripts/meu-worker`, zone: null },
      '990317@7',
    ],
    ['rota de Worker criada', { method: 'POST', uri: `${zone}/workers/routes` }, '990317@7'],
    ['certificado próprio enviado', { method: 'POST', uri: `${zone}/custom_certificates` }, '990318@7'],
    ['certificado da Origin CA emitido', { method: 'POST', uri: '/certificates', zone: null }, '990318@7'],
    [
      'Authenticated Origin Pulls desligado',
      { method: 'PUT', uri: `${zone}/origin_tls_client_auth/settings`, request: { enabled: false } },
      '990319@7',
    ],
    [
      'Authenticated Origin Pulls desligado pela configuração da zona',
      { method: 'PATCH', uri: `${zone}/settings/tls_client_auth`, request: { value: 'off' } },
      '990319@7',
    ],
    ['túnel criado', { method: 'POST', uri: `${account}/cfd_tunnel`, zone: null }, '990320@7'],
    [
      'notificação apagada',
      { method: 'DELETE', uri: `${account}/alerting/v3/policies/${hex(16)}`, zone: null },
      '990321@7',
    ],
    [
      'notificação desativada',
      {
        method: 'PUT',
        uri: `${account}/alerting/v3/policies/${hex(16)}`,
        zone: null,
        request: { enabled: false },
      },
      '990321@7',
    ],
    [
      'bloqueio de transferência do domínio desligado',
      {
        method: 'PUT',
        uri: `${account}/registrar/domains/loja.exemplo.com.br`,
        zone: null,
        request: { locked: false },
      },
      '990322@12',
    ],
    [
      'renovação automática do domínio não conta',
      {
        method: 'PUT',
        uri: `${account}/registrar/domains/loja.exemplo.com.br`,
        zone: null,
        request: { auto_renew: true },
      },
      null,
    ],
    // 990324: equipe do Cloudflare
    [
      'ação da equipe do Cloudflare',
      { method: 'GET', uri: `${zone}/settings`, actor: { type: 'cloudflare_admin', email: null } },
      '990324@4',
    ],
    [
      'equipe do Cloudflare apagando a zona: a regra mais alta vale',
      { method: 'DELETE', uri: zone, actor: { type: 'cloudflare_admin' } },
      '990306@12',
    ],
    // Nada
    ['leitura (GET) não é mudança', { method: 'GET', uri: `${zone}/dns_records` }, null],
    ['caminho desconhecido', { method: 'POST', uri: `${account}/coisa/nova` }, null],
  ])('%s', (_name, fixture, expected) => {
    expect(detected(fixture)).toBe(expected);
  });

  it('o caminho vem sem a query, sem o host e sem o prefixo /client/v4 ou /api/v4', () => {
    expect(
      detected({ method: 'DELETE', uri: `https://api.cloudflare.com/client/v4/zones/${ZONE}?x=1` }),
    ).toBe('990306@12');
    expect(detected({ method: 'DELETE', uri: `/api/v4/zones/${ZONE}` })).toBe('990306@12');
    expect(detected({ method: 'DELETE', uri: `/client/v4/zones/${ZONE}/dns_records/${RECORD}#x` })).toBe(
      '990308@10',
    );
  });

  it('sem o método, vale o tipo da ação', () => {
    const entry = parse({ uri: `/zones/${ZONE}` });
    expect(
      verbOf({
        ...entry,
        raw: { ...entry.raw, method: undefined },
        action: { ...entry.action, type: 'delete' },
      }),
    ).toBe('DELETE');
    expect(verbOf({ ...entry, raw: undefined, action: { ...entry.action, type: 'visualizar' } })).toBe(
      'OTHER',
    );
  });

  it('padrões de caminho: curinga, alternativas e resto', () => {
    const segments = pathSegments({ raw: { uri: `/zones/${ZONE}/rulesets/${RULESET}/rules/${RULE}` } });
    expect(pathMatches(segments, 'accounts|zones/*/rulesets/*/rules/*')).toBe(true);
    expect(pathMatches(segments, 'zones/*/rulesets/**')).toBe(true);
    expect(pathMatches(segments, 'zones/*/rulesets/*')).toBe(false);
    expect(pathMatches(segments, 'accounts/*/rulesets/*/rules/*')).toBe(false);
    expect(pathSegments({ raw: undefined })).toEqual([]);
  });

  it('o corpo é lido só pelas chaves próprias: nada do protótipo, nem por __proto__ ou constructor', () => {
    expect(field({ settings: { enforce_twofactor: false } }, 'settings', 'enforce_twofactor')).toBe(false);
    expect(field({}, 'constructor')).toBeUndefined();
    expect(field({}, 'toString')).toBeUndefined();
    expect(field({ a: 1 }, '__proto__', 'constructor')).toBeUndefined();
    expect(field([{ a: 1 }], '0', 'a')).toBeUndefined();
    expect(field('texto', 'length')).toBeUndefined();
    expect(field({ a: { b: 2 } })).toEqual({ a: { b: 2 } });
    // Um "__proto__" que veio no JSON é chave própria (JSON.parse não toca no protótipo) e é lido como dado.
    expect(field(JSON.parse('{"__proto__": {"enabled": false}}'), '__proto__', 'enabled')).toBe(false);
    expect(({} as Record<string, unknown>)['enabled']).toBeUndefined();
  });
});

describe('entrada da auditoria (zod)', () => {
  it('recusa a entrada sem id ou sem horário, e devolve o id quando ele é aproveitável', () => {
    const valid = auditLogEntry({ accountId: ACCOUNT });
    expect(parseAuditEntry(valid).ok).toBe(true);
    const { id, ...withoutId } = valid;
    expect(parseAuditEntry(withoutId)).toEqual({ ok: false, id: null });
    expect(parseAuditEntry({ ...valid, action: { type: 'create' } })).toEqual({ ok: false, id });
    expect(parseAuditEntry({ ...valid, id: 'com espaço' })).toEqual({ ok: false, id: null });
    expect(parseAuditEntry('texto')).toEqual({ ok: false, id: null });
    expect(parseAuditEntry(null)).toEqual({ ok: false, id: null });
  });

  it('corta texto grande em vez de recusar, e aceita null nos campos opcionais', () => {
    const entry = auditLogEntry({ accountId: ACCOUNT });
    const parsed = auditEntrySchema.parse({
      ...entry,
      actor: { ...(entry.actor as object), email: null, token_name: 'x'.repeat(10_000) },
      raw: { ...(entry.raw as object), user_agent: 'y'.repeat(100_000), uri: null },
      zone: null,
    });
    expect(parsed.actor?.token_name).toHaveLength(256);
    expect(parsed.actor?.email).toBeUndefined();
    expect(parsed.raw?.user_agent).toHaveLength(512);
    expect(parsed.zone).toBeUndefined();
  });

  it('o corpo da requisição em texto é lido como JSON, e só até 64 KB', () => {
    const entry = auditLogEntry({ accountId: ACCOUNT });
    const parsed = auditEntrySchema.parse({
      ...entry,
      resource: { ...(entry.resource as object), request: '{"enabled": false}' },
    });
    expect(parsed.resource?.request).toEqual({ enabled: false });
    const huge = auditEntrySchema.parse({
      ...entry,
      resource: { ...(entry.resource as object), request: `{"a":"${'z'.repeat(70_000)}"}` },
    });
    expect(huge.resource?.request).toBeUndefined();
  });

  it('chaves estáveis: cf/<conta>/<id> e, sem id, o resumo do conteúdo', () => {
    expect(cloudflareEventId(ACCOUNT, 'abc')).toBe(`cf/${ACCOUNT}/abc`);
    const invalid = { action: { time: 'ontem' } };
    expect(invalidEntryId(ACCOUNT, invalid)).toBe(invalidEntryId(ACCOUNT, { action: { time: 'ontem' } }));
    const key = invalidEntryId(ACCOUNT, invalid);
    expect(key.startsWith(`cf/${ACCOUNT}/invalido:`)).toBe(true);
    expect(key.split(':')[1]).toMatch(/^[0-9a-f]{40}$/);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(invalidEntryId(ACCOUNT, { action: { time: 'amanhã' } })).not.toBe(key);
  });
});

describe('de entrada a achado', () => {
  it('campos do achado: conta, chave, ator (e-mail ou nome do token), ID do token, IP, zona e MITRE', () => {
    const tokenId = hex(16);
    const entry = parse({
      id: 'entrada-1',
      method: 'DELETE',
      uri: `/zones/${ZONE}`,
      description: 'Delete zone',
      time: '2026-11-04T10:00:00.123Z',
      actor: {
        email: null,
        token_name: 'automacao',
        token_id: tokenId,
        context: 'api_token',
        type: 'account',
      },
    });
    const detection = detect(entry);
    expect(detection).not.toBeNull();
    if (!detection) return;
    expect(toCloudflareFindingDraft(entry, { tenantId: 'cliente', accountId: ACCOUNT }, detection)).toEqual({
      tenantId: 'cliente',
      accountId: ACCOUNT,
      source: 'cloudflare',
      sourceEventId: `cf/${ACCOUNT}/entrada-1`,
      occurredAt: '2026-11-04T10:00:00.123Z',
      severity: 'critical',
      ruleId: '990306',
      ruleLevel: 12,
      title: 'Zona apagada',
      logSource: 'cloudflare_audit',
      eventName: 'Delete zone',
      region: null,
      resource: 'loja.exemplo.com.br',
      actorUser: 'automacao',
      actorType: 'account',
      accessKeyId: tokenId,
      sourceIp: '203.0.113.10',
      mitreTactics: ['Impact'],
      mitreTechniques: ['T1485'],
    });
  });

  it('nível dinâmico vira a severidade (registro fora do proxy: média); IP inválido fica de fora', () => {
    const entry = parse({
      method: 'PATCH',
      uri: `/zones/${ZONE}/dns_records/${RECORD}`,
      request: { proxied: false },
      description: undefined,
      actor: { ip_address: 'interno' },
      zone: null,
    });
    const detection = detect(entry);
    if (!detection) throw new Error('a regra deveria casar');
    const draft = toCloudflareFindingDraft(entry, { tenantId: 'cliente', accountId: ACCOUNT }, detection);
    expect(draft).toMatchObject({ ruleId: '990307', ruleLevel: 7, severity: 'medium', sourceIp: null });
    expect(draft.resource).toMatch(/^fictício:/);
  });
});
