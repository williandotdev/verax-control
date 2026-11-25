import { describe, expect, it } from 'vitest';
import { DEMO_CODES } from '@/pages/catalog/world-map-demo';
import {
  CODES_WITHOUT_POINT,
  COUNTRY_POINTS,
  WORLD_LAND_PATH,
  WORLD_MAP_HEIGHT,
  WORLD_MAP_WIDTH,
} from './world-map-data';
import { countryName } from './world-map-model';

type Point = readonly [x: number, y: number];

/** Os contornos da terra, do `d` do caminho (um começo absoluto e o resto relativo). */
const CONTOURS: Point[][] = WORLD_LAND_PATH.split('z')
  .filter((part) => part !== '')
  .map((part) => {
    const [start = '', steps = ''] = part.slice(1).split('l');
    let [x = NaN, y = NaN] = start.split(' ').map(Number);
    const points: Point[] = [[x, y]];
    const numbers = [...steps.matchAll(/-?\d+/g)].map(([text]) => Number(text));
    for (let index = 0; index < numbers.length; index += 2) {
      x += numbers[index] ?? NaN;
      y += numbers[index + 1] ?? NaN;
      points.push([x, y]);
    }
    return points;
  });

/** O ponto cai na terra? Pela mesma regra do desenho (`evenodd`). */
function onLand([x, y]: Point): boolean {
  let inside = false;
  for (const ring of CONTOURS) {
    ring.forEach(([ax, ay], index) => {
      const [bx, by] = ring.at(index - 1) as Point;
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    });
  }
  return inside;
}

const point = (code: string): Point => {
  const found = COUNTRY_POINTS[code];
  if (!found) throw new Error(`sem ponto: ${code}`);
  return found;
};
const extent = (ring: readonly Point[]) => {
  const xs = ring.map(([x]) => x);
  return { left: Math.min(...xs), right: Math.max(...xs) };
};

