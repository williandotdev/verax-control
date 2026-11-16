import { useQuery } from '@tanstack/react-query';
import { type ReportKind, type ReportPeriod, reportSchemas } from '@verax/shared';
import type { z } from 'zod';
import { useMe } from '@/features/session/session';
import { api } from '@/lib/api';

/** A janela de um relatório: um período ou o intervalo personalizado da tela Detecções. */
export type ReportRange = { period: ReportPeriod } | { from: string; to: string };

const rangeSearch = (range: ReportRange): string =>
  new URLSearchParams(
    'period' in range ? { period: range.period } : { from: range.from, to: range.to },
  ).toString();

/** Um relatório do cliente da sessão, na janela escolhida. */
export function useReport<K extends ReportKind>(kind: K, range: ReportRange, enabled: boolean) {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const search = rangeSearch(range);
  return useQuery({
    queryKey: ['report', scope, kind, search],
    queryFn: () => {
      // A tabela é indexada pelo mesmo `kind` da URL: o schema é sempre o do relatório pedido.
      const schema = reportSchemas[kind] as unknown as z.ZodType<z.infer<(typeof reportSchemas)[K]>>;
      return api.get(`/v1/reports/${kind}?${search}`, schema);
    },
    enabled,
    // Ao trocar só a janela, os números anteriores ficam na tela (marcados como desatualizados) até os novos
    // chegarem. Ao trocar de relatório ou de cliente, não: o formato ou o dono dos dados é outro.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === scope && previousQuery.queryKey[2] === kind ? previous : undefined,
  });
}
