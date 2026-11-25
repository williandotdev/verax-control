import { describe, expect, it } from 'vitest';
import {
  AWS_SOURCE_ACTIVE_STATES,
  AWS_SOURCE_KIND_INFO,
  AWS_SOURCE_KINDS,
  AWS_WAZUH_SOURCE_KINDS,
  awsSourceIdleState,
  awsSourcesAuthorizeSchema,
  isAwsSourceCollectable,
  NO_AWS_SOURCE_FEATURES,
} from './aws-onboarding.js';
import { GIB_BYTES } from './plan-usage.js';
import {
  hasCodeOverlap,
  isTrustedExpiryValid,
  isWebRoutePath,
  normalizeTrustedCidr,
  projectWebLogs,
  WEB_LOGS_ERROR_CODES,
  WEB_ROUTES_LIMIT,
  WEB_TRUSTED_LIMIT,
  WEB_TRUSTED_MAX_VALIDITY_MS,
  webEstimateSchema,
  webLoadBalancerSchema,
  webLogSourceSchema,
  webRouteCreateSchema,
  webRouteListSchema,
  webRouteUpdateSchema,
  WEB_HEALTH_RULES_LIMIT,
  WEB_HEALTH_SUPPRESSED_LIMIT,
  webSourceHealthSchema,
  webSourceSettingsUpdateSchema,
  webTrustedSourceCreateSchema,
  webTrustedSourceListSchema,
  webTrustedSourceUpdateSchema,
} from './web-logs.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const uuid = (suffix: number) => `018f0000-0000-7000-8000-${String(suffix).padStart(12, '0')}`;
const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('quem lê cada tipo de fonte, e quando ele é coletado', () => {
  it('o balanceador é de bucket, lido pelo worker, e só com os ataques web ligados', () => {
    expect(AWS_SOURCE_KIND_INFO.elb_logs).toEqual({
      method: 's3',
      collector: 'worker',
      capability: 'service-logs',
      collectable: false,
      feature: 'webLogs',
      sensitive: false,
    });
    expect(isAwsSourceCollectable('elb_logs')).toBe(false);
    expect(isAwsSourceCollectable('elb_logs', NO_AWS_SOURCE_FEATURES)).toBe(false);
    expect(isAwsSourceCollectable('elb_logs', { webLogs: true })).toBe(true);
    for (const kind of AWS_SOURCE_KINDS.filter((value) => value !== 'elb_logs')) {
      expect(isAwsSourceCollectable(kind, { webLogs: true })).toBe(isAwsSourceCollectable(kind));
      expect(AWS_SOURCE_KIND_INFO[kind].feature).toBeUndefined();
    }
  });

  it('o Wazuh lê os de bucket e os grupos de sempre; as APIs e o balanceador são do worker; o Config, de ninguém', () => {
    expect(AWS_WAZUH_SOURCE_KINDS).toEqual([
      'cloudtrail',
      'vpc_flow_logs',
      'waf',
      'guardduty_export',
      'cloudwatch_log_group',
    ]);
    const byCollector = (collector: 'worker' | null) =>
      AWS_SOURCE_KINDS.filter((kind) => AWS_SOURCE_KIND_INFO[kind].collector === collector);
    expect(byCollector('worker')).toEqual([
      'guardduty',
      'security_hub',
      'inspector',
      'access_analyzer',
      'elb_logs',
    ]);
    expect(byCollector(null)).toEqual(['config']);
  });

  it('o estado do balanceador sem autorização segue a permissão só com os ataques web ligados', () => {
    const on = { webLogs: true };
    expect(awsSourceIdleState('elb_logs', 'available', 'granted')).toEqual({
      state: 'unavailable',
      stateCode: 'not_collectable_yet',
    });
    expect(awsSourceIdleState('elb_logs', 'available', 'granted', on)).toEqual({
      state: 'available',
      stateCode: null,
    });
    expect(awsSourceIdleState('elb_logs', 'available', 'missing', on)).toEqual({
      state: 'needs_permission',
      stateCode: null,
    });
    expect(awsSourceIdleState('elb_logs', 'no_destination', 'unknown', on)).toEqual({
      state: 'unavailable',
      stateCode: 'no_destination',
    });
    // O Config não depende deles.
    expect(awsSourceIdleState('config', 'available', 'granted', on).state).toBe('unavailable');
    expect(AWS_SOURCE_ACTIVE_STATES).not.toContain('unavailable');
  });
});

