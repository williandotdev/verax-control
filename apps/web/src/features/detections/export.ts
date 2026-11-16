import {
  type DetectionFilters,
  detectionPageSchema,
  type DetectionRow,
  type DetectionSort,
  type Finding,
  findingSchema,
  MAX_PAGE_SIZE,
  paginatedSchema,
} from '@verax/shared';
import { SEVERITY_STYLES } from '@/design/severity';
import { FINDING_SOURCE_LABELS, FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { INCIDENT_STATUS_LABELS } from '@/features/incidents/labels';
import { incidentTitle } from '@/features/incidents/narrative';
import { type CsvCell, toCsv } from '@/features/reports/csv';
import { api } from '@/lib/api';
import { toSearch } from './detections-api';

/** O CSV leva até 2 000 linhas (20 páginas da API); passou disso, avisa e pede para filtrar. */
export const EXPORT_MAX_ROWS = 2_000;

const findingPageSchema = paginatedSchema(findingSchema);

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

/** "Agrupar por incidente": uma linha por incidente e por achado fora de incidente, como na tela. */
export async function exportGrouped(filters: DetectionFilters, sort: DetectionSort): Promise<ExportResult> {
  const { items, total } = await readAll((page) =>
    api.get(
      `/v1/detections?${toSearch({ ...filters, sort, page, pageSize: MAX_PAGE_SIZE })}`,
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
    'Achados',
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
          'Achado',
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

/** "Todos os achados": uma linha por achado, com o incidente. */
export async function exportFindings(filters: DetectionFilters): Promise<ExportResult> {
  // Sem "sem responsável" (só a visão agrupada tem): a lista de achados recusa o parâmetro.
  const { unassigned: _unassigned, ...findingFilters } = filters;
  const { items, total } = await readAll((page) =>
    api.get(
      `/v1/findings?${toSearch({ ...findingFilters, page, pageSize: MAX_PAGE_SIZE })}`,
      findingPageSchema,
    ),
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
