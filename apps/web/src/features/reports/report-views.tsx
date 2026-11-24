import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  type FindingStatus,
  type MitreTactic,
  type ReportWindowPeriod,
} from '@verax/shared';
import { type ReactNode, useContext } from 'react';
import { Link } from 'react-router';
import { INK_RAMP } from '@/components/charts/chart-utils';
import { LineChart } from '@/components/charts/line-chart';
import { PieChart } from '@/components/charts/pie-chart';
import { SeverityBadge } from '@/components/security/severity-badge';
import { ErrorState, LoadingState } from '@/components/states';
import { Card } from '@/components/ui/card';
import { SEVERITY_MARKS, SEVERITY_STYLES } from '@/design/severity';
import { PROVIDER_LABELS } from '@/features/admin/labels';
import { FINDING_SOURCE_LABELS, FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { INCIDENT_STATUS_LABELS } from '@/features/incidents/labels';
import { cn } from '@/lib/cn';
import { formatCount, formatTimestamp } from '@/lib/format';
import { formatDuration } from './labels';
import { MitreRadar } from './mitre-radar';
import { ReportContext } from './report-context';
import { ReportSection, ReportTable } from './report-table';
import { type ReportRange, useReport } from './reports-api';
import { formatPart, tacticShares } from './tactic-share';

/**
 * As análises que vieram do menu Relatórios para a tela Detecções, na janela do filtro de período da tela: o resumo
 * (com os gráficos), o MITRE ATT&CK, as regras, as entidades, a resposta a incidentes, a cobertura das fontes e as
 * exceções. Todas as tabelas exportam em CSV.
 */

const ALERTS = { one: 'alerta', many: 'alertas' };
/** Os gráficos ficam sobre a superfície dos cartões: é contra ela que as cores foram validadas. */
const CHART_FRAME = 'rounded-md border bg-surface p-3';
/**
 * Status do alerta na pizza: a rampa de tinta, do "a validar" (mais tinta, mais atenção pendente) ao resolvido. Status
 * não é severidade, então não usa as cores dela.
 */
const STATUS_TONES: Readonly<Record<FindingStatus, (typeof INK_RAMP)[number]>> = {
  new: INK_RAMP[0],
  investigating: INK_RAMP[1],
  legitimate: INK_RAMP[2],
  resolved: INK_RAMP[3],
};
/** Na ordem do ciclo do alerta (a mesma em todo período, para a cor seguir o status e não a posição). */
const statusRows = (byStatus: Readonly<Record<FindingStatus, number>>) =>
  FINDING_STATUSES.map((status) => ({ status, count: byStatus[status] }));

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

/** Por que um alerta pode ficar sem tática, em linguagem simples. */
const NO_TACTIC_EXPLANATION =
  'A matriz mostra ações de um ataque. Vulnerabilidades, controles reprovados e acessos abertos são fraquezas, não ações de um ataque: ficam sem tática, mas continuam na lista de alertas, para validar. Cada alerta fica com a classificação de quando chegou.';

/**
 * A matriz vazia, explicada: sem isto, um cliente com milhares de alertas de vulnerabilidade e de postura vê 14 zeros e
 * acha que a tela quebrou. O relatório do MITRE não traz o total de alertas (o contrato é fechado, e um painel de antes
 * recusaria um campo novo): ele vem do relatório de resumo da mesma janela, pedido só com a matriz vazia. Sem ele
 * (carregando, erro, ou a matriz ainda da janela anterior), a explicação segue sem o número.
 */
function MitreEmptyNote({ range }: { range: ReportRange }) {
  const { current } = useContext(ReportContext);
  const summary = useReport('summary', range, current);
  const total = current && summary.data && !summary.isPlaceholderData ? summary.data.findings.total : null;
  if (total === 0) {
    return <p className="rounded-md border p-3 text-sm">Nenhum alerta neste período.</p>;
  }
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm">
      <p className="font-medium">
        {total === null
          ? 'Nenhum alerta deste período tem tática do MITRE ATT&CK.'
          : total === 1
            ? 'O único alerta deste período não tem tática do MITRE ATT&CK.'
            : `Nenhum dos ${formatCount(total)} alertas deste período tem tática do MITRE ATT&CK.`}
      </p>
      <p className="text-muted-foreground">{NO_TACTIC_EXPLANATION}</p>
    </div>
  );
}

