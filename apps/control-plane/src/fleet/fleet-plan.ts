import type { CellRecord } from '../cells/cell.schema.js';
import { hostingOf, type TenantRecord, type TenantState } from '../tenants/tenant.schema.js';
import type { NodeTarget, PanelTarget, Wave } from './fleet.schema.js';

/**
 * Quem entra na frota e em que ordem (decisão de 16/11/2026): o registro dos clientes e das células, e não uma lista à
 * parte. A célula com o painel da equipe da Verax é a canária (onda 0), as outras células vêm depois (onda 1), e os nós
 * dedicados por último (onda 2, em lotes). O painel de cada destino anda com o nó dele: na célula, o site de cada
 * cliente dela e o da equipe; no dedicado, o site do cliente.
 */

/** Os estados em que o nó do cliente está no ar (a VM ligada): o resto não recebe pedido. */
export const RUNNING_TENANT_STATES: readonly TenantState[] = [
  'active',
  'waiting_customer_connection',
  'past_due',
];
/** Os estados com nó, mas parado: aparecem na revisão como "fora", com o motivo. */
export const STOPPED_TENANT_STATES: readonly TenantState[] = ['suspended'];

export interface PlannedNode {
  key: string;
  kind: 'cell' | 'dedicated';
  wave: Wave;
  order: number;
  label: string;
  tenantId?: string;
  cellId?: string;
  target: NodeTarget;
  apiOrigin: string;
  panels: PanelTarget[];
}

export const EXCLUSION_REASONS = [
  'cell_closed',
  'cell_without_node',
  'cell_without_address',
  'tenant_stopped',
  'tenant_without_node',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface ExcludedNode {
  key: string;
  label: string;
  kind: 'cell' | 'dedicated';
  reason: ExclusionReason;
}

export interface FleetPlan {
  nodes: PlannedNode[];
  excluded: ExcludedNode[];
}

/** Os endereços públicos: `https://<prefixo><subdomínio>.<zona>` (o `api-<cliente>` pelo túnel). */
export interface FleetHosts {
  apiDomainPrefix: string;
  zoneName: string;
}

export function apiOriginOf(slug: string, hosts: FleetHosts): string {
  return `https://${hosts.apiDomainPrefix}${slug}.${hosts.zoneName}`;
}

function panelOf(tenant: TenantRecord): PanelTarget | undefined {
  const project = tenant.resources?.firebaseProject;
  const siteId = tenant.resources?.siteId;
  return project === undefined || siteId === undefined ? undefined : { project, siteId, slug: tenant.slug };
}

/**
 * Monta o plano a partir das células e dos clientes lidos agora. `tenants` traz os clientes nos estados de
 * `RUNNING_TENANT_STATES` e `STOPPED_TENANT_STATES` (os outros não têm nó no ar).
 */
export function buildFleetPlan(
  cells: readonly CellRecord[],
  tenants: readonly TenantRecord[],
  hosts: FleetHosts,
): FleetPlan {
  const nodes: PlannedNode[] = [];
  const excluded: ExcludedNode[] = [];
  const running = tenants.filter((tenant) => RUNNING_TENANT_STATES.includes(tenant.state));
  const byCell = new Map<string, TenantRecord[]>();
  for (const tenant of running) {
    const cellId = tenant.placement?.cellId;
    if (cellId === undefined) continue;
    byCell.set(cellId, [...(byCell.get(cellId) ?? []), tenant]);
  }

  const sortedCells = [...cells].sort((a, b) => {
    const canary = Number(b.staffPanel !== undefined) - Number(a.staffPanel !== undefined);
    return canary !== 0 ? canary : a.id.localeCompare(b.id);
  });
  let order = 0;
  for (const cell of sortedCells) {
    const key = `cell-${cell.id}`;
    if (cell.state === 'closed') {
      excluded.push({ key, label: cell.id, kind: 'cell', reason: 'cell_closed' });
      continue;
    }
    if (cell.node === undefined) {
      excluded.push({ key, label: cell.id, kind: 'cell', reason: 'cell_without_node' });
      continue;
    }
    const cellTenants = [...(byCell.get(cell.id) ?? [])].sort((a, b) => a.slug.localeCompare(b.slug));
    const addressSlug = cell.staffPanel?.slug ?? cellTenants[0]?.slug;
    if (addressSlug === undefined) {
      excluded.push({ key, label: cell.id, kind: 'cell', reason: 'cell_without_address' });
      continue;
    }
    const panels: PanelTarget[] = [];
    if (cell.staffPanel !== undefined) panels.push({ ...cell.staffPanel });
    for (const tenant of cellTenants) {
      const panel = panelOf(tenant);
      if (panel !== undefined) panels.push(panel);
    }
    nodes.push({
      key,
      kind: 'cell',
      wave: cell.staffPanel === undefined ? 1 : 0,
      order: order++,
      label: cell.id,
      cellId: cell.id,
      target: { project: cell.project, zone: cell.node.zone, instance: cell.node.instance },
      apiOrigin: apiOriginOf(addressSlug, hosts),
      panels,
    });
  }

  const dedicated = tenants
    .filter((tenant) => hostingOf(tenant) === 'verax' && tenant.placement === undefined)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  order = 0;
  for (const tenant of dedicated) {
    const key = `tenant-${tenant.id}`;
    if (STOPPED_TENANT_STATES.includes(tenant.state)) {
      excluded.push({ key, label: tenant.slug, kind: 'dedicated', reason: 'tenant_stopped' });
      continue;
    }
    const resources = tenant.resources;
    if (
      resources?.nodesProject === undefined ||
      resources.zone === undefined ||
      resources.instanceName === undefined ||
      tenant.lifecycle?.nodeStoppedAt !== undefined
    ) {
      excluded.push({
        key,
        label: tenant.slug,
        kind: 'dedicated',
        reason: tenant.lifecycle?.nodeStoppedAt === undefined ? 'tenant_without_node' : 'tenant_stopped',
      });
      continue;
    }
    const panel = panelOf(tenant);
    nodes.push({
      key,
      kind: 'dedicated',
      wave: 2,
      order: order++,
      label: tenant.slug,
      tenantId: tenant.id,
      target: { project: resources.nodesProject, zone: resources.zone, instance: resources.instanceName },
      apiOrigin: apiOriginOf(tenant.slug, hosts),
      panels: panel === undefined ? [] : [panel],
    });
  }
  return { nodes, excluded };
}
