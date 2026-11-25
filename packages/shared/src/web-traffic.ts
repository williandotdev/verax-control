import { z } from 'zod';

/**
 * De onde vêm as requisições que chegam aos balanceadores do cliente (o mapa da tela Detecções): `GET /v1/web-logs/traffic`.
 * Só contagens por país, nunca endereço, caminho nem host.
 *
 * - Como tudo em `/v1/web-logs`, só existe no nó com `AWS_WEB_LOGS_ENABLED` ligado: desligado, 404 `WEB_LOGS_DISABLED`; num
 *   nó de antes, 404 sem código. Nos dois, o painel não mostra o mapa.
 * - Cada requisição está num grupo só: um país (só o cliente direto), origem desconhecida, CDN e proxy, rede interna ou não
 *   verificada.
 */

/**
 * As janelas. Todas cabem no histórico de qualquer plano (o menor é de 30 dias) e nos 35 dias que o tráfego fica guardado.
 * Até 48 h atrás a conta é por intervalo de 5 minutos; antes disso, por hora inteira.
 */
export const WEB_TRAFFIC_WINDOWS = ['24h', '7d', '30d'] as const;
export type WebTrafficWindow = (typeof WEB_TRAFFIC_WINDOWS)[number];
export const WEB_TRAFFIC_WINDOW_HOURS: Readonly<Record<WebTrafficWindow, number>> = {
  '24h': 24,
  '7d': 7 * 24,
  '30d': 30 * 24,
};

/** O "agora" do mapa: os minutos antes de `lastClosedAt`. */
export const WEB_TRAFFIC_RECENT_MINUTES = 15;

/**
 * Sem ler um intervalo novo por este tempo, o mapa está parado. Em dia, o último intervalo lido acabou de 10 a 20 minutos
 * atrás (a AWS entrega com atraso, e cada balanceador é lido a cada 5 minutos); uma falha passageira soma de 5 a 15.
 */
export const WEB_TRAFFIC_STALE_MS = 45 * 60_000;

/**
 * - `ok`: a leitura está em dia;
 * - `stale`: nenhum balanceador foi lido há mais de `WEB_TRAFFIC_STALE_MS`;
 * - `waiting`: há balanceador autorizado, e nenhum log dele chegou ainda;
 * - `no_source`: nenhum balanceador com a leitura autorizada.
 */
export const WEB_TRAFFIC_STATES = ['ok', 'stale', 'waiting', 'no_source'] as const;
export type WebTrafficState = (typeof WEB_TRAFFIC_STATES)[number];

/** `GET /v1/web-logs/traffic`. */
export const webTrafficQuerySchema = z.strictObject({
  window: z.enum(WEB_TRAFFIC_WINDOWS).default('24h'),
});
export type WebTrafficQuery = z.infer<typeof webTrafficQuerySchema>;

/** Um inteiro seguro do JSON: o banco soma em 64 bits, e quem passa disso fica no teto. */
const count = z.int().min(0);

export const webTrafficCountsSchema = z.strictObject({
  requests: count,
  /** Recusadas no caminho (o WAF ou o balanceador). */
  blocked: count,
  /** Com sinal de sondagem, de ferramenta de ataque ou de falha de login. */
  flagged: count,
});
export type WebTrafficCounts = z.infer<typeof webTrafficCountsSchema>;

export const webTrafficCountrySchema = webTrafficCountsSchema.extend({
  /** ISO 3166-1 alfa-2, mais `XK`. Sem país (`ZZ`), conta em `unknown`. */
  code: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .refine((code) => code !== 'ZZ', { error: 'sem país conta em unknown' }),
  /** Nos `recentMinutes` antes de `lastClosedAt`. */
  recentRequests: count,
  recentFlagged: count,
});
export type WebTrafficCountry = z.infer<typeof webTrafficCountrySchema>;

export const webTrafficSchema = z.strictObject({
  state: z.enum(WEB_TRAFFIC_STATES),
  window: z.enum(WEB_TRAFFIC_WINDOWS),
  windowHours: z.int().min(1),
  /** Quando os números foram calculados: o fim da janela. */
  generatedAt: z.iso.datetime(),
  recentMinutes: z.int().min(1),
  /**
   * O fim do último intervalo lido e fechado, do balanceador mais em dia: o "agora" do mapa. Null sem nenhum lido desde a
   * autorização.
   */
  lastClosedAt: z.iso.datetime().nullable(),
  /** O registro de log mais novo. */
  lastLogAt: z.iso.datetime().nullable(),
  /** Do maior volume ao menor. Duas letras: nunca mais de 675. */
  countries: z.array(webTrafficCountrySchema).max(675),
  /** Cliente direto, de endereço público sem país na tabela. */
  unknown: webTrafficCountsSchema,
  /** Por CDN ou proxy: o log tem o endereço dela, e não o de quem acessou. */
  throughProxy: webTrafficCountsSchema,
  /** Endereço privado. */
  internal: webTrafficCountsSchema,
  /** Endereço público lido sem a lista das CDNs: pode ser o visitante ou uma CDN, e o país não diz nada. */
  unverified: webTrafficCountsSchema,
  /** Os balanceadores com a leitura autorizada: só quantos. */
  sources: z.strictObject({
    authorized: count,
    /** Com a leitura em dia. */
    collecting: count,
    /** Só contam, sem abrir achado. */
    observing: count,
    /** Com a leitura recusada, parada ou com arquivo que ficou para trás (o motivo está em Contas cloud). */
    failing: count,
  }),
});
export type WebTraffic = z.infer<typeof webTrafficSchema>;
