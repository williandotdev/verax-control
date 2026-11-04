import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type VersionKind } from '@/lib/api';

export function useVersions(kind: VersionKind) {
  return useQuery({ queryKey: ['versions', kind], queryFn: () => api.list(kind) });
}

export function useVersion<K extends VersionKind>(kind: K, version: string | undefined) {
  return useQuery({
    queryKey: ['version', kind, version],
    queryFn: () => api.get(kind, version ?? ''),
    enabled: version !== undefined,
  });
}

/** A vigente de um tipo (pela lista), com o conteúdo. */
export function useCurrentVersion<K extends VersionKind>(kind: K) {
  const list = useVersions(kind);
  const current = list.data?.find((entry) => entry.current)?.version;
  return { list, record: useVersion(kind, current), version: current };
}

/** Depois de qualquer escrita: as listas e as versões dos dois tipos (publicar um muda a checagem do outro). */
export function invalidateVersions(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => query.queryKey[0] === 'versions' || query.queryKey[0] === 'version',
  });
}

export function useInvalidateVersions(): () => Promise<void> {
  const client = useQueryClient();
  return () => invalidateVersions(client);
}
