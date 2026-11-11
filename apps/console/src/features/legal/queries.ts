import { type QueryClient, useQuery } from '@tanstack/react-query';
import { legalApi } from '@/lib/api';
import type { LegalKind } from '@/lib/api-types';

export function useLegalOverview() {
  return useQuery({ queryKey: ['legal'], queryFn: legalApi.overview });
}

export function useLegalText(kind: LegalKind | undefined, version: string | undefined) {
  return useQuery({
    queryKey: ['legal-text', kind, version],
    queryFn: () => legalApi.get(kind ?? 'terms', version ?? ''),
    enabled: kind !== undefined && version !== undefined,
  });
}

export function useLegalAudit(kind: LegalKind) {
  return useQuery({ queryKey: ['legal-audit', kind], queryFn: () => legalApi.audit(kind) });
}

/** Depois de qualquer escrita: a lista, os textos e as trilhas. */
export function invalidateLegal(client: QueryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey[0];
      return key === 'legal' || key === 'legal-text' || key === 'legal-audit';
    },
  });
}
