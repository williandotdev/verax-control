import { MITRE_TACTICS } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { TACTIC_LABELS, TACTIC_SHORT_LINES } from '@/features/reports/labels';
import {
  axisAngle,
  type Box,
  clampShare,
  pointOn,
  polygonPoints,
  ringPoints,
  shareDistance,
  sharePoint,
  SPIDER_RINGS,
  spiderLayout,
  wrapLabel,
} from './spider-geometry';

const CENTER = { x: 100, y: 100 };
const parse = (points: string) => points.split(' ').map((pair) => pair.split(',').map(Number));

/** Os nomes das 14 táticas, como o gráfico do MITRE os monta. */
const TACTICS = MITRE_TACTICS.map(({ id, name }) => ({
  lines: wrapLabel(TACTIC_LABELS[name] ?? name),
  shortLines: TACTIC_SHORT_LINES[name] ?? [id],
}));

const overlap = (one: Box, other: Box) =>
  one.left < other.left + other.width &&
  other.left < one.left + one.width &&
  one.top < other.top + other.height &&
  other.top < one.top + one.height;

describe('ângulos e pontos', () => {
  it('o primeiro eixo fica no topo e a volta segue o sentido horário', () => {
    expect(axisAngle(0, 14)).toBe(0);
    expect(axisAngle(1, 4)).toBeCloseTo(Math.PI / 2);
    expect(axisAngle(7, 14)).toBeCloseTo(Math.PI);
    expect(axisAngle(0, 0)).toBe(0);

    expect(pointOn(CENTER, 50, 0, 4)).toEqual({ x: 100, y: 50 });
    const right = pointOn(CENTER, 50, 1, 4);
    expect(right.x).toBeCloseTo(150);
    expect(right.y).toBeCloseTo(100);
    const bottom = pointOn(CENTER, 50, 2, 4);
    expect(bottom.x).toBeCloseTo(100);
    expect(bottom.y).toBeCloseTo(150);
    const left = pointOn(CENTER, 50, 3, 4);
    expect(left.x).toBeCloseTo(50);
    expect(left.y).toBeCloseTo(100);
  });

  it('os 14 eixos ficam a distâncias iguais, sem dois no mesmo ângulo', () => {
    const angles = Array.from({ length: 14 }, (_, index) => axisAngle(index, 14));
    for (const [index, angle] of angles.entries()) {
      expect(angle).toBeCloseTo((index * 2 * Math.PI) / 14);
    }
    expect(new Set(angles.map((angle) => angle.toFixed(6))).size).toBe(14);
  });

  it('a fração fica entre 0 e 1: fora da escala vai para a borda, e o que não é número, para o centro', () => {
    expect([-1, -0, 0, 0.25, 1, 1.2, Infinity, -Infinity, NaN].map((value) => clampShare(value) + 0)).toEqual(
      [0, 0, 0, 0.25, 1, 1, 1, 0, 0],
    );
  });
});

/** Uma escala com números redondos: raio 80, e 4 no mínimo. */
const SCALE = { center: CENTER, radius: 80, floor: 4 };

describe('escala de raiz quadrada', () => {
  it('a distância é o raio vezes a raiz da participação', () => {
    const scale = { radius: 100, floor: 0 };
    expect(shareDistance(scale, 0.01)).toBeCloseTo(10);
    expect(shareDistance(scale, 0.05)).toBeCloseTo(22.36, 2);
    expect(shareDistance(scale, 0.25)).toBe(50);
    expect(shareDistance(scale, 0.95)).toBeCloseTo(97.47, 2);
    expect(shareDistance(scale, 1)).toBe(100);
  });

  it('o zero fica no centro; o que existe, no mínimo a distância do piso', () => {
    expect(shareDistance(SCALE, 0)).toBe(0);
    expect(shareDistance(SCALE, NaN)).toBe(0);
    expect(shareDistance(SCALE, -1)).toBe(0);
    expect(shareDistance(SCALE, 0.000_001)).toBe(4);
    expect(shareDistance(SCALE, 0.0025)).toBeCloseTo(4);
    expect(shareDistance(SCALE, 0.01)).toBeCloseTo(8);
  });

  it('nunca diminui quando a participação cresce, e não passa do anel de fora', () => {
    let previous = 0;
    for (let step = 1; step <= 1_000; step += 1) {
      const distance = shareDistance(SCALE, step / 1_000);
      expect(distance).toBeGreaterThanOrEqual(previous);
      expect(distance).toBeLessThanOrEqual(80);
      previous = distance;
    }
    expect(shareDistance(SCALE, 7)).toBe(80);
  });

  it('o piso separa dois pontos vizinhos e fica sempre dentro do anel de 5%, em qualquer largura', () => {
    for (let width = 260; width <= 660; width += 5) {
      const { floor, radius, dotRadius } = spiderLayout(width, TACTICS);
      const firstRing = shareDistance({ floor: 0, radius }, SPIDER_RINGS[0]);
      expect(floor).toBeGreaterThan(dotRadius);
      expect(floor).toBeLessThan(firstRing);
    }
    // Na tela larga, dois pontos no piso, em eixos vizinhos, não se tocam.
    const { floor, dotRadius } = spiderLayout(640, TACTICS);
    const [one, other] = [pointOn(CENTER, floor, 0, 14), pointOn(CENTER, floor, 1, 14)];
    expect(Math.hypot(one.x - other.x, one.y - other.y)).toBeGreaterThan(2 * dotRadius);
  });
});

