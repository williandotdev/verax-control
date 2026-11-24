import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT,
  albLine,
  Harness,
  type LineSpec,
  objectKey,
  prng,
  SLOT,
  T0,
  TEST_RANGES,
  times,
} from '../../test/support/alb-lines.js';
import { DAY_MS, digestStateSchema, NoiseDigest } from './digest.js';
import { type WebFindingDraft, webFindingKey } from './draft.js';
import {
  EVIDENCE_NOTES,
  MAX_EVIDENCE_BYTES,
  sealEvidence,
  type WebEvidence,
  webEvidenceSchema,
} from './evidence.js';
import { PROBE_FAMILIES } from './probes.js';
import { UA_FAMILIES } from './user-agent.js';
import { DEFAULT_LIMITS, divideLimits } from './limits.js';
import { MAX_FINDINGS_PER_RULE, MAX_UNFOLDED_FINDINGS, WebLogEngine } from './engine.js';
import { WEB_RULES, type WebRuleId } from './rules.js';
import { TrustedSources, type WebTrustedSource, webTrustedSourceSchema } from './trusted-sources.js';

const ATTACKER = '198.51.100.7';
const MINUTE = 60_000;

const of = (drafts: readonly WebFindingDraft[], rule: WebRuleId): WebFindingDraft[] =>
  drafts.filter((draft) => draft.ruleId === rule);
const one = (drafts: readonly WebFindingDraft[], rule: WebRuleId): WebFindingDraft => {
  const found = of(drafts, rule);
  expect(found).toHaveLength(1);
  return found[0] as WebFindingDraft;
};

const login = (client: string, status: number, extra: LineSpec = {}): LineSpec => ({
  client,
  method: 'POST',
  path: '/login',
  status,
  ...extra,
});
const probes = (count: number, client = ATTACKER): LineSpec[] =>
  times(count, (i) => ({ client, path: `/x${i}/.env`, status: 404 }));
const failures = (count: number, client = ATTACKER): LineSpec[] => times(count, () => login(client, 401));

describe('objetos e slots', () => {
  it('recusa a chave fora da gramática, de outra fonte ou com fim no futuro', () => {
    const { engine } = new Harness();
    const open = (key: string, now = T0) => engine.openObject(key, now);
    expect(open('x')).toEqual({ ok: false, reason: 'bad_key' });
    expect(open(objectKey(T0, { account: '222222222222' }))).toEqual({ ok: false, reason: 'foreign_key' });
    expect(open(objectKey(T0, { prefix: 'p' }))).toEqual({ ok: false, reason: 'foreign_key' });
    expect(open(objectKey(T0 + 10 * MINUTE))).toMatchObject({ ok: true });
    expect(open(objectKey(T0 + 11 * MINUTE))).toEqual({ ok: false, reason: 'future' });
  });

  it('um arquivo com data no futuro não empurra a janela nem apaga o que está nela', () => {
    const harness = new Harness();
    harness.feed(failures(20));
    expect(harness.engine.openObject(objectKey(T0 + DAY_MS), T0)).toMatchObject({ ok: false });
    expect(of(harness.evaluate().drafts, '990405')).toHaveLength(1);
  });

  it('linha de outro balanceador é contada e não analisada', () => {
    const harness = new Harness();
    harness.feed(failures(50).map((line) => ({ ...line, lb: 'app/outra/fedcba9876543210' })));
    const { drafts, counters } = harness.evaluate();
    expect(drafts).toEqual([]);
    expect(counters).toMatchObject({ lines: 0, foreign: 50 });
  });

  it('malformada, ambígua e fora do horário são contadas', () => {
    const harness = new Harness();
    const object = harness.feed([
      { userAgent: 'a"b' },
      { time: T0 - 2 * 60 * MINUTE },
      { client: '999.1.1.1' },
    ]);
    harness.engine.ingest(object, 'lixo');
    expect(harness.evaluate().counters).toEqual({
      lines: 2,
      malformed: 2,
      foreign: 0,
      ambiguous: 1,
      skewed: 1,
    });
  });

  it('o slot fecha 10 minutos depois; o objeto que chega depois é avaliado sozinho e avisado', () => {
    const harness = new Harness();
    harness.feed(failures(15), T0, T0 + MINUTE);
    expect(of(harness.evaluate(T0 + 9 * MINUTE).drafts, '990405')).toEqual([]);
    expect(harness.evaluate(T0 + 9 * MINUTE).closedThrough).toBe((T0 - 5 * MINUTE) / SLOT);
    expect(harness.evaluate(T0 + 10 * MINUTE).closedThrough).toBe(T0 / SLOT);
    const late = harness.feed(failures(15), T0, T0 + 11 * MINUTE);
    expect(late.late).toBe(true);
    // 15 + 15 não somam: o atrasado é sozinho, e a contagem, um piso.
    expect(of(harness.evaluate(T0 + 11 * MINUTE).drafts, '990405')).toEqual([]);
    harness.feed(failures(20), T0, T0 + 12 * MINUTE);
    const draft = one(harness.evaluate(T0 + 12 * MINUTE).drafts, '990405');
    expect(draft.evidence.notes).toEqual(expect.arrayContaining(['late_object', 'counts_are_floor']));
    expect(of(harness.evaluate(T0 + 13 * MINUTE).drafts, '990405')).toEqual([]);
  });

  it('antes de fechar, o arquivo de outro nó do balanceador soma no mesmo slot', () => {
    const harness = new Harness();
    harness.feed(failures(10), T0, T0 + MINUTE);
    harness.evaluate(T0 + 2 * MINUTE);
    harness.feed(failures(10), T0, T0 + 8 * MINUTE);
    expect(of(harness.evaluate(T0 + 8 * MINUTE).drafts, '990405')).toHaveLength(1);
  });

  it('atrasados além do teto esperam a próxima avaliação', () => {
    const harness = new Harness();
    const now = T0 + 3 * 60 * MINUTE;
    harness.evaluate(now);
    for (let i = 0; i < 12; i += 1) {
      expect(harness.engine.openObject(objectKey(T0 - i * SLOT), now)).toMatchObject({
        ok: true,
        late: true,
      });
    }
    const extra = objectKey(T0 - 12 * SLOT);
    expect(harness.engine.openObject(extra, now)).toEqual({ ok: false, reason: 'late_backlog' });
    harness.evaluate(now);
    expect(harness.engine.openObject(extra, now)).toMatchObject({ ok: true, late: true });
  });

  it('a memória volta a zero quando os slots saem', () => {
    const harness = new Harness();
    const scan = times(600, (i) => ({ client: ATTACKER, path: `/p${i}`, status: 404 }));
    harness.feed([...failures(50), ...scan, ...probes(20)]);
    harness.evaluate(T0 + MINUTE);
    expect(harness.engine.usage.clients).toBeGreaterThan(0);
    harness.evaluate(T0 + 2 * 60 * MINUTE);
    expect(harness.engine.usage).toEqual({
      evictedCells: 0,
      clients: 0,
      loginCells: 0,
      details: 0,
      pathSets: 0,
      hashCells: 0,
    });
  });

  it('fim de arquivo fora do múltiplo de 5 min cai no slot seguinte', () => {
    const { engine } = new Harness();
    const opened = engine.openObject(objectKey(T0 - 3 * MINUTE), T0);
    expect(opened.ok && opened.slot.endMs).toBe(T0);
  });
});

