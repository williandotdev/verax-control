import {
  type CaseListQuery,
  casePageSchema,
  type CaseSummary,
  type DetectionFilters,
  detectionPageSchema,
  type DetectionRow,
  type DetectionSort,
  type Finding,
  type FindingListQuery,
  MAX_PAGE_SIZE,
} from '@verax/shared';
import { SEVERITY_STYLES } from '@/design/severity';
import { keyPartRows, QUEUE_LABELS } from '@/features/cases/labels';
import { getFindingPage } from '@/features/findings/findings-api';
import { FINDING_SOURCE_LABELS, FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { INCIDENT_STATUS_LABELS } from '@/features/incidents/labels';
import { incidentTitle } from '@/features/incidents/narrative';
import { type CsvCell, toCsv } from '@/features/reports/csv';
import { api } from '@/lib/api';
import { toSearch } from './detections-api';

/** O CSV leva até 2 000 linhas (20 páginas da API); passou disso, avisa e pede para filtrar. */
export const EXPORT_MAX_ROWS = 2_000;

export interface ExportResult {
  csv: string;
  rows: number;
  total: number;
}

/** Lê as páginas da lista filtrada até o teto, uma por vez (a mesma API da tela, com a permissão de quem exporta). */
async function readAll<T>(
  read: (page: number) => Promise<{ items: T[]; total: number }>,
): Promise<{ items: T[]; total: number }> {
  const items: T[] = [];
  let total = 0;
  for (let page = 1; items.length < EXPORT_MAX_ROWS; page += 1) {
    const result = await read(page);
    total = result.total;
    items.push(...result.items);
    if (result.items.length < MAX_PAGE_SIZE || items.length >= total) break;
  }
  return { items: items.slice(0, EXPORT_MAX_ROWS), total };
}

const severityLabel = (severity: keyof typeof SEVERITY_STYLES) => SEVERITY_STYLES[severity].label;

/** "Incidentes": uma linha por incidente confirmado, como na tela. */
export async function exportIncidents(filters: DetectionFilters, sort: DetectionSort): Promise<ExportResult> {
  const { items, total } = await readAll((page) =>
    api.get(
      `/v1/detections?${toSearch({ ...filters, sort, kind: 'incident', page, pageSize: MAX_PAGE_SIZE })}`,
      detectionPageSchema,
    ),
  );
  const header = [
    'Tipo',
    'ID',
    'Título',
    'Severidade',
    'Status',
    'Responsável',
    'Nota de risco',
    'Alertas',
    'Primeira atividade',
    'Última atividade',
    'Contas',
    'Recursos',
  ];
  const rows = items.map((row: DetectionRow): CsvCell[] =>
    row.kind === 'incident'
      ? [
          'Incidente',
          row.incident.id,
          incidentTitle(row.incident),
          severityLabel(row.incident.severity),
          INCIDENT_STATUS_LABELS[row.incident.status].label,
          row.incident.assignee?.name ?? '',
          row.incident.riskScore,
          row.incident.findingCount,
          row.incident.firstSeenAt,
          row.incident.lastSeenAt,
          row.incident.accounts.join(', '),
          row.incident.resources.join(', '),
        ]
      : [
          'Alerta',
          row.finding.id,
          row.finding.title,
          severityLabel(row.finding.severity),
          FINDING_STATUS_LABELS[row.finding.status].label,
          '',
          '',
          1,
          row.finding.occurredAt,
          row.finding.occurredAt,
          row.finding.accountId,
          row.finding.resource ?? '',
        ],
  );
  return { csv: toCsv(header, rows), rows: rows.length, total };
}

/** "Alertas": uma linha por alerta, com o incidente em que foi confirmado (vazio se ainda não). */
export async function exportFindings(
  filters: DetectionFilters,
  extras: Pick<FindingListQuery, 'sort' | 'type'> = {},
): Promise<ExportResult> {
  // Sem "sem responsável" (só a visão de incidentes tem): a lista de alertas recusa o parâmetro.
  const { unassigned: _unassigned, ...findingFilters } = filters;
  // A ordem e o tipo (E-06), com a mesma volta da lista: o nó de antes os recusa, e o arquivo sai sem eles.
  const { items, total } = await readAll((page) =>
    getFindingPage({ ...findingFilters, ...extras, page, pageSize: MAX_PAGE_SIZE }),
  );
  const header = [
    'ID',
    'Quando',
    'Severidade',
    'Status',
    'Título',
    'Evento',
    'Fonte',
    'Conta ou agente',
    'Usuário',
    'IP de origem',
    'Recurso',
    'Táticas do MITRE',
    'Incidente',
  ];
  const rows = items.map((finding: Finding): CsvCell[] => [
    finding.id,
    finding.occurredAt,
    severityLabel(finding.severity),
    FINDING_STATUS_LABELS[finding.status].label,
    finding.title,
    finding.eventName ?? '',
    FINDING_SOURCE_LABELS[finding.source],
    finding.accountId,
    finding.actor.user ?? '',
    finding.actor.ip ?? '',
    finding.resource ?? '',
    finding.mitreTactics.join(', '),
    finding.incidentId ?? '',
  ]);
  return { csv: toCsv(header, rows), rows: rows.length, total };
}

/** "Casos" e "Vulnerabilidades": uma linha por caso da lista filtrada, com o começo das amostras (o detalhe tem todas). */
export async function exportCases(query: CaseListQuery): Promise<ExportResult> {
  const { items, total } = await readAll((page) =>
    api.get(`/v1/cases?${toSearch({ ...query, page, pageSize: MAX_PAGE_SIZE })}`, casePageSchema),
  );
  const header = [
    'ID',
    'Fila',
    'Título',
    'O que os alertas têm em comum',
    'Severidade pendente',
    'Item protegido',
    'Críticos pendentes',
    'Altos pendentes',
    'Médios pendentes',
    'Baixos pendentes',
    'Novos',
    'Em análise',
    'Legítimos',
    'Resolvidos',
    'Em incidente',
    'Alertas guardados',
    'Vezes que voltou',
    'Voltas depois de tratado',
    'Primeiro alerta',
    'Último alerta',
    'Fontes',
    'Contas',
    'Usuários',
    'IPs de origem',
    'Recursos',
    'Táticas do MITRE',
  ];
  const rows = items.map((row: CaseSummary): CsvCell[] => [
    row.id,
    QUEUE_LABELS[row.queue],
    row.title,
    keyPartRows(row.keyParts)
      .map((part) => `${part.label}: ${part.value}`)
      .join('; '),
    row.severity === null ? '' : severityLabel(row.severity),
    row.protected ? 'Sim' : 'Não',
    row.pending.critical,
    row.pending.high,
    row.pending.medium,
    row.pending.low,
    row.counts.new,
    row.counts.investigating,
    row.counts.legitimate,
    row.counts.resolved,
    row.counts.incident,
    row.counts.total,
    row.recurrence,
    row.recurrenceTreated ?? '',
    row.firstSeenAt,
    row.lastSeenAt,
    row.sources.map((source) => FINDING_SOURCE_LABELS[source]).join(', '),
    row.preview.accounts.join(', '),
    row.preview.actors.join(', '),
    row.preview.ips.join(', '),
    row.preview.resources.join(', '),
    row.mitreTactics.join(', '),
  ]);
  return { csv: toCsv(header, rows), rows: rows.length, total };
}
