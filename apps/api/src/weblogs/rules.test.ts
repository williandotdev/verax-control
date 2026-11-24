import { describe, expect, it } from 'vitest';
import { Harness, type LineSpec, SLOT, T0, times } from '../../test/support/alb-lines.js';
import { webEvidenceSchema } from './evidence.js';
import type { EvaluateInput, EngineOptions } from './engine.js';
import type { WebFindingDraft } from './draft.js';
import { baselineKey, type WebRuleId } from './rules.js';
import type { WebRoute } from './routes.js';

const ATTACKER = '198.51.100.7';

interface RunOptions {
  engine?: Partial<EngineOptions>;
  evaluate?: Partial<EvaluateInput>;
}

/** Cada item é um slot: o último termina em T0. */
function runSlots(
  slots: readonly (readonly LineSpec[])[],
  options: RunOptions = {},
): Harness & { drafts: WebFindingDraft[] } {
  const harness = new Harness(options.engine);
  slots.forEach((lines, i) => {
    harness.feed(lines, T0 - (slots.length - 1 - i) * SLOT, T0);
  });
  const { drafts } = harness.evaluate(T0 + 60_000, options.evaluate);
  for (const draft of drafts) expect(webEvidenceSchema.safeParse(draft.evidence).success).toBe(true);
  return Object.assign(harness, { drafts });
}

const run = (lines: readonly LineSpec[], options: RunOptions = {}): WebFindingDraft[] =>
  runSlots([lines], options).drafts;

const of = (drafts: readonly WebFindingDraft[], rule: WebRuleId): WebFindingDraft[] =>
  drafts.filter((draft) => draft.ruleId === rule);
const levels = (drafts: readonly WebFindingDraft[], rule: WebRuleId): number[] =>
  of(drafts, rule).map((draft) => draft.ruleLevel);

/** O cliente passa da barra do "direcionado" por uma enumeração de 500 caminhos (990404 alta). */
const digestOf = (drafts: readonly WebFindingDraft[]) => of(drafts, '990400')[0]?.evidence.counters;

const login = (client: string, status: number, extra: LineSpec = {}): LineSpec => ({
  client,
  method: 'POST',
  path: '/login',
  status,
  ...extra,
});

const LOGIN_ROUTE: WebRoute = {
  id: 'entrada',
  host: null,
  method: 'POST',
  path: '/minha/porta',
  kind: 'login',
  failureCodes: [401],
  successCodes: [200],
  multiplier: 1,
};

describe('990401 ferramenta pelo User-Agent', () => {
  const tool = (count: number, agent = 'sqlmap/1.7') =>
    times(count, () => ({ client: ATTACKER, userAgent: agent }));

  it.each([
    [4, 0],
    [5, 5],
    [6, 6],
  ])('%i requisições em 15 min', (count, expected) => {
    expect(digestOf(run(tool(count)))?.toolRequests ?? 0).toBe(expected);
  });

  it('soma os 3 slots da janela, e não o quarto', () => {
    const two = tool(2);
    const one = tool(1);
    // Atividade em 3 slots passa da barra: o achado é próprio.
    expect(of(runSlots([two, two, one]).drafts, '990401')[0]?.evidence.counters.toolRequests).toBe(5);
    expect(digestOf(runSlots([two, tool(3)]).drafts)?.toolRequests).toBe(5);
    expect(digestOf(runSlots([two, [], [], one]).drafts)).toBeUndefined();
    expect(digestOf(runSlots([two, [], two, one]).drafts)).toBeUndefined();
  });

  it('curl, python e Go sozinhos nunca contam', () => {
    for (const agent of ['curl/8.5', 'python-requests/2.31', 'Go-http-client/2.0']) {
      expect(run(tool(500, agent))).toEqual([]);
    }
  });

  it('a técnica de lista de palavras só com ferramenta de lista', () => {
    const targeted = (agent: string): string[] | undefined =>
      of(runSlots([tool(5, agent), tool(5, agent), tool(5, agent)]).drafts, '990401')[0]?.mitreTechniques;
    expect(targeted('sqlmap/1.7')).toEqual(['T1595.002']);
    expect(targeted('gobuster/3.6')).toEqual(['T1595.002', 'T1595.003']);
  });
});

