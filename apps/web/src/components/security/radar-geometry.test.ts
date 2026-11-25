import {
  FINDING_SOURCES,
  RADAR_SECTORS,
  type RadarCase,
  type RadarDetection,
  radarSectorOf,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  angleOf,
  capNotice,
  caseScale,
  echoDelay,
  freshIds,
  hashUnit,
  MAX_CASE_SCALE,
  pointAt,
  RADAR_CENTER,
  RADAR_MIN_RADIUS,
  RADAR_RADIUS,
  radarBlips,
  radarCaseBlips,
  radarRings,
  radiusOf,
  SECTOR_MARGIN_DEG,
  SWEEP_PERIOD_MS,
} from './radar-geometry';

const HOUR = 3_600_000;
const NOW = '2026-11-15T12:00:00.000Z';
const SINCE = '2026-11-14T12:00:00.000Z';

const detection = (overrides: Partial<RadarDetection> = {}): RadarDetection => ({
  id: '018f2c1e-0000-7000-8000-000000001001',
  severity: 'high',
  status: 'new',
  source: 'cloudtrail',
  occurredAt: NOW,
  title: 'Achado de teste',
  incident: null,
  ...overrides,
});

const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => `018f2c1e-0000-7000-8000-${String(index).padStart(12, '0')}`);

describe('setores do radar', () => {
  it('cada fonte de log cai no setor da origem: AWS, GCP, Cloudflare e agentes', () => {
    expect(radarSectorOf('cloudtrail')).toBe('aws');
    expect(radarSectorOf('guardduty')).toBe('aws');
    expect(radarSectorOf('waf')).toBe('aws');
    expect(radarSectorOf('gcp_audit')).toBe('gcp');
    expect(radarSectorOf('cloudflare_audit')).toBe('cloudflare');
    expect(radarSectorOf('cloudflare_waf')).toBe('cloudflare');
    expect(radarSectorOf('wazuh_agent')).toBe('agents');
  });

  it('o ângulo fica dentro do quarto do setor, longe da borda, e é o mesmo a cada atualização', () => {
    for (const source of FINDING_SOURCES) {
      const sector = RADAR_SECTORS.indexOf(radarSectorOf(source));
      for (const id of ids(50)) {
        const angle = angleOf({ id, source });
        expect(angle).toBeGreaterThanOrEqual(sector * 90 + SECTOR_MARGIN_DEG);
        expect(angle).toBeLessThanOrEqual((sector + 1) * 90 - SECTOR_MARGIN_DEG);
        expect(angleOf({ id, source })).toBe(angle);
      }
    }
  });

  it('o hash espalha os IDs pelo setor (não amontoa num ponto)', () => {
    const values = ids(200).map(hashUnit);
    expect(Math.min(...values)).toBeLessThan(0.1);
    expect(Math.max(...values)).toBeGreaterThan(0.9);
    expect(new Set(values.map((value) => Math.floor(value * 4))).size).toBe(4);
  });

  it('cada ponto leva o setor da origem', () => {
    const blips = radarBlips(
      {
        since: SINCE,
        detections: [
          detection({ id: ids(3)[0], source: 'guardduty' }),
          detection({ id: ids(3)[1], source: 'waf' }),
          detection({ id: ids(3)[2], source: 'wazuh_agent' }),
        ],
      },
      NOW,
    );
    expect(blips.map((blip) => blip.sector)).toEqual(['aws', 'aws', 'agents']);
  });
});

