import { request } from '@/lib/api';

/**
 * A frota no console (`/v1/admin/fleet/...`, decisão de 16/11/2026): as versões do bucket, a versão de cada nó e site,
 * as rodadas de "Promover para a frota" e as operações. Os tipos espelham as respostas do cp-admin
 * (`apps/control-plane/src/admin/admin-fleet.service.ts`).
 */
export type ReleaseStatus = 'ok' | 'panel_missing' | 'invalid' | 'unavailable';
export interface ReleaseEntry {
  release: string;
  commit?: string;
  status: ReleaseStatus;
}

export type NodeKind = 'cell' | 'dedicated';
export type ExclusionReason =
  'cell_closed' | 'cell_without_node' | 'cell_without_address' | 'tenant_stopped' | 'tenant_without_node';
export interface ExcludedNode {
  key: string;
  label: string;
  kind: NodeKind;
  reason: ExclusionReason;
}

export interface InventoryNode {
  key: string;
  kind: NodeKind;
  wave: number;
  label: string;
  version?: string;
  updateState?: string;
  error?: 'unreachable';
  panels: { slug: string; release?: string; error?: 'unreachable' }[];
}

export interface Inventory {
  nodes: InventoryNode[];
  excluded: ExcludedNode[];
}

export interface FleetPlan {
  release: { release: string; commit: string };
  nodes: { key: string; kind: NodeKind; wave: number; label: string; instance: string; panels: string[] }[];
  excluded: ExcludedNode[];
  activeRolloutId?: string;
}

export type RolloutState = 'running' | 'paused' | 'paused_on_failure' | 'completed' | 'aborted';
export type NodeState =
  'pending' | 'updating' | 'checking' | 'publishing' | 'done' | 'failed' | 'skipped' | 'reverted';

export interface RolloutTotals {
  nodes: number;
  pending: number;
  inFlight: number;
  done: number;
  failed: number;
  skipped: number;
  reverted: number;
}

export interface Rollout {
  id: string;
  release: string;
  commit: string;
  intent: 'upgrade' | 'rollback';
  state: RolloutState;
  concurrency: number;
  window?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  failure?: { nodeKey: string; code: string; at: string };
  totals: RolloutTotals;
}

export interface RolloutNode {
  key: string;
  kind: NodeKind;
  wave: number;
  label: string;
  instance: string;
  state: NodeState;
  operation?: { kind: 'update' | 'revert'; release: string };
  attempt: number;
  fromVersion?: string;
  nodeState?: string;
  errorCode?: string;
  panels: string[];
  panelsDone: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface RolloutDetail {
  rollout: Rollout;
  nodes: RolloutNode[];
}

export interface RolloutRequest {
  release: string;
  confirmRelease: string;
  concurrency: number;
  window?: string;
}

export type RolloutAction = 'pause' | 'resume' | 'abort';
export type NodeAction = 'skip' | 'rollback';

const FLEET = '/v1/admin/fleet';

export const fleetApi = {
  releases: (): Promise<{ releases: ReleaseEntry[] }> => request('GET', `${FLEET}/releases`),
  inventory: (): Promise<Inventory> => request('GET', `${FLEET}/inventory`),
  rollouts: (): Promise<{ rollouts: Rollout[] }> => request('GET', `${FLEET}/rollouts`),
  rollout: (id: string): Promise<RolloutDetail> =>
    request('GET', `${FLEET}/rollouts/${encodeURIComponent(id)}`),
  plan: (release: string): Promise<FleetPlan> => request('POST', `${FLEET}/plan`, { release }),
  create: (body: RolloutRequest): Promise<{ rollout: Rollout }> => request('POST', `${FLEET}/rollouts`, body),
  act: (id: string, action: RolloutAction): Promise<{ rollout: Rollout }> =>
    request('POST', `${FLEET}/rollouts/${encodeURIComponent(id)}/${action}`, {}),
  actOnNode: (id: string, key: string, action: NodeAction): Promise<RolloutDetail> =>
    request(
      'POST',
      `${FLEET}/rollouts/${encodeURIComponent(id)}/nodes/${encodeURIComponent(key)}/${action}`,
      {},
    ),
};