describe('990402 sondas', () => {
  const probes = (count: number) =>
    times(count, (i) => ({ client: ATTACKER, path: `/x${i}/.env`, status: 404 }));

  it.each([
    [9, 0],
    [10, 10],
    [11, 11],
  ])('%i sondas de uma família em 15 min', (count, expected) => {
    expect(digestOf(run(probes(count)))?.probes ?? 0).toBe(expected);
  });

  it.each([
    [['/.env', '/.git/config'], 0],
    [['/.env', '/.git/config', '/wp-admin'], 3],
    [['/.env', '/.git/config', '/wp-admin', '/phpmyadmin'], 4],
  ])('famílias distintas: %j', (paths, expected) => {
    expect(digestOf(run(paths.map((path) => ({ client: ATTACKER, path, status: 404 }))))?.probes ?? 0).toBe(
      expected,
    );
  });

  it('família de plataforma respondida com 2xx ou 3xx não é sonda (o cliente usa a plataforma)', () => {
    for (const status of [200, 301, 302]) {
      expect(run(times(50, () => ({ client: ATTACKER, path: '/wp-admin/', status })))).toEqual([]);
    }
  });

  it('a evidência não leva a query', () => {
    const drafts = runSlots([
      probes(5).map((line) => ({ ...line, path: `${line.path}?chave=SEGREDO` })),
      probes(5),
      probes(5),
    ]).drafts;
    const [draft] = of(drafts, '990402');
    expect(draft).toMatchObject({ ruleLevel: 7, severity: 'medium', sourceIp: ATTACKER });
    expect(draft?.evidence.samples.length).toBeGreaterThan(0);
    expect(JSON.stringify(draft)).not.toContain('SEGREDO');
  });
});

describe('990403 sonda respondida', () => {
  const leak = (extra: LineSpec = {}): LineSpec => ({
    client: ATTACKER,
    path: '/.env',
    status: 200,
    sent: 900,
    ...extra,
  });

  it('uma resposta basta, e nada menos que uma resposta', () => {
    const [draft] = of(run([leak()]), '990403');
    expect(draft).toMatchObject({
      ruleLevel: 10,
      severity: 'high',
      sourceIp: ATTACKER,
      mitreTechniques: ['T1190'],
      evidence: { counters: { answered: 1 }, probeFamilies: ['env'], host: 'loja.exemplo.com.br' },
    });
    expect(draft?.evidence.pointers).toHaveLength(1);
    expect(of(run([]), '990403')).toEqual([]);
  });

  it.each([
    ['2xx do alvo', { status: 200 }, 1],
    ['206', { status: 206 }, 1],
    ['199', { status: 199 }, 0],
    ['300', { status: 300 }, 0],
    ['404', { status: 404 }, 0],
    ['204, sem corpo', { status: 204 }, 0],
    ['205, sem corpo', { status: 205 }, 0],
    ['nenhum byte', { sent: 0 }, 0],
    ['um byte', { sent: 1 }, 1],
    ['HEAD', { method: 'HEAD' }, 0],
    ['OPTIONS', { method: 'OPTIONS' }, 0],
    ['método inventado', { method: 'FOO' }, 1],
    ['resposta fixa do balanceador (sem alvo)', { status: 200, target: '-' as const }, 0],
    ['alvo respondeu e o cliente fechou (460)', { status: 460, target: 200 }, 1],
    ['família de plataforma', { path: '/wp-admin' }, 0],
    ['aspa no User-Agent', { userAgent: 'a"b' }, 1],
  ])('%s', (_, extra, count) => {
    expect(of(run([leak(extra)]), '990403')).toHaveLength(count);
  });

  it('nunca é calada por fonte confiável', () => {
    const trusted = [
      {
        id: 't',
        cidr: '198.51.100.0/24',
        kind: 'pentest' as const,
        reason: 'x',
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
    ];
    expect(of(run([leak()], { engine: { trusted } }), '990403')).toHaveLength(1);
  });

  it('atrás de CDN: sai sem IP, um por host', () => {
    const drafts = of(run([leak({ client: '203.0.113.5' }), leak({ client: '203.0.113.6' })]), '990403');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      sourceIp: null,
      evidence: { client: null, clientClass: 'cloudflare', counters: { answered: 2 } },
    });
    expect(drafts[0]?.evidence.notes).toContain('client_not_direct');
    expect(drafts[0]?.correlation.keys.some((key) => key.startsWith('web:actor:'))).toBe(false);
  });

  describe('guarda do catch-all', () => {
    const home = (client: string, sent: number, extra: LineSpec = {}): LineSpec => ({
      client,
      path: '/',
      sent,
      ...extra,
    });

    it.each([
      [1000, 980, 0],
      [1000, 979, 1],
      [1000, 1000, 0],
      [1000, 1020, 0],
      [1000, 1021, 1],
    ])('página inicial de %i bytes e resposta de %i', (root, sent, count) => {
      expect(of(run([home('192.0.2.50', root), leak({ sent })]), '990403')).toHaveLength(count);
    });

    it('o suprimido é contado', () => {
      const harness = new Harness();
      harness.feed([home('192.0.2.50', 900), leak(), leak({ path: '/.git/config' })]);
      const result = harness.evaluate();
      expect(of(result.drafts, '990403')).toEqual([]);
      expect(result.catchAllSuppressed).toBe(2);
    });

    it('o tamanho que só o atacante viu não vale, se alguém mais pediu a página', () => {
      expect(of(run([home('192.0.2.50', 8000), home(ATTACKER, 900), leak()]), '990403')).toHaveLength(1);
      // Sem mais ninguém, é o que há: um site que responde tudo igual a um único robô não vira alerta.
      expect(of(run([home(ATTACKER, 900), leak()]), '990403')).toEqual([]);
    });

    it.each([
      ['com query', { path: '/?x=aaaa' }],
      ['que só é a raiz depois de normalizada', { path: '/%3F' }],
      ['com barra repetida', { path: '//' }],
      ['206', { status: 206 }],
      ['POST', { method: 'POST' }],
      ['conexão cortada', { status: 460, target: 200 }],
    ])('página inicial %s não serve de medida', (_, extra) => {
      expect(of(run([home('192.0.2.50', 900, extra), leak()]), '990403')).toHaveLength(1);
    });

    it('a página inicial de outro host não suprime', () => {
      const other = home('192.0.2.50', 900, { domain: 'outra.exemplo.com.br' });
      expect(of(run([other, leak()]), '990403')).toHaveLength(1);
    });

    it.each([
      [['/.env', '/.git/config'], 1],
      [['/.env', '/.git/config', '/backup.sql'], 0],
      [['/.env', '/.git/config', '/backup.sql', '/wp-admin'], 0],
    ])('sondas diferentes com o mesmo tamanho: %j', (paths, count) => {
      expect(of(run(paths.map((path) => leak({ path }))), '990403')).toHaveLength(count);
    });

    it('PATH_INFO e variações do mesmo caminho não criam assinatura', () => {
      const paths = [
        '/phpinfo.php',
        '/phpinfo.php/.env',
        '/phpinfo.php/.git/config',
        '/phpinfo.php/wp-admin',
        '//phpinfo.php',
        '/./phpinfo.php',
      ];
      expect(of(run(paths.map((path) => leak({ path }))), '990403')).toHaveLength(1);
    });
  });
});

