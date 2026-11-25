// Escreve na saída padrão o apps/web/src/components/security/world-map-data.ts, a partir dos arquivos do Natural Earth já
// baixados. Não acessa a rede: quem roda baixa os dois arquivos, e o diff do arquivo gerado é o que se revisa. A mesma
// entrada dá sempre a mesma saída, byte a byte.
//
//   base=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson
//   curl -fsSLO $base/ne_110m_land.geojson
//   curl -fsSLO $base/ne_50m_admin_0_countries.geojson
//   node scripts/update-world-map.mjs ne_110m_land.geojson ne_50m_admin_0_countries.geojson > apps/web/src/components/security/world-map-data.ts
//
// Natural Earth é de domínio público (https://www.naturalearthdata.com/about/terms-of-use/): não exige atribuição.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const [landFile, countriesFile] = process.argv.slice(2);
if (countriesFile === undefined) {
  console.error(
    'uso: node scripts/update-world-map.mjs <ne_110m_land.geojson> <ne_50m_admin_0_countries.geojson>',
  );
  process.exit(2);
}

/** Os códigos que a consulta de país da API produz: os 249 da ISO 3166-1 alfa-2 e o `XK` (Kosovo). */
const CODES = [
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ',
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR',
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO',
  'JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR',
  'MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO',
  'RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV',
  'TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW',
].flatMap((line) => line.split(' '));

/**
 * Códigos que o Natural Earth desenha dentro de outro país (sem linha própria): a feição de onde sai o contorno e a
 * caixa [oeste, sul, leste, norte], em graus, que separa o pedaço. O ponto é calculado do contorno, não copiado daqui.
 */
const INSIDE_ANOTHER = {
  BQ: { feature: 'NLD', box: [-69, 11.5, -62.5, 18] },
  CC: { feature: 'IOA', box: [96, -13, 98, -11] },
  CX: { feature: 'IOA', box: [105, -11, 106, -10] },
  GF: { feature: 'FRA', box: [-55, 2, -51, 6] },
  GP: { feature: 'FRA', box: [-62, 15.5, -61, 17] },
  MQ: { feature: 'FRA', box: [-61.5, 14, -60.5, 15.2] },
  RE: { feature: 'FRA', box: [55, -22, 56, -20] },
  SJ: { feature: 'NOR', box: [10, 74, 34, 81] },
  TK: { feature: 'NZL', box: [-173, -10, -171, -8] },
  YT: { feature: 'FRA', box: [44.5, -13.5, 45.5, -12.5] },
};

/** Sem ponto no mapa, e por quê. Mudou a lista (dado novo, código novo)? O gerador para: quem revisa decide. */
const WITHOUT_POINT = {
  AQ: 'Antártida: fica fora do recorte do mapa',
  BV: 'Ilha Bouvet: não está no arquivo 1:50 milhões',
  GI: 'Gibraltar: não está no arquivo 1:50 milhões',
  UM: 'ilhas menores dos EUA: não estão no arquivo 1:50 milhões',
};

// O quadro do mapa e o recorte (a Antártida fica de fora; a Groenlândia e Svalbard entram inteiras).
const WIDTH = 2000;
const HEIGHT = 820;
const MARGIN_X = 40;
const MARGIN_TOP = 6;
const NORTH = 83.7;
const SOUTH = -57;
/** O meridiano do meio. O corte cai em 169° O, no estreito de Bering: a Rússia, Fiji e a Nova Zelândia ficam inteiras. */
const CENTER_LON = 11;
const CUT_LON = CENTER_LON - 180;
/** Até esta distância do contorno (em graus), o ponto de rótulo vale: ilhas e microestados menores que a generalização. */
const LABEL_TOLERANCE = 0.25;
const MAX_PATH_BYTES = 30_000;

// ---------------------------------------------------------------- leitura e conferência

const fail = (message) => {
  throw new Error(message);
};

