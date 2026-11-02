/**
 * Única configuração do painel: a URL pública da API (`VITE_API_URL`). O build falha se existir qualquer
 * outra variável `VITE_*` (ver `build-guards.ts`).
 */
export const API_URL: string =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3000';
