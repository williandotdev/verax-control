import { HttpStatus, Injectable } from '@nestjs/common';
import {
  compareDetections,
  type DetectionFilters,
  type DetectionListQuery,
  type DetectionRow,
  type DetectionSort,
  type DetectionSortKey,
  filterWindow,
  hasContentFilter,
  INCIDENT_STATUS_OF_FILTER,
  type Paginated,
} from '@verax/shared';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { findingContentWhere, findingWhere } from '../findings/finding-filters.js';
import { findingSelect, toFinding } from '../findings/findings.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { incidentSelect, toIncident } from '../incidents/incidents.service.js';

/**
 * Até onde a lista pagina: a página e o tamanho dela não passam das 5 000 primeiras linhas. Cada página lê as chaves de
 * ordenação das `página × tamanho` primeiras linhas de cada tabela; mais fundo que isso, a leitura cresce sem servir a
 * ninguém (são 50 páginas de 100). Quem precisa ir além refina os filtros.
 */
export const MAX_DETECTION_DEPTH = 5_000;

/** Código da recusa (400) da página além de `MAX_DETECTION_DEPTH`. */
export const DETECTION_PAGE_OUT_OF_RANGE_CODE = 'DETECTION_PAGE_OUT_OF_RANGE';

/**
 * A ordem do banco igual à de `compareDetections`: a severidade primeiro, quando pedida (o enum do Prisma é declarado
 * `critical, high, medium, low`, então `asc` é a mais grave primeiro), depois a mais recente e o id decrescente (o uuid
 * do Postgres ordena pelos bytes, a mesma ordem do texto em minúsculas que o desempate compara).
 */
function incidentOrder(sort: DetectionSort): Prisma.IncidentOrderByWithRelationInput[] {
  return [
    ...(sort === 'severity' ? [{ severity: 'asc' as const }] : []),
    { lastSeenAt: 'desc' },
    { id: 'desc' },
  ];
}

function findingOrder(sort: DetectionSort): Prisma.FindingOrderByWithRelationInput[] {
  return [
    ...(sort === 'severity' ? [{ severity: 'asc' as const }] : []),
    { occurredAt: 'desc' },
    { id: 'desc' },
  ];
}

type RowKey = DetectionSortKey & { kind: DetectionRow['kind'] };

/**
 * Os incidentes que entram na lista, com a regra de `incidentMatchesFilters`; `null` quando nenhum entra (o status
 * "legítimo" é só de achado). Os filtros de conteúdo valem por pelo menos um achado do incidente.
 *
 * O `scoped()` só acrescenta o `tenantId` ao `where` de cima, o do incidente: o filtro aninhado (`findings.some`) e a
 * contagem filtrada (`_count`) seguem a relação a partir de um incidente do próprio cliente. Um achado só aponta para
 * incidente do mesmo cliente (gatilho `Finding_incident_same_tenant` da migration de incidentes), então a relação nunca
 * alcança achado de outro cliente.
 */
export function incidentWhere(filters: DetectionFilters, now: Date): Prisma.IncidentWhereInput | null {
  const status = filters.status === undefined ? undefined : INCIDENT_STATUS_OF_FILTER[filters.status];
  if (status === null) return null;
  const window = filterWindow(filters, now);
  return {
    ...(filters.severity !== undefined && { severity: filters.severity }),
    ...(status !== undefined && { status }),
    ...(filters.unassigned !== undefined && { assigneeId: null }),
    // Ativo em algum momento da janela: o último achado depois do começo, o primeiro antes do fim.
    ...(window.from !== null && { lastSeenAt: { gte: window.from } }),
    ...(window.to !== null && { firstSeenAt: { lte: window.to } }),
    ...(hasContentFilter(filters) && { findings: { some: findingContentWhere(filters) } }),
  };
}

/** Os achados avulsos (fora de incidente) que entram; `null` com "sem responsável", que só incidente tem. */
export function standaloneFindingWhere(
  filters: DetectionFilters,
  now: Date,
): Prisma.FindingWhereInput | null {
  if (filters.unassigned !== undefined) return null;
  return { ...findingWhere(filters, now), incidentId: null };
}