describe('polígonos', () => {
  it('a série usa a escala: um quarto da participação, metade do raio', () => {
    expect(polygonPoints(SCALE, [1, 0.25, 0.0625, 0])).toBe(
      '100.00,20.00 140.00,100.00 100.00,120.00 100.00,100.00',
    );
  });

  it('valores fora da escala não passam do anel de fora nem do centro', () => {
    const [top, right] = parse(polygonPoints(SCALE, [5, -3, 0, 0]));
    expect(top).toEqual([100, 20]);
    expect(right).toEqual([100, 100]);
  });

  it('todos zerados: tudo no centro; um eixo só com 100%: os outros no centro', () => {
    const zeros = Array.from({ length: 14 }, () => 0);
    expect(new Set(polygonPoints(SCALE, zeros).split(' '))).toEqual(new Set(['100.00,100.00']));
    const [first, ...rest] = polygonPoints(SCALE, [1, ...zeros.slice(1)]).split(' ');
    expect(first).toBe('100.00,20.00');
    expect(new Set(rest)).toEqual(new Set(['100.00,100.00']));
  });

  it('dois eixos opostos: cada um na sua distância, passando pelo centro', () => {
    const shares = Array.from({ length: 14 }, (_, index) => (index === 0 ? 0.64 : index === 7 ? 0.36 : 0));
    const points = parse(polygonPoints(SCALE, shares));
    expect(points[0]).toEqual([100, 36]);
    expect(points[7]).toEqual([100, 148]);
    expect(points.filter(([x, y]) => x === 100 && y === 100)).toHaveLength(12);
  });

  it('o anel é um polígono com um vértice por eixo, na distância da participação que ele marca', () => {
    expect(SPIDER_RINGS).toEqual([0.05, 0.25, 0.5, 1]);
    for (const ratio of SPIDER_RINGS) {
      const vertices = parse(ringPoints(SCALE, ratio, 14));
      expect(vertices).toHaveLength(14);
      for (const [x = 0, y = 0] of vertices) {
        expect(Math.hypot(x - 100, y - 100)).toBeCloseTo(80 * Math.sqrt(ratio), 1);
      }
      // Um valor igual ao do anel cai em cima dele.
      expect(sharePoint(SCALE, ratio, 0, 14).y).toBeCloseTo(100 - 80 * Math.sqrt(ratio));
    }
  });
});

describe('nomes em linhas', () => {
  it.each([
    ['Reconhecimento', ['Reconhecimento']],
    ['Acesso inicial', ['Acesso', 'inicial']],
    ['Escalada de privilégio', ['Escalada de', 'privilégio']],
    ['Comando e controle', ['Comando e', 'controle']],
    ['Impacto', ['Impacto']],
    ['', []],
    ['   ', []],
  ])('%s', (text, lines) => {
    expect(wrapLabel(text)).toEqual(lines);
  });

  it('o que passa de duas linhas, ou a palavra longa demais, termina em reticências', () => {
    expect(wrapLabel('Uma tática nova com nome bem comprido')).toEqual(['Uma tática', 'nova com…']);
    const [word = ''] = wrapLabel('x'.repeat(100));
    expect(word).toHaveLength(16);
    expect(word.endsWith('…')).toBe(true);
  });
});

