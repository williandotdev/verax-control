/** Como terminou a renovação forçada do acesso (`CloudflareBearer.renew`). */
export type BearerRenewal =
  /** O valor mudou: vale repetir o pedido uma vez. */
  | 'renewed'
  /** Não há o que renovar (a autorização acabou, ou já foi renovada nesta leitura): a recusa vale. */
  | 'rejected'
  /** A renovação não pôde ser feita agora: a recusa não prova nada, e a leitura espera. */
  | 'unavailable';

/**
 * O que autentica os pedidos à API do Cloudflare: o token colado (`CloudflareToken`, que nunca se renova) ou o acesso de
 * uma concessão por OAuth (`GrantBearer`, que muda a cada renovação). O cliente lê `value()` a cada envio, só para o
 * header `Authorization`.
 */
export interface CloudflareBearer {
  value(): string;
  /** Só no acesso por OAuth: chamado uma vez por pedido, quando o Cloudflare recusa o valor (401). */
  renew?(): Promise<BearerRenewal>;
}
