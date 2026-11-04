/** Tamanho das colunas que guardam o tipo do erro (`connectionError`, `lastErrorKind`, `SyncState.lastError`). */
export const ERROR_KIND_MAX = 64;

/**
 * O tipo de um erro, para o log e para o banco: o nome da classe (`AccessDeniedException`, `TimeoutError`), nunca a
 * mensagem nem a pilha, que podem carregar dado da fonte, recurso do cliente ou segredo. Fica só com letras, números e
 * `_.:-`, e cabe nas colunas de 64 caracteres. O que não é `Error` vira `Error`.
 */
export function errorKind(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return name.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, ERROR_KIND_MAX) || 'Error';
}
