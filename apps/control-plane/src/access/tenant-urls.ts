import type { AppConfig } from '../common/config/config.module.js';

export type TenantDomainSettings = Pick<
  AppConfig,
  'PANEL_DOMAIN_SUFFIX' | 'API_DOMAIN_PREFIX' | 'CLOUDFLARE_ZONE_NAME'
>;

/**
 * Os endereços de um cliente, derivados do subdomínio (plano §4c, passo 1): o painel em
 * `https://<slug>.<PANEL_DOMAIN_SUFFIX>` e a API em `https://<API_DOMAIN_PREFIX><slug>.<CLOUDFLARE_ZONE_NAME>`. Os
 * mesmos que o painel de build único deriva do próprio endereço (CP-08).
 */
export function tenantUrls(
  slug: string,
  domains: TenantDomainSettings,
): { panelUrl: string; apiUrl: string } {
  return {
    panelUrl: `https://${slug}.${domains.PANEL_DOMAIN_SUFFIX}`,
    apiUrl: `https://${domains.API_DOMAIN_PREFIX}${slug}.${domains.CLOUDFLARE_ZONE_NAME}`,
  };
}