describe('990404 enumeração', () => {
  /** `total` requisições, `errors` com 404, em `paths` caminhos distintos. */
  const scan = (total: number, errors: number, paths: number, extra: LineSpec = {}) =>
    times(total, (i) => ({
      client: ATTACKER,
      path: `/p${i % paths}`,
      status: i < errors ? 404 : 200,
      ...extra,
    }));
  const enumerated = (lines: LineSpec[]): boolean => (digestOf(run(lines))?.errors ?? 0) > 0;

  it.each([
    [99, 99, 99, false],
    [100, 100, 100, true],
    [101, 101, 101, true],
    [100, 100, 39, false],
    [100, 100, 40, true],
    [100, 100, 41, true],
    [100, 59, 100, false],
    [100, 60, 100, true],
    [100, 61, 100, true],
  ])('%i requisições, %i recusadas, %i caminhos', (total, errors, paths, expected) => {
    expect(enumerated(scan(total, errors, paths))).toBe(expected);
  });

  it.each([400, 403, 404, 405])('o status %i conta como recusa', (status) => {
    expect(enumerated(times(100, (i) => ({ client: ATTACKER, path: `/p${i}`, status })))).toBe(true);
  });

  it.each([401, 429, 500])('o status %i não conta', (status) => {
    expect(enumerated(times(100, (i) => ({ client: ATTACKER, path: `/p${i}`, status })))).toBe(false);
  });

  it.each([
    [499, []],
    [500, [10]],
    [501, [10]],
  ])('%i caminhos distintos: nível 10 a partir de 500', (count, expected) => {
    expect(levels(run(scan(count, count, count)), '990404')).toEqual(expected);
  });

  it('500 caminhos espalhados nos 3 slots, com repetição, contam uma vez cada', () => {
    const part = (from: number, count: number) =>
      times(count, (i) => ({ client: ATTACKER, path: `/p${from + i}`, status: 404 }));
    expect(levels(runSlots([part(0, 200), part(150, 200), part(300, 200)]).drafts, '990404')).toEqual([10]);
    const [draft] = of(runSlots([part(0, 200), part(150, 200), part(300, 200)]).drafts, '990404');
    expect(draft?.evidence.counters.distinctPaths).toBe(500);
    // 499 distintos, em 3 slots: direcionado pela insistência, nível 7.
    expect(levels(runSlots([part(0, 200), part(150, 200), part(300, 199)]).drafts, '990404')).toEqual([7]);
  });

  it('trocar a query, as maiúsculas ou as barras não faz outro caminho', () => {
    const lines = times(200, (i) => ({
      client: ATTACKER,
      path: `${i % 2 === 0 ? '/Alvo' : '//alvo/'}?i=${i}`,
      status: 404,
    }));
    expect(enumerated(lines)).toBe(false);
  });
});

