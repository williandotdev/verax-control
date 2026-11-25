import { formatHour, formatShare } from '@/components/charts/chart-utils';
import { formatDate } from '@/lib/format';

/**
 * Lógica do mapa de origens (sem React e sem os dados do mapa): a soma por país, o tamanho e o lugar de cada ponto, quem
 * pulsa, qual ponto o ponteiro acerta e onde a dica cabe.
 *
 * As contas não escondem o que não tem lugar no mapa: cada requisição está em **um** grupo só (um país, origem
 * desconhecida, rede interna ou CDN e proxy), e o percentual de qualquer um deles é sobre a soma de todos.
 */

/** Requisições de uma origem na janela. */
export interface OriginCounts {
  requests: number;
  /** Recusadas no caminho (bloqueio do WAF ou do balanceador). */
  blocked: number;
  /** Suspeitas: sondagem, ferramenta de ataque ou falha de login. */
  flagged: number;
}

export interface CountryTraffic extends OriginCounts {
  /** ISO 3166-1 alfa-2, mais `XK`. `ZZ` (ou o que não tem forma de código) conta como origem desconhecida. */
  code: string;
  /** Nos últimos `recentMinutes` antes de `recentUntil` (ou de `generatedAt`, sem ele). */
  recentRequests: number;
  recentFlagged: number;
}

/** O que o mapa mostra. Cada requisição entra em um grupo só. */
export interface WorldTraffic {
  /** Quando os números foram calculados (ISO 8601): o fim da janela. */
  generatedAt: string;
  windowHours: number;
  /** O tamanho do "agora": quem teve requisição nele pulsa. */
  recentMinutes: number;
  /** O fim do "agora" (ISO 8601): o log chega com atraso, e o último intervalo completo acabou antes de `generatedAt`. */
  recentUntil?: string | null;
  countries: readonly CountryTraffic[];
  /** Endereço público sem país na tabela. */
  unknown: OriginCounts;
  /** Da origem desconhecida, quantas vieram de endereço público que pode ser o visitante ou uma CDN. */
  unverified?: number;
  /** Chegaram por CDN ou proxy: o log tem o endereço da CDN, e não o de quem acessou. */
  throughProxy: OriginCounts;
  /** Endereço privado, de dentro da rede. */
  internal: OriginCounts;
  /** `stale`: a fonte parou de mandar log. Nada pulsa, e o aviso diz desde quando. */
  state?: 'ok' | 'stale';
  /** O log mais novo (ISO 8601), para o aviso de `stale`. */
  lastLogAt?: string | null;
  /** A última atualização falhou, e os números são os de `generatedAt`. Nada pulsa. */
  refreshFailed?: boolean;
}

/** Um ponto do mapa, no quadro em px. */
export interface WorldDot {
  code: string;
  x: number;
  y: number;
  radius: number;
  /** Com muitas requisições suspeitas na janela (`isFlagged`): cor do crítico, octógono e anel. */
  flagged: boolean;
  /** Da borda da marca à borda de fora do anel do suspeito; zero no comum. */
  ring: number;
  /** Pulsa (ou mostra o anel parado): está entre os mais ativos dos últimos minutos. */
  recent: boolean;
  /** Marcado, e com requisição suspeita nos últimos minutos: a onda sai na cor do crítico. */
  recentFlagged: boolean;
  /** Onde a onda está no instante zero, em ms (de 0 a `PULSE_PERIOD_MS`). */
  phase: number;
}

/**
 * Um período da onda: menos de meia piscada por segundo. Uma volta da animação do `index.css` são dez períodos: a cada volta,
 * o navegador acorda a página para o evento `animationiteration` (o React escuta todos na raiz), e com uma onda por volta o
 * ganho de animar só na placa de vídeo se perdia (medido na tela Detecções, ao lado do radar: 9% da thread principal, contra
 * 3% com dez por volta e 2,5% sem o mapa).
 */