describe('a ciência da estimativa no pedido de autorização', () => {
  const item = (overrides: Record<string, unknown> = {}) => ({
    sourceId: uuid(1),
    estimatedAt: NOW.toISOString(),
    estimatedGbPerDay: 2.4,
    projectedPercent: 112.4,
    acknowledged: true,
    ...overrides,
  });
  const body = (webLogs: unknown) => ({ sourceIds: [uuid(1), uuid(2)], webLogs });

  it('aceita uma por balanceador, com os números ou sem amostra', () => {
    expect(ok(awsSourcesAuthorizeSchema, { sourceIds: [uuid(1)] })).toBe(true);
    expect(ok(awsSourcesAuthorizeSchema, body([item()]))).toBe(true);
    expect(
      ok(
        awsSourcesAuthorizeSchema,
        body([item(), item({ sourceId: uuid(2), estimatedGbPerDay: null, projectedPercent: null })]),
      ),
    ).toBe(true);
  });

  it('recusa a de uma fonte fora do pedido, a repetida, a lista vazia, o campo a mais e o que falta', () => {
    for (const webLogs of [
      [],
      [item({ sourceId: uuid(3) })],
      [item(), item()],
      [item({ estimatedGbPerDay: -1 })],
      [item({ projectedPercent: Number.NaN })],
      [item({ estimatedAt: 'ontem' })],
      [item({ acknowledged: 'sim' })],
      [item({ acknowledged: undefined })],
      [item({ estimatedGbPerDay: undefined })],
      [item({ extra: true })],
      true,
    ]) {
      expect(ok(awsSourcesAuthorizeSchema, body(webLogs))).toBe(false);
    }
  });
});

describe('a projeção da estimativa', () => {
  const monthly = { monthlyGib: 60, franchiseGbPerDay: null };

  it('GB por dia e a porcentagem do volume do mês, em 30 dias', () => {
    // 2,4 GB/dia são 67 GiB por mês.
    expect(projectWebLogs(2_400_000_000, false, monthly)).toEqual({
      gbPerDay: 2.4,
      percent: 111.8,
      basis: 'monthly',
      acknowledgementRequired: true,
    });
    expect(projectWebLogs(0, false, monthly)).toEqual({
      gbPerDay: 0,
      percent: 0,
      basis: 'monthly',
      acknowledgementRequired: false,
    });
  });

  it('a confirmação é pelo valor exato: em 20% não pede, um byte acima pede', () => {
    const exact = (monthly.monthlyGib * GIB_BYTES * 0.2) / 30;
    expect(Number.isInteger(exact)).toBe(false);
    expect(projectWebLogs(Math.floor(exact), false, monthly)).toMatchObject({
      percent: 20,
      acknowledgementRequired: false,
    });
    expect(projectWebLogs(Math.ceil(exact), false, monthly)).toMatchObject({
      percent: 20,
      acknowledgementRequired: true,
    });
    expect(projectWebLogs(2e9, false, { monthlyGib: null, franchiseGbPerDay: 10 })).toEqual({
      gbPerDay: 2,
      percent: 20,
      basis: 'franchise',
      acknowledgementRequired: false,
    });
    expect(
      projectWebLogs(2e9 + 1, false, { monthlyGib: null, franchiseGbPerDay: 10 }).acknowledgementRequired,
    ).toBe(true);
  });

  it('sem amostra ou com a listagem cortada, pede sempre; no plano sem limite, só nesses dois casos', () => {
    const none = { monthlyGib: null, franchiseGbPerDay: null };
    expect(projectWebLogs(null, false, monthly)).toEqual({
      gbPerDay: null,
      percent: null,
      basis: 'monthly',
      acknowledgementRequired: true,
    });
    expect(projectWebLogs(1, true, monthly).acknowledgementRequired).toBe(true);
    expect(projectWebLogs(5e12, false, none)).toEqual({
      gbPerDay: 5000,
      percent: null,
      basis: 'none',
      acknowledgementRequired: false,
    });
    expect(projectWebLogs(null, false, none).acknowledgementRequired).toBe(true);
    expect(projectWebLogs(5e12, true, none).acknowledgementRequired).toBe(true);
  });

  it('a franquia do dia vale antes do volume do mês', () => {
    expect(projectWebLogs(1e9, false, { monthlyGib: 60, franchiseGbPerDay: 4 })).toMatchObject({
      basis: 'franchise',
      percent: 25,
    });
  });
});

