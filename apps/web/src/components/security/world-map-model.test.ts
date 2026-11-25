import { describe, expect, it, vi } from 'vitest';
import {
  type CountryTraffic,
  countryName,
  dotAt,
  dotRadius,
  hasPoint,
  HIT_RADIUS,
  MAX_PULSING,
  maxRadius,
  momentText,
  outerRadius,
  PULSE_PERIOD_MS,
  PULSE_SLOTS,
  pulsePhase,
  pulsingCodes,
  shareOf,
  summarize,
  tipPosition,
  type WorldDot,
  worldDots,
  type WorldTraffic,
} from './world-map-model';

const country = (code: string, requests: number, extra: Partial<CountryTraffic> = {}): CountryTraffic => ({
  code,
  requests,
  blocked: 0,
  flagged: 0,
  recentRequests: 0,
  recentFlagged: 0,
  ...extra,
});
const none = { requests: 0, blocked: 0, flagged: 0 };
const traffic = (countries: CountryTraffic[], extra: Partial<WorldTraffic> = {}): WorldTraffic => ({
  generatedAt: '2026-11-24T17:30:00.000Z',
  windowHours: 24,
  recentMinutes: 15,
  countries,
  unknown: none,
  throughProxy: none,
  internal: none,
  ...extra,
});

describe('soma por país', () => {
  it('ordena do maior volume ao menor, com o código no empate, e tira quem não teve requisição', () => {
    const { countries } = summarize(
      traffic([country('US', 5), country('DE', 9), country('AR', 5), country('CL', 0)]),
    );
    expect(countries.map((item) => item.code)).toEqual(['DE', 'AR', 'US']);
  });

  it('junta o mesmo código (em maiúscula ou não), somando todos os números', () => {
    const { countries } = summarize(
      traffic([
        country('BR', 10, { blocked: 1, flagged: 2, recentRequests: 3, recentFlagged: 1 }),
        country('br', 5, { blocked: 4, flagged: 3, recentRequests: 2, recentFlagged: 2 }),
      ]),
    );
    expect(countries).toEqual([
      { code: 'BR', requests: 15, blocked: 5, flagged: 5, recentRequests: 5, recentFlagged: 3 },
    ]);
  });

  it('`ZZ` e o que não tem forma de código viram origem desconhecida', () => {
    const summary = summarize(
      traffic(
        [
          country('ZZ', 7, { blocked: 1, flagged: 2 }),
          country('', 1),
          country('BRA', 2),
          country('1A', 3),
          country('BR', 10),
        ],
        { unknown: { requests: 100, blocked: 10, flagged: 5 } },
      ),
    );
    expect(summary.countries.map((item) => item.code)).toEqual(['BR']);
    expect(summary.unknown).toEqual({ requests: 113, blocked: 11, flagged: 7 });
  });

  it('o total é a soma de todos os grupos, dentro e fora do mapa', () => {
    const summary = summarize(
      traffic([country('BR', 10, { blocked: 1, flagged: 2 }), country('US', 5, { flagged: 1 })], {
        unknown: { requests: 100, blocked: 10, flagged: 5 },
        throughProxy: { requests: 1_000, blocked: 20, flagged: 7 },
        internal: { requests: 10_000, blocked: 30, flagged: 9 },
      }),
    );
    expect(summary.total).toEqual({ requests: 11_115, blocked: 61, flagged: 24 });
    expect(summary.flaggedCountries).toBe(2);
    expect(summary.throughProxy.requests).toBe(1_000);
    expect(summary.internal.requests).toBe(10_000);
  });

  it('número inválido (negativo, infinito, NaN) conta como zero, e o fracionado é truncado', () => {
    const summary = summarize(
      traffic(
        [country('BR', NaN), country('US', -4), country('DE', Infinity), country('FR', 2.9, { flagged: -1 })],
        { unknown: { requests: -1, blocked: NaN, flagged: 0 } },
      ),
    );
    expect(summary.countries).toEqual([country('FR', 2)]);
    expect(summary.total.requests).toBe(2);
  });
});