describe('terra do mapa', () => {
  it('cabe no orçamento: um caminho de até 30 KB, só com números inteiros dentro do quadro', () => {
    expect(WORLD_LAND_PATH.length).toBeLessThanOrEqual(30_000);
    expect(WORLD_LAND_PATH).toMatch(/^[Mlz0-9 -]+$/);
    expect(CONTOURS.length).toBeGreaterThan(80);
    for (const [x, y] of CONTOURS.flat()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(WORLD_MAP_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(WORLD_MAP_HEIGHT);
    }
    // Uma faixa larga: perto de 2,5 por 1.
    expect(WORLD_MAP_WIDTH / WORLD_MAP_HEIGHT).toBeCloseTo(2.44, 2);
  });

  it('os mares são mares (o Cáspio é um buraco no continente) e os continentes são terra', () => {
    // Pontos calculados com a projeção do gerador: Atlântico (20° N, 30° O), Cáspio (41,5° N, 51° L), Pacífico (10° N,
    // 140° O), golfo do México (25° N, 90° O), baía de Hudson (59° N, 85° O) e mar Vermelho (20° N, 38° L).
    const seas: Point[] = [
      [785, 356],
      [1195, 227],
      [198, 417],
      [476, 326],
      [587, 125],
      [1141, 356],
    ];
    expect(seas.map(onLand)).toEqual(seas.map(() => false));
    // Manaus, Alasca (65° N, 152° O), Madagascar, o interior da Austrália e o lago Vitória (a terra não tem lagos).
    const land: Point[] = [
      [622, 496],
      [340, 92],
      [1186, 592],
      [1704, 676],
      [1117, 483],
    ];
    expect(land.map(onLand)).toEqual(land.map(() => true));
  });

  it('o antimeridiano não corta nada: a ponta da Rússia faz parte da Eurásia, à direita', () => {
    const [eurasia = []] = CONTOURS;
    // O cabo Dejnev (169,65° O) fica em x = 1718. Se a Rússia ficasse partida em 180°, o continente pararia em 1685.
    expect(extent(eurasia).right).toBeGreaterThanOrEqual(1_716);
    // Nenhum contorno atravessa o mapa de ponta a ponta.
    for (const ring of CONTOURS) {
      const { left, right } = extent(ring);
      expect(right - left).toBeLessThan(WORLD_MAP_WIDTH * 0.5);
    }
  });

  it('não desenha fronteira: os vizinhos estão no mesmo contorno', () => {
    // Uma fronteira partiria o continente em vários contornos grandes. São só estes: Eurásia e África, as Américas e a
    // Austrália passam de 150 unidades de largura; com a Groenlândia, os quatro.
    const wide = CONTOURS.filter((ring) => extent(ring).right - extent(ring).left > 150);
    expect(wide).toHaveLength(4);
  });
});

describe('pontos dos países', () => {
  it('todo código que a API produz tem ponto ou está na lista dos sem ponto, e nunca nos dois', () => {
    const withPoint = Object.keys(COUNTRY_POINTS);
    expect(new Set([...withPoint, ...CODES_WITHOUT_POINT]).size).toBe(250);
    expect(withPoint).toHaveLength(250 - CODES_WITHOUT_POINT.length);
    expect(CODES_WITHOUT_POINT).toEqual(['AQ', 'BV', 'GI', 'UM']);
    expect([...withPoint, ...CODES_WITHOUT_POINT].sort()).toEqual([...DEMO_CODES].sort());
  });

  it('todo código tem nome em pt-BR', () => {
    for (const code of [...Object.keys(COUNTRY_POINTS), ...CODES_WITHOUT_POINT])
      expect(countryName(code), code).not.toBe(code);
    expect(countryName('DE')).toBe('Alemanha');
    expect(countryName('XK')).toBe('Kosovo');
  });

  it('cada ponto cai na terra desenhada; só as ilhas pequenas demais para a escala ficam no mar', () => {
    const atSea = Object.entries(COUNTRY_POINTS)
      .filter(([, place]) => !onLand(place))
      .map(([code]) => code);
    expect(atSea.join(' ')).toBe(
      'AG AI AS AW AX BB BH BL BM BQ CC CK CV CW CX DM FM FO GD GG GP GS GU HM IM IO JE KI KM KN KY LC MF MH MO MP MQ MS ' +
        'MT MU MV NF NR NU PF PM PN PW RE SC SH ST SX TC TK TO TT TV VC VG VI WF WS YT',
    );
  });

  it('cada ponto fica dentro do quadro, com folga para o raio, e só a ilha dividida em dois repete o lugar', () => {
    for (const [code, [x, y]] of Object.entries(COUNTRY_POINTS)) {
      expect(x, code).toBeGreaterThan(20);
      expect(x, code).toBeLessThan(WORLD_MAP_WIDTH - 20);
      expect(y, code).toBeGreaterThan(10);
      expect(y, code).toBeLessThan(WORLD_MAP_HEIGHT - 10);
    }
    const byPlace = Map.groupBy(Object.entries(COUNTRY_POINTS), ([, place]) => place.join());
    const shared = [...byPlace.values()].filter((group) => group.length > 1);
    // A ilha de São Martinho (metade francesa e metade holandesa) é menor que uma unidade do quadro.
    expect(shared.map((group) => group.map(([code]) => code))).toEqual([['MF', 'SX']]);
  });

  it('o mundo está no lugar: leste e oeste, norte e sul, e o Pacífico na ponta certa', () => {
    const west = ['US', 'BR', 'PT', 'DE', 'RU', 'IN', 'CN', 'JP', 'NZ', 'FJ'].map((code) => point(code)[0]);
    expect(west).toEqual([...west].sort((a, b) => a - b));
    const north = ['SJ', 'NO', 'DE', 'IT', 'EG', 'NG', 'KE', 'AO', 'ZA', 'HM'].map((code) => point(code)[1]);
    expect(north).toEqual([...north].sort((a, b) => a - b));
    // Com o corte em 169° O, o que está a leste da Nova Zelândia até ali fica à direita; o Havaí e o resto, à esquerda.
    for (const code of ['FJ', 'TO', 'WS', 'AS', 'NU', 'TK', 'WF', 'TV'])
      expect(point(code)[0], code).toBeGreaterThan(1_800);
    for (const code of ['PF', 'CK', 'PN', 'KI']) expect(point(code)[0], code).toBeLessThan(300);
  });

  it('os territórios que o Natural Earth desenha dentro de outro país ficam no lugar deles', () => {
    // Guiana Francesa entre Suriname e Brasil; Reunião perto de Maurício; Svalbard ao norte da Noruega.
    expect(point('GF')[0]).toBeGreaterThan(point('SR')[0]);
    expect(point('GF')[1]).toBeLessThan(point('BR')[1]);
    expect(Math.hypot(point('RE')[0] - point('MU')[0], point('RE')[1] - point('MU')[1])).toBeLessThan(20);
    expect(Math.hypot(point('YT')[0] - point('KM')[0], point('YT')[1] - point('KM')[1])).toBeLessThan(20);
    expect(Math.hypot(point('MQ')[0] - point('DM')[0], point('MQ')[1] - point('DM')[1])).toBeLessThan(10);
    expect(Math.hypot(point('GP')[0] - point('DM')[0], point('GP')[1] - point('DM')[1])).toBeLessThan(10);
    expect(Math.hypot(point('BQ')[0] - point('CW')[0], point('BQ')[1] - point('CW')[1])).toBeLessThan(10);
    expect(point('SJ')[1]).toBeLessThan(40);
    // As duas ilhas australianas do Índico: Cocos a oeste da Ilha Christmas, as duas a oeste da Austrália.
    expect(point('CC')[0]).toBeLessThan(point('CX')[0]);
    expect(point('CX')[0]).toBeLessThan(point('AU')[0]);
  });
});
