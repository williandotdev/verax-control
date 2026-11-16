import type { AppConfig } from '../../common/config/config.module.js';
import { belongsToHost, type HostTenant } from '../host-tenant.js';

/**
 * Onde a entrada única pelo console existe nesta requisição (`docs/ARQUITETURA.md`, "Entrada única"). Só onde a equipe
 * da Verax entra, e só com a entrada única configurada (`config.sso`):
 * - na célula, no endereço da equipe (`api-<CELL_STAFF_SLUG>`): o pedido fica preso ao cliente da equipe, e a sessão,
 *   ao endereço, como qualquer outra sessão da célula;
 * - no nó dedicado da própria Verax (`PLAN=interno`; decisão de 16/11/2026): o nó inteiro é da equipe (um nó, um
 *   endereço, `API_ORIGIN`), sem cliente do endereço; o painel é o `WEB_ORIGIN`.
 *
 * Em qualquer outro caso (o endereço de um cliente da célula, um desconhecido, um nó dedicado de cliente ou a entrada
 * única sem configuração), `undefined`, e as rotas respondem 404. A configuração já recusa as variáveis num nó dedicado
 * de cliente; o `PLAN` é conferido de novo aqui, para um erro na configuração nunca abrir a entrada num nó de cliente.
 */
export interface SsoSite {
  sso: NonNullable<AppConfig['sso']>;
  /** O cliente da equipe, na célula (o pedido e o retorno precisam bater); `null` no nó dedicado da Verax. */
  tenantId: string | null;
  /** A origem do painel para onde o navegador volta (a sessão aberta, ou a recusa). */
  panelOrigin: string;
  /** Na célula, o endereço da equipe; `undefined` no nó dedicado. */
  host: HostTenant | undefined;
}

export function ssoSiteOf(
  config: Pick<AppConfig, 'sso' | 'cell' | 'PLAN' | 'WEB_ORIGIN'>,
  host: HostTenant | undefined,
): SsoSite | undefined {
  const sso = config.sso;
  if (sso === null) return undefined;
  if (config.cell === null) {
    if (config.PLAN !== 'interno') return undefined;
    return { sso, tenantId: null, panelOrigin: config.WEB_ORIGIN, host: undefined };
  }
  if (host === undefined || !host.staff) return undefined;
  return { sso, tenantId: host.tenantId, panelOrigin: host.panelOrigin, host };
}

/**
 * Quem a entrada única pode ser neste lugar: o `admin_verax` sem cliente (o papel já foi conferido por quem chama). Na
 * célula, a mesma regra do endereço de sempre (`belongsToHost`); no nó dedicado da Verax, sem cliente também.
 */
export function belongsToSsoSite(user: { role: string; tenantId?: string | null }, site: SsoSite): boolean {
  if (site.host !== undefined) return belongsToHost(user, site.host);
  return user.role === 'admin_verax' && (user.tenantId ?? null) === null;
}