export const PULSE_PERIOD_MS = 2_400;
/** Em quantos instantes do período as ondas começam: as voltas acabam juntas, e o mapa não pisca em uníssono. */
export const PULSE_SLOTS = 12;
/** Quantos pontos pulsam ao mesmo tempo, no máximo. */
export const MAX_PULSING = 60;
/** Quantos países a lista "Principais origens" mostra. */
export const TOP_COUNT = 10;
/** Abaixo desta largura, a dica fica embaixo do mapa, e não solta sobre ele. */
export const COMPACT_WIDTH = 560;
/** Raio da área de toque de um ponto sem vizinho: 24 px de lado. */
export const HIT_RADIUS = 12;

const MIN_RADIUS = 3;
/** O octógono do suspeito precisa de um pouco mais para ser lido como octógono. */
const MIN_FLAGGED_RADIUS = 3.5;
/** O anel do suspeito, e o dele no mapa estreito (os pontos ficam mais perto). */
const FLAGGED_RING = 3.5;
const FLAGGED_RING_COMPACT = 2.5;
/** A escala cobre três ordens de grandeza: quem tem mil vezes menos que o maior (ou menos ainda) fica no mínimo. */
const DECADES = 3;
const UNKNOWN_CODE = 'ZZ';
const NO_REQUESTS: OriginCounts = { requests: 0, blocked: 0, flagged: 0 };

/**
 * A partir de quantas requisições suspeitas o país é marcado (cor do crítico, octógono e anel). Todo site recebe sondagem o
 * tempo todo, de todo lugar: com uma só bastando, o mapa inteiro ficaria vermelho e não diria nada. Basta um dos dois: muitas
 * suspeitas, ou uma parte que pesa no que o país mandou (com um piso, para uma visita suspeita em dez não virar alarme).
 */
export const FLAGGED_MIN = 50;
export const FLAGGED_MIN_SHARE = 0.01;
export const FLAGGED_MIN_WITH_SHARE = 10;

/** Os números são de um dia: numa janela maior, crescem com ela (em 7 dias, 350 e 70). Numa menor, não diminuem. */
const flaggedScale = (windowHours: number): number => Math.max(1, windowHours / 24);

/** Os limites que valem na janela: os que as legendas dizem. */
export const flaggedLimits = (windowHours: number): { min: number; minWithShare: number } => ({
  min: Math.ceil(FLAGGED_MIN * flaggedScale(windowHours)),
  minWithShare: Math.ceil(FLAGGED_MIN_WITH_SHARE * flaggedScale(windowHours)),
});

/** Suspeitas o bastante para marcar o país. */
export function isFlagged(counts: Pick<OriginCounts, 'requests' | 'flagged'>, windowHours: number): boolean {
  const { min, minWithShare } = flaggedLimits(windowHours);
  return (
    counts.flagged >= min ||
    (counts.flagged >= minWithShare && counts.flagged / counts.requests >= FLAGGED_MIN_SHARE)
  );
}

const count = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

const addCounts = (a: OriginCounts, b: OriginCounts): OriginCounts => ({
  requests: a.requests + count(b.requests),
  blocked: a.blocked + count(b.blocked),
  flagged: a.flagged + count(b.flagged),
});

export interface TrafficSummary {
  /** Um por código, do maior volume ao menor. */
  countries: CountryTraffic[];
  unknown: OriginCounts;
  throughProxy: OriginCounts;
  internal: OriginCounts;
  /** Tudo o que chegou na janela, dentro e fora do mapa. */
  total: OriginCounts;
  /** Os países marcados (`isFlagged`). */
  flaggedCodes: ReadonlySet<string>;
}

/**
 * Soma e ordena: um país por código (do maior volume ao menor, e por código no empate), o que não é código de país vai
 * para a origem desconhecida, e o total é a soma de todos os grupos.
 */
