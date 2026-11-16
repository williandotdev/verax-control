import type { AppConfig } from '../common/config/config.module.js';
import type { FleetHosts } from './fleet-plan.js';

/**
 * O que a frota precisa da configuração do cp-worker: o bucket de releases (o manifesto assinado e o bundle do painel
 * de cada versão) e os endereços públicos das APIs. Não depende do provisionamento ligado: a célula da Verax se
 * atualiza antes do primeiro cliente dedicado.
 */
export interface FleetSettings extends FleetHosts {
  releaseBucket: string;
}

export function resolveFleetSettings(config: AppConfig): FleetSettings | undefined {
  if (config.RELEASE_BUCKET === undefined) return undefined;
  return {
    releaseBucket: config.RELEASE_BUCKET,
    apiDomainPrefix: config.API_DOMAIN_PREFIX,
    zoneName: config.CLOUDFLARE_ZONE_NAME,
  };
}

export const FLEET_SETTINGS = Symbol('FLEET_SETTINGS');
export const FLEET_CLOUD = Symbol('FLEET_CLOUD');