describe('determinismo', () => {
  const traffic = (): LineSpec[] => {
    const random = prng(42);
    const lines: LineSpec[] = [];
    for (let i = 0; i < 3_000; i += 1) {
      const client = `198.51.100.${Math.floor(random() * 15) + 1}`;
      const kind = Math.floor(random() * 5);
      const time = T0 - Math.floor(random() * 5 * MINUTE);
      if (kind === 0) lines.push({ client, time, path: `/p${Math.floor(random() * 900)}`, status: 404 });
      else if (kind === 1) lines.push(login(client, random() < 0.8 ? 401 : 302, { time }));
      else if (kind === 2) lines.push({ client, time, path: '/.env', status: 200, sent: 700 + (i % 3) });
      else if (kind === 3) lines.push({ client, time, path: `/d${i % 20}/.git/config`, status: 404 });
      else lines.push({ client, time, path: '/', sent: 9000 });
    }
    return lines;
  };
  const sorted = (drafts: WebFindingDraft[]): unknown[] =>
    drafts.map(({ evidence, ...draft }) => ({
      ...draft,
      // As amostras guardadas são as primeiras que chegaram: só elas dependem da ordem.
      counters: evidence.counters,
      statuses: evidence.statuses,
      notes: [...evidence.notes].sort(),
    }));

  it('a mesma entrada dá o mesmo resultado, byte a byte', () => {
    const result = () => {
      const harness = new Harness();
      harness.feed(traffic());
      return JSON.stringify(harness.evaluate());
    };
    expect(result()).toBe(result());
  });

  it('a ordem das linhas dentro do slot não muda as detecções', () => {
    const forward = new Harness();
    forward.feed(traffic());
    const backward = new Harness();
    backward.feed(traffic().reverse());
    expect(sorted(backward.evaluate().drafts)).toEqual(sorted(forward.evaluate().drafts));
  });

  it('reavaliar não soma: as chaves e as contagens são as mesmas', () => {
    const harness = new Harness();
    harness.feed(traffic());
    const first = harness.evaluate(T0 + MINUTE).drafts;
    const second = harness.evaluate(T0 + 2 * MINUTE).drafts;
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(5);
  });

  it('em passos ou de uma vez, o resultado é o mesmo', () => {
    const whole = new Harness();
    whole.feed(traffic());
    const stepped = new Harness();
    stepped.feed(traffic());
    const steps = stepped.engine.evaluateSteps({ now: T0 + MINUTE });
    let count = 0;
    let step = steps.next();
    while (step.done !== true) {
      count += 1;
      step = steps.next();
    }
    expect(count).toBeGreaterThan(5);
    expect(step.value).toEqual(whole.evaluate(T0 + MINUTE));
  });

  it('um motor novo que relê a última hora chega às mesmas chaves', () => {
    const feedAll = (harness: Harness, now: number): void => {
      harness.feed(failures(12), T0 - SLOT, now);
      harness.feed(failures(12), T0, now);
    };
    const lived = new Harness();
    feedAll(lived, T0);
    const before = lived.evaluate(T0 + MINUTE).drafts;
    const restarted = new Harness();
    feedAll(restarted, T0 + 20 * MINUTE);
    const after = restarted.evaluate(T0 + 20 * MINUTE).drafts;
    expect(after.map((draft) => draft.sourceEventId)).toEqual(before.map((draft) => draft.sourceEventId));
  });
});

