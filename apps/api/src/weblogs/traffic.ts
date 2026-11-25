import type { ClientClass } from './client-class.js';

/**
 * O tráfego por país de um objeto: o que cada linha soma. Puro, sem banco (`store/web-traffic-store.ts` é quem grava).
 *
 * Toda linha do balanceador conta, inclusive a de um cliente que o motor não guardou (o teto de memória): a conta é por
 * objeto, num vetor de tamanho fixo, e não depende do que está na memória do motor. Nada é alocado por linha.
 */

/** País desconhecido. */
export const UNKNOWN_COUNTRY = 'ZZ';

/**
 * `proxy` é qualquer CDN ou proxy do cliente: o país é o da borda, não o do visitante. `unverified` é o endereço público
 * sem a lista das CDNs: pode ser uma coisa ou outra.
 */
export const TRAFFIC_CLASSES = ['direct', 'proxy', 'private', 'unverified'] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

const CLASS_OF: Readonly<Record<ClientClass, TrafficClass>> = {
  direct: 'direct',
  customer_proxy: 'proxy',
  cloudflare: 'proxy',
  cloudfront: 'proxy',
  private: 'private',
  unverified: 'unverified',
};

export const trafficClassOf = (cls: ClientClass): TrafficClass => CLASS_OF[cls];

export const TRAFFIC_COUNTERS = ['requests', 'blocked', 'clientErrors', 'serverErrors', 'flagged'] as const;
export type TrafficCounter = (typeof TRAFFIC_COUNTERS)[number];

export interface TrafficDelta extends Record<TrafficCounter, number> {
  tenantId: string;
  /** A fonte (`AwsSource`) do balanceador. */
  sourceId: string;
  /** O começo do intervalo de 5 minutos, alinhado. */
  slotStart: Date;
  /** ISO 3166-1 alfa-2, maiúsculo, ou `UNKNOWN_COUNTRY`. */
  country: string;
  clientClass: TrafficClass;
}

/** O que a contagem usa da tabela de países (`geo/ip-country.ts`): só o caminho numérico. O índice 0 é "sem país". */
export interface CountryLookup {
  /** Quantidade de índices, com o 0. */
  readonly size: number;
  countryOfV4(word: number): number;
  countryOfWords(first: number, second: number, third: number, fourth: number): number;
  code(index: number): string | null;
}

/** O índice do país de um endereço em palavras de 32 bits (uma no IPv4, quatro no IPv6); 0 sem a tabela. */
export function countryIndex(lookup: CountryLookup | null, version: 4 | 6, words: readonly number[]): number {
  if (lookup === null) return 0;
  const [first = 0, second = 0, third = 0, fourth = 0] = words;
  return version === 4 ? lookup.countryOfV4(first) : lookup.countryOfWords(first, second, third, fourth);
}

const CLASSES = TRAFFIC_CLASSES.length;
const COUNTERS = TRAFFIC_COUNTERS.length;
const CLASS_INDEX: Readonly<Record<ClientClass, number>> = Object.fromEntries(
  Object.entries(CLASS_OF).map(([cls, traffic]) => [cls, TRAFFIC_CLASSES.indexOf(traffic)]),
) as Record<ClientClass, number>;

/**
 * As contas de um objeto, por país e classe. `flagged` é a linha que contou como sonda a caminho sensível, como ferramenta
 * de ataque (User-Agent) ou como falha de login: uma vez, mesmo que seja as três.
 */
export class ObjectTraffic {
  /** O horário da linha mais recente; 0 sem nenhuma. */
  newestMs = 0;
  private readonly lookup: CountryLookup | null;
  private readonly cells: Uint32Array;

  constructor(lookup: CountryLookup | null) {
    this.lookup = lookup;
    this.cells = new Uint32Array((lookup?.size ?? 1) * CLASSES * COUNTERS);
  }

  count(
    country: number,
    cls: ClientClass,
    status: number,
    blocked: boolean,
    flagged: boolean,
    timeMs: number,
  ): void {
    const { cells } = this;
    if (timeMs > this.newestMs) this.newestMs = timeMs;
    const at = (country * CLASSES + CLASS_INDEX[cls]) * COUNTERS;
    cells[at] = (cells[at] ?? 0) + 1;
    if (blocked) cells[at + 1] = (cells[at + 1] ?? 0) + 1;
    if (status >= 400 && status <= 499) cells[at + 2] = (cells[at + 2] ?? 0) + 1;
    else if (status >= 500 && status <= 599) cells[at + 3] = (cells[at + 3] ?? 0) + 1;
    if (flagged) cells[at + 4] = (cells[at + 4] ?? 0) + 1;
  }

  /** As linhas a somar no banco: só o que tem requisição. */
  deltas(source: { tenantId: string; sourceId: string }, slotStart: Date): TrafficDelta[] {
    const { cells, lookup } = this;
    const out: TrafficDelta[] = [];
    for (let at = 0; at < cells.length; at += COUNTERS) {
      const requests = cells[at] ?? 0;
      if (requests === 0) continue;
      const row = at / COUNTERS;
      out.push({
        tenantId: source.tenantId,
        sourceId: source.sourceId,
        slotStart,
        country: lookup?.code(Math.floor(row / CLASSES)) ?? UNKNOWN_COUNTRY,
        clientClass: TRAFFIC_CLASSES[row % CLASSES] ?? 'unverified',
        requests,
        blocked: cells[at + 1] ?? 0,
        clientErrors: cells[at + 2] ?? 0,
        serverErrors: cells[at + 3] ?? 0,
        flagged: cells[at + 4] ?? 0,
      });
    }
    return out;
  }
}