describe('desenho para uma largura', () => {
  const widths = Array.from({ length: 200 }, (_, index) => 260 + index * 2);

  it('de 260 a 658 px: nada sai do quadro, e nenhum nome encosta em outro, num percentual ou na teia', () => {
    for (const width of widths) {
      const layout = spiderLayout(width, TACTICS);
      const { center, radius } = layout;
      // A menor distância do centro em que a teia ainda está: o meio de um lado do anel de fora.
      const inner = radius * Math.cos(Math.PI / 14);
      const boxes = [
        ...layout.labels.map((label) => ({ name: label.lines.join(' '), box: label })),
        ...layout.chips.map((chip) => ({ name: `${chip.ratio}`, box: chip })),
      ];
      for (const [index, { name, box }] of boxes.entries()) {
        const where = `${name} em ${width} px`;
        expect(box.left, where).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width, where).toBeLessThanOrEqual(width);
        expect(box.top, where).toBeGreaterThanOrEqual(0);
        expect(box.top + box.height, where).toBeLessThanOrEqual(layout.height);
        for (const other of boxes.slice(index + 1)) {
          expect(overlap(box, other.box), `${where} e ${other.name}`).toBe(false);
        }
      }
      for (const label of layout.labels) {
        const near = {
          x: Math.min(Math.max(center.x, label.left), label.left + label.width),
          y: Math.min(Math.max(center.y, label.top), label.top + label.height),
        };
        expect(
          Math.hypot(near.x - center.x, near.y - center.y),
          `${label.lines.join(' ')} em ${width} px`,
        ).toBeGreaterThan(inner);
        expect(label.hit.width).toBeGreaterThanOrEqual(24);
        expect(label.hit.height).toBeGreaterThanOrEqual(24);
        expect(label.hit.left).toBeGreaterThanOrEqual(-0.01);
        expect(label.hit.left + label.hit.width).toBeLessThanOrEqual(width + 0.01);
      }
    }
  });

  it('nomes curtos no celular, completos da largura média para cima, e a teia cresce até o teto', () => {
    expect(spiderLayout(270, TACTICS).compact).toBe(true);
    expect(spiderLayout(310, TACTICS).compact).toBe(true);
    expect(spiderLayout(454, TACTICS)).toMatchObject({ compact: false, fontSize: 12 });
    expect(spiderLayout(640, TACTICS)).toMatchObject({ compact: false, fontSize: 13 });
    expect(spiderLayout(640, TACTICS).radius).toBeGreaterThan(200);
    expect(spiderLayout(4_000, TACTICS).radius).toBe(240);
    // Quadro absurdo: ainda há desenho, sem número inválido.
    const tiny = spiderLayout(10, TACTICS);
    expect(tiny.radius).toBe(24);
    expect(Number.isFinite(tiny.height)).toBe(true);
  });

  it('os percentuais dos anéis dizem a participação de verdade, do menor para o maior', () => {
    const { chips, center } = spiderLayout(640, TACTICS);
    expect(chips.map((chip) => chip.label)).toEqual(['5%', '25%', '50%', '100%']);
    const tops = chips.map((chip) => chip.top);
    expect([...tops].sort((one, other) => other - one)).toEqual(tops);
    for (const chip of chips) expect(chip.left).toBeGreaterThan(center.x);
  });

  it('o nome se apoia para fora da teia: início à direita, fim à esquerda, meio no topo e embaixo', () => {
    const { labels, center } = spiderLayout(640, TACTICS);
    expect(labels.map((label) => label.anchor)).toEqual([
      'middle',
      ...Array.from({ length: 6 }, () => 'start'),
      'middle',
      ...Array.from({ length: 6 }, () => 'end'),
    ]);
    expect(labels[0]?.x).toBeCloseTo(center.x);
    expect((labels[0]?.top ?? 0) + (labels[0]?.height ?? 0)).toBeLessThan(center.y);
    expect(labels[7]?.top).toBeGreaterThan(center.y);
  });

  it('um nome a mais, comprido ou sem letra nenhuma, não quebra o desenho', () => {
    const names = [...TACTICS.slice(0, 13), { lines: wrapLabel('Nome '.repeat(30)), shortLines: [] }];
    const layout = spiderLayout(310, names);
    expect(layout.labels).toHaveLength(14);
    expect(layout.labels.every((label) => Number.isFinite(label.left) && Number.isFinite(label.top))).toBe(
      true,
    );
    expect(spiderLayout(310, []).labels).toEqual([]);
    expect(Number.isFinite(spiderLayout(310, []).height)).toBe(true);
  });
});