describe('resumo do dia e a barra do direcionado', () => {
  it('ruído vira um achado só por dia, com os endereços', () => {
    const harness = new Harness();
    harness.feed([...probes(12, '198.51.100.1'), ...probes(30, '198.51.100.2')]);
    const { drafts } = harness.evaluate();
    expect(drafts).toHaveLength(1);
    const draft = one(drafts, '990400');
    expect(draft).toMatchObject({
      ruleLevel: 4,
      severity: 'low',
      sourceIp: null,
      mitreTechniques: ['T1595'],
      revision: { lastSeenAt: new Date(T0 - MINUTE).toISOString() },
      evidence: {
        counters: { probes: 42, clients: 2 },
        clients: [
          { client: '198.51.100.2', requests: 30, count: 30 },
          { client: '198.51.100.1', requests: 12, count: 12 },
        ],
      },
    });
    expect(draft.recurrence).toBeUndefined();
  });

  it.each([
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 1],
  ])('detecção com atividade em %i slots', (slots, own) => {
    const harness = new Harness();
    for (let i = 0; i < slots; i += 1) harness.feed(probes(10), T0 - i * 3 * SLOT, T0);
    const { drafts } = harness.evaluate();
    expect(of(drafts, '990402')).toHaveLength(own);
    expect(of(drafts, '990400')).toHaveLength(1 - own);
  });

  it('uma rajada só num slot não é insistência, mesmo avaliada em 3 janelas', () => {
    const harness = new Harness();
    for (let i = 0; i < 3; i += 1) {
      harness.feed(i === 0 ? probes(50) : [{ client: ATTACKER }], T0 + i * SLOT, T0 + i * SLOT);
      expect(of(harness.evaluate(T0 + i * SLOT + MINUTE).drafts, '990402')).toEqual([]);
    }
  });

  it('a insistência vale por 24 h, não mais', () => {
    const at = (gapMs: number): number => {
      const harness = new Harness({ now: T0 - 2 * DAY_MS });
      for (const end of [T0 - gapMs, T0 - gapMs + SLOT, T0]) {
        harness.feed(probes(10), end, end);
        harness.evaluate(end + MINUTE);
      }
      harness.feed([], T0, T0);
      return of(harness.evaluate(T0 + 2 * MINUTE).drafts, '990402').length;
    };
    expect(at(23 * 60 * MINUTE)).toBe(1);
    expect(at(25 * 60 * MINUTE)).toBe(0);
  });

  it.each([
    [299, 0],
    [300, 1],
    [301, 1],
  ])('%i sondas no dia', (count, own) => {
    const harness = new Harness();
    harness.feed(probes(count));
    expect(of(harness.evaluate().drafts, '990402')).toHaveLength(own);
  });

  it.each([
    ['990403', [{ client: ATTACKER, path: '/backup.sql', status: 200, sent: 777_777 }]],
    ['990405', failures(20)],
    ['990406', [...failures(10), login(ATTACKER, 302)]],
  ] as const)('a %s do mesmo cliente tira a varredura dele do resumo', (_, serious) => {
    const harness = new Harness();
    harness.feed([...probes(12), ...serious]);
    const { drafts } = harness.evaluate();
    expect(of(drafts, '990402')).toHaveLength(1);
    expect(of(drafts, '990400')).toEqual([]);
  });

  it('quem participou da distribuída também', () => {
    const harness = new Harness();
    harness.feed([
      ...times(600, (i) => login(`192.0.2.${(i % 100) + 1}`, 401)),
      ...probes(12, '192.0.2.9'),
      ...probes(12, '198.51.100.9'),
    ]);
    const { drafts } = harness.evaluate();
    expect(of(drafts, '990402').map((draft) => draft.sourceIp)).toEqual(['192.0.2.9']);
    expect(one(drafts, '990400').evidence.clients.map((item) => item.client)).toEqual(['198.51.100.9']);
  });

  it('o total do dia não encolhe quando os slots saem da memória, nem dobra enquanto estão', () => {
    const harness = new Harness({ now: T0 });
    let total = 0;
    for (let i = 0; i < 40; i += 1) {
      const end = T0 + i * SLOT;
      harness.feed(probes(10, `198.51.100.${i + 1}`), end, end);
      total += 10;
      const draft = one(harness.evaluate(end + MINUTE).drafts, '990400');
      expect(draft.evidence.counters.probes).toBe(total);
      expect(draft.evidence.counters.clients).toBe(i + 1);
    }
  });

  it('a virada do dia separa os resumos, com chaves diferentes', () => {
    const midnight = Math.ceil(T0 / DAY_MS) * DAY_MS;
    const harness = new Harness();
    harness.feed(probes(10, '198.51.100.1'), midnight, midnight);
    harness.feed(probes(10, '198.51.100.2'), midnight + SLOT, midnight + SLOT);
    const digests = of(harness.evaluate(midnight + SLOT + MINUTE).drafts, '990400');
    expect(digests).toHaveLength(2);
    expect(new Set(digests.map((draft) => draft.sourceEventId)).size).toBe(2);
    expect(digests.map((draft) => draft.evidence.windowFrom)).toEqual([
      new Date(midnight - DAY_MS).toISOString(),
      new Date(midnight).toISOString(),
    ]);
  });

  it('um reinício com o estado guardado e a releitura da última hora não perde nem dobra o dia', () => {
    const end = (i: number): number => T0 + i * SLOT;
    const lived = new Harness();
    for (let i = 0; i < 30; i += 1) {
      lived.feed(probes(10, `198.51.100.${i + 1}`), end(i), end(i));
      lived.evaluate(end(i) + MINUTE);
    }
    const now = end(29) + 2 * MINUTE;
    const expected = one(lived.evaluate(now).drafts, '990400').evidence.counters;
    const state: unknown = JSON.parse(JSON.stringify(lived.engine.snapshot()));
    expect(digestStateSchema.safeParse(state).success).toBe(true);

    const restarted = new Harness();
    restarted.engine.restore(state);
    // O que vem depois do assentado é relido; reler um slot a mais, já assentado, não dobra.
    const { settledThrough } = digestStateSchema.parse(state);
    expect(settledThrough).toBe(Math.ceil(now / SLOT) - 14);
    for (let i = 29; i >= 0 && end(i) / SLOT >= (settledThrough ?? 0); i -= 1) {
      if (end(i) / SLOT === settledThrough) continue;
      restarted.feed(probes(10, `198.51.100.${i + 1}`), end(i), now);
    }
    expect(one(restarted.evaluate(now).drafts, '990400').evidence.counters).toEqual(expected);
    const reread = new Harness();
    reread.engine.restore({ ...digestStateSchema.parse(state), settledThrough: end(29) / SLOT });
    reread.feed(probes(10, '198.51.100.30'), end(29), now);
    expect(one(reread.evaluate(now).drafts, '990400').evidence.counters.probes).toBe(170);
  });

  it('a história guardada vale por 24 h, mesmo na primeira avaliação depois do reinício', () => {
    const own = (agoMs: number): number => {
      const harness = new Harness();
      const slot = Math.floor((T0 - agoMs) / SLOT);
      const track = { slots: [slot, slot + 1], seriousMs: null, targetedMs: null };
      harness.engine.restore({ version: 1, settledThrough: null, days: [], tracks: [[ATTACKER, track]] });
      harness.feed(probes(12));
      return of(harness.evaluate().drafts, '990402').length;
    };
    expect(own(60 * MINUTE)).toBe(1);
    expect(own(25 * 60 * MINUTE)).toBe(0);
  });

  it('um estado guardado que não serve é recusado', () => {
    const { engine } = new Harness();
    const good = { version: 1, settledThrough: null, days: [], tracks: [] };
    expect(() => engine.restore(good)).not.toThrow();
    for (const bad of [
      null,
      {},
      { ...good, version: 2 },
      { ...good, x: 1 },
      { ...good, days: [{ day: -1 }] },
    ]) {
      expect(() => engine.restore(bad)).toThrow();
    }
  });

  it('o dia tem teto de clientes: ficam os maiores, e o corte é dito', () => {
    const harness = new Harness({ limits: { ...DEFAULT_LIMITS, maxDayClients: 20 } });
    harness.feed([
      ...times(40, (i) => probes(10, `198.51.100.${i + 1}`)).flat(),
      ...probes(250, '192.0.2.1'),
    ]);
    harness.evaluate();
    const later = T0 + 90 * MINUTE;
    harness.evaluate(later);
    const draft = one(harness.evaluate(later).drafts, '990400');
    expect(draft.evidence.truncated).toBe(true);
    expect(draft.evidence.clients[0]?.client).toBe('192.0.2.1');
  });
});

