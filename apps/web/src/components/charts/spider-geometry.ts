import { textWidth } from './chart-utils';

/**
 * Geometria do gráfico de teia (um radar de eixos, em SVG puro): um eixo por categoria, a partir do topo e no sentido
 * horário, com anéis poligonais a 5%, 25%, 50% e 100%.
 *
 * A distância do centro é a raiz quadrada da participação. As participações somam 100%, então numa escala linear, com
 * oito eixos, a série inteira seria um pontinho no centro, e um eixo com 95% esconderia todos os outros. Na raiz, 1% fica
 * a 10% do raio, 5% a 22%, 25% na metade e 95% a 97%. Os anéis seguem a mesma escala e dizem o percentual de verdade.
 *
 * O tamanho sai da largura do quadro: o raio é o maior que deixa o nome de cada eixo inteiro dentro dela, e a altura
 * sai do raio. Os nomes completos diminuem de letra e, quando ainda deixariam a teia pequena demais (celular), dão lugar
 * aos curtos. A largura do texto é a estimativa folgada de `textWidth`, para as fontes mais largas do Linux também
 * caberem.
 */

/** Os anéis da grade, em participação. */
export const SPIDER_RINGS = [0.05, 0.25, 0.5, 1] as const;

/** O teto da distância mínima, em fração do raio: ela fica sempre dentro do primeiro anel (5%, a 22% do raio). */
const MAX_FLOOR = 0.2;
/** Respiro entre a borda do quadro e os nomes. */
const PAD = 4;
/** Respiro entre dois nomes do mesmo lado. */
const LABEL_SPACE = 4;
/** Teto do raio: acima disto, a teia só ocuparia espaço. */
const MAX_RADIUS = 240;
/** Piso do raio, para um quadro estreito demais ainda ter desenho. */
const MIN_RADIUS = 24;
/** Até este seno, o eixo conta como vertical: o nome fica centrado em cima ou embaixo dele. */
const VERTICAL_SIN = 0.1;
/** Lado mínimo da área de toque de um nome. */
const HIT_SIZE = 24;
/** Uma palavra mais longa que isto, no nome de um eixo, é cortada com reticências. */
const MAX_WORD = 16;

interface SpiderStyle {
  /** Com os nomes curtos. */
  compact: boolean;
  /** Com um raio menor que este, vale o estilo seguinte. */
  minRadius: number;
  fontSize: number;
  lineHeight: number;
  /** Distância entre a ponta do eixo e o nome dele. */
  gap: number;
  /** A letra do percentual dos anéis e a distância dele ao eixo do topo. */
  chipSize: number;
  chipOffset: number;
  dotRadius: number;
}
const FULL = { compact: false, gap: 10, chipSize: 11, chipOffset: 8, dotRadius: 4 } as const;
/** O último estilo: vale para qualquer largura. */
const COMPACT: SpiderStyle = {
  compact: true,
  minRadius: 0,
  fontSize: 11,
  lineHeight: 13,
  gap: 6,
  chipSize: 10,
  chipOffset: 3,
  dotRadius: 3,
};
/** Do maior ao menor: vale o primeiro em que a teia fica grande o bastante. */
const STYLES: readonly SpiderStyle[] = [
  { ...FULL, minRadius: 160, fontSize: 13, lineHeight: 16 },
  { ...FULL, minRadius: 110, fontSize: 12, lineHeight: 15 },
  COMPACT,
];

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SpiderLabel {
  /** O nome em uma ou duas linhas. */
  lines: readonly string[];
  /** O nome curto, para a tela estreita. */
  shortLines: readonly string[];
}

export interface PlacedLabel extends Box {
  lines: readonly string[];
  anchor: 'start' | 'middle' | 'end';
  /** Onde o texto se apoia (o `x` de cada linha). */
  x: number;
  /** A área de toque: a caixa do nome, com folga e pelo menos 24 px de lado. */
  hit: Box;
}

export interface SpiderChip extends Box {
  ratio: number;
  label: string;
}

export interface SpiderLayout {
  width: number;
  height: number;
  center: Point;
  radius: number;
  /** A menor distância do centro de um valor que não é zero. */
  floor: number;
  /** Com os nomes curtos. */
  compact: boolean;
  fontSize: number;
  lineHeight: number;
  chipSize: number;
  dotRadius: number;
  labels: PlacedLabel[];
  chips: SpiderChip[];
}

const ORIGIN: Point = { x: 0, y: 0 };

/** O ângulo do eixo, em radianos, a partir do topo e no sentido horário. */
export function axisAngle(index: number, count: number): number {
  return count <= 0 ? 0 : (index / count) * 2 * Math.PI;
}

