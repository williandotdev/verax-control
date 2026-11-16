import {
  type FindingSeverity,
  RADAR_SECTORS,
  type RadarDetection,
  type RadarSector,
  radarSectorOf,
  type TowerRadar,
} from '@verax/shared';

/**
 * Geometria do radar de detecções da Torre (SVG puro): cada detecção vira um ponto em coordenadas polares.
 * - **Ângulo** é a origem: um quarto da volta por setor (`RADAR_SECTORS`, no sentido horário a partir do topo), e a
 *   posição dentro do setor sai de um hash do ID do achado, estável entre as atualizações (o ponto não pula de lugar).
 * - **Distância do centro** é a idade: o centro é agora (o `generatedAt` do resumo) e o anel de fora é o começo da
 *   janela (`since`). A escala é a raiz quadrada da idade: as últimas horas, onde estão as decisões, ganham mais espaço
 *   (a 1 hora, um quinto do raio; a 6 horas, a metade), e os anéis marcam 1, 3, 6, 12 e 24 horas. Um raio mínimo afasta
 *   do centro as detecções do último minuto, para não se empilharem.
 * - **Forma e tamanho** são a severidade (`BLIP_SHAPES`), com a cor do token dela: nunca só a cor.
 */

/** Lado do quadro (viewBox) e o centro do radar. */
export const RADAR_SIZE = 400;
export const RADAR_CENTER = RADAR_SIZE / 2;
/** Raio do anel de fora: sobra canto para o nome dos setores. */
export const RADAR_RADIUS = 160;
/** Raio de "agora": as detecções recentes começam aqui, não no centro exato. */
export const RADAR_MIN_RADIUS = 14;
/** Folga, em graus, entre a borda do setor e as detecções: o eixo fica livre para os rótulos dos anéis. */
export const SECTOR_MARGIN_DEG = 8;
/** Uma volta da varredura, em ms: o brilho de cada ponto acompanha a passagem dela. */
export const SWEEP_PERIOD_MS = 7_000;
/** Detecção mais nova que isto na primeira abertura da Torre pulsa uma vez (depois, só as que chegam). */
export const FRESH_ON_OPEN_MS = 15 * 60_000;

const SECTOR_SPAN_DEG = 360 / RADAR_SECTORS.length;
const HOUR_MS = 3_600_000;

/** Forma e raio de cada severidade, do mais grave ao mais leve: octógono, triângulo, círculo e losango. */
export const BLIP_SHAPES: Readonly<
  Record<FindingSeverity, { shape: 'octagon' | 'triangle' | 'circle' | 'diamond'; radius: number }>
> = {
  critical: { shape: 'octagon', radius: 7 },
  high: { shape: 'triangle', radius: 6.5 },
  medium: { shape: 'circle', radius: 5 },
  low: { shape: 'diamond', radius: 4.5 },
};

export interface Blip {
  detection: RadarDetection;
  sector: RadarSector;
  /** Graus no sentido horário a partir do topo, de 0 a 360. */
  angle: number;
  /** Distância do centro, de `RADAR_MIN_RADIUS` a `RADAR_RADIUS`. */
  radius: number;
  x: number;
  y: number;
}

/**
 * Hash de um texto como fração de 0 (inclusive) a 1 (exclusive): FNV-1a de 32 bits com a mistura final do
 * MurmurHash3, para IDs quase iguais (UUIDs v7 do mesmo instante, os sequenciais da demonstração) não caírem juntos.
 */
export function hashUnit(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 2 ** 32;
}

/** O ângulo de uma detecção: o começo do setor da origem, mais a folga, mais a posição estável do ID dentro dele. */
export function angleOf(detection: Pick<RadarDetection, 'id' | 'source'>): number {
  const sector = RADAR_SECTORS.indexOf(radarSectorOf(detection.source));
  const usable = SECTOR_SPAN_DEG - 2 * SECTOR_MARGIN_DEG;
  return sector * SECTOR_SPAN_DEG + SECTOR_MARGIN_DEG + hashUnit(detection.id) * usable;
}

/**
 * A distância do centro pela idade: agora fica no raio mínimo, o começo da janela no anel de fora, pela raiz quadrada
 * da fração da janela (sempre crescente: mais velha, mais longe). Fora da janela (relógio adiantado da fonte, ou mais
 * velha que a janela), fica na borda mais próxima.
 */