describe('990405 força bruta', () => {
  const failures = (count: number, client = ATTACKER, extra: LineSpec = {}) =>
    times(count, () => login(client, 401, extra));

  it.each([
    [19, []],
    [20, [7]],
    [21, [7]],
    [99, [7]],
    [100, [10]],
    [101, [10]],
  ])('%i falhas em 15 min', (count, expected) => {
    expect(levels(run(failures(count)), '990405')).toEqual(expected);
  });

  it('a razão de 0,7 olha só falha e sucesso', () => {
    const success = (count: number) => times(count, () => login(ATTACKER, 302));
    expect(levels(run([...failures(70), ...success(30)]), '990405')).toEqual([7]);
    expect(levels(run([...failures(70), ...success(31)]), '990405')).toEqual([]);
    // Um 415 ou um 500 provocado de propósito não dilui.
    const noise = times(500, () => login(ATTACKER, 500));
    expect(levels(run([...failures(20), ...noise]), '990405')).toEqual([7]);
  });

  it.each([400, 401, 403, 422, 429])('%i é falha', (status) => {
    expect(levels(run(times(20, () => login(ATTACKER, status))), '990405')).toEqual([7]);
  });

  it.each([404, 405, 500])('%i não é falha', (status) => {
    expect(levels(run(times(59, () => login(ATTACKER, status))), '990405')).toEqual([]);
  });

  it('só POST e PUT', () => {
    expect(levels(run(failures(100, ATTACKER, { method: 'GET' })), '990405')).toEqual([]);
    expect(levels(run(failures(100, ATTACKER, { method: 'PUT' })), '990405')).toEqual([10]);
  });

  it.each([
    ['o fim do caminho', (i: number) => ({ path: `/login.php/x${i}` })],
    ['as maiúsculas e as barras', (i: number) => ({ path: i % 2 === 0 ? '/LOGIN' : '//login/' })],
    ['a query', (i: number) => ({ path: `/login?i=${i}` })],
    ['o host do certificado curinga', (i: number) => ({ domain: `h${i}.exemplo.com.br` })],
    ['o parâmetro de matriz', (i: number) => ({ path: `/login;s=${i}` })],
    ['o User-Agent', (i: number) => ({ userAgent: `agente-${i}` })],
    ['aspas no User-Agent', (i: number) => ({ userAgent: `a"${i}` })],
  ])('trocar %s a cada tentativa não espalha a contagem', (_, vary) => {
    expect(levels(run(times(20, (i) => login(ATTACKER, 401, vary(i)))), '990405')).toEqual([7]);
  });

  it('endereços do mesmo /64 são um cliente', () => {
    const lines = times(20, (i) => login(`2001:db8:1:2::${(i + 1).toString(16)}`, 401));
    const [draft] = of(run(lines), '990405');
    expect(draft).toMatchObject({
      ruleLevel: 7,
      sourceIp: '2001:db8:1:2::1',
      evidence: { client: '2001:db8:1:2::/64' },
    });
  });

  it.each([
    [59, []],
    [60, [7]],
    [61, [7]],
  ])('rota que sempre responde 200: %i tentativas', (count, expected) => {
    const drafts = run(times(count, () => login(ATTACKER, 200)));
    expect(levels(drafts, '990405')).toEqual(expected);
    if (expected.length > 0) {
      expect(of(drafts, '990405')[0]?.evidence).toMatchObject({
        routeSemantics: 'unknown',
        notes: ['volume_only'],
      });
    }
  });

  it('a rota que distingue falha de sucesso não é avaliada por volume', () => {
    const others = times(5, (i) => login(`192.0.2.${i + 1}`, 401));
    expect(levels(run([...others, ...times(80, () => login(ATTACKER, 200))]), '990405')).toEqual([]);
    expect(levels(run([...others.slice(1), ...times(80, () => login(ATTACKER, 200))]), '990405')).toEqual([
      7,
    ]);
  });

  it('rota declarada: códigos, subtécnica e multiplicador', () => {
    const lines = (count: number): LineSpec[] =>
      times(count, () => ({ client: ATTACKER, method: 'POST', path: '/minha/porta', status: 401 }));
    const at = (count: number, multiplier: number) =>
      levels(run(lines(count), { engine: { routes: [{ ...LOGIN_ROUTE, multiplier }] } }), '990405');
    expect(at(19, 1)).toEqual([]);
    expect(at(20, 1)).toEqual([7]);
    expect(at(9, 0.5)).toEqual([]);
    expect(at(10, 0.5)).toEqual([7]);
    expect(at(199, 10)).toEqual([]);
    expect(at(200, 10)).toEqual([7]);
    expect(at(1000, 10)).toEqual([10]);
    const [draft] = of(run(lines(20), { engine: { routes: [LOGIN_ROUTE] } }), '990405');
    expect(draft?.mitreTechniques).toEqual(['T1110', 'T1110.001']);
    expect(draft?.evidence).toMatchObject({ routeSemantics: 'declared', route: '/minha/porta' });
    const reset = of(run(lines(20), { engine: { routes: [{ ...LOGIN_ROUTE, kind: 'reset' }] } }), '990405');
    expect(reset[0]?.mitreTechniques).toEqual(['T1110']);
    expect(of(run(failures(20)), '990405')[0]?.mitreTechniques).toEqual(['T1110']);
  });

  it('`ignore` só tira a rota das de login', () => {
    const routes: WebRoute[] = [{ ...LOGIN_ROUTE, path: '/login', kind: 'ignore' }];
    expect(levels(run(failures(100), { engine: { routes } }), '990405')).toEqual([]);
    const ignored: WebRoute[] = [{ ...LOGIN_ROUTE, method: 'ANY', path: '/.env', kind: 'ignore' }];
    const leak = { client: ATTACKER, path: '/.env', status: 200, sent: 900 };
    expect(levels(run([leak], { engine: { routes: ignored } }), '990403')).toEqual([10]);
  });
});