/** A fração do eixo, de 0 a 1: o que passar da escala fica na borda dela, e o que não é número, no centro. */
export function clampShare(share: number): number {
  return Number.isNaN(share) ? 0 : Math.min(1, Math.max(0, share));
}

/** O ponto de um eixo a uma distância do centro. */
export function pointOn(center: Point, distance: number, index: number, count: number): Point {
  const angle = axisAngle(index, count);
  return { x: center.x + distance * Math.sin(angle), y: center.y - distance * Math.cos(angle) };
}

/** O que a escala precisa saber do desenho. */
export type SpiderScale = Pick<SpiderLayout, 'center' | 'radius' | 'floor'>;

/**
 * A distância do centro de uma participação: o raio vezes a raiz quadrada dela. O zero fica no centro; o que existe, no
 * mínimo a `floor` dele, para o ponto se distinguir do centro e dos pontos dos eixos vizinhos.
 */
export function shareDistance(
  { radius, floor }: Pick<SpiderScale, 'radius' | 'floor'>,
  share: number,
): number {
  const part = clampShare(share);
  return part === 0 ? 0 : Math.max(floor, radius * Math.sqrt(part));
}

/** O ponto de uma participação no eixo dela. */
export function sharePoint(scale: SpiderScale, share: number, index: number, count: number): Point {
  return pointOn(scale.center, shareDistance(scale, share), index, count);
}