describe('raio do ponto', () => {
  it('vai de 3 px ao máximo da largura, 10 px num mapa de 1.280 px', () => {
    expect(maxRadius(1_280)).toBe(10);
    expect(maxRadius(296)).toBeCloseTo(5.08, 2);
    expect(maxRadius(200)).toBe(5);
    expect(maxRadius(4_000)).toBe(11);
    expect(dotRadius(1_000, 1_000, 1_280)).toBe(10);
    expect(dotRadius(1, 1_000, 1_280)).toBe(3);
  });

  it('cada dez vezes menos tira o mesmo tanto; mil vezes menos, ou ainda menos, fica no mínimo', () => {
    const at = (requests: number) => dotRadius(requests, 1_000_000, 1_280);
    expect(at(1_000_000) - at(100_000)).toBeCloseTo(7 / 3, 6);
    expect(at(100_000) - at(10_000)).toBeCloseTo(7 / 3, 6);
    expect(at(1_000)).toBeCloseTo(3, 6);
    expect(at(1)).toBe(3);
  });

  it('sem volume (ou sem maior), fica no mínimo, nunca NaN', () => {
    expect(dotRadius(0, 10, 1_280)).toBe(3);
    expect(dotRadius(5, 0, 1_280)).toBe(3);
    // Um volume acima do maior informado não passa do máximo.
    expect(dotRadius(50, 10, 1_280)).toBe(10);
  });
});