export function radiusOf(occurredAt: number, since: number, until: number): number {
  const window = until - since;
  const age = window <= 0 ? 0 : Math.min(1, Math.max(0, (until - occurredAt) / window));
  return RADAR_MIN_RADIUS + Math.sqrt(age) * (RADAR_RADIUS - RADAR_MIN_RADIUS);
}

/** Ponto do quadro a partir do ângulo (graus, horário, do topo) e do raio. */
export function pointAt(angle: number, radius: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180 - Math.PI / 2;
  return { x: RADAR_CENTER + radius * Math.cos(radians), y: RADAR_CENTER + radius * Math.sin(radians) };
}

/** Os pontos do radar, na ordem das detecções (as mais recentes primeiro, como a API manda). */
export function radarBlips(radar: Pick<TowerRadar, 'since' | 'detections'>, generatedAt: string): Blip[] {
  const since = Date.parse(radar.since);
  const until = Date.parse(generatedAt);
  return radar.detections.map((detection) => {
    const angle = angleOf(detection);
    const radius = radiusOf(Date.parse(detection.occurredAt), since, until);
    return { detection, sector: radarSectorOf(detection.source), angle, radius, ...pointAt(angle, radius) };
  });
}

/** Os anéis de distância, em fração da janela: na de 24 horas, 1, 3, 6, 12 e 24 horas atrás. */
const RING_FRACTIONS = [1 / 24, 3 / 24, 6 / 24, 12 / 24, 1] as const;

/** Os anéis de distância, com as horas atrás que cada um marca ("1 h", ..., "24 h") e o raio na escala do radar. */
export function radarRings(windowHours: number): { hours: number; radius: number }[] {
  return RING_FRACTIONS.map((fraction) => {
    const hours = windowHours * fraction;
    return { hours, radius: radiusOf(-hours * HOUR_MS, -windowHours * HOUR_MS, 0) };
  });
}

/**
 * Atraso da animação do brilho de um ponto, em ms (negativo: a animação já começa andando). A varredura sai do topo
 * no instante zero e dá uma volta por `period`; o brilho começa (0% da animação) quando ela passa pelo ângulo do ponto.
 */
export function echoDelay(angle: number, period = SWEEP_PERIOD_MS): number {
  return Math.round((angle / 360) * period - period);
}

/** Quando o radar não mostra tudo: o total da janela passou do teto. Null quando mostra todas. */
export function capNotice(
  radar: Pick<TowerRadar, 'total' | 'detections'>,
): { shown: number; total: number } | null {
  return radar.total > radar.detections.length
    ? { shown: radar.detections.length, total: radar.total }
    : null;
}

/**
 * Quais detecções pulsam: na primeira leitura (`seen` null), as que aconteceram há menos de `FRESH_ON_OPEN_MS`;
 * depois, as que não estavam na leitura anterior.
 */
export function freshIds(
  detections: readonly Pick<RadarDetection, 'id' | 'occurredAt'>[],
  seen: ReadonlySet<string> | null,
  generatedAt: string,
): Set<string> {
  const now = Date.parse(generatedAt);
  return new Set(
    detections
      .filter((detection) =>
        seen === null ? now - Date.parse(detection.occurredAt) < FRESH_ON_OPEN_MS : !seen.has(detection.id),
      )
      .map((detection) => detection.id),
  );
}

/** O contorno de uma forma de severidade centrada em (x, y), como `points` de um polígono (o círculo fica de fora). */
export function shapePoints(
  shape: 'octagon' | 'triangle' | 'diamond',
  x: number,
  y: number,
  r: number,
): string {
  const corners = shape === 'octagon' ? 8 : shape === 'triangle' ? 3 : 4;
  // O octógono de lado reto no topo (como o ícone), o triângulo e o losango de ponta para cima.
  const offset = shape === 'octagon' ? 22.5 : 0;
  // O triângulo equilátero, com o mesmo raio, parece menor: um pouco maior para pesar como os outros.
  const radius = shape === 'triangle' ? r * 1.2 : r;
  return Array.from({ length: corners }, (_, index) => {
    const { x: px, y: py } = pointAt(offset + (index * 360) / corners, radius);
    return `${(px - RADAR_CENTER + x).toFixed(2)},${(py - RADAR_CENTER + y).toFixed(2)}`;
  }).join(' ');
}
