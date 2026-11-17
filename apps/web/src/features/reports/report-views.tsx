import type { MitreTactic, ReportWindowPeriod } from '@verax/shared';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { PROVIDER_LABELS } from '@/features/admin/labels';
import { FINDING_SOURCE_LABELS } from '@/features/findings/labels';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/format';
import { TACTIC_LABELS } from './labels';
import { MitreGrid } from './mitre-grid';
import { ReportContext } from './report-context';
import { ReportTable } from './report-table';
import { type ReportRange, useReport } from './reports-api';

/**
 * As análises que vieram do menu Relatórios para a tela Detecções: o MITRE ATT&CK e a cobertura das fontes, na janela
 * do filtro de período da tela. Todas as tabelas exportam em CSV.
 */

/**
 * Estados comuns: carregando, erro e o conteúdo, com a janela do relatório no topo. Ao trocar de período, os números
 * anteriores seguem na tela até os novos chegarem, marcados como desatualizados e sem exportação.
 */
function Loaded<T extends { period: ReportWindowPeriod; from: string; to: string }>({
  query,
  label,
  children,
}: {
  query: {
    data?: T;
    error: Error | null;
    isError: boolean;
    isPlaceholderData: boolean;
    refetch: () => unknown;
  };
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState rows={6} label={`Carregando ${label}`} />;
  const current = !query.isPlaceholderData;
  return (
    <ReportContext value={{ period: query.data.period, current }}>
      <div className="space-y-6" aria-busy={!current}>
        <p className="text-xs text-muted-foreground">
          De {formatTimestamp(query.data.from)} a {formatTimestamp(query.data.to)}
          {!current && <span role="status"> · Atualizando para o período escolhido…</span>}
        </p>
        <div className={cn('space-y-6', !current && 'opacity-60')}>{children(query.data)}</div>
      </div>
    </ReportContext>
  );
}

/** As 14 táticas na grade e na tabela; cada tática da grade filtra a lista por ela (`tacticHref`). */
export function MitreReportView({
  range,
  tacticHref,
}: {
  range: ReportRange;
  tacticHref?: (tactic: MitreTactic) => string;
}) {
  const report = useReport('mitre', range, true);
  return (
    <Loaded query={report} label="o MITRE ATT&CK">
      {(data) => (
        <>
          <MitreGrid tactics={data.tactics} tacticHref={tacticHref} />
          <ReportTable
            caption="Táticas e técnicas do MITRE ATT&CK"
            file={'mitre-attck'}
            rows={data.tactics}
            rowKey={(row) => row.id}
            columns={[
              {
                header: 'Tática',
                cell: (row) => `${row.id} · ${TACTIC_LABELS[row.name] ?? row.name}`,
                csv: (row) => `${row.id} ${row.name}`,
              },
              { header: 'Alertas', cell: (row) => row.findings, csv: (row) => row.findings, align: 'right' },
              {
                header: 'Incidentes',
                cell: (row) => row.incidents,
                csv: (row) => row.incidents,
                align: 'right',
              },
              {
                header: 'Técnicas mais vistas',
                cell: (row) =>
                  row.techniques.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="font-mono text-xs">
                      {row.techniques
                        .map((technique) => `${technique.id} (${technique.findings})`)
                        .join(', ')}
                    </span>
                  ),
                csv: (row) =>
                  row.techniques.map((technique) => `${technique.id} (${technique.findings})`).join('; '),
              },
            ]}
          />
        </>
      )}
    </Loaded>
  );
}

const sourceLabel = (source: string) =>
  FINDING_SOURCE_LABELS[source as keyof typeof FINDING_SOURCE_LABELS] ?? source;

/** As contas monitoradas e o que chegou de cada uma no período. */
export function CoverageReportView({ range }: { range: ReportRange }) {
  const report = useReport('coverage', range, true);
  return (
    <Loaded query={report} label="a cobertura">
      {(data) => (
        <ReportTable
          caption="Contas monitoradas e o que chegou de cada uma"
          file={'cobertura'}
          rows={data.accounts}
          rowKey={(row) => `${row.provider}:${row.accountId}`}
          empty="Nenhuma conta cadastrada."
          columns={[
            {
              header: 'Provedor',
              cell: (row) => PROVIDER_LABELS[row.provider],
              csv: (row) => PROVIDER_LABELS[row.provider],
            },
            {
              header: 'Conta',
              cell: (row) => <span className="break-all font-mono text-xs">{row.accountId}</span>,
              csv: (row) => row.accountId,
            },
            {
              header: 'Status',
              cell: (row) => (row.active ? 'Ativa' : 'Inativa'),
              csv: (row) => (row.active ? 'Ativa' : 'Inativa'),
            },
            {
              header: 'Último evento',
              cell: (row) => (row.lastEventAt ? formatTimestamp(row.lastEventAt) : 'nenhum ainda'),
              csv: (row) => row.lastEventAt,
            },
            { header: 'Alertas', cell: (row) => row.findings, csv: (row) => row.findings, align: 'right' },
            {
              header: 'Por fonte',
              cell: (row) =>
                row.bySource.map((item) => `${sourceLabel(item.source)}: ${item.count}`).join(', ') || '—',
              csv: (row) => row.bySource.map((item) => `${item.source}: ${item.count}`).join('; '),
            },
          ]}
        />
      )}
    </Loaded>
  );
}
