import { type ProviderRanges, type ProxyProvider, PROXY_RANGES } from './data/proxy-ranges.js';
import { type Cidr, cidrContains, type Ip, parseCidr } from './ip.js';

/**
 * Classe do endereço de um cliente do ALB. O log do ALB não traz o `X-Forwarded-For`: o `client` é quem abriu a conexão,
 * e atrás de uma CDN ou de um proxy ele é a borda, nunca o visitante. Por isso o cabeçalho forjado não engana a chave, e
 * por isso as regras por IP só valem para `direct`.
 *
 * Ordem: proxies declarados pelo cliente, CDNs, endereço privado, e o resto é `direct`. Sem as faixas das CDNs (uma
 * delas vazia ou sem data), o resto é `unverified`: não se acusa um IP que pode ser a borda de uma CDN com centenas de
 * visitantes atrás (a falha de um e o sucesso de outro virariam "acesso indevido").
 */
export const CLIENT_CLASSES = [
  'direct',
  'customer_proxy',
  'cloudflare',
  'cloudfront',
  'private',
  'unverified',
] as const;
export type ClientClass = (typeof CLIENT_CLASSES)[number];

export type RangesStatus = 'ok' | 'stale' | 'unavailable';

/** Lista mais velha que isto é avisada. */
export const RANGES_MAX_AGE_MS = 180 * 24 * 60 * 60_000;
/** Faixa de CDN mais larga que isto é erro de cópia (desligaria as regras por IP de meia internet). */
const MIN_PROVIDER_PREFIX = { 4: 8, 6: 24 } as const;

function required(text: string): Cidr {
  const cidr = parseCidr(text);
  if (cidr === null) throw new Error(`weblogs: faixa inválida: ${text}`);
  return cidr;
}

const PRIVATE: readonly Cidr[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/127',
  'fc00::/7',
  'fe80::/10',
].map(required);

/** As faixas de uma CDN. Faixa malformada ou larga demais derruba a carga: lista errada não vira lista silenciosa. */
function providerCidrs(provider: ProviderRanges): Cidr[] {
  return provider.ranges.map((text) => {
    const cidr = required(text);
    if (cidr.prefix < MIN_PROVIDER_PREFIX[cidr.version]) {
      throw new Error(`weblogs: faixa larga demais em ${provider.provider}: ${text}`);
    }
    return cidr;
  });
}

export class ClientClassifier {
  readonly status: RangesStatus;
  /** Igual em dois classificadores que dão sempre a mesma classe. */
  readonly signature: string;
  private readonly providers: readonly { provider: ProxyProvider; cidrs: readonly Cidr[] }[];
  private readonly proxies: readonly Cidr[];

  constructor(options: {
    now: number;
    /** Os proxies declarados pelo cliente (fontes confiáveis do tipo `proxy`). */
    proxies?: readonly Cidr[];
    ranges?: readonly ProviderRanges[];
  }) {
    const ranges = options.ranges ?? PROXY_RANGES;
    this.proxies = options.proxies ?? [];
    this.providers = ranges.map((entry) => ({ provider: entry.provider, cidrs: providerCidrs(entry) }));
    const dates = ranges.map((entry) => (entry.generatedAt === null ? NaN : Date.parse(entry.generatedAt)));
    const listed = (provider: ProxyProvider): boolean =>
      ranges.some((entry) => entry.provider === provider && entry.ranges.length > 0);
    if (!listed('cloudflare') || !listed('cloudfront') || dates.some((date) => Number.isNaN(date))) {
      this.status = 'unavailable';
    } else {
      this.status = options.now - Math.min(...dates) > RANGES_MAX_AGE_MS ? 'stale' : 'ok';
    }
    const list = (cidrs: readonly Cidr[]): string =>
      cidrs.map(({ words, prefix }) => `${words.join('.')}/${prefix}`).join(' ');
    this.signature = [
      this.status === 'unavailable',
      list(this.proxies),
      ...this.providers.map(({ provider, cidrs }) => `${provider} ${list(cidrs)}`),
    ].join('|');
  }

  classify(ip: Ip): ClientClass {
    if (this.proxies.some((cidr) => cidrContains(cidr, ip))) return 'customer_proxy';
    for (const { provider, cidrs } of this.providers) {
      if (cidrs.some((cidr) => cidrContains(cidr, ip))) return provider;
    }
    if (PRIVATE.some((cidr) => cidrContains(cidr, ip))) return 'private';
    return this.status === 'unavailable' ? 'unverified' : 'direct';
  }
}