describe('a faixa de uma fonte confiável', () => {
  it('os pisos: IPv4 de /16 a /32, IPv6 de /32 a /64, sem bit de máquina', () => {
    for (const [text, expected] of [
      ['192.0.2.0/24', '192.0.2.0/24'],
      ['198.51.0.0/16', '198.51.0.0/16'],
      ['203.0.113.7/32', '203.0.113.7/32'],
      ['203.0.112.0/20', '203.0.112.0/20'],
      ['2001:db8::/32', '2001:db8::/32'],
      ['2001:db8:0:1::/64', '2001:db8:0:1::/64'],
      ['2001:db8:ff00::/40', '2001:db8:ff00::/40'],
    ] as const) {
      expect(normalizeTrustedCidr(text)).toBe(expected);
    }
    for (const text of [
      '198.50.0.0/15',
      '198.51.0.0/15',
      '0.0.0.0/0',
      '192.0.2.0/33',
      '192.0.2.1/24',
      '203.0.113.0/19',
      '2001:db8::/31',
      '2001:db8::/65',
      '2001:db8::1/64',
      '2001:db8:0:1::/63',
      '2001:db8:ff00::/39',
      '::/0',
    ]) {
      expect(normalizeTrustedCidr(text)).toBeNull();
    }
  });

  it('a mesma faixa escrita de dois jeitos é uma só', () => {
    for (const text of [
      '2001:db8:0:1::/64',
      '2001:0db8:0000:0001::/64',
      '2001:DB8:0:1:0:0:0:0/64',
      '2001:db8::1:0:0:0:0/64',
    ]) {
      expect(normalizeTrustedCidr(text)).toBe('2001:db8:0:1::/64');
    }
    expect(normalizeTrustedCidr('2001:db8:0:0::/32')).toBe('2001:db8::/32');
    expect(normalizeTrustedCidr('64:0:0:1::/64')).toBe('64:0:0:1::/64');
  });

  it('recusa o que não é uma faixa', () => {
    for (const text of [
      '',
      '/',
      '192.0.2.0',
      '192.0.2.0/',
      '192.0.2.0/24/24',
      '192.0.2/24',
      '192.0.2.0.0/24',
      '192.0.02.0/24',
      '192.0.256.0/24',
      '192.0.2.0/024',
      '192.0.2.0/ 24',
      '192.0.2.0/2.4',
      '1e2.0.0.0/24',
      '::ffff:192.0.2.0/64',
      '2001:db8:::/32',
      '2001::db8::/32',
      '2001:db8:0:0::0:0:0:0::/32',
      '2001:db8:0:0::0:0:0:0/32',
      '2001:db8:0:0:0:0:0:0::/32',
      '2001:db8:1:2:3:4:5:6:7/64',
      '2001:db8:1:2:3:4:5/64',
      '2001:db8:1:2:3:4:5:6::/64',
      '2001:db8:g::/48',
      '2001:db80000::/32',
      'fe80::%eth0/64',
      '*.*.*.*/16',
    ]) {
      expect(normalizeTrustedCidr(text)).toBeNull();
    }
  });

  it('a validade: no futuro, e até 365 dias', () => {
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(isTrustedExpiryValid(at(1), NOW)).toBe(true);
    expect(isTrustedExpiryValid(at(WEB_TRUSTED_MAX_VALIDITY_MS), NOW)).toBe(true);
    expect(isTrustedExpiryValid(at(0), NOW)).toBe(false);
    expect(isTrustedExpiryValid(at(-1), NOW)).toBe(false);
    expect(isTrustedExpiryValid(at(WEB_TRUSTED_MAX_VALIDITY_MS + 1), NOW)).toBe(false);
    expect(isTrustedExpiryValid(new Date(Number.NaN), NOW)).toBe(false);
  });

  it('o pedido: a faixa sai normalizada; motivo de uma linha; nada a mais', () => {
    const create = (overrides: Record<string, unknown> = {}) => ({
      sourceId: null,
      cidr: ' 2001:DB8:0::/48 ',
      kind: 'office',
      reason: '  escritório  ',
      expiresAt: NOW.toISOString(),
      ...overrides,
    });
    expect(webTrustedSourceCreateSchema.parse(create())).toEqual({
      sourceId: null,
      cidr: '2001:db8::/48',
      kind: 'office',
      reason: 'escritório',
      expiresAt: NOW.toISOString(),
    });
    expect(ok(webTrustedSourceCreateSchema, create({ sourceId: uuid(1) }))).toBe(true);
    expect(ok(webTrustedSourceCreateSchema, create({ reason: 'r'.repeat(200) }))).toBe(true);
    for (const overrides of [
      { sourceId: undefined },
      { sourceId: 'todos' },
      { cidr: '0.0.0.0/0' },
      { kind: 'vpn' },
      { reason: '   ' },
      { reason: 'r'.repeat(201) },
      { reason: 'duas\nlinhas' },
      { reason: 'escape\u001b[31m' },
      { expiresAt: '2026-12-01' },
      { expiresAt: null },
      { active: true },
      { tenantId: uuid(2) },
    ]) {
      expect(ok(webTrustedSourceCreateSchema, create(overrides))).toBe(false);
    }
    expect(ok(webTrustedSourceUpdateSchema, { reason: 'novo' })).toBe(true);
    for (const body of [{}, { cidr: '192.0.2.0/24' }, { sourceId: null }, { reason: undefined }]) {
      expect(ok(webTrustedSourceUpdateSchema, body)).toBe(false);
    }
  });
});

