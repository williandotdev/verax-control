import {
  awsWebLogsAcknowledgementSchema,
  WEB_ESTIMATE_MAX_AGE_MS,
  type WebEstimate,
  webEstimateSchema,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  acknowledgementOf,
  acknowledgementText,
  estimateKey,
  estimateView,
  formatGbPerDay,
  projectionText,
  usableEstimate,
} from './estimate';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const HOUR = 3_600_000;
const SLOW = 180_000;
const ID = '018f2c1e-0000-7000-8000-000000000001';

function estimate(overrides: Partial<WebEstimate> = {}): WebEstimate {
  return webEstimateSchema.parse({
    requestedAt: null,
    status: 'ready',
    computedAt: iso(-HOUR),
    day: '2026-11-24',
    objects: 864,
    truncated: false,
    errorCode: null,
    projection: {
      gbPerDay: 1,
      percent: 46.6,
      basis: 'monthly',
      acknowledgementRequired: true,
      validUntil: iso(-HOUR + WEB_ESTIMATE_MAX_AGE_MS),
    },
    ...overrides,
  });
}
const NO_SAMPLE = {
  status: 'no_sample',
  objects: 0,
  projection: {
    gbPerDay: null,
    percent: null,
    basis: 'monthly',
    acknowledgementRequired: true,
    validUntil: iso(WEB_ESTIMATE_MAX_AGE_MS),
  },
} as const;
const kind = (value: WebEstimate | null) => estimateView(value, NOW, SLOW).current.kind;

describe('a estimativa de volume: o que a tela mostra', () => {
  it('cada situação, pelo que a API mandou', () => {
    expect(kind(null)).toBe('never');
    expect(
      kind(estimate({ status: null, computedAt: null, day: null, objects: null, projection: null })),
    ).toBe('never');
    expect(kind(estimate())).toBe('ready');
    expect(kind(estimate(NO_SAMPLE))).toBe('no_sample');
    expect(kind(estimate({ status: 'failed', errorCode: 'bucket_denied', projection: null }))).toBe('failed');
    // Quem não lê o plano não vê a projeção: não é o mesmo que vencida.
    expect(kind(estimate({ projection: null }))).toBe('hidden');
  });

  it('vence com mais de 7 dias, e não antes; um computador com o relógio atrasado não a derruba', () => {
    const aged = (ms: number) => estimate({ computedAt: iso(-ms) });
    expect(kind(aged(WEB_ESTIMATE_MAX_AGE_MS))).toBe('ready');
    expect(kind(aged(WEB_ESTIMATE_MAX_AGE_MS + 1))).toBe('expired');
    expect(kind(aged(-60_000))).toBe('ready');
    // Vencida para quem não vê o plano também: a idade qualquer um lê.
    expect(kind(estimate({ computedAt: iso(-WEB_ESTIMATE_MAX_AGE_MS - 1), projection: null }))).toBe(
      'expired',
    );
  });

  it('pedida: esperando, com o resultado anterior à vista, e o aviso de demora só depois do prazo', () => {
    const pending = (ms: number, overrides: Partial<WebEstimate> = {}) =>
      estimateView(estimate({ requestedAt: iso(-ms), ...overrides }), NOW, SLOW);
    expect(pending(1_000)).toMatchObject({
      current: { kind: 'pending', slow: false },
      previous: { kind: 'ready' },
    });
    expect(pending(SLOW).current).toMatchObject({ slow: false });
    expect(pending(SLOW + 1).current).toMatchObject({ slow: true });
    expect(
      pending(1_000, { status: null, computedAt: null, day: null, objects: null, projection: null }).previous,
    ).toBeNull();
  });
});