/**
 * As 14 táticas no gráfico de radar e na tabela; cada tática com alerta, no gráfico, filtra a lista por ela
 * (`tacticHref`). Sem alerta com tática, a explicação toma o lugar do gráfico: uma teia sem série pareceria quebrada.
 */
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
          {data.tactics.every((tactic) => tactic.findings === 0) ? (
            <MitreEmptyNote range={range} />
          ) : (
            <p className="text-xs text-muted-foreground">{NO_TACTIC_EXPLANATION}</p>
          )}
          <MitreRadar tactics={data.tactics} tacticHref={tacticHref} />
          <ReportTable
            caption="Táticas e técnicas do MITRE ATT&CK"
            file={'mitre-attck'}
            rows={tacticShares(data.tactics)}
            rowKey={({ tactic }) => tactic.id}
            columns={[
              {
                header: 'Tática',
                cell: ({ tactic, label }) => `${tactic.id} · ${label}`,
                csv: ({ tactic }) => `${tactic.id} ${tactic.name}`,
              },
              {
                header: 'Alertas',
                cell: ({ tactic }) => formatCount(tactic.findings),
                csv: ({ tactic }) => tactic.findings,
                align: 'right',
              },
              {
                // Só na tela: no CSV vão os números crus e inteiros, de onde o percentual sai.
                header: 'Participação',
                cell: ({ share }) => formatPart(share),
                align: 'right',
              },
              {
                header: 'Incidentes',
                cell: ({ tactic }) => formatCount(tactic.incidents),
                csv: ({ tactic }) => tactic.incidents,
                align: 'right',
              },
              {
                header: 'Técnicas mais vistas',
                cell: ({ tactic }) =>
                  tactic.techniques.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className="font-mono text-xs">
                      {tactic.techniques
                        .map((technique) => `${technique.id} (${formatCount(technique.findings)})`)
                        .join(', ')}
                    </span>
                  ),
                csv: ({ tactic }) =>
                  tactic.techniques.map((technique) => `${technique.id} (${technique.findings})`).join('; '),
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

function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

/** O resumo do período: os números do topo, os alertas por severidade, status (pizza) e fonte, e por dia (linhas). */
export function SummaryReportView({ range }: { range: ReportRange }) {
  const report = useReport('summary', range, true);
  return (
    <Loaded query={report} label="o resumo">
      {(data) => (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Kpi label="Alertas no período" value={formatCount(data.findings.total)} />
            <Kpi label="Incidentes abertos no período" value={formatCount(data.incidents.opened)} />
            <Kpi label="Incidentes resolvidos" value={formatCount(data.incidents.resolved)} />
            <Kpi label="Tempo médio até a validação" value={formatDuration(data.meanTimeToTriageMinutes)} />
            <Kpi label="Tempo médio até a resolução" value={formatDuration(data.meanTimeToResolveMinutes)} />
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            <ReportTable
              caption="Alertas por severidade"
              file={'alertas-por-severidade'}
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
                { header: 'Alertas', cell: (row) => row.count, csv: (row) => row.count, align: 'right' },
              ]}
            />
            <ReportSection
              caption="Alertas por status"
              file={'alertas-por-status'}
              rows={statusRows(data.findings.byStatus)}
              csv={[
                { header: 'Status', csv: (row) => FINDING_STATUS_LABELS[row.status].label },
                { header: 'Alertas', csv: (row) => row.count },
              ]}
            >
              <PieChart
                title="Alertas por status"
                className={CHART_FRAME}
                unit={ALERTS}
                columns={{ category: 'Status', value: 'Alertas' }}
                empty="Nenhum alerta no período."
                slices={statusRows(data.findings.byStatus).map((row) => ({
                  key: row.status,
                  label: FINDING_STATUS_LABELS[row.status].label,
                  icon: FINDING_STATUS_LABELS[row.status].icon,
                  value: row.count,
                  ...STATUS_TONES[row.status],
                }))}
              />
            </ReportSection>
            <ReportTable
              caption="Alertas por fonte"
              file={'alertas-por-fonte'}
              rows={data.findings.bySource}
              rowKey={(row) => row.source}
              columns={[
                {
                  header: 'Fonte',
                  cell: (row) => sourceLabel(row.source),
                  csv: (row) => sourceLabel(row.source),
                },
                { header: 'Alertas', cell: (row) => row.count, csv: (row) => row.count, align: 'right' },
              ]}
            />
          </div>
          <ReportSection
            caption="Alertas por dia"
            file={'alertas-por-dia'}
            rows={[...data.daily].reverse()}
            csv={[
              { header: 'Dia', csv: (row) => row.date },
              ...FINDING_SEVERITIES.map((severity) => ({
                header: SEVERITY_STYLES[severity].label,
                csv: (row: (typeof data.daily)[number]) => row[severity],
              })),
            ]}
          >
            <LineChart
              title="Alertas por dia"
              className={CHART_FRAME}
              rows={data.daily}
              unit={ALERTS}
              empty="Nenhum alerta no período."
              series={FINDING_SEVERITIES.map((severity) => ({
                key: severity,
                label: SEVERITY_STYLES[severity].label,
                icon: SEVERITY_STYLES[severity].icon,
                iconClass: SEVERITY_STYLES[severity].tone,
                ...SEVERITY_MARKS[severity],
              }))}
            />
          </ReportSection>
        </>
      )}
    </Loaded>
  );
}

/** As regras que mais geraram alertas no período. */
export function RulesReportView({ range }: { range: ReportRange }) {
  const report = useReport('rules', range, true);
  return (
    <Loaded query={report} label="as regras">
      {(data) => (
        <ReportTable
          caption="Regras que mais dispararam"
          file={'regras'}
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
            { header: 'Alertas', cell: (row) => row.findings, csv: (row) => row.findings, align: 'right' },
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

/** Quem e o que mais aparece nos alertas: usuários, IPs de origem, chaves de acesso e recursos. */
export function EntitiesReportView({ range }: { range: ReportRange }) {
  const report = useReport('entities', range, true);
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
                  header: 'Alertas',
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

/** A resposta a incidentes: por severidade (com o tempo até resolver), por responsável e os abertos no período. */
export function IncidentsReportView({ range }: { range: ReportRange }) {
  const report = useReport('incidents', range, true);
  return (
    <Loaded query={report} label="a resposta a incidentes">
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
                  <Link to={`/?visao=incidentes&incidente=${row.id}`} className="underline">
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

const FIELD_LABELS: Readonly<Record<string, string>> = {
  user: 'Usuário',
  ip: 'IP ou faixa',
  resource: 'Recurso',
};
const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;

/** As exceções e quantos alertas cada uma silenciou, no período e no total. */
export function ExceptionsReportView({ range }: { range: ReportRange }) {
  const report = useReport('exceptions', range, true);
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