describe('teto por regra', () => {
  const noisy = (clients: number): LineSpec[] =>
    times(clients, (i) => failures(20 + i, `198.51.100.${i + 1}`)).flat();

  it.each([
    [MAX_FINDINGS_PER_RULE - 1, MAX_FINDINGS_PER_RULE - 1],
    [MAX_FINDINGS_PER_RULE, MAX_FINDINGS_PER_RULE],
    [MAX_FINDINGS_PER_RULE + 1, MAX_FINDINGS_PER_RULE + 1],
    [MAX_FINDINGS_PER_RULE + 15, MAX_FINDINGS_PER_RULE + 1],
  ])('%i endereços viram %i achados', (clients, expected) => {
    const harness = new Harness();
    harness.feed(noisy(clients));
    const drafts = of(harness.evaluate().drafts, '990405');
    expect(drafts).toHaveLength(expected);
    const named = drafts.filter((draft) => draft.sourceIp !== null);
    expect(named).toHaveLength(Math.min(clients, MAX_FINDINGS_PER_RULE));
    // Os de maior contagem ficam com achado próprio; os outros, no resumo, que os lista.
    expect(named[0]?.sourceIp).toBe(`198.51.100.${clients}`);
    const summary = drafts.find((draft) => draft.sourceIp === null);
    if (clients <= MAX_FINDINGS_PER_RULE) {
      expect(summary).toBeUndefined();
      return;
    }
    expect(summary?.evidence.clients).toHaveLength(clients - MAX_FINDINGS_PER_RULE);
    expect(summary?.evidence.counters.clients).toBe(clients - MAX_FINDINGS_PER_RULE);
  });

  it('a 990403 e a 990406 vêm primeiro e não são dobradas', () => {
    const harness = new Harness();
    const clients = 40;
    harness.feed([
      ...noisy(30),
      ...times(clients, (i) => [...failures(12, `192.0.2.${i + 1}`), login(`192.0.2.${i + 1}`, 302)]).flat(),
      ...times(clients, (i) => ({
        client: `192.0.2.${i + 1}`,
        path: '/.env',
        status: 200,
        sent: 900,
      })),
    ]);
    const { drafts } = harness.evaluate();
    expect(of(drafts, '990406')).toHaveLength(clients);
    // Um grupo de respostas guarda até 20 clientes: os outros são ditos como corte.
    expect(of(drafts, '990403')).toHaveLength(20);
    expect(of(drafts, '990403')[0]?.evidence.truncated).toBe(true);
    const ids = drafts.map((draft) => draft.ruleId);
    expect(Math.max(ids.lastIndexOf('990403'), ids.lastIndexOf('990406'))).toBeLessThan(
      ids.indexOf('990405'),
    );
  });

  it('e têm um teto de segurança, com resumo', () => {
    const harness = new Harness();
    harness.feed(
      times(MAX_UNFOLDED_FINDINGS + 5, (i) => [
        ...failures(12, `192.0.2.${i + 1}`),
        login(`192.0.2.${i + 1}`, 302),
      ]).flat(),
    );
    const drafts = of(harness.evaluate().drafts, '990406');
    expect(drafts).toHaveLength(MAX_UNFOLDED_FINDINGS + 1);
    expect(drafts.at(-1)).toMatchObject({ sourceIp: null, evidence: { counters: { clients: 5 } } });
  });

  it('nível 10 passa na frente do barulho de nível 7', () => {
    const harness = new Harness();
    // Os barulhentos têm mais tentativas (só volume, nível 7) que as 100 falhas do nível 10.
    const volume = times(40, (i) =>
      times(300, () => ({ client: `198.51.100.${i + 1}`, method: 'POST', path: '/session', status: 200 })),
    ).flat();
    harness.feed([...volume, ...failures(100, '192.0.2.77')]);
    expect(of(harness.evaluate().drafts, '990405')[0]).toMatchObject({
      sourceIp: '192.0.2.77',
      ruleLevel: 10,
    });
  });
});

