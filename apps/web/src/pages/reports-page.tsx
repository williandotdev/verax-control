import { FINDING_SEVERITIES, REPORT_PERIODS, type ReportKind, type ReportPeriod } from '@verax/shared';
import { Tabs } from 'radix-ui';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { SeverityBadge } from '@/components/security/severity-badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card } from '@/components/ui/card';
import { SelectField } from '@/components/ui/select-field';
import { PROVIDER_LABELS } from '@/features/admin/labels';
import { FINDING_SOURCE_LABELS, FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { INCIDENT_STATUS_LABELS } from '@/features/incidents/labels';
import { formatDuration, PERIOD_LABELS, REPORT_TABS, TACTIC_LABELS } from '@/features/reports/labels';
import { MitreGrid } from '@/features/reports/mitre-grid';
import { ReportContext } from '@/features/reports/report-context';
import { ReportTable } from '@/features/reports/report-table';
import { useReport } from '@/features/reports/reports-api';
import { useMe } from '@/features/session/session';
import { SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/format';

const PERIOD_OPTIONS = REPORT_PERIODS.map((period) => ({ value: period, label: PERIOD_LABELS[period] }));

/**
 * Relatórios para especialistas: as visões tradicionais de um SOC, por período, com exportação em CSV. A Torre
 * continua sendo o ponto de partida; aqui fica o detalhe para quem quer analisar a fundo.
 */
export function ReportsPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const [params, setParams] = useSearchParams();
  const tab = REPORT_TABS.find((item) => item.slug === params.get('aba')) ?? REPORT_TABS[0];
  const period = REPORT_PERIODS.find((value) => value === params.get('periodo')) ?? '30d';
  const update = (changes: Record<string, string | null>) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    });

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Relatórios</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            As visões clássicas de um SOC, para análise detalhada. Todas as tabelas podem ser exportadas em
            CSV.
          </p>
        </div>
        <SelectField
          label="Período"
          value={period}
          onChange={(value) => update({ periodo: value === '30d' ? null : value })}
          options={PERIOD_OPTIONS}
        />
      </header>
      {scope === null ? (
        <EmptyState
          title="Escolha um cliente"
          description="Os relatórios mostram um cliente por vez. Escolha um no seletor do topo da tela."
        />
      ) : (
        <Tabs.Root
          value={tab?.slug ?? 'resumo'}
          onValueChange={(value) => update({ aba: value === 'resumo' ? null : value })}
        >
          <Tabs.List aria-label="Relatório" className="flex flex-wrap gap-1 border-b">
            {REPORT_TABS.map((item) => (
              <Tabs.Trigger
                key={item.slug}
                value={item.slug}
                className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground data-[state=active]:border-foreground data-[state=active]:font-medium data-[state=active]:text-foreground"
              >
                {item.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value={tab?.slug ?? 'resumo'} className="pt-4 focus:outline-none">
            {tab && <ReportView key={tab.kind} kind={tab.kind} period={period} />}
          </Tabs.Content>
        </Tabs.Root>
      )}
    </section>
  );
}

function ReportView({ kind, period }: { kind: ReportKind; period: ReportPeriod }) {
  switch (kind) {
    case 'summary':
      return <SummaryReportView period={period} />;
    case 'mitre':
      return <MitreReportView period={period} />;
    case 'rules':
      return <RulesReportView period={period} />;
    case 'entities':
      return <EntitiesReportView period={period} />;
    case 'incidents':
      return <IncidentsReportView period={period} />;
    case 'coverage':
      return <CoverageReportView period={period} />;
    case 'exceptions':
      return <ExceptionsReportView period={period} />;
  }
}

/**
 * Estados comuns: carregando, erro e o conteúdo, com a janela do relatório no topo. Ao trocar de período, os números
 * anteriores seguem na tela até os novos chegarem, marcados como desatualizados e sem exportação.
 */
function Loaded<T extends { period: ReportPeriod; from: string; to: string }>({
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

function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

function SummaryReportView({ period }: { period: ReportPeriod }) {
  const report = useReport('summary', period, true);
  return (
    <Loaded query={report} label="o resumo">
      {(data) => (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Kpi label="Achados no período" value={data.findings.total} />
            <Kpi label="Incidentes abertos no período" value={data.incidents.opened} />
            <Kpi label="Incidentes resolvidos" value={data.incidents.resolved} />
            <Kpi label="Tempo médio até a triagem" value={formatDuration(data.meanTimeToTriageMinutes)} />
            <Kpi label="Tempo médio até a resolução" value={formatDuration(data.meanTimeToResolveMinutes)} />
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <ReportTable
              caption="Achados por severidade"
              file={'achados-por-severidade'}
              rows={FINDING_SEVERITIES.map((severity) => ({
                severity,
                count: data.findings.bySeverity[severity],
              }))}
              rowKey={(row) => row.severity}
              columns={[
                {
                  header: 'Severidade',
                  cell: (row) => <SeverityBadge severity={row.severity} />,
                  csv: (row) => SEVERITY_STYLES[row.severity].label,
                },
                { header: 'Achados', cell: (row) => row.count, csv: (row) => row.count, align: 'right' },
              ]}
            />
            <ReportTable
              caption="Achados por status"
              file={'achados-por-status'}
              rows={Object.entries(data.findings.byStatus).map(([status, count]) => ({ status, count }))}
              rowKey={(row) => row.status}
              columns={[
                {
                  header: 'Status',
                  cell: (row) => statusLabel(row.status),
                  csv: (row) => statusLabel(row.status),
                },
                { header: 'Achados', cell: (row) => row.count, csv: (row) => row.count, align: 'right' },
              ]}
            />
            <ReportTable
              caption="Achados por fonte"
              file={'achados-por-fonte'}
              rows={data.findings.bySource}
              rowKey={(row) => row.source}
              columns={[
                {
                  header: 'Fonte',
                  cell: (row) => sourceLabel(row.source),
                  csv: (row) => sourceLabel(row.source),
                },
                { header: 'Achados', cell: (row) => row.count, csv: (row) => row.count, align: 'right' },
              ]}
            />
          </div>
          <ReportTable
            caption="Achados por dia"
            file={'achados-por-dia'}
            rows={[...data.daily].reverse()}
            rowKey={(row) => row.date}
            columns={[
              { header: 'Dia', cell: (row) => formatDay(row.date), csv: (row) => row.date },
              ...FINDING_SEVERITIES.map((severity) => ({
                header: SEVERITY_STYLES[severity].label,
                cell: (row: (typeof data.daily)[number]) => row[severity],
                csv: (row: (typeof data.daily)[number]) => row[severity],
                align: 'right' as const,
              })),
            ]}
          />
        </>
      )}
    </Loaded>
  );
}

function MitreReportView({ period }: { period: ReportPeriod }) {
  const report = useReport('mitre', period, true);
  return (
    <Loaded query={report} label="o MITRE ATT&CK">
      {(data) => (
        <>
          <MitreGrid tactics={data.tactics} />
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
              { header: 'Achados', cell: (row) => row.findings, csv: (row) => row.findings, align: 'right' },
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

function RulesReportView({ period }: { period: ReportPeriod }) {
  const report = useReport('rules', period, true);
  return (
    <Loaded query={report} label="as detecções">
      {(data) => (
        <ReportTable
          caption="Regras que mais dispararam"
          file={'deteccoes'}
          rows={data.items}
          rowKey={(row) => row.ruleId}
          columns={[
            {
              header: 'Regra',
              cell: (row) => <span className="font-mono text-xs">{row.ruleId}</span>,
              csv: (row) => row.ruleId,
            },
            { header: 'Descrição', cell: (row) => row.title, csv: (row) => row.title },
            {
              header: 'Severidade',
              cell: (row) => <SeverityBadge severity={row.severity} />,
              csv: (row) => SEVERITY_STYLES[row.severity].label,
            },
            { header: 'Achados', cell: (row) => row.findings, csv: (row) => row.findings, align: 'right' },
            { header: 'Contas', cell: (row) => row.accounts, csv: (row) => row.accounts, align: 'right' },
            {
              header: 'Última vez',
              cell: (row) => formatTimestamp(row.lastSeenAt),
              csv: (row) => row.lastSeenAt,
            },
          ]}
        />
      )}
    </Loaded>
  );
}

function EntitiesReportView({ period }: { period: ReportPeriod }) {
  const report = useReport('entities', period, true);
  const lists = [
    { key: 'users', caption: 'Usuários e identidades', file: 'usuarios' },
    { key: 'ips', caption: 'IPs de origem', file: 'ips' },
    { key: 'keys', caption: 'Chaves de acesso', file: 'chaves' },
    { key: 'resources', caption: 'Recursos', file: 'recursos' },
  ] as const;
  return (
    <Loaded query={report} label="as entidades">
      {(data) => (
        <div className="grid gap-6 lg:grid-cols-2">
          {lists.map((list) => (
            <ReportTable
              key={list.key}
              caption={list.caption}
              file={`entidades-${list.file}`}
              rows={data[list.key]}
              rowKey={(row) => row.value}
              columns={[
                {
                  header: 'Valor',
                  cell: (row) => <span className="break-all font-mono text-xs">{row.value}</span>,
                  csv: (row) => row.value,
                },
                {
                  header: 'Achados',
                  cell: (row) => row.findings,
                  csv: (row) => row.findings,
                  align: 'right',
                },
                {
                  header: 'Incidentes',
                  cell: (row) => row.incidents,
                  csv: (row) => row.incidents,
                  align: 'right',
                },
              ]}
            />
          ))}
        </div>
      )}
    </Loaded>
  );
}

function IncidentsReportView({ period }: { period: ReportPeriod }) {
  const report = useReport('incidents', period, true);
  return (
    <Loaded query={report} label="os incidentes">
      {(data) => (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <ReportTable
              caption="Por severidade"
              file={'incidentes-por-severidade'}
              rows={data.bySeverity}
              rowKey={(row) => row.severity}
              columns={[
                {
                  header: 'Severidade',
                  cell: (row) => <SeverityBadge severity={row.severity} />,
                  csv: (row) => SEVERITY_STYLES[row.severity].label,
                },
                { header: 'Abertos', cell: (row) => row.opened, csv: (row) => row.opened, align: 'right' },
                {
                  header: 'Resolvidos',
                  cell: (row) => row.resolved,
                  csv: (row) => row.resolved,
                  align: 'right',
                },
                {
                  header: 'Tempo médio até resolver',
                  cell: (row) => formatDuration(row.meanTimeToResolveMinutes),
                  csv: (row) => row.meanTimeToResolveMinutes,
                  align: 'right',
                },
              ]}
            />
            <ReportTable
              caption="Por responsável"
              file={'incidentes-por-responsavel'}
              rows={data.byAssignee}
              rowKey={(row) => row.assignee?.id ?? 'ninguem'}
              columns={[
                {
                  header: 'Responsável',
                  cell: (row) => row.assignee?.name ?? 'Ninguém',
                  csv: (row) => row.assignee?.name ?? 'Ninguém',
                },
                { header: 'Em aberto', cell: (row) => row.open, csv: (row) => row.open, align: 'right' },
                {
                  header: 'Resolvidos no período',
                  cell: (row) => row.resolved,
                  csv: (row) => row.resolved,
                  align: 'right',
                },
              ]}
            />
          </div>
          <ReportTable
            caption="Incidentes abertos no período"
            file={'incidentes'}
            rows={data.items}
            rowKey={(row) => row.id}
            columns={[
              {
                header: 'Incidente',
                cell: (row) => (
                  <Link to={`/incidentes/${row.id}`} className="underline">
                    {formatTimestamp(row.firstSeenAt)}
                  </Link>
                ),
                csv: (row) => row.id,
              },
              {
                header: 'Severidade',
                cell: (row) => <SeverityBadge severity={row.severity} />,
                csv: (row) => SEVERITY_STYLES[row.severity].label,
              },
              { header: 'Nota', cell: (row) => row.riskScore, csv: (row) => row.riskScore, align: 'right' },
              {
                header: 'Status',
                cell: (row) => INCIDENT_STATUS_LABELS[row.status].label,
                csv: (row) => INCIDENT_STATUS_LABELS[row.status].label,
              },
              {
                header: 'Responsável',
                cell: (row) => row.assignee?.name ?? 'Ninguém',
                csv: (row) => row.assignee?.name ?? '',
              },
              {
                header: 'Resolvido em',
                cell: (row) => (row.resolvedAt ? formatTimestamp(row.resolvedAt) : '—'),
                csv: (row) => row.resolvedAt,
              },
            ]}
          />
        </>
      )}
    </Loaded>
  );
}

function CoverageReportView({ period }: { period: ReportPeriod }) {
  const report = useReport('coverage', period, true);
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
            { header: 'Achados', cell: (row) => row.findings, csv: (row) => row.findings, align: 'right' },
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

function ExceptionsReportView({ period }: { period: ReportPeriod }) {
  const report = useReport('exceptions', period, true);
  return (
    <Loaded query={report} label="as exceções">
      {(data) => (
        <ReportTable
          caption="Exceções e quantos alertas cada uma silenciou"
          file={'excecoes'}
          rows={data.items}
          rowKey={(row) => row.id}
          empty="Nenhuma exceção cadastrada."
          columns={[
            {
              header: 'Regra',
              cell: (row) => <span className="font-mono text-xs">{row.ruleId}</span>,
              csv: (row) => row.ruleId,
            },
            { header: 'Campo', cell: (row) => fieldLabel(row.field), csv: (row) => row.field },
            {
              header: 'Valor',
              cell: (row) => <span className="break-all font-mono text-xs">{row.value}</span>,
              csv: (row) => row.value,
            },
            { header: 'Motivo', cell: (row) => row.reason, csv: (row) => row.reason },
            {
              header: 'Situação',
              cell: (row) => (row.active ? 'Em vigor' : 'Vencida'),
              csv: (row) => (row.active ? 'Em vigor' : 'Vencida'),
            },
            {
              header: 'No período',
              cell: (row) => row.matchedInPeriod,
              csv: (row) => row.matchedInPeriod,
              align: 'right',
            },
            {
              header: 'No total',
              cell: (row) => row.matchedTotal,
              csv: (row) => row.matchedTotal,
              align: 'right',
            },
          ]}
        />
      )}
    </Loaded>
  );
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  user: 'Usuário',
  ip: 'IP ou faixa',
  resource: 'Recurso',
};
const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;
const statusLabel = (status: string) =>
  FINDING_STATUS_LABELS[status as keyof typeof FINDING_STATUS_LABELS]?.label ?? status;
const sourceLabel = (source: string) =>
  FINDING_SOURCE_LABELS[source as keyof typeof FINDING_SOURCE_LABELS] ?? source;

function formatDay(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}
