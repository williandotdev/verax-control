import { CLOUDFLARE_OAUTH_CALLBACK_PATH } from '@verax/shared';

/**
 * O endereço de retorno do app, na origem pública do cp-public (a mesma da sincronização do nó): o registrado no
 * Cloudflare tem de ser igual a este, e o nó o repete na troca do código.
 */
export function cloudflareOauthRedirectUri(env: { NODE_SYNC_AUDIENCE: string }): string {
  return `${new URL(env.NODE_SYNC_AUDIENCE).origin}${CLOUDFLARE_OAUTH_CALLBACK_PATH}`;
}