describe('a rota declarada', () => {
  it('o caminho: minúsculas, até 8 segmentos, `*` só no lugar de um segmento inteiro', () => {
    for (const path of [
      '/',
      '/login',
      '/api/v1/login.php',
      '/*/login',
      '/a/b/c/d/e/f/g/h',
      '/*/*/*/*/*/*/*/*',
      `/${'a'.repeat(255)}`,
      '/~joao/entrar_aqui-1',
    ]) {
      expect(isWebRoutePath(path)).toBe(true);
    }
    for (const path of [
      '',
      'login',
      '//',
      '/login/',
      '/Login',
      '/log*',
      '/**',
      '/a/b/c/d/e/f/g/h/i',
      `/${'a'.repeat(256)}`,
      '/login?x=1',
      '/log%69n',
      '/ação',
      '/.',
      '/a/../b',
      '/login;a',
      '/(a+)+$',
    ]) {
      expect(isWebRoutePath(path)).toBe(false);
    }
  });

  it('o pedido: host e caminho em minúsculas; códigos sem repetir e sem sobrepor; nada a mais', () => {
    const create = (overrides: Record<string, unknown> = {}) => ({
      host: 'Loja.Example.COM',
      method: 'POST',
      path: '/Conta/Entrar',
      kind: 'login',
      failureCodes: [401, 403],
      successCodes: [200, 302],
      multiplier: 1,
      ...overrides,
    });
    expect(webRouteCreateSchema.parse(create())).toMatchObject({
      host: 'loja.example.com',
      path: '/conta/entrar',
    });
    for (const overrides of [
      { host: null },
      { method: 'ANY' },
      { failureCodes: [], successCodes: [] },
      { failureCodes: [100, 599] },
      { failureCodes: Array.from({ length: 20 }, (_, i) => 400 + i) },
      { multiplier: 0.5 },
      { multiplier: 10 },
      { kind: 'ignore' },
    ]) {
      expect(ok(webRouteCreateSchema, create(overrides))).toBe(true);
    }
    for (const overrides of [
      { host: undefined },
      { host: '' },
      { host: '*.example.com' },
      { host: `${'a'.repeat(254)}` },
      { method: 'HEAD' },
      { method: 'post' },
      { path: '/a b' },
      { kind: 'admin' },
      { failureCodes: [401, 401] },
      { failureCodes: [99] },
      { failureCodes: [600] },
      { failureCodes: [401.5] },
      { failureCodes: Array.from({ length: 21 }, (_, i) => 400 + i) },
      { successCodes: [200, 401] },
      { multiplier: 0.49 },
      { multiplier: 10.01 },
      { multiplier: Number.POSITIVE_INFINITY },
      { sourceId: uuid(1) },
    ]) {
      expect(ok(webRouteCreateSchema, create(overrides))).toBe(false);
    }
    expect(hasCodeOverlap([401], [200])).toBe(false);
    expect(hasCodeOverlap([401, 200], [200])).toBe(true);
    expect(ok(webRouteUpdateSchema, { kind: 'mfa' })).toBe(true);
    for (const body of [{}, { path: '/x' }, { host: null }, { method: 'GET' }, { failureCodes: [1] }]) {
      expect(ok(webRouteUpdateSchema, body)).toBe(false);
    }
  });
});