export function summarize(traffic: WorldTraffic): TrafficSummary {
  const byCode = new Map<string, CountryTraffic>();
  let unknown = addCounts(NO_REQUESTS, traffic.unknown);
  for (const item of traffic.countries) {
    const code = item.code.toUpperCase();
    if (code === UNKNOWN_CODE || !/^[A-Z]{2}$/.test(code)) {
      unknown = addCounts(unknown, item);
      continue;
    }
    const before = byCode.get(code);
    byCode.set(code, {
      code,
      ...addCounts(before ?? NO_REQUESTS, item),
      recentRequests: (before?.recentRequests ?? 0) + count(item.recentRequests),
      recentFlagged: (before?.recentFlagged ?? 0) + count(item.recentFlagged),
    });
  }
  const countries = [...byCode.values()]
    .filter((item) => item.requests > 0)
    .sort((a, b) => b.requests - a.requests || (a.code < b.code ? -1 : 1));
  const throughProxy = addCounts(NO_REQUESTS, traffic.throughProxy);
  const internal = addCounts(NO_REQUESTS, traffic.internal);
  return {
    countries,
    unknown,
    throughProxy,
    internal,
    total: [...countries, unknown, throughProxy, internal].reduce(addCounts, NO_REQUESTS),
    flaggedCodes: new Set(
      countries.filter((item) => isFlagged(item, traffic.windowHours)).map((item) => item.code),
    ),
  };
}

/** O raio do maior ponto: 10 px num mapa de 1.280 px, menos nos estreitos (a Europa não vira uma mancha só). */
export const maxRadius = (width: number): number => Math.min(11, Math.max(5, 3.6 + width / 200));

/**
 * O raio pelo volume, em escala logarítmica relativa ao país de maior volume: cada dez vezes menos tira o mesmo tanto, até
 * o mínimo.
 */
export function dotRadius(requests: number, busiest: number, width: number): number {
  if (busiest <= 0) return MIN_RADIUS;
  const level = Math.min(1, Math.max(0, 1 + Math.log10(requests / busiest) / DECADES));
  return MIN_RADIUS + level * (maxRadius(width) - MIN_RADIUS);
}

/**
 * Onde a onda de um país está no instante zero: fixo por código, num dos `PULSE_SLOTS` instantes, e bem espalhado (múltiplos
 * de um irracional), para o mapa não piscar em uníssono.
 */
export function pulsePhase(code: string): number {
  const index = (code.charCodeAt(0) - 65) * 26 + (code.charCodeAt(1) - 65);
  const turn = index * Math.sqrt(3);
  return Math.floor((turn - Math.floor(turn)) * PULSE_SLOTS) * (PULSE_PERIOD_MS / PULSE_SLOTS);
}

/** Quem pulsa: os mais ativos dos últimos minutos (e quantos tiveram requisição neles). */
export function pulsingCodes(
  countries: readonly CountryTraffic[],
  limit = MAX_PULSING,
): { codes: ReadonlySet<string>; active: number } {
  const active = countries.filter((item) => item.recentRequests > 0);
  const codes = [...active]
    .sort((a, b) => b.recentRequests - a.recentRequests || (a.code < b.code ? -1 : 1))
    .slice(0, limit)
    .map((item) => item.code);
  return { codes: new Set(codes), active: active.length };
}

type MapPoints = Readonly<Record<string, readonly [x: number, y: number]>>;

/** O país tem lugar no mapa? */
export const hasPoint = (code: string, points: MapPoints): boolean => Object.hasOwn(points, code);

/**
 * Os pontos, na ordem dos países (do maior volume ao menor): desenhados nessa ordem, o menor fica por cima. País sem lugar
 * no mapa fica de fora (está na lista e na tabela).
 */