/** Os arquivos viram código: só entra o que tem a forma esperada, e nenhum texto deles é copiado. */
function load(file, minFeatures) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- arquivo baixado, passado na linha de comando
  const content = readFileSync(file);
  const data = JSON.parse(content.toString('utf8'));
  if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features)) fail(`${file}: não é um GeoJSON`);
  if (data.features.length < minFeatures) fail(`${file}: poucas feições: download incompleto?`);
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    features: data.features.map((feature, index) => ({
      properties: feature?.properties ?? {},
      polygons: polygonsOf(feature?.geometry, `${file}, feição ${index}`),
    })),
  };
}

function polygonsOf(geometry, where) {
  if (geometry?.type === 'Polygon') return [polygonOf(geometry.coordinates, where)];
  if (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates))
    return geometry.coordinates.map((polygon) => polygonOf(polygon, where));
  return fail(`${where}: geometria inesperada`);
}

function polygonOf(rings, where) {
  if (!Array.isArray(rings) || rings.length === 0) fail(`${where}: polígono vazio`);
  return rings.map((ring) => {
    if (!Array.isArray(ring) || ring.length < 4) fail(`${where}: anel curto demais`);
    const points = ring.map((point) => {
      const [lon, lat] = Array.isArray(point) ? point : [];
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90)
        fail(`${where}: coordenada inválida`);
      return [lon, lat];
    });
    const [first, last] = [points[0], points.at(-1)];
    if (first[0] !== last[0] || first[1] !== last[1]) fail(`${where}: anel aberto`);
    return points;
  });
}

// ---------------------------------------------------------------- geometria plana

