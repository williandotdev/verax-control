import { useQuery } from '@tanstack/react-query';
import { type ReportKind, type ReportPeriod, reportSchemas } from '@verax/shared';
import type { z } from 'zod';
import { getWithCases } from '@/features/cases/cases-api';
import { useCasesContext } from '@/features/cases/cases-context';
import { useMe } from '@/features/session/session';

/** A janela de um relatório: um período ou o intervalo personalizado da tela Detecções. */
export type ReportRange = { period: ReportPeriod } | { from: string; to: string };

const rangeSearch = (range: ReportRange): string =>
  new URLSearchParams(
    'period' in range ? { period: range.period } : { from: range.from, to: range.to },
  ).toString();

/** Os relatórios que mudam com os casos. */
const WITH_CASES: ReadonlySet<ReportKind> = new Set(['summary', 'mitre']);

/** Um relatório do cliente da sessão, na janela escolhida. Com os casos valendo, leva também os números deles. */
export function useReport<K extends ReportKind>(kind: K, range: ReportRange, enabled: boolean) {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const search = rangeSearch(range);
  const { mode, loading } = useCasesContext();
  const changes = WITH_CASES.has(kind);
  const cases = changes && mode !== 'off';
  return useQuery({
    queryKey: ['report', scope, kind, search, cases],
    queryFn: () => {
      // A tabela é indexada pelo mesmo `kind` da URL: o schema é sempre o do relatório pedido.
      const schema = reportSchemas[kind] as unknown as z.ZodType<z.infer<(typeof reportSchemas)[K]>>;
      return getWithCases(`/v1/reports/${kind}?${search}`, schema, cases);
    },
    enabled: enabled && !(changes && loading),
    // Ao trocar só a janela, os números anteriores ficam na tela (marcados como desatualizados) até os novos
    // chegarem. Ao trocar de relatório ou de cliente, não: o formato ou o dono dos dados é outro.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === scope && previousQuery.queryKey[2] === kind ? previous : undefined,
  });
}