describe('a configuração e a leitura dos balanceadores', () => {
  it('o modo e o multiplicador', () => {
    for (const body of [
      { mode: 'alert' },
      { mode: 'observe', thresholdMultiplier: 0.5 },
      { thresholdMultiplier: 10 },
    ]) {
      expect(ok(webSourceSettingsUpdateSchema, body)).toBe(true);
    }
    for (const body of [
      {},
      { mode: 'off' },
      { mode: null },
      { thresholdMultiplier: 0.4 },
      { thresholdMultiplier: 11 },
      { thresholdMultiplier: '2' },
      { mode: 'alert', observeUntil: null },
    ]) {
      expect(ok(webSourceSettingsUpdateSchema, body)).toBe(false);
    }
  });

  it('só o ALB tem o identificador, no formato do ARN', () => {
    for (const value of ['app/loja/0123456789abcdef', `app/${'a'.repeat(32)}/0123456789abcdef`]) {
      expect(ok(webLoadBalancerSchema, value)).toBe(true);
    }
    for (const value of [
      'net/loja/0123456789abcdef',
      'app/loja',
      'app/loja/0123456789abcde',
      'app/lo_ja/0123456789abcdef',
      'app/loja/0123456789abcdef/x',
    ]) {
      expect(ok(webLoadBalancerSchema, value)).toBe(false);
    }
  });

  it('as respostas são estritas, e as listas têm o teto do cadastro', () => {
    const estimate = {
      requestedAt: null,
      status: 'ready',
      computedAt: NOW.toISOString(),
      day: '2026-11-23',
      objects: 864,
      truncated: false,
      errorCode: null,
      projection: {
        gbPerDay: 2.4,
        percent: 111.8,
        basis: 'monthly',
        acknowledgementRequired: true,
        validUntil: NOW.toISOString(),
      },
    };
    expect(webEstimateSchema.parse(estimate)).toEqual(estimate);
    expect(ok(webEstimateSchema, { ...estimate, bytesPerDay: 1 })).toBe(false);
    const item = {
      id: uuid(1),
      cloudAccountId: uuid(2),
      accountId: '111111111111',
      region: 'sa-east-1',
      name: 'loja',
      loadBalancer: 'app/loja/0123456789abcdef',
      internetFacing: true,
      state: 'available',
      authorized: false,
      settings: null,
      estimate,
    };
    expect(webLogSourceSchema.parse(item)).toEqual(item);
    expect(ok(webLogSourceSchema, { ...item, bucket: 'x' })).toBe(false);
    expect(ok(webTrustedSourceListSchema, { items: [], limit: WEB_TRUSTED_LIMIT })).toBe(true);
    expect(ok(webTrustedSourceListSchema, { items: [], limit: 201 })).toBe(false);
    expect(ok(webRouteListSchema, { items: [], limit: WEB_ROUTES_LIMIT })).toBe(true);
    expect(new Set(WEB_LOGS_ERROR_CODES).size).toBe(WEB_LOGS_ERROR_CODES.length);
  });
});

