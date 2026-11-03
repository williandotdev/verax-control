import { useQuery } from '@tanstack/react-query';
import { type ReportKind, type ReportPeriod, reportSchemas } from '@verax/shared';
import type { z } from 'zod';
import { useMe } from '@/features/session/session';
import { api } from '@/lib/api';

/** Um relatório do cliente da sessão, no período escolhido. */
export function useReport<K extends ReportKind>(kind: K, period: ReportPeriod, enabled: boolean) {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  return useQuery({
    queryKey: ['report', scope, kind, period],
    queryFn: () => {
      // A tabela é indexada pelo mesmo `kind` da URL: o schema é sempre o do relatório pedido.
      const schema = reportSchemas[kind] as unknown as z.ZodType<z.infer<(typeof reportSchemas)[K]>>;
      return api.get(`/v1/reports/${kind}?period=${period}`, schema);
    },
    enabled,
    // Ao trocar só o período, os números anteriores ficam na tela (marcados como desatualizados) até os novos
    // chegarem. Ao trocar de relatório ou de cliente, não: o formato ou o dono dos dados é outro.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === scope && previousQuery.queryKey[2] === kind ? previous : undefined,
  });
}
