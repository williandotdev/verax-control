import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CloudflareApiError,
  CloudflareClient,
  graphqlErrorCode,
} from '../../src/cloudflare/cloudflare.client.js';
import {
  CLOUDFLARE_SECURITY_RULES,
  detectWindow,
  isLoginPath,
  loginIpsOf,
  normalizeValue,
  rateLimitedIps,
  SECURITY_MAX_IP_FINDINGS,
  type SecurityRule,
  toSecurityFindingDraft,
} from '../../src/cloudflare/cloudflare-security-rules.js';
import {
  batchLayout,
  decodeState,
  encodeState,
  eventsQueryNodes,
  eventsRequest,
  lastReadableWindowEnd,
  nextReadableAt,
  parseEvents,
  parseSettings,
  pathsRequest,
  QueryBudget,
  retentionFloor,
  type SecurityGroup,
  securityEventId,
  settingsRequest,
  usableLimits,
  windowCeil,
  windowStartOf,
  type ZoneEvents,
} from '../../src/cloudflare/security-events.js';
import { CloudflareToken } from '../../src/credentials/credential-vault.js';
import { fakeCloudflare, FakeCloudflareServer } from '../support/fake-cloudflare.js';

const ACCOUNT = fakeCloudflare.accountId();
const ZONE = fakeCloudflare.zoneTag(ACCOUNT, 'loja.exemplo.com.br');
const OTHER_ZONE = fakeCloudflare.zoneTag(ACCOUNT, 'blog.exemplo.com.br');
const T = (iso: string) => new Date(iso);

const group = (overrides: Partial<SecurityGroup> = {}): SecurityGroup => ({
  action: 'block',
  source: 'firewallCustom',
  clientIP: '198.51.100.7',
  host: 'loja.exemplo.com.br',
  count: 1,
  ...overrides,
});

const zoneEvents = (groups: SecurityGroup[], baselineCount: number | null = null): ZoneEvents => ({
  zoneTag: ZONE,
  groups,
  truncated: false,
  baselineCount,
});

const detect = (
  groups: SecurityGroup[],
  { baseline = null as number | null, loginIps = new Set<string>(), rules = CLOUDFLARE_SECURITY_RULES } = {},
) => detectWindow({ zone: zoneEvents(groups, baseline), baselineWindows: 96, loginIps }, rules);

