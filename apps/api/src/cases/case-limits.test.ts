import { describe, expect, it } from 'vitest';
import { type CaseKeyInput, caseKeyOf } from './case-key.js';
import {
  type CaseOpening,
  FAN_OUT_CRITICAL_LIMIT,
  FAN_OUT_LIMIT,
  fanOutGroup,
  foldFor,
  LIMIT_WINDOW_MS,
  possibleFolds,
  QUEUE_SOFT_CAP,
  RecentOpenings,
} from './case-limits.js';

const ACCOUNT = '111122223333';
const T0 = new Date('2026-11-02T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const DAY_MS = 24 * 60 * 60 * 1000;

const finding = (overrides: Partial<CaseKeyInput> = {}): CaseKeyInput => ({
  accountId: ACCOUNT,
  logSource: 'vpc_flow',
  severity: 'high',
  ruleId: '100400',
  title: 'x',
  eventName: null,
  resource: null,
  actorUser: null,
  sourceIp: '203.0.113.7',
  caseGroup: null,
  ...overrides,
});

const groupOf = (overrides: Partial<CaseKeyInput> = {}): string | null => {
  const input = finding(overrides);
  const key = caseKeyOf(input);
  return fanOutGroup(key.family, input.accountId, key.parts);
};

const decide = (
  overrides: Partial<CaseKeyInput>,
  openings: readonly CaseOpening[],
  options: { arrival?: Date; isProtected?: boolean } = {},
) => {
  const input = finding(overrides);
  return foldFor(
    caseKeyOf(input),
    { accountId: input.accountId, severity: input.severity, isProtected: options.isProtected ?? false },
    options.arrival ?? T0,
    new RecentOpenings(openings),
  );
};

const opened = (count: number, opening: Partial<CaseOpening> = {}): CaseOpening[] =>
  Array.from({ length: count }, () => ({ queue: 'detection', openedAt: T0, group: groupOf(), ...opening }));

describe('o grupo do fan-out', () => {
  it('os limites do desenho', () => {
    expect([FAN_OUT_LIMIT, FAN_OUT_CRITICAL_LIMIT, QUEUE_SOFT_CAP, LIMIT_WINDOW_MS]).toEqual([
      8,
      100,
      40,
      DAY_MS,
    ]);
  });

  it('é a família, a conta e as partes sem a rede; só com rede da internet', () => {
    expect(groupOf()).not.toBeNull();
    expect(groupOf()).toBe(groupOf({ sourceIp: '198.51.100.9' }));
    expect(groupOf()).toBe(groupOf({ sourceIp: '2001:db8::1' }));
    expect(groupOf()).not.toBe(groupOf({ ruleId: '100401' }));
    expect(groupOf()).not.toBe(groupOf({ accountId: '444455556666' }));
    expect(groupOf()).not.toBe(groupOf({ logSource: 'cloudwatch_logs' }));
    expect(groupOf({ sourceIp: '10.0.0.7' })).toBeNull();
    expect(groupOf({ sourceIp: 'fd00::7' })).toBeNull();
    expect(groupOf({ sourceIp: null })).toBeNull();
    // A chave da média e da baixa não tem rede.
    expect(groupOf({ severity: 'medium' })).toBeNull();
    expect(groupOf({ logSource: 'cloudtrail', actorUser: 'a' })).toBeNull();
    // Só a rede na chave (o login no console): o grupo é a família e a conta.
    expect(groupOf({ logSource: 'cloudtrail', ruleId: '80254' })).toBe(
      JSON.stringify(['console-login', ACCOUNT]),
    );
  });

  it('um valor com o texto de outro não cai no mesmo grupo', () => {
    const network = { name: 'network', value: 'ipv4:203.0.113.0/24' };
    const a = fanOutGroup('waf', 'a', [{ name: 'rule', value: 'x"],["y","' }, network]);
    const b = fanOutGroup('waf', 'a', [{ name: 'rule', value: 'x' }, { name: 'y', value: '' }, network]);
    expect(a).not.toBe(b);
  });
});

describe('fan-out', () => {
  it('o 9º caso do grupo vai para o distribuído', () => {
    expect(decide({}, opened(7))).toBeNull();
    expect(decide({}, opened(8))).toBe('distributed');
  });

  it('o crítico, só a partir do 101º, e para o próprio caso', () => {
    expect(decide({ severity: 'critical' }, opened(99))).toBeNull();
    expect(decide({ severity: 'critical' }, opened(100))).toBe('overflow');
    expect(decide({}, opened(100))).toBe('distributed');
  });

  it('só contam as aberturas do grupo, nas 24 h antes da chegada', () => {
    expect(decide({}, opened(50, { group: groupOf({ ruleId: '100401' }) }))).toBeNull();
    expect(decide({}, opened(50, { group: null }))).toBeNull();
    expect(decide({}, opened(8), { arrival: at(DAY_MS - 1) })).toBe('distributed');
    expect(decide({}, opened(8), { arrival: at(DAY_MS) })).toBeNull();
    // As que abriram depois da chegada (um alerta antigo que volta à fila) não contam.
    expect(decide({}, opened(8, { openedAt: at(1) }))).toBeNull();
  });

  it('protegido e origem privada nunca', () => {
    expect(decide({}, opened(500), { isProtected: true })).toBeNull();
    expect(decide({ severity: 'critical' }, opened(500), { isProtected: true })).toBeNull();
    expect(decide({ sourceIp: '192.168.0.9' }, opened(500))).toBeNull();
  });

  it('sem rede na chave, o alto e o crítico nunca são reunidos', () => {
    for (const severity of ['high', 'critical']) {
      const many = opened(500, { group: null });
      expect(decide({ logSource: 'cloudtrail', actorUser: 'a', severity }, many)).toBeNull();
      expect(decide({ logSource: 'guardduty', resource: 'ec2:i-0', severity }, many)).toBeNull();
    }
  });

  it('uma severidade que não se conhece vale como alta', () => {
    expect(decide({ severity: 'nova' }, opened(8))).toBe('distributed');
    const many = opened(500, { group: null });
    expect(decide({ severity: 'nova', logSource: 'cloudtrail', actorUser: 'a' }, many)).toBeNull();
  });
});

describe('teto da fila', () => {
  const noise = { logSource: 'cloudtrail', actorUser: 'a', severity: 'low' };

  it('a média e a baixa, a partir de 40 casos na mesma fila em 24 h', () => {
    expect(decide(noise, opened(39))).toBeNull();
    expect(decide(noise, opened(40))).toBe('rollup');
    expect(decide({ ...noise, severity: 'medium' }, opened(40, { group: null }))).toBe('rollup');
    expect(decide(noise, opened(40), { arrival: at(LIMIT_WINDOW_MS) })).toBeNull();
    expect(decide(noise, opened(40, { queue: 'posture' }))).toBeNull();
    const control = { logSource: 'security_hub', ruleId: '990501', eventName: 'S3.8', severity: 'medium' };
    expect(decide(control, opened(40, { queue: 'posture' }))).toBe('rollup');
    expect(decide(control, opened(40))).toBeNull();
    expect(decide({ ...control, severity: 'high' }, opened(40, { queue: 'posture' }))).toBeNull();
  });

  it('a fila de vulnerabilidade não tem teto, e o protegido não entra', () => {
    const vulnerability = { logSource: 'inspector', ruleId: '990511', caseGroup: 'openssl', severity: 'low' };
    expect(decide(vulnerability, opened(500, { queue: 'vulnerability' }))).toBeNull();
    expect(decide(noise, opened(500), { isProtected: true })).toBeNull();
  });
});

describe('as reuniões possíveis de uma chave', () => {
  it.each<[Partial<CaseKeyInput>, string[]]>([
    [{}, ['distributed', 'overflow']],
    [{ sourceIp: '10.0.0.7' }, []],
    [{ severity: 'low' }, ['rollup']],
    [{ logSource: 'cloudtrail', actorUser: 'a' }, []],
    [{ logSource: 'inspector', ruleId: '990511', severity: 'low' }, []],
  ])('%j', (overrides, folds) => {
    expect(possibleFolds(caseKeyOf(finding(overrides)), ACCOUNT)).toEqual(folds);
    // A decisão nunca sai desta lista.
    const decision = decide(overrides, [...opened(500), ...opened(500, { queue: 'posture' })]);
    if (decision !== null) expect(folds).toContain(decision);
  });
});