describe('chave e formato do achado', () => {
  it('chave por regra, balanceador, cliente, rota e nível; a versão é a hora da atividade', () => {
    const harness = new Harness();
    harness.feed(failures(20));
    const draft = one(harness.evaluate().drafts, '990405');
    expect(draft.sourceEventId).toMatch(/^aws\/111111111111\/alb:[0-9a-f]{40}$/);
    expect(draft.sourceEventId.length).toBeLessThanOrEqual(128);
    expect(draft.recurrence).toEqual({
      lastSeenAt: '2026-11-24T11:00:00.000Z',
      chainKey: draft.sourceEventId,
      sourceEventId: `${draft.sourceEventId}@2026-11-24T11:00:00.000Z`,
    });
    expect(draft.recurrence?.sourceEventId.length).toBeLessThanOrEqual(128);
    expect(draft).toMatchObject({
      accountId: ACCOUNT,
      source: 'aws',
      logSource: 'alb',
      region: 'sa-east-1',
      resource: 'alb:app/loja/0123456789abcdef',
      title: WEB_RULES['990405'].title,
    });
    expect(draft.correlation.keys).toEqual([
      `web:actor:${ATTACKER}`,
      'web:host:loja.exemplo.com.br:credential',
      'web:alb:0123456789abcdef',
    ]);
  });

  it('a escalada é um achado novo, e a volta não', () => {
    const harness = new Harness();
    harness.feed(failures(30));
    const medium = one(harness.evaluate(T0 + MINUTE).drafts, '990405');
    harness.feed(failures(100));
    const high = one(harness.evaluate(T0 + 2 * MINUTE).drafts, '990405');
    expect([medium.ruleLevel, high.ruleLevel]).toEqual([7, 10]);
    expect(high.sourceEventId).not.toBe(medium.sourceEventId);
    harness.evaluate(T0 + 20 * MINUTE);
    const later = T0 + 60 * MINUTE;
    harness.feed(failures(20), later, later);
    const calm = one(harness.evaluate(later + MINUTE).drafts, '990405');
    expect(calm.ruleLevel).toBe(7);
    expect(calm.sourceEventId).toBe(high.sourceEventId);
    harness.evaluate(later + 20 * MINUTE);
    const nextDay = T0 + 26 * 60 * MINUTE;
    harness.feed(failures(20), nextDay, nextDay);
    expect(one(harness.evaluate(nextDay + MINUTE).drafts, '990405').sourceEventId).toBe(medium.sourceEventId);
  });

  it('outra conta, balanceador, cliente ou rota é outra chave', () => {
    const source = {
      tenantId: 't',
      accountId: ACCOUNT,
      region: 'sa-east-1',
      loadBalancer: 'app/loja/0123456789abcdef',
    };
    const parts = { rule: '990405' as const, client: ATTACKER, host: null, route: 'h:/login', extra: '7' };
    const keys = [
      webFindingKey(source, parts),
      webFindingKey({ ...source, accountId: '222222222222' }, parts),
      webFindingKey({ ...source, loadBalancer: 'app/x/0123456789abcdef' }, parts),
      webFindingKey(source, { ...parts, client: '192.0.2.1' }),
      webFindingKey(source, { ...parts, route: 'h:/entrar' }),
      webFindingKey(source, { ...parts, extra: '10' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('trocar o host a cada tentativa não fragmenta nem envenena: sem um host só, não há host', () => {
    const harness = new Harness();
    harness.feed(times(40, (i) => login(ATTACKER, 401, { domain: `h${i}.exemplo.com.br` })));
    const draft = one(harness.evaluate().drafts, '990405');
    expect(draft.evidence.host).toBeNull();
    expect(draft.correlation.keys).toEqual([`web:actor:${ATTACKER}`, 'web:alb:0123456789abcdef']);
  });

  it('o host sem certificado casado não entra na correlação', () => {
    const harness = new Harness();
    harness.feed(times(20, () => login(ATTACKER, 401, { domain: '-' })));
    expect(one(harness.evaluate().drafts, '990405').correlation.keys.join()).not.toContain('web:host');
  });

  it('MITRE: só o da tabela do desenho', () => {
    expect(
      Object.fromEntries(Object.entries(WEB_RULES).map(([id, rule]) => [id, [...rule.techniques]])),
    ).toEqual({
      '990400': ['T1595'],
      '990401': ['T1595.002'],
      '990402': ['T1595.003'],
      '990403': ['T1190'],
      '990404': ['T1595.003'],
      '990405': ['T1110'],
      '990406': ['T1110', 'T1078'],
      '990407': ['T1110'],
    });
  });

  it('nenhum título ou evento leva texto de quem faz a requisição', () => {
    const harness = new Harness();
    const mark = 'ZQMARCAZQ';
    harness.feed([
      ...times(30, () => login(ATTACKER, 401, { userAgent: `sqlmap/1 ${mark}`, path: `/login/${mark}` })),
      ...times(30, (i) => ({ client: ATTACKER, path: `/${mark}${i}/.env`, status: 404 })),
      ...times(600, (i) => ({
        client: ATTACKER,
        path: `/${mark}/${i}x`,
        status: 404,
        domain: `${mark}.exemplo.com.br`,
      })),
      { client: ATTACKER, path: '/.env', status: 200, sent: 900 },
    ]);
    const { drafts } = harness.evaluate();
    expect(drafts.length).toBeGreaterThan(4);
    for (const draft of drafts) {
      expect(`${draft.title}${draft.eventName ?? ''}${draft.resource ?? ''}`.toLowerCase()).not.toContain(
        'zqmarca',
      );
    }
  });
});

describe('fontes confiáveis', () => {
  const source: WebTrustedSource = {
    id: 'monitor',
    cidr: '198.51.100.0/24',
    kind: 'monitor',
    reason: 'sonda de disponibilidade',
    expiresAt: '2026-12-24T00:00:00.000Z',
  };
  const noise: LineSpec[] = [
    ...times(10, () => ({ client: ATTACKER, userAgent: 'nuclei' })),
    ...probes(300),
    ...times(600, (i) => ({ client: ATTACKER, path: `/p${i}`, status: 404 })),
    ...failures(30),
  ];

  it('cala 401, 402, 404 e 405, com contador, e não entra no resumo', () => {
    const harness = new Harness({ trusted: [source] });
    harness.feed(noise);
    const result = harness.evaluate();
    expect(result.drafts).toEqual([]);
    expect(result.suppressed).toEqual([
      { sourceId: 'monitor', rule: '990401', clients: 1 },
      { sourceId: 'monitor', rule: '990402', clients: 1 },
      { sourceId: 'monitor', rule: '990404', clients: 1 },
      { sourceId: 'monitor', rule: '990405', clients: 1 },
    ]);
  });

  it('vencida não vale, e vence sozinha na troca da configuração', () => {
    const harness = new Harness({ trusted: [{ ...source, expiresAt: new Date(T0).toISOString() }] });
    harness.feed(noise);
    expect(harness.evaluate().drafts.length).toBeGreaterThan(0);
    harness.engine.configure({ now: T0, routes: [], trusted: [source] });
    expect(harness.evaluate().drafts).toEqual([]);
  });

  it.each([
    ['10.1.0.0/16', true],
    ['10.0.0.0/15', false],
    ['198.51.100.7/32', true],
    ['2001:db8::/32', true],
    ['2001:db8::/31', false],
    ['2001:db8:1:2::/64', true],
    // Mais estreita que a chave das contagens: calaria o /64 inteiro.
    ['2001:db8:1:2::/65', false],
    ['2001:db8:1:2::1/128', false],
    ['198.51.100.1/24', false],
    ['0.0.0.0/0', false],
    ['x', false],
  ])('a faixa %s: %s', (cidr, valid) => {
    expect(webTrustedSourceSchema.safeParse({ ...source, cidr }).success).toBe(valid);
    expect(new TrustedSources([{ ...source, cidr }], T0).rejected).toEqual(valid ? [] : ['monitor']);
  });

  it('validade de até 365 dias', () => {
    const at = (days: number, extraMs = 0): string[] => [
      ...new TrustedSources(
        [{ ...source, expiresAt: new Date(T0 + days * DAY_MS + extraMs).toISOString() }],
        T0,
      ).rejected,
    ];
    expect(at(365)).toEqual([]);
    expect(at(365, 1)).toEqual(['monitor']);
    expect(new TrustedSources([{ ...source, expiresAt: 'nunca' }], T0).rejected).toEqual(['monitor']);
  });

  it('a recusada não cala nada, e é avisada', () => {
    const harness = new Harness({ trusted: [{ ...source, cidr: '198.0.0.0/8' }] });
    harness.feed(noise);
    const result = harness.evaluate();
    expect(result.drafts.length).toBeGreaterThan(0);
    expect(result.notes).toContain('trusted_rejected');
  });

  it('o User-Agent nunca isenta', () => {
    for (const userAgent of ['Googlebot/2.1', 'UptimeRobot/2.0', 'ELB-HealthChecker/2.0']) {
      const harness = new Harness();
      harness.feed(times(600, (i) => ({ client: ATTACKER, path: `/p${i}`, status: 404, userAgent })));
      expect(of(harness.evaluate().drafts, '990404')).toHaveLength(1);
    }
  });
});

describe('a classe de um endereço muda com a configuração', () => {
  const asProxy: WebTrustedSource[] = [
    {
      id: 'proxy',
      cidr: '198.51.100.0/24',
      kind: 'proxy',
      reason: 'proxy reverso',
      expiresAt: '2026-12-24T00:00:00.000Z',
    },
  ];
  const declare = (harness: Harness, trusted: WebTrustedSource[], now = T0): void => {
    harness.engine.configure({ now, routes: [], trusted });
  };
  const leak: LineSpec = { client: ATTACKER, path: '/backup.sql', status: 200, sent: 777_777 };
  const success = login(ATTACKER, 302, { time: T0 - 30_000 });
  const perIp = ['990401', '990402', '990404', '990405', '990406'] as const;
  const perIpRules = (drafts: readonly WebFindingDraft[]): string[] =>
    perIp.filter((rule) => of(drafts, rule).length > 0);

  describe('direto que virou proxy', () => {
    const traffic = [...failures(60), success, ...probes(300), leak];

    it('logo depois da troca, sem linha nova, nenhuma regra por IP acusa', () => {
      const harness = new Harness();
      harness.feed(traffic);
      const before = harness.evaluate().drafts;
      expect(perIpRules(before)).toEqual(['990402', '990404', '990405', '990406']);
      expect(one(before, '990403').sourceIp).toBe(ATTACKER);
      declare(harness, asProxy);
      const { drafts, unkeyed } = harness.evaluate();
      expect(drafts.map((draft) => draft.ruleId)).toEqual(['990403']);
      expect(drafts[0]).toMatchObject({
        sourceIp: null,
        evidence: { client: null, clientClass: 'customer_proxy', counters: { answered: 1 } },
      });
      expect(JSON.stringify(drafts)).not.toContain(ATTACKER);
      expect(unkeyed).toEqual({ requests: 362, tool: 0, probes: 301, errors: 300, loginFailures: 60 });
    });

    it('nem as linhas que chegam depois, no mesmo slot aberto ou no seguinte', () => {
      const harness = new Harness();
      harness.feed(traffic);
      declare(harness, asProxy);
      harness.feed(traffic);
      harness.feed(traffic, T0 + SLOT, T0 + SLOT);
      const { drafts, unkeyed } = harness.evaluate(T0 + SLOT + MINUTE);
      expect(drafts.map((draft) => draft.ruleId)).toEqual(['990403']);
      expect(unkeyed.requests).toBe(3 * 362);
    });

    it('vale para os slots anteriores e para o objeto atrasado', () => {
      const harness = new Harness();
      harness.feed(failures(40), T0 - 3 * SLOT, T0);
      harness.evaluate(T0 - 3 * SLOT + 11 * MINUTE);
      harness.feed(failures(40), T0 - 3 * SLOT, T0);
      declare(harness, asProxy);
      harness.feed([success], T0, T0);
      expect(harness.evaluate().drafts).toEqual([]);
    });

    it('vale para o /64 inteiro de uma faixa IPv6', () => {
      const harness = new Harness();
      harness.feed(times(30, (i) => login(`2001:db8:1:2::${i + 1}`, 401)));
      expect(of(harness.evaluate().drafts, '990405')).toHaveLength(1);
      declare(
        harness,
        asProxy.map((source) => ({ ...source, cidr: '2001:db8:1:2::/64' })),
      );
      harness.feed(times(30, (i) => login(`2001:db8:1:2:ffff::${i + 1}`, 401)));
      expect(harness.evaluate().drafts).toEqual([]);
    });

    it('sai do resumo do dia: do que está na memória, do assentado e do estado guardado', () => {
      const other = probes(12, '192.0.2.9');
      const harness = new Harness();
      harness.feed([...probes(12), ...other]);
      const listed = (now: number): string[] =>
        one(harness.evaluate(now).drafts, '990400').evidence.clients.map((item) => item.client);
      expect(listed(T0 + MINUTE).sort()).toEqual(['192.0.2.9', ATTACKER]);
      // Assentado: o slot já saiu da memória.
      const later = T0 + 2 * 60 * MINUTE;
      harness.evaluate(later);
      const state: unknown = JSON.parse(JSON.stringify(harness.engine.snapshot()));
      expect(listed(later).sort()).toEqual(['192.0.2.9', ATTACKER]);
      declare(harness, asProxy, later);
      expect(listed(later)).toEqual(['192.0.2.9']);

      const live = new Harness();
      live.feed([...probes(12), ...other]);
      live.evaluate();
      declare(live, asProxy);
      expect(one(live.evaluate().drafts, '990400').evidence.clients.map((item) => item.client)).toEqual([
        '192.0.2.9',
      ]);

      const restored = new Harness({ now: later, trusted: asProxy });
      restored.engine.restore(state);
      expect(
        one(restored.evaluate(later).drafts, '990400').evidence.clients.map((item) => item.client),
      ).toEqual(['192.0.2.9']);
    });

    it('a nota de proxy e as contas por classe acompanham', () => {
      const harness = new Harness();
      harness.feed([...times(6, () => ({ client: ATTACKER })), ...times(4, () => ({ client: '192.0.2.9' }))]);
      expect(harness.evaluate().notes).toEqual([]);
      declare(harness, asProxy);
      expect(harness.evaluate().notes).toEqual(['behind_proxy']);
    });
  });

  describe('proxy que virou direto', () => {
    const traffic = [...failures(60), success, ...probes(300), leak];

    it('logo depois da troca, o que foi contado como proxy não acusa ninguém', () => {
      const harness = new Harness({ trusted: asProxy });
      harness.feed(traffic);
      expect(harness.evaluate().drafts.map((draft) => draft.ruleId)).toEqual(['990403']);
      declare(harness, []);
      const { drafts, unkeyed } = harness.evaluate();
      expect(drafts.map((draft) => draft.ruleId)).toEqual(['990403']);
      expect(drafts[0]).toMatchObject({ sourceIp: null, evidence: { clientClass: 'customer_proxy' } });
      expect(JSON.stringify(drafts)).not.toContain(ATTACKER);
      expect(unkeyed.requests).toBe(362);
    });

    it.each([
      [19, []],
      [20, [7]],
      [21, [7]],
    ])('as linhas novas contam do zero, no mesmo slot aberto: %i falhas', (count, expected) => {
      const harness = new Harness({ trusted: asProxy });
      harness.feed(traffic);
      declare(harness, []);
      harness.feed(failures(count));
      const drafts = of(harness.evaluate().drafts, '990405');
      expect(drafts.map((draft) => draft.ruleLevel)).toEqual(expected);
      for (const draft of drafts) {
        expect(draft.sourceIp).toBe(ATTACKER);
        expect(draft.evidence.counters).toMatchObject({ failures: count, requests: count, errors: 0 });
      }
    });

    it('a falha de quando era proxy não se junta ao sucesso de agora, nem noutro slot', () => {
      for (const end of [T0, T0 - SLOT]) {
        const harness = new Harness({ trusted: asProxy });
        harness.feed(failures(60), end, T0);
        declare(harness, []);
        harness.feed([success], T0, T0);
        expect(of(harness.evaluate().drafts, '990406')).toEqual([]);
        harness.feed(failures(10));
        expect(one(harness.evaluate().drafts, '990406')).toMatchObject({
          ruleLevel: 10,
          evidence: { counters: { failures: 10 } },
        });
      }
    });

    it('a resposta nova sai com o IP, e a antiga, sem', () => {
      const harness = new Harness({ trusted: asProxy });
      harness.feed([leak]);
      declare(harness, []);
      harness.feed([leak, leak]);
      const drafts = of(harness.evaluate().drafts, '990403');
      expect(drafts.map((draft) => [draft.sourceIp, draft.evidence.counters.answered]).sort()).toEqual(
        [
          [null, 1],
          [ATTACKER, 2],
        ].sort(),
      );
    });

    it('a guarda do catch-all continua a saber quem pediu a página inicial', () => {
      const harness = new Harness({ trusted: asProxy });
      harness.feed([{ client: ATTACKER, path: '/', sent: 777_777 }, leak]);
      declare(harness, []);
      // Só ele pediu a página, e ela tem o tamanho da resposta: suprimida dos dois lados da troca.
      harness.feed([leak]);
      const result = harness.evaluate();
      expect(result.drafts).toEqual([]);
      expect(result.catchAllSuppressed).toBe(2);
    });
  });

  it('a 990407 não muda com a classe, e conta o mesmo endereço uma vez só', () => {
    const at = (clients: number) => {
      const each = times(clients, (i) => failures(9, `198.51.100.${i + 1}`)).flat();
      const harness = new Harness({ trusted: asProxy });
      harness.feed(each);
      declare(harness, []);
      harness.feed(each);
      return of(harness.evaluate().drafts, '990407').map(({ evidence }) => evidence);
    };
    expect(at(29)).toEqual([]);
    expect(at(30)).toMatchObject([{ counters: { clients: 30, failures: 540 }, clients: [] }]);
  });

  it('ir e voltar no mesmo slot: cada período fica no seu lugar, e a memória volta a zero', () => {
    const harness = new Harness();
    harness.feed(failures(19));
    for (const trusted of [asProxy, [], asProxy, []]) {
      declare(harness, trusted);
      harness.feed(failures(19));
    }
    // Só o último período é direto: 19. Os outros são de proxy, ou viraram.
    const { drafts, unkeyed } = harness.evaluate();
    expect(drafts).toEqual([]);
    expect(unkeyed.loginFailures).toBe(4 * 19);
    harness.feed(failures(1));
    expect(one(harness.evaluate().drafts, '990405').evidence.counters.failures).toBe(20);
    // Quem já está de lado não é movido de novo a cada troca: o nome não cresce.
    const ids = [...harness.engine['tally'].slots.values()].flatMap((slot) => [...slot.clients.keys()]);
    expect(ids.sort()).toEqual([ATTACKER, `customer_proxy!${ATTACKER}!2`, `customer_proxy!${ATTACKER}!4`]);
    harness.evaluate(T0 + 2 * 60 * MINUTE);
    expect(Object.values(harness.engine.usage)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('a limpeza de memória acha o registro certo, mesmo o que ficou de lado', () => {
    const limits = { ...DEFAULT_LIMITS, maxClosedClients: 5 };
    const harness = new Harness({ trusted: asProxy, limits });
    harness.feed(times(40, (i) => ({ client: `198.51.100.${i + 1}`, path: '/p', status: 404 })));
    declare(harness, []);
    harness.feed([
      ...failures(25),
      ...times(40, (i) => ({ client: `198.51.100.${i + 1}`, path: '/', status: 200 })),
    ]);
    harness.evaluate(T0 + 10 * MINUTE);
    expect(harness.engine.usage.clients).toBe(5);
    harness.feed([{ client: ATTACKER }], T0 + 2 * SLOT, T0 + 2 * SLOT);
    const draft = one(harness.evaluate(T0 + 2 * SLOT + MINUTE).drafts, '990405');
    expect(draft.evidence.counters).toMatchObject({ failures: 25, requests: 27 });
    harness.evaluate(T0 + 3 * 60 * MINUTE);
    expect(harness.engine.usage.clients).toBe(0);
  });

  it('a história do endereço não atravessa o período de proxy: nem o nível, nem a barra', () => {
    const harness = new Harness();
    harness.feed(failures(100));
    const high = one(harness.evaluate().drafts, '990405');
    expect(high.ruleLevel).toBe(10);
    const later = T0 + 2 * 60 * MINUTE;
    harness.evaluate(later);
    declare(harness, asProxy, later);
    declare(harness, [], later);
    harness.feed([...failures(20), ...probes(12)], later, later);
    const drafts = harness.evaluate(later + MINUTE).drafts;
    const medium = one(drafts, '990405');
    expect(medium.ruleLevel).toBe(7);
    expect(medium.sourceEventId).not.toBe(high.sourceEventId);
    // Sem a troca, a atividade menor continuaria no achado mais alto.
    const steady = new Harness();
    steady.feed(failures(100));
    steady.evaluate();
    steady.evaluate(later);
    steady.feed(failures(20), later, later);
    expect(one(steady.evaluate(later + MINUTE).drafts, '990405').sourceEventId).toBe(high.sourceEventId);
  });

  it('a barra do direcionado também recomeça', () => {
    const own = (change: boolean): number => {
      const harness = new Harness();
      harness.feed(failures(20));
      harness.evaluate();
      const later = T0 + 2 * 60 * MINUTE;
      harness.evaluate(later);
      if (change) {
        declare(harness, asProxy, later);
        declare(harness, [], later);
      }
      harness.feed(probes(12), later, later);
      return of(harness.evaluate(later + MINUTE).drafts, '990402').length;
    };
    expect(own(false)).toBe(1);
    expect(own(true)).toBe(0);
  });

  it('configuração igual, ou que não muda proxy, não mexe em nada', () => {
    const harness = new Harness({ trusted: asProxy });
    harness.feed([...failures(30, '192.0.2.9'), ...failures(30)]);
    const before = JSON.stringify(harness.evaluate());
    declare(harness, asProxy);
    const monitor = {
      ...(asProxy[0] as WebTrustedSource),
      id: 'm',
      kind: 'monitor' as const,
      cidr: '203.0.113.0/24',
    };
    const forget = vi.spyOn(NoiseDigest.prototype, 'forget');
    declare(harness, [...asProxy, monitor]);
    expect(JSON.stringify(harness.evaluate())).toBe(before);
    // Nem percorre a memória: a tarefa configura a cada passo.
    expect(forget).not.toHaveBeenCalled();
    declare(harness, []);
    expect(forget).toHaveBeenCalledOnce();
    forget.mockRestore();
  });

  it('sem as faixas das CDNs, declarar e retirar o proxy acerta a conta de quem não se sabe', () => {
    const harness = new Harness({ ranges: [] });
    harness.feed(times(10, () => ({ client: ATTACKER })));
    expect(harness.evaluate().notes).toEqual(['proxy_ranges_unavailable']);
    declare(harness, asProxy);
    expect(harness.evaluate().notes).toEqual(['behind_proxy', 'proxy_ranges_unavailable']);
    declare(harness, []);
    expect(harness.evaluate().notes).toEqual(['proxy_ranges_unavailable']);
  });

  it('a troca que não é dele não mexe com um cliente IPv6: nem no resumo, nem no estado guardado', () => {
    const six = '2001:db8:1:2::5';
    const harness = new Harness();
    harness.feed([...probes(12, six), ...probes(12)]);
    const later = T0 + 2 * 60 * MINUTE;
    harness.evaluate();
    harness.evaluate(later);
    const state: unknown = JSON.parse(JSON.stringify(harness.engine.snapshot()));
    const listed = (target: Harness): string[] =>
      one(target.evaluate(later).drafts, '990400').evidence.clients.map((item) => item.client);
    declare(harness, asProxy, later);
    expect(listed(harness)).toEqual(['2001:db8:1:2::/64']);
    const restored = new Harness({ now: later, trusted: asProxy });
    restored.engine.restore(state);
    expect(listed(restored)).toEqual(['2001:db8:1:2::/64']);
  });

  it('a 990407 não aponta quem foi contado dos dois lados, venha qual for primeiro', () => {
    // As linhas de quando era proxy estão no slot mais novo; as novas, diretas, chegam no anterior, ainda aberto.
    const each = times(30, (i) => failures(9, `198.51.100.${i + 1}`)).flat();
    const harness = new Harness({ trusted: asProxy });
    harness.feed(each, T0, T0);
    declare(harness, []);
    harness.feed(each, T0 - SLOT, T0);
    const { evidence } = one(harness.evaluate().drafts, '990407');
    expect(evidence).toMatchObject({ counters: { clients: 30, failures: 540 }, clients: [] });
    expect(evidence.notes).toContain('client_not_direct');
  });

  it('e continua a contar uma vez só com a memória cheia e a classe trocada no meio', () => {
    const at = (clients: number) => {
      const limits = { ...DEFAULT_LIMITS, maxRouteClients: 10 };
      const each = times(9, () => times(clients, (i) => login(`198.51.100.${i + 1}`, 401))).flat();
      const harness = new Harness({ trusted: asProxy, limits });
      harness.feed(each);
      declare(harness, []);
      harness.feed(each);
      return of(harness.evaluate().drafts, '990407').map((draft) => draft.evidence.counters);
    };
    expect(at(29)).toEqual([]);
    expect(at(30)).toMatchObject([{ clients: 30, failures: 540 }]);
  });
});

describe('evidência', () => {
  const valid: WebEvidence = {
    version: 1,
    ruleId: '990405',
    windowFrom: '2026-11-24T11:45:00.000Z',
    windowTo: '2026-11-24T12:00:00.000Z',
    firstSeenAt: '2026-11-24T11:50:00.000Z',
    lastSeenAt: '2026-11-24T11:59:00.000Z',
    client: ATTACKER,
    clientClass: 'direct',
    host: 'loja.exemplo.com.br',
    route: '/api/*/login',
    routeKind: 'login',
    routeSemantics: 'declared',
    counters: {
      requests: 1,
      blocked: 0,
      errors: 0,
      toolRequests: 0,
      probes: 0,
      distinctPaths: 0,
      attempts: 0,
      failures: 0,
      successes: 0,
      clients: 1,
      answered: 0,
    },
    blockedPercent: 0,
    statuses: [],
    probeFamilies: [],
    routes: [],
    clients: [],
    userAgents: { families: [], sample: null },
    samples: [],
    pointers: [],
    truncated: false,
    notes: [],
  };
  const sample = {
    at: '2026-11-24T11:59:00.000Z',
    method: 'GET' as const,
    path: '/x',
    status: 404,
    bytes: 1,
  };

  it('é estrita', () => {
    expect(webEvidenceSchema.safeParse(valid).success).toBe(true);
    expect(webEvidenceSchema.safeParse({ ...valid, query: 'x' }).success).toBe(false);
    expect(webEvidenceSchema.safeParse({ ...valid, host: 'a b' }).success).toBe(false);
    expect(webEvidenceSchema.safeParse({ ...valid, client: 'joao' }).success).toBe(false);
    for (const path of ['/a?b=c', '/a=b', '/A', 'a', '/a b', '/á', '/a@b', '/%41']) {
      expect(webEvidenceSchema.safeParse({ ...valid, samples: [{ ...sample, path }] }).success).toBe(false);
    }
  });

  it('o item que não passa sai, e o resto fica', () => {
    const sealed = sealEvidence({
      ...valid,
      samples: [sample, { ...sample, path: '/a?senha=1' }],
      routes: [
        { path: '/ok', count: 1 },
        { path: '/ruim?x=1', count: 1 },
      ],
      pointers: [
        { objectKey: 'a\u202eb', minute: sample.at },
        { objectKey: 'ok', minute: sample.at },
      ],
      userAgents: { families: [], sample: '<script>' },
    });
    expect(sealed.samples).toEqual([sample]);
    expect(sealed.routes).toEqual([{ path: '/ok', count: 1 }]);
    expect(sealed.pointers).toEqual([{ objectKey: 'ok', minute: sample.at }]);
    expect(sealed.userAgents.sample).toBeNull();
  });

  it('um campo errado fora das listas é erro de programação, não dado gravado', () => {
    expect(() => sealEvidence({ ...valid, ruleId: 'x' })).toThrow();
  });

  it('a maior evidência possível cabe em 16 KB', () => {
    const top = Number.MAX_SAFE_INTEGER;
    const longest = {
      ...valid,
      host: 'h'.repeat(253),
      route: `/${'r'.repeat(255)}`,
      counters: Object.fromEntries(
        Object.keys(valid.counters).map((key) => [key, top]),
      ) as WebEvidence['counters'],
      statuses: times(12, () => ({ status: '4xxxx', count: top })),
      probeFamilies: [...PROBE_FAMILIES],
      routes: times(10, () => ({ path: `/${'a'.repeat(255)}`, count: top })),
      samples: times(10, () => ({ ...sample, path: `/${'b'.repeat(255)}`, bytes: top })),
      pointers: times(5, () => ({ objectKey: 'k'.repeat(512), minute: sample.at })),
      clients: times(20, () => ({ client: 'f'.repeat(49), requests: top, count: top })),
      userAgents: { families: [...UA_FAMILIES], sample: 'u'.repeat(120) },
      notes: [...EVIDENCE_NOTES],
    };
    expect(webEvidenceSchema.safeParse(longest).success).toBe(true);
    expect(sealEvidence(longest)).toEqual(longest);
    expect(Buffer.byteLength(JSON.stringify(longest))).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
    for (const over of [
      { routes: [...longest.routes, ...longest.routes] },
      { samples: [...longest.samples, ...longest.samples] },
      { pointers: [...longest.pointers, ...longest.pointers] },
      { clients: [...longest.clients, ...longest.clients] },
    ]) {
      expect(webEvidenceSchema.safeParse({ ...longest, ...over }).success).toBe(false);
    }
  });

  it('os ponteiros levam ao objeto do cliente, e a linha não fica', () => {
    const harness = new Harness();
    harness.feed(failures(20));
    const { evidence } = one(harness.evaluate().drafts, '990405');
    expect(evidence.pointers).toEqual([
      { objectKey: objectKey(T0), minute: new Date(T0 - MINUTE).toISOString() },
    ]);
    expect(evidence.samples.length).toBeGreaterThan(0);
    expect(evidence.samples.length).toBeLessThanOrEqual(10);
    const raw = albLine(login(ATTACKER, 401));
    expect(JSON.stringify(evidence)).not.toContain(raw.slice(0, 60));
    expect(JSON.stringify(evidence)).not.toContain('Root=');
  });
});

describe('limites por nó', () => {
  it('divididos entre as fontes, com piso', () => {
    expect(divideLimits(DEFAULT_LIMITS, 1).maxClients).toBe(DEFAULT_LIMITS.maxClients);
    expect(divideLimits(DEFAULT_LIMITS, 4).maxClients).toBe(DEFAULT_LIMITS.maxClients / 4);
    expect(divideLimits(DEFAULT_LIMITS, 1000).maxClients).toBe(2_000);
    expect(divideLimits(DEFAULT_LIMITS, 0).maxClients).toBe(DEFAULT_LIMITS.maxClients);
  });

  it('a lista vendorizada (vazia) é o padrão do motor', () => {
    const engine = new WebLogEngine({
      source: {
        tenantId: 't',
        accountId: ACCOUNT,
        region: 'sa-east-1',
        loadBalancer: 'app/loja/0123456789abcdef',
      },
      hashKey: new Uint8Array(16),
      now: T0,
    });
    expect(engine.evaluate({ now: T0 }).notes).toContain('proxy_ranges_unavailable');
    expect(TEST_RANGES.every((entry) => entry.source === 'teste')).toBe(true);
  });
});