const ruleIds = (groups: SecurityGroup[], options?: Parameters<typeof detect>[1]) =>
  detect(groups, options).detections.map((detection) => [detection.rule.id, detection.hit.level]);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CloudflareApiError) return error.code;
    throw error;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe('eventos de segurança do Cloudflare: janelas, consultas e chaves', () => {
  it('janelas de 15 min alinhadas em UTC, lidas 5 min depois de fechar', () => {
    expect(windowStartOf(T('2026-11-04T12:14:59.999Z'))).toEqual(T('2026-11-04T12:00:00Z'));
    expect(windowStartOf(T('2026-11-04T12:15:00.000Z'))).toEqual(T('2026-11-04T12:15:00Z'));
    expect(windowCeil(T('2026-11-04T12:00:00.001Z'))).toEqual(T('2026-11-04T12:15:00Z'));
    expect(windowCeil(T('2026-11-04T12:15:00Z'))).toEqual(T('2026-11-04T12:15:00Z'));
    // 12:19:59: a janela 12:00-12:15 fechou há menos de 5 min; a última que dá para ler termina às 12:00.
    expect(lastReadableWindowEnd(T('2026-11-04T12:19:59Z'))).toEqual(T('2026-11-04T12:00:00Z'));
    expect(lastReadableWindowEnd(T('2026-11-04T12:20:00Z'))).toEqual(T('2026-11-04T12:15:00Z'));
    // Virada do dia em UTC.
    expect(lastReadableWindowEnd(T('2026-11-05T00:04:00Z'))).toEqual(T('2026-11-04T23:45:00Z'));
    expect(nextReadableAt(T('2026-11-04T12:15:00Z'))).toEqual(T('2026-11-04T12:35:00Z'));
  });

  it('chave do achado estável e distinta por regra, zona, IP e janela', () => {
    const start = T('2026-11-04T12:00:00Z');
    const id = securityEventId(ACCOUNT, '990330', ZONE, '198.51.100.7', start);
    expect(id.startsWith(`cf/${ACCOUNT}/sec:`)).toBe(true);
    expect(/^[0-9a-f]{40}$/.test(id.slice(`cf/${ACCOUNT}/sec:`.length))).toBe(true);
    expect(id).toHaveLength(80);
    expect(securityEventId(ACCOUNT, '990330', ZONE, '198.51.100.7', T('2026-11-04T12:00:00.000Z'))).toBe(id);
    const others = [
      securityEventId(ACCOUNT, '990331', ZONE, '198.51.100.7', start),
      securityEventId(ACCOUNT, '990330', OTHER_ZONE, '198.51.100.7', start),
      securityEventId(ACCOUNT, '990330', ZONE, '198.51.100.8', start),
      securityEventId(ACCOUNT, '990330', ZONE, '198.51.100.7', T('2026-11-04T12:15:00Z')),
      securityEventId(fakeCloudflare.accountId(), '990330', ZONE, '198.51.100.7', start),
    ];
    expect(new Set([id, ...others]).size).toBe(6);
  });

  it('consulta dos eventos: valores nas variáveis, limite conferido, a base só quando pedida', () => {
    const query = {
      zoneTags: [ZONE, OTHER_ZONE],
      since: T('2026-11-04T12:00:00Z'),
      until: T('2026-11-04T12:15:00Z'),
      limit: 500,
      baselineSince: T('2026-11-03T12:00:00Z'),
    };
    const request = eventsRequest(query);
    expect(request.variables).toEqual({
      zoneTags: [ZONE, OTHER_ZONE],
      since: '2026-11-04T12:00:00Z',
      until: '2026-11-04T12:15:00Z',
      baselineSince: '2026-11-03T12:00:00Z',
    });
    expect(request.query).toContain('firewallEventsAdaptiveGroups');
    expect(request.query).toContain('zoneTag_in: $zoneTags');
    expect(request.query).toContain('limit: 500');
    expect(request.query).toContain('clientRequestHTTPHost');
    expect(request.query).toContain('baseline:');
    expect(eventsQueryNodes(query)).toBe(2);
    const plain = eventsRequest({ ...query, baselineSince: null });
    expect(plain.query).not.toContain('baseline');
    expect(plain.variables).not.toHaveProperty('baselineSince');
    expect(eventsQueryNodes({ baselineSince: null })).toBe(1);

    // Nada de fora do formato entra na consulta.
    for (const zoneTags of [[], ['LOJA'], Array.from({ length: 11 }, () => ZONE), [`${ZONE}"`]]) {
      expect(() => eventsRequest({ ...query, zoneTags })).toThrow(RangeError);
    }
    for (const limit of [0, 1001, 1.5, Number.NaN]) {
      expect(() => eventsRequest({ ...query, limit })).toThrow(RangeError);
    }
    expect(settingsRequest([ZONE]).variables).toEqual({ zoneTags: [ZONE] });
    expect(() => settingsRequest([])).toThrow(RangeError);
    const paths = pathsRequest({ ...query, clientIPs: ['198.51.100.7'], limit: 10 });
    expect(paths.variables).toMatchObject({ clientIPs: ['198.51.100.7'] });
    expect(paths.query).toContain('clientIP_in: $clientIPs');
    expect(() => pathsRequest({ ...query, clientIPs: [], limit: 10 })).toThrow(RangeError);
  });

  it('resposta dos eventos validada: formato, zona não pedida ou repetida, linhas além do limite', () => {
    const query = {
      zoneTags: [ZONE],
      since: T('2026-11-04T12:00:00Z'),
      until: T('2026-11-04T12:15:00Z'),
      limit: 2,
      baselineSince: T('2026-11-03T12:00:00Z'),
    };
    const row = (count: number, ip = '198.51.100.7') => ({
      count,
      dimensions: {
        action: 'block',
        source: 'waf',
        clientIP: ip,
        clientRequestHTTPHost: 'loja.exemplo.com.br',
      },
    });
    const ok = {
      viewer: {
        zones: [{ zoneTag: ZONE, events: [row(5), row(3, '198.51.100.8')], baseline: [{ count: 7 }] }],
      },
    };
    expect(parseEvents(ok, query)).toEqual([
      {
        zoneTag: ZONE,
        groups: [
          { action: 'block', source: 'waf', clientIP: '198.51.100.7', host: 'loja.exemplo.com.br', count: 5 },
          { action: 'block', source: 'waf', clientIP: '198.51.100.8', host: 'loja.exemplo.com.br', count: 3 },
        ],
        // Bateu no limite de linhas: as contagens são piso.
        truncated: true,
        baselineCount: 7,
      },
    ]);
    expect(
      parseEvents({ viewer: { zones: [{ zoneTag: ZONE, events: [], baseline: [] }] } }, query)?.[0],
    ).toMatchObject({
      truncated: false,
      baselineCount: 0,
    });
    const bad = [
      null,
      { viewer: {} },
      { viewer: { zones: [{ zoneTag: OTHER_ZONE, events: [], baseline: [] }] } },
      {
        viewer: {
          zones: [
            { zoneTag: ZONE, events: [], baseline: [] },
            { zoneTag: ZONE, events: [], baseline: [] },
          ],
        },
      },
      { viewer: { zones: [{ zoneTag: ZONE, events: [row(-1)], baseline: [] }] } },
      { viewer: { zones: [{ zoneTag: ZONE, events: [row(1.5)], baseline: [] }] } },
      { viewer: { zones: [{ zoneTag: ZONE, events: [row(1), row(1), row(1)], baseline: [] }] } },
      {
        viewer: {
          zones: [{ zoneTag: ZONE, events: [{ count: 1, dimensions: { action: 'block' } }], baseline: [] }],
        },
      },
      { viewer: { zones: [{ zoneTag: ZONE, events: [] }] } },
      { viewer: { zones: [{ zoneTag: 'loja', events: [], baseline: [] }] } },
    ];
    for (const data of bad) expect(parseEvents(data, query)).toBeNull();
    // Texto longo é cortado, não recusado.
    const long = parseEvents(
      {
        viewer: {
          zones: [
            {
              zoneTag: ZONE,
              events: [{ ...row(1), dimensions: { ...row(1).dimensions, action: 'x'.repeat(500) } }],
              baseline: [],
            },
          ],
        },
      },
      query,
    );
    expect(long?.[0]?.groups[0]?.action).toHaveLength(64);
  });

  it('limites de cada zona pelo nó settings', () => {
    const limits = { enabled: true, maxDuration: 259_200, maxPageSize: 10_000, notOlderThan: 2_678_400 };
    const parsed = parseSettings(
      {
        viewer: {
          zones: [
            { zoneTag: ZONE, settings: { firewallEventsAdaptiveGroups: limits } },
            { zoneTag: OTHER_ZONE, settings: { firewallEventsAdaptiveGroups: null } },
          ],
        },
      },
      [ZONE, OTHER_ZONE],
    );
    expect(parsed?.get(ZONE)).toEqual(limits);
    // Sem o nó: sem acesso ao conjunto de dados.
    expect(parsed?.get(OTHER_ZONE)?.enabled).toBe(false);
    expect(
      parseSettings({ viewer: { zones: [{ zoneTag: OTHER_ZONE, settings: null }] } }, [ZONE]),
    ).toBeNull();
    expect(
      parseSettings(
        {
          viewer: {
            zones: [{ zoneTag: ZONE, settings: { firewallEventsAdaptiveGroups: { enabled: 'sim' } } }],
          },
        },
        [ZONE],
      ),
    ).toBeNull();

    expect(usableLimits(limits)).toBe(true);
    expect(usableLimits({ ...limits, enabled: false })).toBe(false);
    expect(usableLimits({ ...limits, maxDuration: 600 })).toBe(false);
    expect(usableLimits({ ...limits, maxPageSize: 0 })).toBe(false);
    expect(usableLimits({ ...limits, notOlderThan: 1800 })).toBe(false);
    const now = T('2026-11-04T12:00:00Z');
    expect(retentionFloor({ ...limits, notOlderThan: 86_400 }, now)).toEqual(T('2026-11-03T12:15:00Z'));
  });

  it('orçamento de consultas: 250 em qualquer intervalo de 5 min, em baldes de um minuto', () => {
    const at = (minutes: number, seconds = 0) => new Date(Date.UTC(2026, 10, 4, 12, minutes, seconds));
    const budget = new QueryBudget(250);
    expect(budget.take(200, at(0, 59))).toBe(true);
    expect(budget.take(51, at(1))).toBe(false);
    expect(budget.take(50, at(1))).toBe(true);
    expect(budget.spent(at(5, 59))).toBe(250);
    // O balde do minuto 0 só sai no minuto 6: um intervalo de 5 min começando em 0:59 ainda o pega até 5:59.
    expect(budget.take(1, at(5, 59))).toBe(false);
    expect(budget.availableAt(150, at(2))).toEqual(at(6));
    expect(budget.availableAt(250, at(2))).toEqual(at(7));
    // No minuto 6, só o balde do minuto 1 (50) ainda conta.
    expect(budget.spent(at(6))).toBe(50);
    expect(budget.take(150, at(6))).toBe(true);
    expect(budget.take(51, at(6))).toBe(false);
    expect(budget.take(50, at(6))).toBe(true);
    expect(() => budget.take(0, at(6))).toThrow(RangeError);
    expect(budget.take(251, at(30))).toBe(false);

    // O estado gravado volta igual.
    const restored = new QueryBudget(250, budget.snapshot(at(6)));
    expect(restored.spent(at(6))).toBe(250);
    expect(restored.take(1, at(6))).toBe(false);
    // Depois de um 429, nada sai antes de o orçamento voltar.
    const limited = new QueryBudget(250);
    limited.take(10, at(0));
    limited.exhaust(at(0));
    expect(limited.take(1, at(5, 59))).toBe(false);
    expect(limited.take(250, at(6))).toBe(true);
  });

  it('estado do fluxo: orçamento e progresso da janela, e o fora do formato vira estado vazio', () => {
    const state = {
      budget: [[29_000_000, 12] as [number, number]],
      progress: {
        windowStart: T('2026-11-04T12:00:00Z'),
        done: 2,
        layout: batchLayout([[ZONE], [OTHER_ZONE]]),
      },
    };
    expect(decodeState(encodeState(state))).toEqual(state);
    expect(decodeState(encodeState({ budget: [], progress: null }))).toEqual({ budget: [], progress: null });
    for (const text of [
      null,
      '',
      'x',
      '{}',
      '{"v":2,"b":[]}',
      '{"v":1,"b":[[1,999]]}',
      '{"v":1,"b":[],"extra":1}',
    ]) {
      expect(decodeState(text)).toEqual({ budget: [], progress: null });
    }
    expect(batchLayout([[ZONE], [OTHER_ZONE]])).not.toBe(batchLayout([[ZONE, OTHER_ZONE]]));
  });

  it('erros do GraphQL viram um código, pela mensagem documentada', () => {
    expect(graphqlErrorCode(['rate limiter budget depleted, try again after 5 minutes'])).toBe(
      'rate_limited',
    );
    expect(graphqlErrorCode(['not authorized for that account'])).toBe('security_events_forbidden');
    expect(graphqlErrorCode([`zones ["${ZONE}"] are not authorized`])).toBe('security_events_forbidden');
    expect(graphqlErrorCode([`zone '${ZONE}' does not have access to the path`])).toBe(
      'security_events_not_entitled',
    );
    expect(graphqlErrorCode(['cannot request data older than 2678400s'])).toBe('security_events_expired');
    expect(graphqlErrorCode(['too many queries in progress, please try again later'])).toBe(
      'graphql_unavailable',
    );
    expect(graphqlErrorCode(['unknown field "x"'])).toBe('graphql_rejected');
    expect(graphqlErrorCode(['query time range is too large'])).toBe('graphql_rejected');
    expect(graphqlErrorCode(['algo novo'])).toBe('graphql_error');
    // Mais de um erro: o limite manda.
    expect(graphqlErrorCode(['does not have access to the path', 'rate limiter budget depleted'])).toBe(
      'rate_limited',
    );
  });
});