describe('a saúde da leitura de um balanceador', () => {
  const at = NOW.toISOString();
  const rule = { ruleId: '990405', level: 10, findings: 3, firstSeenAt: at, lastSeenAt: at };
  const suppressed = { trustedId: uuid(9), ruleId: '990402', clients: 2, lastSeenAt: at };
  const health = {
    sourceId: uuid(1),
    since: at,
    objects: { read: 864, late: 2, quarantined: 1, gap: 0 },
    lines: { analysed: 1_000_000, malformed: 3, oversize: 1, foreign: 0 },
    bytes: 800_000_000,
    gap: { from: at, to: at },
    observation: { since: at, rules: [rule], truncated: false },
    suppressed: [suppressed],
    notes: ['behind_proxy'],
    stateAt: at,
  };

  it('a resposta inteira e a vazia', () => {
    expect(ok(webSourceHealthSchema, health)).toBe(true);
    const empty = { gap: null, observation: null, suppressed: [], notes: [], stateAt: null };
    expect(ok(webSourceHealthSchema, { ...health, ...empty })).toBe(true);
  });

  it('nenhum campo a mais entra, em nível nenhum: nem endereço, nem chave, nem o resumo do dia', () => {
    const observation = health.observation;
    for (const extra of [
      { ...health, digest: {} },
      { ...health, observation: { ...observation, keys: ['0123456789ab'] } },
      { ...health, observation: { ...observation, rules: [{ ...rule, client: '203.0.113.7' }] } },
      { ...health, suppressed: [{ ...suppressed, ip: '203.0.113.7' }] },
      { ...health, objects: { ...health.objects, keys: 1 } },
      { ...health, lines: { ...health.lines, text: 1 } },
      { ...health, gap: { from: at, to: at, objectKey: 'x' } },
      { ...health, notes: ['203.0.113.7'] },
    ]) {
      expect(ok(webSourceHealthSchema, extra)).toBe(false);
    }
  });

  it('os códigos são abertos (um nó mais novo), os tetos não', () => {
    const { observation } = health;
    const withRules = (rules: unknown[]) => ({ ...health, observation: { ...observation, rules } });
    expect(ok(webSourceHealthSchema, withRules([{ ...rule, ruleId: '990499', level: 15 }]))).toBe(true);
    expect(ok(webSourceHealthSchema, { ...health, notes: ['uma_nota_nova'] })).toBe(true);
    expect(ok(webSourceHealthSchema, withRules([{ ...rule, level: 16 }]))).toBe(false);
    expect(ok(webSourceHealthSchema, withRules([{ ...rule, findings: 0 }]))).toBe(false);
    expect(ok(webSourceHealthSchema, withRules([{ ...rule, ruleId: '99040' }]))).toBe(false);
    const many = <T>(item: T, total: number): T[] => new Array<T>(total).fill(item);
    expect(ok(webSourceHealthSchema, withRules(many(rule, WEB_HEALTH_RULES_LIMIT)))).toBe(true);
    expect(ok(webSourceHealthSchema, withRules(many(rule, WEB_HEALTH_RULES_LIMIT + 1)))).toBe(false);
    const calm = (total: number) => ({ ...health, suppressed: many(suppressed, total) });
    expect(ok(webSourceHealthSchema, calm(WEB_HEALTH_SUPPRESSED_LIMIT))).toBe(true);
    expect(ok(webSourceHealthSchema, calm(WEB_HEALTH_SUPPRESSED_LIMIT + 1))).toBe(false);
    expect(ok(webSourceHealthSchema, { ...health, bytes: -1 })).toBe(false);
  });
});
