import { useQuery } from '@tanstack/react-query';
import { type ReportKind, type ReportPeriod, reportSchemas } from '@verax/shared';
import type { z } from 'zod';
import { api } from '@/lib/api';

/** Um relatório do cliente da sessão, no período escolhido. */
export function useReport<K extends ReportKind>(kind: K, period: ReportPeriod, enabled: boolean) {
  return useQuery({
    queryKey: ['report', kind, period],
    queryFn: () => {
      // A tabela é indexada pelo mesmo `kind` da URL: o schema é sempre o do relatório pedido.
      const schema = reportSchemas[kind] as unknown as z.ZodType<z.infer<(typeof reportSchemas)[K]>>;
      return api.get(`/v1/reports/${kind}?period=${period}`, schema);
    },
    enabled,
    // Ao trocar só o período, os números anteriores ficam na tela até os novos chegarem. Ao trocar de relatório,
    // não: o formato é outro, e mostrar o anterior quebraria a tabela.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === kind ? previous : undefined,
  });
}