describe('regras 990330 a 990335', () => {
  it('grafias diferentes da ação e da origem valem o mesmo', () => {
    expect(normalizeValue('managed_challenge')).toBe('managedchallenge');
    expect(normalizeValue('managedChallenge')).toBe('managedchallenge');
    expect(normalizeValue('firewallManaged')).toBe('firewallmanaged');
    expect(normalizeValue('L7DDoS')).toBe('l7ddos');
  });

  it('990330: rajada de bloqueios de um IP (500; nível 10 a partir de 5000), somando hosts e ações de bloqueio', () => {
    expect(ruleIds([group({ count: 499 })])).toEqual([]);
    expect(
      ruleIds([
        group({ count: 300 }),
        group({ action: 'connection_close', host: 'api.exemplo.com.br', count: 200 }),
      ]),
    ).toEqual([['990330', 7]]);
    expect(ruleIds([group({ count: 5000 })])).toEqual([['990330', 10]]);
    // Desafio e registro não são bloqueio.
    expect(
      ruleIds([group({ action: 'managed_challenge', count: 900 }), group({ action: 'log', count: 900 })]),
    ).toEqual([]);
    // IPs diferentes não somam.
    expect(ruleIds([group({ count: 300 }), group({ clientIP: '198.51.100.8', count: 300 })])).toEqual([]);
  });

  it('990331: WAF gerenciado barrando um IP (20 ou mais), bloqueio ou desafio; registro não conta', () => {
    expect(ruleIds([group({ source: 'firewallManaged', count: 19 })])).toEqual([]);
    expect(
      ruleIds([
        group({ source: 'firewallManaged', count: 10 }),
        group({ source: 'waf', action: 'challenge', count: 10 }),
      ]),
    ).toEqual([['990331', 7]]);
    expect(ruleIds([group({ source: 'firewallManaged', action: 'log', count: 100 })])).toEqual([]);
    expect(ruleIds([group({ source: 'firewallCustom', count: 100 })])).toEqual([]);
  });

  it('990332: limite de taxa disparado (nível 10 contra rota de login); o que só deixou passar não conta', () => {
    expect(ruleIds([group({ source: 'rateLimit', count: 3 })])).toEqual([['990332', 7]]);
    expect(
      ruleIds([group({ source: 'ratelimit', count: 3 })], { loginIps: new Set(['198.51.100.7']) }),
    ).toEqual([['990332', 10]]);
    expect(
      ruleIds([group({ source: 'rateLimit', action: 'managed_challenge_interactive_solved', count: 3 })]),
    ).toEqual([]);
    expect(
      rateLimitedIps([group({ source: 'rateLimit' }), group({ source: 'waf', clientIP: '198.51.100.9' })]),
    ).toEqual(['198.51.100.7']);
    expect(isLoginPath('/wp-login.php')).toBe(true);
    expect(isLoginPath('/api/v1/Auth/Token?x=1')).toBe(true);
    expect(isLoginPath('/produtos/123')).toBe(false);
    expect(isLoginPath('/busca?q=login')).toBe(false);
    expect(isLoginPath(null)).toBe(false);
    expect(
      loginIpsOf([
        { clientIP: '198.51.100.7', source: 'rateLimit', path: '/login', count: 5 },
        { clientIP: '198.51.100.8', source: 'rateLimit', path: '/produtos', count: 5 },
        { clientIP: '198.51.100.9', source: 'waf', path: '/login', count: 5 },
      ]),
    ).toEqual(new Set(['198.51.100.7']));
  });

  it('990333: DDoS de camada 7 mitigado na zona (1000 ou mais, somando os IPs)', () => {
    // Os bloqueios da proteção DDoS contam na zona, não na rajada de cada IP (990330).
    const ddos = (ip: string, count: number) => group({ source: 'l7ddos', clientIP: ip, count });
    expect(ruleIds([ddos('198.51.100.1', 600), ddos('198.51.100.2', 399)])).toEqual([]);
    const { detections } = detect([ddos('198.51.100.1', 600), ddos('198.51.100.2', 400)]);
    expect(
      detections.map((detection) => [
        detection.rule.id,
        detection.hit.level,
        detection.ip,
        detection.hit.count,
      ]),
    ).toEqual([['990333', 10, '', 1000]]);
  });

  it('990334: pico de eventos na zona (10 vezes a média das 24 h e 500 ou mais); sem a base, não avalia', () => {
    const spread = (count: number) =>
      Array.from({ length: 10 }, (_, index) =>
        group({ action: 'log', clientIP: `198.51.100.${index + 1}`, count: count / 10 }),
      );
    // Base de 96 janelas com 4800 eventos: média de 50 por janela; 500 é exatamente 10 vezes.
    expect(ruleIds(spread(500), { baseline: 4800 })).toEqual([['990334', 7]]);
    expect(ruleIds(spread(490), { baseline: 0 })).toEqual([]);
    expect(ruleIds(spread(600), { baseline: 9600 })).toEqual([]);
    expect(ruleIds(spread(600))).toEqual([]);
    expect(detect(spread(500), { baseline: 4800 }).detections[0]?.hit.eventName).toContain(
      'média de 50 por 15 min',
    );
  });

  it('990335 nasce desligada; ligada, pede 50 desafios resolvidos com 90% de acerto', () => {
    const solving = [
      group({ action: 'managed_challenge', count: 55 }),
      group({ action: 'managed_challenge_non_interactive_solved', count: 50 }),
    ];
    expect(CLOUDFLARE_SECURITY_RULES.find((rule) => rule.id === '990335')?.enabled).toBe(false);
    expect(ruleIds(solving)).toEqual([]);
    const enabled: SecurityRule[] = CLOUDFLARE_SECURITY_RULES.map((rule) =>
      rule.id === '990335' ? { ...rule, enabled: true } : rule,
    );
    expect(ruleIds(solving, { rules: enabled })).toEqual([['990335', 4]]);
    expect(
      ruleIds([group({ action: 'challenge', count: 100 }), group({ action: 'challengeSolved', count: 60 })], {
        rules: enabled,
      }),
    ).toEqual([]);
  });

  it('agregação: uma rajada vira um achado; muitos IPs viram 10 achados e um resumo', () => {
    const burst = detect([group({ count: 12_000 })]);
    expect(burst.detections).toHaveLength(1);
    expect(burst.detections[0]?.hit.eventName).toBe('12000 requisições bloqueadas em 15 min');

    const many = Array.from({ length: 25 }, (_, index) =>
      group({ clientIP: `198.51.100.${index + 1}`, count: 500 + index }),
    );
    const { detections, folded } = detect(many);
    expect(detections).toHaveLength(SECURITY_MAX_IP_FINDINGS + 1);
    expect(folded).toBe(15);
    // Os 10 com mais eventos têm achado próprio.
    expect(detections.slice(0, 10).map((detection) => detection.ip)).toEqual(
      Array.from({ length: 10 }, (_, index) => `198.51.100.${25 - index}`),
    );
    const summary = detections[10];
    expect(summary?.ip).toBe('*');
    const restCount = Array.from({ length: 15 }, (_, index) => 500 + index).reduce((a, b) => a + b, 0);
    expect(summary?.hit).toMatchObject({ level: 7, count: restCount });
    expect(summary?.hit.eventName).toBe(`mais 15 IPs acima do limite: ${restCount} eventos em 15 min`);
  });

  it('achado: fonte, chave, janela, zona, IP de verdade e MITRE', () => {
    const start = T('2026-11-04T12:00:00Z');
    const [detection] = detect([
      group({ source: 'firewallManaged', count: 40, host: 'api.loja.exemplo.com.br' }),
    ]).detections;
    if (detection === undefined) throw new Error('deveria detectar');
    const draft = toSecurityFindingDraft(
      detection,
      { tenantId: 'cliente', accountId: ACCOUNT },
      { tag: ZONE, name: 'loja.exemplo.com.br' },
      start,
    );
    expect(draft).toEqual({
      tenantId: 'cliente',
      accountId: ACCOUNT,
      source: 'cloudflare',
      sourceEventId: securityEventId(ACCOUNT, '990331', ZONE, '198.51.100.7', start),
      occurredAt: '2026-11-04T12:00:00.000Z',
      severity: 'medium',
      ruleId: '990331',
      ruleLevel: 7,
      title: 'Ataques barrados pelo WAF gerenciado vindos de um mesmo IP (20 ou mais em 15 min)',
      logSource: 'cloudflare_waf',
      eventName: '40 requisições barradas pelo WAF gerenciado em 15 min em api.loja.exemplo.com.br',
      region: null,
      resource: 'loja.exemplo.com.br',
      actorUser: null,
      actorType: null,
      accessKeyId: null,
      sourceIp: '198.51.100.7',
      mitreTactics: ['Initial Access', 'Reconnaissance'],
      mitreTechniques: ['T1190', 'T1595.002'],
    });
    // O resumo e a zona não têm IP.
    const zone = toSecurityFindingDraft(
      { ...detection, ip: '*' },
      { tenantId: 'c', accountId: ACCOUNT },
      { tag: ZONE, name: 'z' },
      start,
    );
    expect(zone.sourceIp).toBeNull();
    // Os IDs das regras não colidem com a auditoria (990301 a 990324).
    for (const rule of CLOUDFLARE_SECURITY_RULES) {
      expect(Number(rule.id)).toBeGreaterThanOrEqual(990330);
      expect(Number(rule.id)).toBeLessThanOrEqual(990335);
    }
  });
});

