import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fleetApi } from './api';

/** Com a rodada andando (ou um nó mudando), o detalhe se atualiza sozinho. */
const LIVE_REFRESH_MS = 10_000;

export function useReleases() {
  return useQuery({ queryKey: ['fleet', 'releases'], queryFn: fleetApi.releases, retry: false });
}

export function useInventory() {
  return useQuery({ queryKey: ['fleet', 'inventory'], queryFn: fleetApi.inventory, retry: false });
}

export function useRollouts() {
  return useQuery({ queryKey: ['fleet', 'rollouts'], queryFn: fleetApi.rollouts });
}

export function useRollout(id: string) {
  return useQuery({
    queryKey: ['fleet', 'rollout', id],
    queryFn: () => fleetApi.rollout(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      return data.rollout.state === 'running' || data.rollout.totals.inFlight > 0 ? LIVE_REFRESH_MS : false;
    },
  });
}

export function usePlan(release: string) {
  return useQuery({
    queryKey: ['fleet', 'plan', release],
    queryFn: () => fleetApi.plan(release),
    retry: false,
  });
}

export function useInvalidateFleet(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['fleet'] });
}