describe('onda', () => {
  it('a fase é fixa por código, dentro do período e espalhada', () => {
    expect(pulsePhase('BR')).toBe(pulsePhase('BR'));
    const codes = Array.from({ length: 676 }, (_, index) =>
      String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)),
    );
    const phases = codes.map((code) => pulsePhase(code));
    for (const phase of phases) {
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(PULSE_PERIOD_MS);
    }
    // Um doze avos dos códigos em cada um dos doze instantes (com folga de 2 em 56): nunca todos juntos.
    const slots = Map.groupBy(phases, (phase) => phase);
    expect([...slots.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: PULSE_SLOTS }, (_, slot) => slot * 200),
    );
    for (const slot of slots.values()) expect(Math.abs(slot.length - 676 / PULSE_SLOTS)).toBeLessThan(3);
    // As maiores origens de um site brasileiro não piscam juntas.
    const top = ['BR', 'US', 'DE', 'PT', 'AR', 'FR', 'GB', 'NL'].map((code) => pulsePhase(code));
    expect(new Set(top).size).toBeGreaterThanOrEqual(6);
    expect(new Set(top.slice(0, 4)).size).toBe(4);
  });

  it('no máximo três piscadas por segundo: cada ponto, menos de meia', () => {
    expect(1_000 / PULSE_PERIOD_MS).toBeLessThan(0.5);
  });

  it('pulsa só quem teve requisição nos últimos minutos', () => {
    const { codes, active } = pulsingCodes([
      country('BR', 10, { recentRequests: 1 }),
      country('US', 99),
      country('DE', 5, { recentRequests: 3 }),
    ]);
    expect([...codes].sort()).toEqual(['BR', 'DE']);
    expect(active).toBe(2);
  });

  it('com muitos, só os mais ativos agora (e o código no empate), e diz quantos eram', () => {
    const many = Array.from({ length: MAX_PULSING + 15 }, (_, index) =>
      country(
        `${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
        10,
        {
          recentRequests: index + 1,
        },
      ),
    );
    const { codes, active } = pulsingCodes(many);
    expect(codes.size).toBe(MAX_PULSING);
    expect(active).toBe(MAX_PULSING + 15);
    expect(codes.has(many[14]?.code ?? '')).toBe(false);
    expect(codes.has(many[15]?.code ?? '')).toBe(true);

    const tied = pulsingCodes(
      ['CC', 'AA', 'BB'].map((code) => country(code, 1, { recentRequests: 4 })),
      2,
    );
    expect([...tied.codes]).toEqual(['AA', 'BB']);
  });
});

const POINTS = { BR: [600, 400], US: [300, 200], DE: [1_000, 180] } as const;

describe('pontos', () => {
  it('na ordem do volume, no lugar do quadro em px, com a marca do suspeito e a da onda', () => {
    const dots = worldDots(
      [
        country('BR', 1_000, { recentRequests: 9 }),
        country('DE', 100, { flagged: 2, recentRequests: 5, recentFlagged: 1 }),
        country('US', 1),
      ],
      new Set(['DE']),
      POINTS,
      2_000,
      1_000,
    );
    expect(dots.map(({ code, x, y }) => [code, x, y])).toEqual([
      ['BR', 300, 200],
      ['DE', 500, 90],
      ['US', 150, 100],
    ]);
    const [br, de, us] = dots;
    expect(br).toMatchObject({ flagged: false, ring: 0, recent: false, recentFlagged: false });
    expect(de).toMatchObject({ flagged: true, ring: 3.5, recent: true, recentFlagged: true });
    expect(us?.radius).toBe(3);
    expect(br?.radius).toBeGreaterThan(de?.radius ?? 0);
    expect(de?.phase).toBe(pulsePhase('DE'));
  });

  it('o suspeito pequeno cresce até o octógono ser lido; no mapa estreito o anel é mais fino', () => {
    const list = [country('BR', 1_000_000), country('US', 1, { flagged: 1 })];
    const wide = worldDots(list, new Set(), POINTS, 2_000, 1_000);
    expect(wide[1]).toMatchObject({ radius: 3.5, ring: 3.5 });
    const narrow = worldDots(list, new Set(), POINTS, 2_000, 300);
    expect(narrow[1]).toMatchObject({ radius: 3.5, ring: 2.5 });
    expect(outerRadius({ radius: 4, ring: 2.5 })).toBe(6.5);
  });

  it('país sem ponto fica fora do mapa, sem mudar a escala dos outros', () => {
    const dots = worldDots([country('GI', 1_000_000), country('BR', 1_000)], new Set(), POINTS, 2_000, 1_280);
    expect(dots.map((dot) => dot.code)).toEqual(['BR']);
    expect(dots[0]?.radius).toBeCloseTo(3, 6);
    // Nome de propriedade herdada não é país.
    expect(hasPoint('constructor', POINTS)).toBe(false);
    expect(hasPoint('BR', POINTS)).toBe(true);
  });
});

const dot = (code: string, x: number, y: number, radius: number, ring = 0): WorldDot => ({
  code,
  x,
  y,
  radius,
  ring,
  flagged: ring > 0,
  recent: false,
  recentFlagged: false,
  phase: 0,
});

describe('qual ponto o ponteiro acerta', () => {
  it('um ponto sozinho tem área de 24 px, por menor que seja', () => {
    const only = [dot('BR', 100, 100, 3)];
    expect(dotAt(only, 100 + HIT_RADIUS, 100)?.code).toBe('BR');
    expect(dotAt(only, 100, 100 - HIT_RADIUS)?.code).toBe('BR');
    expect(dotAt(only, 100 + HIT_RADIUS + 0.5, 100)).toBeNull();
    expect(dotAt([], 0, 0)).toBeNull();
  });

  it('um ponto maior que a área mínima é acertado em todo o tamanho dele, com o anel', () => {
    const big = [dot('BR', 100, 100, 11, 3.5)];
    expect(dotAt(big, 114, 100)?.code).toBe('BR');
    expect(dotAt(big, 115, 100)).toBeNull();
  });

  it('entre dois vizinhos, vale o de borda mais perto: nenhum toma a área do outro', () => {
    const pair = [dot('FR', 100, 100, 6), dot('CH', 116, 100, 3)];
    // Entre as bordas (106 e 113): a metade é 109,5.
    expect(dotAt(pair, 109, 100)?.code).toBe('FR');
    expect(dotAt(pair, 110, 100)?.code).toBe('CH');
  });

  it('dentro de um ponto que se vê, é ele, mesmo com o centro de outro mais perto', () => {
    const pair = [dot('FR', 100, 100, 10), dot('CH', 113, 100, 3)];
    expect(dotAt(pair, 109, 100)?.code).toBe('FR');
  });

  it('um sobre o outro, vale o que está por cima (o menor, desenhado depois)', () => {
    const stacked = [dot('IT', 100, 100, 10), dot('VA', 103, 100, 3)];
    expect(dotAt(stacked, 102, 100)?.code).toBe('VA');
    expect(dotAt(stacked, 95, 100)?.code).toBe('IT');
  });
});

describe('lugar da dica', () => {
  const frame = { width: 900, height: 370 };
  const tip = { width: 200, height: 100 };

  it('à direita do ponto, centrada nele', () => {
    expect(tipPosition(dot('BR', 300, 200, 10), tip, frame)).toEqual({ left: 318, top: 150 });
    // O anel do suspeito afasta a dica.
    expect(tipPosition(dot('BR', 300, 200, 10, 3.5), tip, frame).left).toBe(321.5);
  });

  it('sem espaço à direita, vai para a esquerda', () => {
    expect(tipPosition(dot('NZ', 800, 200, 10), tip, frame)).toEqual({ left: 582, top: 150 });
  });

  it('nunca sai do mapa: em cima, embaixo e, sem lugar de nenhum lado, na borda', () => {
    expect(tipPosition(dot('SJ', 300, 10, 4), tip, frame).top).toBe(4);
    expect(tipPosition(dot('HM', 300, 365, 4), tip, frame).top).toBe(266);
    const narrow = { width: 220, height: 110 };
    for (const x of [0, 110, 220]) {
      const { left, top } = tipPosition(dot('BR', x, 50, 4), tip, narrow);
      expect(left).toBeGreaterThanOrEqual(4);
      expect(left + tip.width).toBeLessThanOrEqual(216);
      expect(top).toBeGreaterThanOrEqual(4);
      expect(top + tip.height).toBeLessThanOrEqual(106);
    }
  });
});

describe('textos', () => {
  it('o nome do país em pt-BR; sem nome, o código', () => {
    expect(countryName('US')).toBe('Estados Unidos');
    expect(countryName('QQ')).toBe('QQ');
    // Malformado: o navegador recusa, e o código aparece.
    expect(countryName('x')).toBe('x');
  });

  it('sem os nomes no navegador, o código', async () => {
    vi.resetModules();
    const names = vi.spyOn(Intl, 'DisplayNames').mockImplementation(function unsupported(): never {
      throw new RangeError('sem nomes');
    });
    const fresh = await import('./world-map-model');
    expect(fresh.countryName('BR')).toBe('BR');
    names.mockRestore();
  });

  it('o percentual não mente nas pontas: o que existe não é 0%, e só o todo é 100%', () => {
    expect(shareOf(0, 100)).toBe('0%');
    expect(shareOf(5, 0)).toBe('0%');
    expect(shareOf(1, 1_000_000)).toBe('menos de 0,1%');
    expect(shareOf(1, 1_000)).toBe('0,1%');
    expect(shareOf(45, 1_000)).toBe('4,5%');
    expect(shareOf(623, 1_000)).toBe('62%');
    expect(shareOf(9_999, 10_000)).toBe('99%');
    expect(shareOf(10, 10)).toBe('100%');
  });

  it('a hora no mesmo dia; noutro dia, com a data', () => {
    const at = new Date(2026, 10, 24, 13, 5);
    const later = new Date(2026, 10, 24, 14, 30).toISOString();
    const tomorrow = new Date(2026, 10, 25, 9, 0).toISOString();
    expect(momentText(at.toISOString(), later)).toBe('13:05');
    expect(momentText(at.toISOString(), tomorrow)).toBe('24/11/2026, 13:05');
    expect(momentText('ontem', later)).toBe('—');
  });
});