/**
 * Tela Detecções, visão agrupada (`GET /v1/detections`): os incidentes e os achados que não entraram em nenhum incidente
 * do cliente da sessão, numa ordem só e paginados aqui. As regras de filtro e de ordem são as funções puras do
 * `@verax/shared`, escritas como `where` e `orderBy` do Prisma.
 *
 * A paginação junta as duas tabelas sem SQL à mão: para a página `p` de tamanho `t`, lê só as chaves de ordenação
 * (severidade, data e id) das `p × t` primeiras linhas de cada tabela, na ordem do banco igual à de
 * `compareDetections`; junta, ordena com a mesma função, corta a página e só então busca as linhas inteiras dos ids
 * dela. As `p × t` primeiras da lista junta estão sempre entre as `p × t` primeiras de cada tabela.
 */
@Injectable()
export class DetectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: DetectionListQuery, now = new Date()): Promise<Paginated<DetectionRow>> {
    const depth = query.page * query.pageSize;
    if (depth > MAX_DETECTION_DEPTH) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'Página fora do alcance: refine os filtros',
        DETECTION_PAGE_OUT_OF_RANGE_CODE,
      );
    }
    const sort = query.sort ?? 'recent';
    const incidents = incidentWhere(query, now);
    const findings = standaloneFindingWhere(query, now);
    const db = this.prisma.scoped();

    const [incidentKeys, findingKeys, incidentTotal, findingTotal] = await Promise.all([
      incidents === null
        ? []
        : db.incident.findMany({
            where: incidents,
            select: { id: true, severity: true, lastSeenAt: true },
            orderBy: incidentOrder(sort),
            take: depth,
          }),
      findings === null
        ? []
        : db.finding.findMany({
            where: findings,
            select: { id: true, severity: true, occurredAt: true },
            orderBy: findingOrder(sort),
            take: depth,
          }),
      incidents === null ? 0 : db.incident.count({ where: incidents }),
      findings === null ? 0 : db.finding.count({ where: findings }),
    ]);

    const keys: RowKey[] = [
      ...incidentKeys.map((row) => ({
        kind: 'incident' as const,
        id: row.id,
        severity: row.severity,
        at: row.lastSeenAt.toISOString(),
      })),
      ...findingKeys.map((row) => ({
        kind: 'finding' as const,
        id: row.id,
        severity: row.severity,
        at: row.occurredAt.toISOString(),
      })),
    ];
    keys.sort((a, b) => compareDetections(sort, a, b));
    const page = keys.slice(depth - query.pageSize, depth);

    const items = await this.rowsOf(db, page, query);
    return toPaginated(items, incidentTotal + findingTotal, query);
  }

  /** As linhas inteiras dos ids da página, na ordem dela. */
  private async rowsOf(
    db: Prisma.TransactionClient,
    page: readonly RowKey[],
    filters: DetectionFilters,
  ): Promise<DetectionRow[]> {
    const incidentIds = page.filter((key) => key.kind === 'incident').map((key) => key.id);
    const findingIds = page.filter((key) => key.kind === 'finding').map((key) => key.id);
    const [incidentRows, findingRows] = await Promise.all([
      incidentIds.length === 0
        ? []
        : db.incident.findMany({
            where: { id: { in: incidentIds } },
            select: {
              ...incidentSelect,
              // Quantos achados do incidente batem com os filtros de conteúdo (sem nenhum, todos).
              _count: { select: { findings: { where: findingContentWhere(filters) } } },
            },
          }),
      findingIds.length === 0
        ? []
        : db.finding.findMany({ where: { id: { in: findingIds } }, select: findingSelect }),
    ]);
    const incidentsById = new Map(incidentRows.map((row) => [row.id, row]));
    const findingsById = new Map(findingRows.map((row) => [row.id, row]));
    const rows: DetectionRow[] = [];
    // Uma linha apagada entre as duas leituras (expurgo) só sai da página.
    for (const key of page) {
      if (key.kind === 'incident') {
        const row = incidentsById.get(key.id);
        if (row) {
          rows.push({ kind: 'incident', incident: toIncident(row), matchedFindings: row._count.findings });
        }
      } else {
        const row = findingsById.get(key.id);
        if (row) rows.push({ kind: 'finding', finding: toFinding(row) });
      }
    }
    return rows;
  }
}
