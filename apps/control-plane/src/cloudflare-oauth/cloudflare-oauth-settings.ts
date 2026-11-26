import type { CloudflareOauthConfig } from '@verax/shared';
import type { AppConfig } from '../common/config/config.module.js';
import { NODE_SYNC_ACTIVE_STATES } from '../node-sync/node-sync-states.js';
import { hostingOf, type TenantRecord } from '../tenants/tenant.schema.js';
import { cloudflareOauthRedirectUri } from './redirect-uri.js';

export type CloudflareOauthEnv = Pick<
  AppConfig,
  | 'CLOUDFLARE_OAUTH_CLIENT_ID'
  | 'CLOUDFLARE_OAUTH_SCOPES'
  | 'CLOUDFLARE_OAUTH_TENANT_SLUGS'
  | 'NODE_SYNC_AUDIENCE'
>;

/** A conexão do Cloudflare por OAuth ligada neste plano de controle: o app (sem segredo) e os clientes liberados. */
export interface CloudflareOauthSettings {
  config: CloudflareOauthConfig;
  /** Os subdomínios liberados; `all`, todos (`*` na configuração). */
  tenants: ReadonlySet<string> | 'all';
}

/** Desligada (o padrão), `null`: sem `CLOUDFLARE_OAUTH_CLIENT_ID` nada muda em lugar nenhum. */
export function cloudflareOauthSettings(env: CloudflareOauthEnv): CloudflareOauthSettings | null {
  const clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID;
  const scopes = env.CLOUDFLARE_OAUTH_SCOPES;
  if (clientId === undefined || scopes === undefined) return null;
  const slugs = env.CLOUDFLARE_OAUTH_TENANT_SLUGS ?? [];
  return {
    config: { clientId, redirectUri: cloudflareOauthRedirectUri(env), scopes },
    tenants: slugs.includes('*') ? 'all' : new Set(slugs),
  };
}

/** O subdomínio está na lista dos liberados (antes de qualquer leitura do banco)? */
export function isSlugReleased(settings: CloudflareOauthSettings, slug: string): boolean {
  return settings.tenants === 'all' || settings.tenants.has(slug);
}

/**
 * O cliente conecta o Cloudflare por OAuth: liberado, com o servidor dedicado gerenciado pela Verax (a VM do cliente e a
 * célula ficam no token colado) e num estado com o servidor no ar.
 */
export function isTenantReleased(
  settings: CloudflareOauthSettings,
  tenant: Pick<TenantRecord, 'slug' | 'state' | 'hosting' | 'placement'>,
): boolean {
  return (
    isSlugReleased(settings, tenant.slug) &&
    hostingOf(tenant) === 'verax' &&
    tenant.placement === undefined &&
    NODE_SYNC_ACTIVE_STATES.has(tenant.state)
  );
}