describe('990406 falhas e depois sucesso', () => {
  const at = (minute: number, second = 0): number => T0 - 5 * 60_000 + minute * 60_000 + second * 1000;
  const fails = (count: number, time = at(0), extra: LineSpec = {}) =>
    times(count, () => login(ATTACKER, 401, { time, ...extra }));
  const success = (time = at(1), status = 302): LineSpec => login(ATTACKER, status, { time });

  it.each([
    [9, []],
    [10, [10]],
    [11, [10]],
    [49, [10]],
    [50, [12]],
    [51, [12]],
  ])('%i falhas e um sucesso', (count, expected) => {
    expect(levels(run([...fails(count), success()]), '990406')).toEqual(expected);
  });

  it.each([
    [2, [12]],
    [3, [12]],
    [4, [10]],
  ])('50 falhas e %i sucessos', (count, expected) => {
    expect(levels(run([...fails(50), ...times(count, () => success())]), '990406')).toEqual(expected);
  });

  it('o sucesso antes das falhas não conta', () => {
    expect(levels(run([success(at(0)), ...fails(50, at(1))]), '990406')).toEqual([]);
    expect(levels(run([...fails(9, at(0)), success(at(1)), ...fails(50, at(2))]), '990406')).toEqual([]);
  });

  it('a ordem de chegada das linhas não importa', () => {
    expect(levels(run([success(), ...fails(10)]), '990406')).toEqual([10]);
  });

  it.each([
    [590, [10]],
    [600, [10]],
    [610, []],
  ])('a última falha %i segundos antes do sucesso (até 10 min)', (seconds, expected) => {
    const when = at(4);
    const failing = when - seconds * 1000;
    const slotEnd = Math.ceil((failing + 1) / SLOT) * SLOT;
    const harness = new Harness();
    harness.feed(fails(10, failing), slotEnd, T0);
    harness.feed([success(when)], T0, T0);
    expect(levels(harness.evaluate().drafts, '990406')).toEqual(expected);
  });

  it('soma 60 minutos: uma falha por slot, devagar, e não 11 slots antes', () => {
    const slow = (slots: number) => {
      const harness = new Harness();
      for (let i = slots; i >= 1; i -= 1) {
        const end = T0 - (i - 1) * SLOT;
        harness.feed(fails(1, end - 290_000), end, T0);
      }
      harness.feed([success(at(4))], T0, T0);
      return levels(harness.evaluate().drafts, '990406');
    };
    expect(slow(9)).toEqual([]);
    expect(slow(10)).toEqual([10]);
  });

  it('as falhas de mais de 60 minutos antes não somam', () => {
    const harness = new Harness();
    harness.feed(fails(5, T0 - 12 * SLOT - 10_000), T0 - 12 * SLOT, T0);
    harness.feed([...fails(5, at(0)), success()], T0, T0);
    expect(levels(harness.evaluate().drafts, '990406')).toEqual([]);
  });

  it('sai da série de 10 s certa, com muitas falhas antes e depois', () => {
    const before = times(30, (i) => login(ATTACKER, 401, { time: at(0, i) }));
    const after = times(400, (i) => login(ATTACKER, 401, { time: at(3, i % 60) }));
    const [draft] = of(run([...after, success(at(2)), ...before]), '990406');
    expect(draft?.eventName).toContain('30 falhas');
    expect(draft?.mitreTechniques).toEqual(['T1078', 'T1110']);
    expect(draft?.evidence.notes).toContain('valid_account_possible');
  });

  it('rota que não distingue não prova nada: 429 e depois 200', () => {
    const limited = times(50, () => login(ATTACKER, 429, { time: at(0) }));
    expect(levels(run([...limited, success(at(1), 200)]), '990406')).toEqual([]);
    // Com recusas da aplicação na rota (de qualquer cliente), ela distingue.
    const others = times(5, (i) => login(`192.0.2.${i + 1}`, 401));
    expect(levels(run([...limited, ...others, success(at(1), 200)]), '990406')).toEqual([12]);
  });

  it('o que o WAF barrou não é recusa de credencial', () => {
    const blocked = fails(50, at(0), { actions: 'waf', status: 403, target: '-' });
    expect(levels(run([...blocked, success()]), '990406')).toEqual([]);
  });

  it('não vale para cadastro, e vale para código de acesso', () => {
    const lines: LineSpec[] = [
      ...times(20, () => ({
        client: ATTACKER,
        method: 'POST',
        path: '/minha/porta',
        status: 401,
        time: at(0),
      })),
      { client: ATTACKER, method: 'POST', path: '/minha/porta', status: 200, time: at(1) },
    ];
    const withKind = (kind: WebRoute['kind']) =>
      levels(run(lines, { engine: { routes: [{ ...LOGIN_ROUTE, kind }] } }), '990406');
    expect(withKind('signup')).toEqual([]);
    expect(withKind('mfa')).toEqual([10]);
    expect(withKind('login')).toEqual([10]);
  });

  it('nunca é calada por fonte confiável, e a 990405 da mesma fonte é', () => {
    const trusted = [
      {
        id: 'escritorio',
        cidr: '198.51.100.0/24',
        kind: 'office' as const,
        reason: 'x',
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
    ];
    const harness = runSlots([[...fails(60), success()]], { engine: { trusted } });
    expect(levels(harness.drafts, '990406')).toEqual([12]);
    expect(levels(harness.drafts, '990405')).toEqual([]);
    expect(harness.evaluate().suppressed).toEqual([{ sourceId: 'escritorio', rule: '990405', clients: 1 }]);
  });
});

describe('990407 distribuída', () => {
  /** `clients` endereços, com `each` falhas cada um. */
  const spread = (clients: number, each: number, extra: LineSpec = {}) =>
    times(clients * each, (i) => login(`192.0.2.${(i % clients) + 1}`, 401, extra));

  it.each([
    [499, []],
    [500, [10]],
    [501, [10]],
  ])('%i falhas de 100 endereços', (count, expected) => {
    expect(levels(run(spread(100, 6).slice(0, count)), '990407')).toEqual(expected);
  });

  it.each([
    [29, []],
    [30, [10]],
    [31, [10]],
  ])('580 falhas ou mais de %i endereços', (clients, expected) => {
    expect(levels(run(spread(clients, 20)), '990407')).toEqual(expected);
  });

  it('cada um até 20: quem passa sai da conta, e não desliga a regra', () => {
    expect(levels(run(spread(30, 21)), '990407')).toEqual([]);
    const loud = times(1000, () => login(ATTACKER, 401));
    const drafts = run([...spread(50, 10), ...loud]);
    expect(levels(drafts, '990407')).toEqual([10]);
    expect(of(drafts, '990407')[0]?.evidence.counters).toMatchObject({ failures: 500, clients: 50 });
    expect(levels(run([...spread(50, 10).slice(1), ...loud]), '990407')).toEqual([]);
  });

  it('com a base de 7 dias: 200 falhas e 5 vezes a mediana', () => {
    const at = (count: number, median: number) =>
      levels(
        run(spread(50, 6).slice(0, count), {
          evaluate: { baselines: new Map([[baselineKey('loja.exemplo.com.br', 'h:/login'), median]]) },
        }),
        '990407',
      );
    expect(at(199, 1)).toEqual([]);
    expect(at(200, 1)).toEqual([10]);
    expect(at(200, 40)).toEqual([10]);
    expect(at(200, 41)).toEqual([]);
    expect(at(250, 50)).toEqual([10]);
  });

  it('vale atrás de CDN, sem listar as bordas', () => {
    const lines = times(600, (i) => login(`203.0.113.${(i % 100) + 1}`, 401));
    const [draft] = of(run(lines), '990407');
    expect(draft).toMatchObject({ ruleLevel: 10, sourceIp: null, evidence: { clients: [] } });
    expect(draft?.evidence.notes).toContain('client_not_direct');
  });

  it('a lista traz os 20 maiores, e nenhuma fonte confiável a cala', () => {
    const trusted = [
      {
        id: 'm',
        cidr: '192.0.2.0/24',
        kind: 'monitor' as const,
        reason: 'x',
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
    ];
    const [draft] = of(run(spread(100, 6), { engine: { trusted } }), '990407');
    expect(draft?.evidence.clients).toHaveLength(20);
    expect(draft?.correlation.keys).toContain('web:host:loja.exemplo.com.br:credential');
  });

  it('é por host e rota', () => {
    const half = (domain: string) => spread(50, 5, { domain });
    expect(levels(run([...half('a.exemplo.com.br'), ...half('b.exemplo.com.br')]), '990407')).toEqual([]);
  });
});

describe('cara de NAT', () => {
  const office = '192.0.2.200';
  const agents = (count: number) =>
    times(count, (i) => login(office, 302, { path: '/login', userAgent: `navegador-${i}` }));

  it('25 User-Agents e 5 logins limpos: os limites valem 5 vezes', () => {
    // Os logins limpos são numa rota; as falhas, noutra (a própria rota da falha não dá a folga).
    const failing = (count: number) =>
      times(count, () => login(office, 401, { path: '/admin/entrar', userAgent: 'navegador-0' }));
    const at = (people: number, failures: number) =>
      levels(run([...agents(people), ...failing(failures)]), '990405');
    expect(at(24, 20)).toEqual([7]);
    expect(at(25, 20)).toEqual([]);
    expect(at(25, 99)).toEqual([]);
    expect(at(25, 100)).toEqual([7]);
    expect(at(25, 500)).toEqual([10]);
  });

  it('5 logins limpos, não 4', () => {
    const browse = times(25, (i) => ({ client: office, path: '/', userAgent: `navegador-${i}` }));
    const ok = (count: number) => times(count, () => login(office, 302));
    const failing = times(20, () => login(office, 401, { path: '/admin/entrar', userAgent: 'navegador-0' }));
    expect(levels(run([...browse, ...ok(4), ...failing]), '990405')).toEqual([7]);
    expect(levels(run([...browse, ...ok(5), ...failing]), '990405')).toEqual([]);
  });

  it('quem erra mais do que acerta na rota não ganha a folga com os próprios acertos', () => {
    const lines = [...agents(25), ...times(60, () => login(office, 401))];
    expect(levels(run(lines), '990405')).toEqual([7]);
    expect(levels(run(lines), '990406').length).toBe(1);
  });

  it('nunca vale para a 990403 nem para a 990407', () => {
    const leak = { client: office, path: '/.env', status: 200, sent: 900 };
    expect(levels(run([...agents(25), leak]), '990403')).toEqual([10]);
  });
});

describe('barrado pelo WAF', () => {
  const blocked = (count: number) =>
    times(count, () => ({
      client: ATTACKER,
      userAgent: 'sqlmap/1.7',
      status: 403,
      target: '-' as const,
      actions: 'waf',
    }));
  const passed = (count: number) =>
    times(count, () => ({ client: ATTACKER, userAgent: 'sqlmap/1.7', status: 200 }));
  const tool = (lines: LineSpec[], wafCollecting: boolean) =>
    // Três slots com atividade: passa da barra, e o achado é próprio.
    of(runSlots([passed(1), passed(1), lines], { evaluate: { wafCollecting } }).drafts, '990401');

  it('95% barrado, e o que passou não atinge a regra sozinho: nível 4', () => {
    const [draft] = tool(blocked(60), true);
    expect(draft).toMatchObject({ ruleLevel: 4, severity: 'low' });
    expect(draft?.eventName).toContain('barradas pelo WAF');
    expect(draft?.evidence.notes).toContain('held_by_waf');
  });

  it.each([
    [37, 7],
    [38, 4],
    [39, 4],
  ])('a fração de 95%%: %i barradas e 2 que passaram', (count, level) => {
    expect(tool(blocked(count), true).map((draft) => draft.ruleLevel)).toEqual([level]);
  });

  it('com a fonte do WAF fora do ar, o nível não muda', () => {
    expect(tool(blocked(60), false).map((draft) => draft.ruleLevel)).toEqual([7]);
  });

  it('misturar requisições barradas não rebaixa o que passou', () => {
    expect(tool([...blocked(500), ...passed(2)], true).map((draft) => draft.ruleLevel)).toEqual([4]);
    expect(tool([...blocked(500), ...passed(3)], true).map((draft) => draft.ruleLevel)).toEqual([7]);
  });

  it('um `waf` falso no User-Agent não rebaixa', () => {
    const forged = times(60, () => ({
      client: ATTACKER,
      path: '/.env',
      status: 404,
      userAgent: 'x" - - - "t" "d" "c" 0 2026-11-24T11:59:00.000000Z "waf',
    }));
    const drafts = runSlots([forged, forged, forged], { evaluate: { wafCollecting: true } }).drafts;
    expect(levels(drafts, '990402')).toEqual([7]);
  });

  it('a força bruta barrada continua a aparecer', () => {
    const lines = times(20, () => login(ATTACKER, 403, { target: '-', actions: 'waf' }));
    const [draft] = of(run(lines, { evaluate: { wafCollecting: true } }), '990405');
    expect(draft).toMatchObject({ ruleLevel: 7, evidence: { counters: { blocked: 20 } } });
  });
});

describe('cliente que não é direto', () => {
  const noisy = (client: string): LineSpec[] => [
    ...times(200, (i) => ({ client, path: `/p${i}`, status: 404, userAgent: 'sqlmap/1.7' })),
    ...times(20, (i) => ({ client, path: `/x${i}/.env`, status: 404 })),
    ...times(100, () => login(client, 401)),
    login(client, 302),
  ];

  it.each([
    ['CDN', '203.0.113.5', {}],
    ['privado', '10.0.0.9', {}],
    [
      'proxy declarado',
      '198.51.100.7',
      {
        trusted: [
          {
            id: 'p',
            cidr: '198.51.100.0/24',
            kind: 'proxy' as const,
            reason: 'x',
            expiresAt: '2026-12-01T00:00:00.000Z',
          },
        ],
      },
    ],
    ['faixas indisponíveis', '198.51.100.7', { ranges: [] }],
  ])('%s: regras por IP desligadas, com contagem à parte', (_, client, engine) => {
    const harness = new Harness(engine);
    harness.feed(noisy(client));
    const result = harness.evaluate();
    expect(result.drafts).toEqual([]);
    expect(result.unkeyed).toEqual({ requests: 321, tool: 200, probes: 20, errors: 220, loginFailures: 100 });
  });

  it('as notas: atrás de proxy, e faixas indisponíveis ou velhas', () => {
    const notes = (lines: LineSpec[], engine: Partial<EngineOptions> = {}, now = T0) => {
      const harness = new Harness({ now, ...engine });
      harness.feed(lines);
      return harness.evaluate().notes;
    };
    const direct = times(5, () => ({ client: ATTACKER }));
    const proxied = times(5, () => ({ client: '203.0.113.9' }));
    expect(notes(direct)).toEqual([]);
    expect(notes([...direct, ...proxied])).toEqual(['behind_proxy']);
    expect(notes([...direct, ...proxied.slice(1)])).toEqual([]);
    expect(notes(direct, { ranges: [] })).toEqual(['proxy_ranges_unavailable']);
    expect(notes(direct, {}, T0 + 400 * 24 * 60 * 60_000)).toEqual(['proxy_ranges_stale']);
  });
});