describe('a estimativa que vale para autorizar', () => {
  it('só a calculada, com projeção e de até 7 dias; um pedido em andamento não a tira', () => {
    const usable = (value: WebEstimate | null) => usableEstimate({ estimate: value }, NOW);
    expect(usable(estimate())).toMatchObject({ computedAt: iso(-HOUR), truncated: false });
    expect(usable(estimate(NO_SAMPLE))).not.toBeNull();
    expect(usable(estimate({ requestedAt: iso(-1_000) }))).not.toBeNull();
    expect(usable(null)).toBeNull();
    expect(usableEstimate(undefined, NOW)).toBeNull();
    expect(usable(estimate({ projection: null }))).toBeNull();
    expect(usable(estimate({ status: 'failed', projection: null }))).toBeNull();
    expect(usable(estimate({ computedAt: iso(-WEB_ESTIMATE_MAX_AGE_MS - 1) }))).toBeNull();
  });

  it('o pedido leva exatamente os números da API, e a ciência como foi dada', () => {
    const usable = usableEstimate({ estimate: estimate() }, NOW);
    if (usable === null) throw new Error('a estimativa vale');
    for (const acknowledged of [true, false]) {
      const sent = acknowledgementOf(ID, usable, acknowledged);
      expect(sent).toEqual({
        sourceId: ID,
        estimatedAt: iso(-HOUR),
        estimatedGbPerDay: 1,
        projectedPercent: 46.6,
        acknowledged,
      });
      expect(awsWebLogsAcknowledgementSchema.safeParse(sent).success).toBe(true);
    }
    const empty = usableEstimate({ estimate: estimate(NO_SAMPLE) }, NOW);
    if (empty === null) throw new Error('a estimativa vale');
    expect(acknowledgementOf(ID, empty, true)).toMatchObject({
      estimatedGbPerDay: null,
      projectedPercent: null,
    });
  });

  it('a identidade muda com a estimativa refeita, com outro número e com outro balanceador', () => {
    const key = (id: string, value: WebEstimate) => {
      const usable = usableEstimate({ estimate: value }, NOW);
      if (usable === null) throw new Error('a estimativa vale');
      return estimateKey(id, usable);
    };
    const base = key(ID, estimate());
    const projection = estimate().projection;
    if (projection === null) throw new Error('com projeção');
    expect(key(ID, estimate())).toBe(base);
    expect(key(ID, estimate({ requestedAt: iso(0) }))).toBe(base);
    const others = [
      key(`${ID.slice(0, -1)}2`, estimate()),
      key(ID, estimate({ computedAt: iso(-2 * HOUR) })),
      key(ID, estimate({ projection: { ...projection, gbPerDay: 1.2 } })),
      key(ID, estimate({ projection: { ...projection, percent: 40 } })),
      key(ID, estimate({ projection: { ...projection, percent: null } })),
    ];
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
});

describe('os textos do volume', () => {
  const projection = (overrides = {}) => ({
    gbPerDay: 1,
    percent: 46.6,
    basis: 'monthly' as const,
    acknowledgementRequired: true,
    validUntil: iso(0),
    ...overrides,
  });

  it('GB por dia, e pouco em MB: nunca "0 GB"', () => {
    expect(formatGbPerDay(1)).toBe('1 GB');
    expect(formatGbPerDay(1.234)).toBe('1,23 GB');
    expect(formatGbPerDay(0.1)).toBe('0,1 GB');
    expect(formatGbPerDay(0.099)).toBe('99 MB');
    expect(formatGbPerDay(0.0001)).toBe('1 MB');
    expect(formatGbPerDay(0)).toBe('menos de 1 MB');
  });

  it('a base da porcentagem: o mês, a franquia do dia, ou nenhuma; com a listagem cortada, é um mínimo', () => {
    expect(projectionText(projection(), false)).toBe(
      'cerca de 1 GB por dia (46,6% do volume do mês do plano)',
    );
    expect(projectionText(projection({ basis: 'franchise' }), false)).toContain(
      'da franquia por dia do plano',
    );
    expect(projectionText(projection({ basis: 'none', percent: null }), false)).toBe(
      'cerca de 1 GB por dia (o plano não tem limite de volume)',
    );
    expect(projectionText(projection(), true)).toMatch(/^pelo menos 1 GB por dia/);
    expect(projectionText(projection({ gbPerDay: null, percent: null }), false)).toBeNull();
  });

  it('a confirmação diz o nome e o número; sem amostra, diz que não deu para medir', () => {
    const usable = { computedAt: iso(0), truncated: false, projection: projection() };
    expect(acknowledgementText('loja-alb', usable)).toBe(
      'Entendi: o loja-alb deve consumir cerca de 1 GB por dia (46,6% do volume do mês do plano).',
    );
    expect(
      acknowledgementText('blog-alb', {
        ...usable,
        projection: projection({ gbPerDay: null, percent: null }),
      }),
    ).toMatch(/^Entendi: não deu para medir o volume do blog-alb/);
  });
});