describe('cliente GraphQL (servidor falso)', () => {
  const cloudflare = new FakeCloudflareServer();
  const account = fakeCloudflare.accountId();
  let value: string;
  let token: CloudflareToken;
  let client: CloudflareClient;
  let zone: string;

  beforeAll(async () => {
    await cloudflare.start();
    value = cloudflare.readableAccountToken(account);
    token = new CloudflareToken(value);
    client = new CloudflareClient({ baseUrl: cloudflare.baseUrl, timeoutMs: 300, retryDelaysMs: [10, 10] });
    zone = cloudflare.addSecurityZone(account, 'loja.exemplo.com.br');
  });

  afterAll(async () => {
    await cloudflare.stop();
  });

  it('POST com o Bearer, JSON e as variáveis; a lista de zonas traz os IDs', async () => {
    const zones = await client.zones(token, account);
    expect(zones.ids).toEqual(new Map([[zone, 'loja.exemplo.com.br']]));
    const result = await client.graphql(token, settingsRequest([zone]));
    expect(result.bytes).toBeGreaterThan(0);
    expect(parseSettings(result.data, [zone])?.get(zone)?.enabled).toBe(true);
    const [request] = cloudflare.graphqlReads(value);
    expect(request?.authorization).toBe(`Bearer ${value}`);
    expect(request?.operation).toBe('settings');
    expect(request?.variables).toEqual({ zoneTags: [zone] });
  });

  it('200 com errors[] é erro, com o código pela mensagem e nada dela no erro', async () => {
    const respond = (status: number, messages: string[], headers?: Record<string, string>) =>
      cloudflare.graphqlScript.push({
        status,
        headers,
        body: JSON.stringify({
          data: { viewer: { zones: [] } },
          errors: messages.map((message) => ({ message: `${message} ${value}` })),
        }),
      });
    respond(200, ['rate limiter budget depleted, try again after 5 minutes']);
    const limited = await client.graphql(token, settingsRequest([zone])).catch((error: unknown) => error);
    expect(limited).toMatchObject({ code: 'rate_limited', retryAfterMs: 300_000 });
    expect(String((limited as Error).message)).not.toContain(value);
    respond(200, ['does not have access to the path']);
    expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('security_events_not_entitled');
    respond(200, ['algo que ninguém documentou']);
    expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('graphql_error');
    // 403 e 400 pelo corpo; sem corpo útil, o código padrão de cada um.
    respond(403, ['does not have access to the path']);
    expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('security_events_not_entitled');
    respond(403, ['not authorized for that account']);
    expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('security_events_forbidden');
    cloudflare.graphqlScript.push({ status: 403, body: 'nada' });
    expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('security_events_forbidden');
    respond(400, ['cannot request data older than 2678400s']);
    expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('security_events_expired');
    respond(400, ['error parsing args']);
    expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('graphql_rejected');
  });

  it('o gancho de cada envio roda antes de toda tentativa; se ele recusar, nada sai', async () => {
    const attempts: number[] = [];
    const before = cloudflare.graphqlReads(value).length;
    cloudflare.graphqlScript.push({ status: 502 }, { status: 503 });
    await client.graphql(token, settingsRequest([zone]), undefined, {
      beforeAttempt: (attempt) => {
        attempts.push(attempt);
        return Promise.resolve();
      },
    });
    expect(attempts).toEqual([0, 1, 2]);
    expect(cloudflare.graphqlReads(value).length - before).toBe(3);

    // Recusado antes da segunda tentativa (o orçamento acabou): só o primeiro envio sai, e o erro do gancho sobe.
    const refused = new Error('sem orçamento');
    cloudflare.graphqlScript.push({ status: 502 });
    const sent = cloudflare.graphqlReads(value).length;
    await expect(
      client.graphql(token, settingsRequest([zone]), undefined, {
        beforeAttempt: (attempt) => (attempt === 0 ? Promise.resolve() : Promise.reject(refused)),
      }),
    ).rejects.toBe(refused);
    expect(cloudflare.graphqlReads(value).length - sent).toBe(1);
  });

  it('401, 429 com o retry-after, 5xx tentado de novo e resposta fora do formato', async () => {
    cloudflare.graphqlScript.push({ status: 401 });
    expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('credential_rejected');
    cloudflare.graphqlScript.push({ status: 429, headers: { 'retry-after': '90' } });
    expect(
      await client.graphql(token, settingsRequest([zone])).catch((error: unknown) => error),
    ).toMatchObject({
      code: 'rate_limited',
      retryAfterMs: 90_000,
    });
    const before = cloudflare.graphqlReads(value).length;
    cloudflare.graphqlScript.push({ status: 502 });
    await client.graphql(token, settingsRequest([zone]));
    expect(cloudflare.graphqlReads(value).length - before).toBe(2);
    for (const body of [
      'não é json',
      JSON.stringify({ data: null, errors: null }),
      JSON.stringify({ errors: 'x' }),
    ]) {
      cloudflare.graphqlScript.push({ status: 200, body });
      expect(await codeOf(client.graphql(token, settingsRequest([zone])))).toBe('bad_response');
    }
  });
});
