/** Tamanhos e tempos do motor (seção 1 do desenho). */

export const MINUTE_MS = 60_000;
/** O intervalo de um arquivo de log do ALB. */
export const SLOT_MS = 5 * MINUTE_MS;
/** W15 e W60, em slots. */
export const SHORT_SLOTS = 3;
export const LONG_SLOTS = 12;
/** Um slot fecha 10 minutos depois do fim dele (a AWS entrega com atraso). */
export const CLOSE_DELAY_MS = 10 * MINUTE_MS;
/** Slots guardados: os da janela de 60 minutos do slot aberto mais antigo. */
export const KEEP_SLOTS = LONG_SLOTS + CLOSE_DELAY_MS / SLOT_MS;
/** Um arquivo com fim além disto, no futuro, é recusado: empurraria a janela e apagaria o que está nela. */
export const FUTURE_TOLERANCE_MS = CLOSE_DELAY_MS;

/**
 * Tetos de memória de um motor (um balanceador). O padrão é o do nó inteiro com uma fonte só; com mais, a tarefa usa
 * `divideLimits`, para uma fonte sob ataque não tirar a memória da outra.
 */
export interface WebLimits {
  /** Registros de cliente por slot, somados todos os slots. */
  maxClients: number;
  /** Registros que um slot guarda depois de fechar. */
  maxClosedClients: number;
  /** Conjuntos de caminhos distintos. */
  maxPathSets: number;
  /** Posições de hash (4 bytes) somadas. */
  maxHashCells: number;
  /** Rotas de login sem configuração por slot. */
  maxLoginRoutes: number;
  /** Clientes por rota de login e slot. */
  maxRouteClients: number;
  /** Pares de cliente e rota de login, somados todos os slots. */
  maxLoginCells: number;
  /** Séries de 10 s por slot (a ordem entre falha e sucesso). */
  maxSeries: number;
  /** Posições (5 bytes) dos registros de quem saiu das rotas de login, somadas (`evicted.ts`). */
  maxEvictedCells: number;
  /** Hosts (SNI) por slot. */
  maxHosts: number;
  /** Clientes com rotas e amostras guardadas, somados todos os slots. */
  maxDetails: number;
  /** Grupos de sondas respondidas por slot. */
  maxAnswered: number;
  /** Clientes por dia no resumo. */
  maxDayClients: number;
}

export const DEFAULT_LIMITS: WebLimits = {
  // Medido: cerca de 600 bytes por registro, com a lista de caminhos (o desenho supunha 200 e 40 mil registros).
  maxClients: 30_000,
  maxClosedClients: 2_000,
  maxPathSets: 4_000,
  maxHashCells: 1_048_576,
  maxLoginRoutes: 20,
  maxRouteClients: 2_000,
  maxLoginCells: 16_000,
  maxSeries: 4_000,
  maxEvictedCells: 262_144,
  maxHosts: 50,
  maxDetails: 2_000,
  maxAnswered: 500,
  maxDayClients: 2_000,
};

/** Os tetos divididos entre as fontes do nó (só os que somam memória de verdade). */
export function divideLimits(limits: WebLimits, sources: number): WebLimits {
  const share = (value: number, floor: number): number =>
    Math.max(floor, Math.floor(value / Math.max(1, sources)));
  return {
    ...limits,
    maxClients: share(limits.maxClients, 2_000),
    maxPathSets: share(limits.maxPathSets, 200),
    maxHashCells: share(limits.maxHashCells, 65_536),
    maxLoginCells: share(limits.maxLoginCells, 1_000),
    maxSeries: share(limits.maxSeries, 250),
    maxEvictedCells: share(limits.maxEvictedCells, 16_384),
    maxDetails: share(limits.maxDetails, 200),
  };
}