/** Área com sinal (anel fechado ou aberto). */
function signedArea(ring) {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [ax, ay] = ring[index];
    const [bx, by] = ring[(index + 1) % ring.length];
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

function insideRing([x, y], ring) {
  let inside = false;
  for (let index = 0, last = ring.length - 1; index < ring.length; last = index, index += 1) {
    const [ax, ay] = ring[index];
    const [bx, by] = ring[last];
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

const insidePolygon = (point, [outer, ...holes]) =>
  insideRing(point, outer) && !holes.some((hole) => insideRing(point, hole));

/** Distância do ponto ao contorno. */
function distanceToRing([x, y], ring) {
  let best = Infinity;
  for (let index = 1; index < ring.length; index += 1) {
    const [ax, ay] = ring[index - 1];
    const [dx, dy] = [ring[index][0] - ax, ring[index][1] - ay];
    const length = dx * dx + dy * dy;
    const at = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
    best = Math.min(best, Math.hypot(x - ax - at * dx, y - ay - at * dy));
  }
  return best;
}

function boxOf(ring) {
  const xs = ring.map(([x]) => x);
  const ys = ring.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const largest = (polygons) =>
  polygons.reduce((best, polygon) =>
    Math.abs(signedArea(polygon[0])) > Math.abs(signedArea(best[0])) ? polygon : best,
  );

/** Um ponto bem dentro do polígono: entre os de uma grade, o mais longe do contorno. */
function innerPoint(polygon) {
  const [west, south, east, north] = boxOf(polygon[0]);
  const STEPS = 40;
  let best = null;
  for (let row = 1; row < STEPS; row += 1) {
    for (let column = 1; column < STEPS; column += 1) {
      const point = [west + ((east - west) * column) / STEPS, south + ((north - south) * row) / STEPS];
      if (!insidePolygon(point, polygon)) continue;
      const distance = distanceToRing(point, polygon[0]);
      if (best === null || distance > best.distance) best = { point, distance };
    }
  }
  return best?.point ?? fail('polígono sem ponto interno');
}

// ---------------------------------------------------------------- projeção

// Robinson: pseudocilíndrica, feita para o mapa-múndi inteiro (não infla os polos como a Mercator), com os paralelos
// retos e quase equidistantes: recortada em 83,7° N e 57° S, é naturalmente larga (2,4:1). Tabela do autor, de 5 em 5
// graus: o comprimento do paralelo e a distância dele ao equador.
const LENGTHS = [
  1, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216, 0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186,
  0.6732, 0.6213, 0.5722, 0.5322,
];
const DISTANCES = [
  0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435,
  0.8936, 0.9394, 0.9761, 1,
];

/** Catmull-Rom na tabela; antes do equador, o paralelo espelhado (o comprimento é par, a distância é ímpar). */
function interpolate(table, lat, parity) {
  const at = Math.min(table.length - 2, Math.floor(lat / 5));
  const t = lat / 5 - at;
  const p1 = table[at];
  const p2 = table[at + 1];
  const p0 = at > 0 ? table[at - 1] : parity * table[1];
  const p3 = at + 2 < table.length ? table[at + 2] : 2 * p2 - p1;
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

const scale = (WIDTH - 2 * MARGIN_X) / (2 * 0.8487 * Math.PI);
const rise = (lat) => Math.sign(lat) * 1.3523 * interpolate(DISTANCES, Math.abs(lat), -1);

/** Longitude desenrolada (de `CUT_LON` a `CUT_LON` + 360) e latitude no quadro do mapa. */
function project([lon, lat]) {
  const half = 0.8487 * interpolate(LENGTHS, Math.abs(lat), 1);
  return [
    WIDTH / 2 + (scale * half * (lon - CENTER_LON) * Math.PI) / 180,
    MARGIN_TOP + scale * (rise(NORTH) - rise(lat)),
  ];
}

/** O corte do mapa é em 169° O: o que fica a oeste dele vai para a ponta direita. */
const unrollLon = (lon) => (lon < CUT_LON ? Number((lon + 360).toFixed(9)) : lon);

/**
 * Um anel inteiro de um lado só do corte (o meio dele decide): as duas ilhas que o meridiano 169° O atravessa (São
 * Lourenço e Umnak) ficam inteiras, um nada além da borda da projeção.
 */
function unrollRing(ring) {
  const [west, , east] = boxOf(ring);
  return (west + east) / 2 < CUT_LON ? ring.map(([lon, lat]) => [Number((lon + 360).toFixed(9)), lat]) : ring;
}

// ---------------------------------------------------------------- a terra

/**
 * Junta os polígonos que se encostam (o Natural Earth corta a Rússia e Fiji em 180°, e com o corte do mapa em 169° O os
 * pedaços ficam lado a lado): a aresta percorrida nos dois sentidos some, e as que sobram formam o contorno. Antes, as
 * arestas sobre 180° são partidas nos vértices do outro lado.
 */
function dissolve(rings) {
  const key = ([x, y]) => `${x},${y}`;
  const onSeam = [
    ...new Set(
      rings
        .flat()
        .filter(([x]) => x === 180)
        .map(([, y]) => y),
    ),
  ].sort((a, b) => a - b);
  const edges = new Map();
  for (const ring of rings) {
    for (let index = 1; index < ring.length; index += 1) {
      const [from, to] = [ring[index - 1], ring[index]];
      const stops = [from];
      if (from[0] === 180 && to[0] === 180) {
        const [low, high] = [Math.min(from[1], to[1]), Math.max(from[1], to[1])];
        const between = onSeam.filter((lat) => lat > low && lat < high).map((lat) => [180, lat]);
        stops.push(...(from[1] < to[1] ? between : between.reverse()));
      }
      stops.push(to);
      for (let step = 1; step < stops.length; step += 1) {
        const [a, b] = [key(stops[step - 1]), key(stops[step])];
        if (a === b) continue;
        const back = `${b}|${a}`;
        if (edges.has(back)) edges.delete(back);
        else edges.set(`${a}|${b}`, [a, b]);
      }
    }
  }
  const next = new Map();
  for (const [a, b] of edges.values()) next.set(a, [...(next.get(a) ?? []), b]);
  const loops = [];
  while (next.size > 0) {
    const [start] = next.keys();
    const loop = [];
    let current = start;
    do {
      loop.push(current.split(',').map(Number));
      const options = next.get(current) ?? fail('contorno da terra aberto');
      const following = options.pop();
      if (options.length === 0) next.delete(current);
      current = following;
    } while (current !== start);
    loops.push(loop);
  }
  return loops;
}

/** O anel no quadro do mapa, em inteiros, sem pontos repetidos nem no meio de uma reta. */
function quantise(loop) {
  let points = loop.map((point) => project(point).map((value) => Math.round(value)));
  for (;;) {
    // Um ponto a menos pode deixar o vizinho repetido ou no meio de uma reta: até não sobrar nenhum.
    const extra = points.findIndex(([x, y], index) => {
      const [ax, ay] = points.at(index - 1);
      const [bx, by] = points[(index + 1) % points.length];
      return (x - ax) * (by - ay) === (bx - ax) * (y - ay);
    });
    if (extra === -1 || points.length < 3) return points;
    points = points.toSpliced(extra, 1);
  }
}

/** O anel como trecho do `d` do SVG: o começo absoluto, o resto relativo, com o mínimo de separadores. */
function ringPath(points) {
  const numbers = [];
  for (let index = 1; index < points.length; index += 1)
    numbers.push(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  const body = numbers.map((value, index) => (index === 0 || value < 0 ? `${value}` : ` ${value}`)).join('');
  return `M${points[0].join(' ')}l${body}z`;
}

const land = load(landFile, 100);
const rings = land.features
  .flatMap(({ polygons }) => polygons.flat())
  // Fora do recorte (a Antártida).
  .filter((ring) => boxOf(ring)[3] > SOUTH)
  .map(unrollRing);
const subpaths = dissolve(rings)
  .map(quantise)
  .filter((points) => points.length >= 3 && Math.abs(signedArea(points)) >= 1)
  .sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
const landPath = subpaths.map(ringPath).join('');
if (subpaths.length < 80 || subpaths.length > 200) fail(`número inesperado de contornos: ${subpaths.length}`);
if (!/^[Mlz0-9 -]+$/.test(landPath)) fail('caminho da terra fora do formato');
if (landPath.length > MAX_PATH_BYTES) fail(`caminho da terra com ${landPath.length} bytes`);

// ---------------------------------------------------------------- os pontos dos países

const countries = load(countriesFile, 200);
const byCode = new Map();
const byFeature = new Map();
for (const feature of countries.features) {
  byFeature.set(feature.properties.ADM0_A3, feature);
  const code = feature.properties.ISO_A2_EH;
  if (typeof code !== 'string' || !/^[A-Z]{2}$/.test(code)) continue;
  byCode.set(code, [...(byCode.get(code) ?? []), feature]);
}

const points = {};
const snapped = [];
const tolerated = [];
const without = [];
for (const code of CODES) {
  const source = sourceOf(code);
  if (source === null) {
    without.push(code);
    continue;
  }
  const [x, y] = project([unrollLon(source[0]), source[1]]).map((value) => Math.round(value));
  if (source[1] < SOUTH || source[1] > NORTH) {
    without.push(code);
    continue;
  }
  if (x < 0 || x > WIDTH || y < 0 || y > HEIGHT) fail(`${code}: ponto fora do mapa`);
  points[code] = [x, y];
}

/** O lugar do ponto de um país, em graus; null quando os dados não têm o país. */
function sourceOf(code) {
  const inside = Object.hasOwn(INSIDE_ANOTHER, code) ? INSIDE_ANOTHER[code] : undefined;
  if (inside !== undefined) {
    if (byCode.has(code)) fail(`${code}: já tem linha própria no Natural Earth; tire da lista`);
    const [west, south, east, north] = inside.box;
    const pieces = (byFeature.get(inside.feature)?.polygons ?? []).filter(([outer]) => {
      const [w, s, e, n] = boxOf(outer);
      return w >= west && s >= south && e <= east && n <= north;
    });
    if (pieces.length === 0) fail(`${code}: nenhum pedaço na caixa`);
    return innerPoint(largest(pieces));
  }
  const features = byCode.get(code);
  if (features === undefined) return null;
  // Mais de uma feição com o mesmo código (a Austrália e as ilhas dela): vale a maior.
  const feature = features.reduce((best, item) =>
    Math.abs(signedArea(largest(item.polygons)[0])) > Math.abs(signedArea(largest(best.polygons)[0]))
      ? item
      : best,
  );
  const label = [feature.properties.LABEL_X, feature.properties.LABEL_Y];
  if (!label.every(Number.isFinite) || Math.abs(label[0]) > 180 || Math.abs(label[1]) > 90)
    fail(`${code}: ponto de rótulo inválido`);
  if (feature.polygons.some((polygon) => insidePolygon(label, polygon))) return label;
  const distance = Math.min(...feature.polygons.map(([outer]) => distanceToRing(label, outer)));
  if (distance <= LABEL_TOLERANCE) {
    tolerated.push(`${code} (${distance.toFixed(2)}°)`);
    return label;
  }
  // O rótulo do arquipélago fica no mar: vai para dentro da maior ilha.
  snapped.push(`${code} (${distance.toFixed(2)}°)`);
  return innerPoint(largest(feature.polygons));
}

if (new Set(CODES).size !== 250) fail(`lista de códigos com ${new Set(CODES).size}`);
if (without.join() !== Object.keys(WITHOUT_POINT).join())
  fail(`sem ponto: ${without.join(' ')} (esperado ${Object.keys(WITHOUT_POINT).join(' ')})`);

// ---------------------------------------------------------------- saída

const target = fileURLToPath(
  new URL('../apps/web/src/components/security/world-map-data.ts', import.meta.url),
);
const source = `/**
 * Mapa-múndi do painel: a terra num caminho só, sem fronteiras (nada de político é desenhado), e o ponto de cada país.
 *
 * GERADO por \`scripts/update-world-map.mjs\` a partir do Natural Earth 5.1.2 (domínio público); não editar à mão.
 * - Terra: \`ne_110m_land.geojson\`, sha256 ${land.sha256}
 * - Pontos: \`ne_50m_admin_0_countries.geojson\`, sha256 ${countries.sha256}
 *
 * Projeção de Robinson centrada em ${CENTER_LON}° L (o corte cai no estreito de Bering: a Rússia e Fiji ficam inteiras),
 * recortada de 83,7° N a 57° S. As coordenadas são do quadro de ${WIDTH} por ${HEIGHT}.
 */

export const WORLD_MAP_WIDTH = ${WIDTH};
export const WORLD_MAP_HEIGHT = ${HEIGHT};

/** Códigos que a API produz e que não têm ponto: aparecem só na lista e na tabela. */
export const CODES_WITHOUT_POINT: readonly string[] = [
${Object.entries(WITHOUT_POINT)
  .map(([code, reason]) => `  // ${reason}.\n  '${code}',`)
  .join('\n')}
];

/** Código ISO 3166-1 alfa-2 (mais \`XK\`) para o ponto do país no quadro. */
export const COUNTRY_POINTS: Readonly<Record<string, readonly [x: number, y: number]>> = {
${Object.entries(points)
  .map(([code, [x, y]]) => `  ${code}: [${x}, ${y}],`)
  .join('\n')}
};

/** A terra: ${subpaths.length} contornos, ${landPath.length} bytes. Regra de preenchimento \`evenodd\` (o mar Cáspio é um buraco). */
export const WORLD_LAND_PATH =
  '${landPath}';
`;
process.stdout.write(await format(source, { ...(await resolveConfig(target)), parser: 'typescript' }));
console.error(`terra: ${subpaths.length} contornos, ${landPath.length} bytes`);
console.error(`pontos: ${Object.keys(points).length}; sem ponto: ${without.join(' ')}`);
console.error(`rótulo fora do contorno, dentro da tolerância: ${tolerated.join(', ') || 'nenhum'}`);
console.error(`rótulo no mar, levado para a maior ilha: ${snapped.join(', ') || 'nenhum'}`);
