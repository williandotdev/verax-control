import { type ApiAddress, resolveApiUrl } from './tenant-address';

/**
 * Única configuração do painel: a URL pública da API (`VITE_API_URL`). O build falha se existir qualquer
 * outra variável `VITE_*` (ver `build-guards.ts`). No build único, a URL traz o marcador `{tenant}`, trocado aqui pelo
 * cliente do endereço em que o painel foi aberto (`tenant-address.ts`).
 */
const CONFIGURED_API_URL: string =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3000';

/** Resolução da API para este endereço. Sem ela (`ok: false`), o painel só mostra o aviso (`main.tsx`). */
export const API_ADDRESS: ApiAddress = resolveApiUrl(CONFIGURED_API_URL, window.location.hostname);

/** URL da API. Vazia quando o endereço não é de um cliente: o cliente HTTP recusa chamar (`api-client.ts`). */
export const API_URL: string = API_ADDRESS.ok ? API_ADDRESS.url : '';