describe('distância pela idade', () => {
  const since = Date.parse(SINCE);
  const until = Date.parse(NOW);

  it('agora fica no raio mínimo, o começo da janela no anel de fora, e cresce pela raiz da idade', () => {
    const span = RADAR_RADIUS - RADAR_MIN_RADIUS;
    expect(radiusOf(until, since, until)).toBe(RADAR_MIN_RADIUS);
    expect(radiusOf(since, since, until)).toBe(RADAR_RADIUS);
    // 6 horas de 24: a metade do caminho (as horas recentes ganham espaço); 1 hora, um quinto.
    expect(radiusOf(until - 6 * HOUR, since, until)).toBeCloseTo(RADAR_MIN_RADIUS + span / 2);
    expect(radiusOf(until - HOUR, since, until)).toBeCloseTo(RADAR_MIN_RADIUS + span * Math.sqrt(1 / 24));
    // Sempre crescente: mais velha, mais longe.
    const radii = Array.from({ length: 25 }, (_, hours) => radiusOf(until - hours * HOUR, since, until));
    for (let index = 1; index < radii.length; index += 1) {
      expect(radii[index]).toBeGreaterThan(radii[index - 1] ?? Infinity);
    }
  });

  it('fora da janela fica na borda mais próxima (relógio adiantado no centro, mais velha no anel de fora)', () => {
    expect(radiusOf(until + HOUR, since, until)).toBe(RADAR_MIN_RADIUS);
    expect(radiusOf(since - HOUR, since, until)).toBe(RADAR_RADIUS);
  });

  it('os anéis marcam 1, 3, 6, 12 e 24 horas atrás, no raio da mesma escala dos pontos', () => {
    const rings = radarRings(24);
    expect(rings.map((ring) => ring.hours)).toEqual([1, 3, 6, 12, 24]);
    for (const ring of rings) {
      expect(ring.radius).toBeCloseTo(radiusOf(until - ring.hours * HOUR, since, until));
    }
    expect(rings.at(-1)?.radius).toBe(RADAR_RADIUS);
  });
});

describe('coordenadas polares', () => {
  it('0 grau é o topo e o sentido é horário', () => {
    const top = pointAt(0, 100);
    expect(top.x).toBeCloseTo(RADAR_CENTER);
    expect(top.y).toBeCloseTo(RADAR_CENTER - 100);
    const right = pointAt(90, 100);
    expect(right.x).toBeCloseTo(RADAR_CENTER + 100);
    expect(right.y).toBeCloseTo(RADAR_CENTER);
  });

  it('cada detecção vira um ponto no ângulo do setor e na distância da idade, na ordem recebida', () => {
    const [first, second] = ids(2);
    const blips = radarBlips(
      {
        since: SINCE,
        detections: [
          detection({ id: first, source: 'gcp_audit', occurredAt: NOW }),
          detection({ id: second, source: 'cloudflare_waf', occurredAt: SINCE }),
        ],
      },
      NOW,
    );
    expect(blips.map((blip) => blip.detection.id)).toEqual([first, second]);
    const [gcp, cloudflare] = blips;
    expect(gcp?.sector).toBe('gcp');
    expect(gcp?.radius).toBe(RADAR_MIN_RADIUS);
    expect(gcp?.angle).toBeGreaterThan(90);
    expect(gcp?.angle).toBeLessThan(180);
    expect(cloudflare?.sector).toBe('cloudflare');
    expect(cloudflare?.radius).toBe(RADAR_RADIUS);
    // No terceiro quarto (180 a 270 graus): abaixo e à esquerda do centro.
    expect(cloudflare?.x).toBeLessThan(RADAR_CENTER);
    expect(cloudflare?.y).toBeGreaterThan(RADAR_CENTER);
    const distance = Math.hypot((cloudflare?.x ?? 0) - RADAR_CENTER, (cloudflare?.y ?? 0) - RADAR_CENTER);
    expect(distance).toBeCloseTo(RADAR_RADIUS);
  });
});

