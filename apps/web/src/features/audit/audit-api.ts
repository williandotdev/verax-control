import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  auditEntryDetailSchema,
  auditEntrySchema,
  type AuditListQuery,
  paginatedSchema,
} from '@verax/shared';
import { api } from '@/lib/api';

const auditPageSchema = paginatedSchema(auditEntrySchema);

function toSearch(query: AuditListQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** Trilha de auditoria que a sessão alcança, com os filtros na query string. */
export function useAuditEntries(query: AuditListQuery) {
  return useQuery({
    queryKey: ['audit', query],
    queryFn: () => api.get(`/v1/audit?${toSearch(query)}`, auditPageSchema),
    placeholderData: keepPreviousData,
  });
}

/** Um registro inteiro, com o estado anterior e o novo. */
export function useAuditEntry(id: string | null) {
  return useQuery({
    queryKey: ['audit-entry', id],
    queryFn: () => api.get(`/v1/audit/${encodeURIComponent(id ?? '')}`, auditEntryDetailSchema),
    enabled: id !== null,
  });
}