/** O contorno de uma série (uma participação por eixo) como `points` de um polígono. */
export function polygonPoints(scale: SpiderScale, shares: readonly number[]): string {
  return shares
    .map((share, index) => {
      const { x, y } = sharePoint(scale, share, index, shares.length);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** O contorno de um anel da grade: a mesma participação em todos os eixos. */
export function ringPoints(scale: SpiderScale, ratio: number, count: number): string {
  return polygonPoints(
    scale,
    Array.from({ length: count }, () => ratio),
  );
}

/** A distância mínima de um ponto: a que separa dois pontos em eixos vizinhos, até `MAX_FLOOR` do raio. */
function floorOf(radius: number, count: number, dotRadius: number): number {
  const apart = (2 * dotRadius + 1) / (2 * Math.sin(Math.PI / Math.max(3, count)));
  return Math.min(radius * MAX_FLOOR, apart);
}

const cut = (text: string): string => (text.length > MAX_WORD ? `${text.slice(0, MAX_WORD - 1)}…` : text);

/**
 * Um nome em até duas linhas, quebrado entre palavras. Uma palavra longa demais, ou o que passar da segunda linha, vira
 * reticências: o nome inteiro fica na dica, na lista e na tabela.
 */
export function wrapLabel(text: string, maxChars = 12): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const joined = `${lines[lines.length - 1] ?? ''} ${word}`;
    if (lines.length > 0 && joined.length <= maxChars) lines[lines.length - 1] = joined;
    else lines.push(cut(word));
  }
  const [first = '', second = '', ...rest] = lines;
  return rest.length > 0 ? [first, cut(`${second}…`)] : lines;
}

const widest = (lines: readonly string[], fontSize: number): number =>
  Math.max(0, ...lines.map((line) => textWidth(line, fontSize)));

/** Os nomes que o estilo usa: os completos ou os curtos. */
const namesIn = (style: SpiderStyle, names: readonly SpiderLabel[]): (readonly string[])[] =>
  names.map((name) => (style.compact ? name.shortLines : name.lines));

/** O maior raio que deixa todos os nomes dentro da largura. */
function fittingRadius(width: number, names: readonly (readonly string[])[], style: SpiderStyle): number {
  return names.reduce((radius, lines, index) => {
    const sin = Math.abs(Math.sin(axisAngle(index, names.length)));
    if (sin <= VERTICAL_SIN) return radius;
    return Math.min(radius, (width / 2 - PAD - widest(lines, style.fontSize)) / sin - style.gap);
  }, MAX_RADIUS);
}

/** O estilo e o raio para uma largura. */
function fit(width: number, names: readonly SpiderLabel[]): { style: SpiderStyle; radius: number } {
  for (const style of STYLES) {
    const radius = fittingRadius(width, namesIn(style, names), style);
    if (radius >= style.minRadius) return { style, radius: Math.max(MIN_RADIUS, radius) };
  }
  return { style: COMPACT, radius: MIN_RADIUS };
}

type Placed = Omit<PlacedLabel, 'hit'>;

/** A caixa do nome de um eixo, com o centro da teia na origem. */
function placeLabel(
  lines: readonly string[],
  index: number,
  count: number,
  radius: number,
  style: SpiderStyle,
): Placed {
  const angle = axisAngle(index, count);
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const tip = pointOn(ORIGIN, radius + style.gap, index, count);
  const width = widest(lines, style.fontSize);
  const height = lines.length * style.lineHeight;
  const anchor = sin > VERTICAL_SIN ? 'start' : sin < -VERTICAL_SIN ? 'end' : 'middle';
  const left = anchor === 'start' ? tip.x : anchor === 'end' ? tip.x - width : tip.x - width / 2;
  // De lado, centrado na ponta do eixo; no topo e embaixo, inteiro para fora dela.
  const top = tip.y - height / 2 - (cos * height) / 2;
  return { lines, anchor, x: tip.x, left, top, width, height };
}

const touching = (one: Box, other: Box): boolean =>
  one.left < other.left + other.width &&
  other.left < one.left + one.width &&
  one.top < other.top + other.height + LABEL_SPACE &&
  other.top < one.top + one.height + LABEL_SPACE;

/**
 * Afasta os nomes que se encostariam na teia pequena: do eixo mais perto da horizontal para o topo e para baixo, cada
 * nome sobe (ou desce) até passar dos que já têm lugar. Sempre para fora da teia, nunca para dentro.
 */
function spread(labels: readonly Placed[]): Placed[] {
  const middle = (label: Placed) => label.top + label.height / 2;
  const settled = new Map<Placed, Placed>();
  for (const label of [...labels].sort((one, other) => Math.abs(middle(one)) - Math.abs(middle(other)))) {
    const up = middle(label) < 0;
    let moved = label;
    for (const other of settled.values()) {
      if (!touching(moved, other)) continue;
      moved = {
        ...label,
        top: up ? other.top - label.height - LABEL_SPACE : other.top + other.height + LABEL_SPACE,
      };
    }
    settled.set(label, moved);
  }
  return labels.map((label) => settled.get(label) ?? label);
}

/** A área de toque de um nome: a caixa dele, com folga e pelo menos 24 px de lado. */
function hitBox({ left, top, width, height }: Box): Box {
  const hitWidth = Math.max(HIT_SIZE, width + 8);
  const hitHeight = Math.max(HIT_SIZE, height + 4);
  return {
    left: left + width / 2 - hitWidth / 2,
    top: top + height / 2 - hitHeight / 2,
    width: hitWidth,
    height: hitHeight,
  };
}

/** O percentual de um anel, como vai na etiqueta: "5%". */
const ringLabel = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * Os percentuais dos anéis, à direita do eixo do topo: ao lado, e não em cima dele, para o ponto e a linha do primeiro
 * eixo nunca ficarem embaixo do número.
 */
function placeChips(
  scale: Pick<SpiderScale, 'radius' | 'floor'>,
  count: number,
  style: SpiderStyle,
): SpiderChip[] {
  const height = style.chipSize + 2;
  return SPIDER_RINGS.map((ratio) => {
    const label = ringLabel(ratio);
    const width = textWidth(label, style.chipSize) + 3;
    const distance = shareDistance(scale, ratio);
    const vertex = pointOn(ORIGIN, distance, 1, count);
    // Na altura em que o anel passa pelo meio da etiqueta (no anel pequeno, a do vértice seguinte).
    const along = vertex.x <= 0 ? 0 : Math.min(1, (style.chipOffset + width / 2) / vertex.x);
    const middle = -distance + along * (vertex.y + distance);
    return { ratio, label, left: style.chipOffset, top: middle - height / 2, width, height };
  });
}

/** O desenho inteiro para uma largura: o raio, a altura, onde vai cada nome e cada percentual. */
export function spiderLayout(width: number, names: readonly SpiderLabel[]): SpiderLayout {
  const { style, radius } = fit(width, names);
  const floor = floorOf(radius, names.length, style.dotRadius);
  const labels = spread(
    namesIn(style, names).map((lines, index) => placeLabel(lines, index, names.length, radius, style)),
  );
  const hits = labels.map(hitBox);
  const top = Math.min(-radius, ...hits.map((hit) => hit.top));
  const bottom = Math.max(radius, ...hits.map((hit) => hit.top + hit.height));
  const center = { x: width / 2, y: PAD - top };
  const moved = (box: Box): Box => ({
    left: box.left + center.x,
    top: box.top + center.y,
    width: box.width,
    height: box.height,
  });

  return {
    width,
    height: bottom - top + 2 * PAD,
    center,
    radius,
    floor,
    compact: style.compact,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    chipSize: style.chipSize,
    dotRadius: style.dotRadius,
    labels: labels.map((label) => ({
      ...label,
      ...moved(label),
      x: label.x + center.x,
      hit: moved(hitBox(label)),
    })),
    chips: placeChips({ radius, floor }, names.length, style).map((chip) => ({ ...chip, ...moved(chip) })),
  };
}