describe('teto, pulso e brilho', () => {
  it('avisa quando o total da janela passa das detecções desenhadas', () => {
    expect(capNotice({ total: 134, detections: Array.from({ length: 100 }, () => detection()) })).toEqual({
      shown: 100,
      total: 134,
    });
    expect(capNotice({ total: 2, detections: [detection(), detection()] })).toBeNull();
    expect(capNotice({ total: 0, detections: [] })).toBeNull();
  });

  it('pulsa, na primeira leitura, só as dos últimos 15 minutos; depois, só as que chegaram', () => {
    const [a = '', b = '', c = ''] = ids(3);
    const recent = detection({ id: a, occurredAt: new Date(Date.parse(NOW) - 5 * 60_000).toISOString() });
    const older = detection({ id: b, occurredAt: new Date(Date.parse(NOW) - 40 * 60_000).toISOString() });
    expect([...freshIds([recent, older], null, NOW)]).toEqual([a]);
    const arrived = detection({ id: c, occurredAt: new Date(Date.parse(NOW) - 50 * 60_000).toISOString() });
    expect([...freshIds([recent, older, arrived], new Set([a, b]), NOW)]).toEqual([c]);
    expect(freshIds([recent, older], new Set([a, b]), NOW).size).toBe(0);
  });

  it('o brilho começa quando a varredura passa pelo ângulo do ponto (atraso negativo, dentro de uma volta)', () => {
    expect(echoDelay(0)).toBe(-SWEEP_PERIOD_MS);
    expect(echoDelay(90)).toBe(-0.75 * SWEEP_PERIOD_MS);
    expect(echoDelay(180, 8_000)).toBe(-4_000);
    for (const angle of [10, 100, 200, 350]) {
      const delay = echoDelay(angle);
      expect(delay).toBeLessThanOrEqual(0);
      expect(delay).toBeGreaterThan(-SWEEP_PERIOD_MS);
      // A varredura chega ao ângulo em `angle / 360` do período; com o atraso negativo, a animação anda `-delay` à
      // frente do relógio: ali, ela está no começo (0%) de uma volta.
      const phase = ((angle / 360) * SWEEP_PERIOD_MS - delay) % SWEEP_PERIOD_MS;
      expect(Math.min(phase, SWEEP_PERIOD_MS - phase)).toBeLessThan(1);
    }
  });
});

describe('pontos dos casos', () => {
  const item = (overrides: Partial<RadarCase> = {}): RadarCase => ({
    id: ids(1)[0] ?? '',
    title: 'Caso',
    severity: 'high',
    sources: ['cloudtrail'],
    sector: 'aws',
    total: 1,
    pending: 1,
    recent: 1,
    lastActivityAt: NOW,
    incident: null,
    ...overrides,
  });

  it('o setor vem da API, a distância é a da última atividade, e o ângulo do caso não muda entre as leituras', () => {
    const [a = '', b = '', c = ''] = ids(3);
    const items = [
      item({ id: a, sector: 'agents', sources: [] }),
      item({ id: b, sector: 'gcp', lastActivityAt: SINCE }),
      // Mais velho que a janela (não deveria vir): na borda.
      item({ id: c, sector: 'cloudflare', lastActivityAt: '2020-01-01T00:00:00.000Z' }),
    ];
    const blips = radarCaseBlips({ items }, { since: SINCE }, NOW);
    expect(blips.map((blip) => [blip.item.id, blip.sector])).toEqual([
      [a, 'agents'],
      [b, 'gcp'],
      [c, 'cloudflare'],
    ]);
    expect(blips.map((blip) => blip.radius)).toEqual([RADAR_MIN_RADIUS, RADAR_RADIUS, RADAR_RADIUS]);
    for (const [index, blip] of blips.entries()) {
      const quarter = [3, 1, 2][index] ?? 0;
      expect(blip.angle).toBeGreaterThan(quarter * 90);
      expect(blip.angle).toBeLessThan((quarter + 1) * 90);
    }
    const later = radarCaseBlips(
      { items: [item({ id: b, sector: 'gcp', total: 900, lastActivityAt: NOW })] },
      { since: SINCE },
      NOW,
    );
    expect(later[0]?.angle).toBe(blips[1]?.angle);
  });

  it('o tamanho cresce com os alertas, sem passar do teto', () => {
    expect(caseScale(0)).toBe(1);
    expect(caseScale(1)).toBe(1);
    expect(caseScale(10)).toBeCloseTo(1.32);
    expect(caseScale(100)).toBeCloseTo(1.64);
    const sizes = [1, 2, 10, 50, 100, 1_000, 5_000].map(caseScale);
    expect([...sizes].sort((x, y) => x - y)).toEqual(sizes);
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(caseScale(20_000)).toBe(MAX_CASE_SCALE);
    expect(caseScale(2_000_000_000)).toBe(MAX_CASE_SCALE);
    expect(radarCaseBlips({ items: [item({ total: 100 })] }, { since: SINCE }, NOW)[0]?.scale).toBe(
      caseScale(100),
    );
  });
});
