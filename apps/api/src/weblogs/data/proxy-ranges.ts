/**
 * Faixas de saída das CDNs, VENDORIZADAS: o motor nunca busca faixa na rede nem faz consulta de DNS.
 *
 * ***** MARCADOR: LISTA VAZIA. *****
 * As faixas oficiais ainda não foram copiadas para cá (a PR-1 não faz chamada externa, e faixa de memória não serve).
 * Enquanto uma das CDNs estiver sem faixa, o motor não sabe distinguir um visitante de uma borda de CDN: todo endereço
 * público fica na classe `unverified`, as regras por IP ficam desligadas, nenhum achado aponta IP, e o resultado traz a
 * nota `proxy_ranges_unavailable` (`client-class.ts`). As regras que não dependem do IP (990403 e 990407) seguem.
 *
 * Para preencher (a cada release, D10): copiar as faixas da fonte de cada CDN sem editar, pôr `generatedAt` no instante
 * da cópia e rodar `client-class.test.ts`, que confere a sintaxe de cada faixa e que nenhuma é larga demais. Lista com
 * mais de 180 dias vira a nota `proxy_ranges_stale`.
 */

export type ProxyProvider = 'cloudflare' | 'cloudfront';

export interface ProviderRanges {
  provider: ProxyProvider;
  /** De onde as faixas são copiadas. */
  source: string;
  /** Quando foram copiadas (ISO 8601); null enquanto a lista é o marcador vazio. */
  generatedAt: string | null;
  ranges: readonly string[];
}

export const PROXY_RANGES: readonly ProviderRanges[] = [
  {
    provider: 'cloudflare',
    source: 'https://www.cloudflare.com/ips-v4 e https://www.cloudflare.com/ips-v6',
    generatedAt: null,
    ranges: [],
  },
  {
    provider: 'cloudfront',
    source: 'https://ip-ranges.amazonaws.com/ip-ranges.json (service CLOUDFRONT_ORIGIN_FACING)',
    generatedAt: null,
    ranges: [],
  },
];