export function worldDots(
  countries: readonly CountryTraffic[],
  flaggedCodes: ReadonlySet<string>,
  pulsing: ReadonlySet<string>,
  points: MapPoints,
  mapWidth: number,
  width: number,
): WorldDot[] {
  const scale = width / mapWidth;
  const busiest = countries[0]?.requests ?? 0;
  return countries.flatMap((country) => {
    const point = hasPoint(country.code, points) ? points[country.code] : undefined;
    if (!point) return [];
    const flagged = flaggedCodes.has(country.code);
    const radius = dotRadius(country.requests, busiest, width);
    return [
      {
        code: country.code,
        x: point[0] * scale,
        y: point[1] * scale,
        radius: flagged ? Math.max(MIN_FLAGGED_RADIUS, radius) : radius,
        flagged,
        ring: flagged ? (width < COMPACT_WIDTH ? FLAGGED_RING_COMPACT : FLAGGED_RING) : 0,
        recent: pulsing.has(country.code),
        // A onda vermelha num ponto neutro diria o contrário dele.
        recentFlagged: flagged && country.recentFlagged > 0,
        phase: pulsePhase(country.code),
      },
    ];
  });
}

/** O raio do que se vê do ponto (com o anel do suspeito). */
export const outerRadius = (dot: Pick<WorldDot, 'radius' | 'ring'>): number => dot.radius + dot.ring;

/**
 * O ponto que o ponteiro acerta: o que está por cima entre os que ele cobre ou, fora de todos, o de borda mais perto, até a
 * área de toque de 24 px. Assim nenhum ponto toma a área do vizinho.
 */
export function dotAt(dots: readonly WorldDot[], x: number, y: number): WorldDot | null {
  let covered: WorldDot | null = null;
  let nearest: WorldDot | null = null;
  let nearestGap = Infinity;
  for (const dot of dots) {
    const distance = Math.hypot(dot.x - x, dot.y - y);
    const outer = outerRadius(dot);
    // A ordem é a do desenho: o último que cobre o ponteiro é o que aparece.
    if (distance <= outer) covered = dot;
    if (distance <= Math.max(HIT_RADIUS, outer) && distance - outer < nearestGap) {
      nearest = dot;
      nearestGap = distance - outer;
    }
  }
  return covered ?? nearest;
}

/** Distância entre a dica e a borda do ponto, e entre a dica e a borda do mapa. */
const TIP_GAP = 8;
const TIP_MARGIN = 4;

interface Size {
  width: number;
  height: number;
}

/** Onde vai a dica: ao lado do ponto (à direita ou, sem espaço, à esquerda), sempre inteira dentro do mapa. */
export function tipPosition(
  dot: Pick<WorldDot, 'x' | 'y' | 'radius' | 'ring'>,
  tip: Size,
  frame: Size,
): { left: number; top: number } {
  const clamp = (value: number, size: number, limit: number) =>
    Math.max(TIP_MARGIN, Math.min(value, limit - size - TIP_MARGIN));
  const away = outerRadius(dot) + TIP_GAP;
  const right = dot.x + away;
  const left = right + tip.width + TIP_MARGIN <= frame.width ? right : dot.x - away - tip.width;
  return {
    left: clamp(left, tip.width, frame.width),
    top: clamp(dot.y - tip.height / 2, tip.height, frame.height),
  };
}

let regionNames: Intl.DisplayNames | undefined;

/** O nome do país em pt-BR; sem nome no navegador, o próprio código. */
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames('pt-BR', { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    // Código malformado, ou navegador sem os nomes.
    return code;
  }
}

/** "62%", "4,5%"; o que existe e arredondaria para zero é "menos de 0,1%", e só o todo é "100%". */
export function shareOf(value: number, total: number): string {
  if (value <= 0 || total <= 0) return '0%';
  const ratio = value / total;
  if (ratio < 0.0005) return 'menos de 0,1%';
  return formatShare(ratio < 1 ? Math.min(ratio, 0.994) : 1);
}

/** "14:05" no mesmo dia de `reference` (no fuso do navegador); noutro dia, com a data: "23/11/2026, 14:05". */
export function momentText(value: string, reference: string): string {
  const date = formatDate(value);
  if (date === '—') return date;
  return date === formatDate(reference) ? formatHour(value) : `${date}, ${formatHour(value)}`;
}
