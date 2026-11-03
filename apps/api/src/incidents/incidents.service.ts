import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  Author,
  Incident,
  IncidentDetail,
  IncidentListQuery,
  IncidentUpdate,
  Paginated,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { findingSelect, toFinding } from '../findings/findings.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/** A linha do tempo do detalhe mostra até 500 achados, o limite do contrato: os mais recentes. */
const MAX_TIMELINE = 500;

const incidentSelect = {
  id: true,
  severity: true,
  status: true,
  riskScore: true,
  findingCount: true,
  firstSeenAt: true,
  lastSeenAt: true,
  keys: true,
  accounts: true,
  resources: true,
  mitreTactics: true,
  assigneeId: true,
  assignee: { select: { id: true, name: true } },
} as const satisfies Prisma.IncidentSelect;

const detailSelect = {
  ...incidentSelect,
  mitreTechniques: true,
  findings: {
    select: findingSelect,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: MAX_TIMELINE,
  },
} as const satisfies Prisma.IncidentSelect;

type IncidentRow = Prisma.IncidentGetPayload<{ select: typeof incidentSelect }>;
type DetailRow = Prisma.IncidentGetPayload<{ select: typeof detailSelect }>;

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    severity: row.severity,
    status: row.status,
    riskScore: row.riskScore,
    findingCount: row.findingCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    keys: row.keys,
    accounts: row.accounts,
    resources: row.resources,
    mitreTactics: row.mitreTactics,
    assignee: row.assignee,
  };
}

const NOT_FOUND = 'Incidente não encontrado';

/** Quem pode ser responsável: usuários ativos do cliente que operam incidentes e a equipe da Verax. */
const CLIENT_OPERATORS = ['admin_cliente', 'analista_cliente'] as const;

/**
 * Incidentes do cliente da sessão (T5.7): lista pela nota de risco, detalhe com a linha do tempo dos achados,
 * status e responsável. Os incidentes são abertos e alimentados pelo sync (T5.6); pela API, só o trabalho humano
 * muda, e tudo é auditado.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async list(query: IncidentListQuery): Promise<Paginated<Incident>> {
    const where: Prisma.IncidentWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.severity && { severity: query.severity }),
      ...(query.unassigned && { assigneeId: null }),
    };
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.incident.findMany({
        where,
        select: incidentSelect,
        orderBy: [{ riskScore: 'desc' }, { lastSeenAt: 'desc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      db.incident.count({ where }),
    ]);
    return toPaginated(rows.map(toIncident), total, query);
  }

  async get(id: string): Promise<IncidentDetail> {
    const row = await this.find(id);
    return {
      ...toIncident(row),
      mitreTechniques: row.mitreTechniques,
      // Buscados do mais recente para trás (o limite nunca esconde o último), mostrados do mais antigo ao recente.
      findings: row.findings.map(toFinding).reverse(),
    };
  }

  async assignees(auth: RequestAuth): Promise<{ items: Author[] }> {
    const items = await this.prisma.db().user.findMany({
      where: {
        status: 'active',
        OR: [
          { tenantId: auth.scopeTenantId as string, role: { in: [...CLIENT_OPERATORS] } },
          { role: 'admin_verax' },
        ],
      },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return { items };
  }

  async update(auth: RequestAuth, id: string, input: IncidentUpdate): Promise<IncidentDetail> {
    const before = await this.find(id);
    if (input.assigneeId) {
      const allowed = await this.assignees(auth);
      if (!allowed.items.some((user) => user.id === input.assigneeId)) {
        throw new ApiError(HttpStatus.BAD_REQUEST, 'Responsável inválido para este cliente');
      }
    }
    const resolving = input.status === 'resolved' && before.status !== 'resolved';
    const reopening =
      input.status !== undefined && input.status !== 'resolved' && before.status === 'resolved';
    await this.prisma.scoped().incident.update({
      where: { id },
      data: {
        ...(input.status && { status: input.status }),
        ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
        ...(resolving && { resolvedAt: new Date() }),
        ...(reopening && { resolvedAt: null }),
      },
      select: { id: true },
    });
    const after = await this.find(id);
    this.audit.describe({
      action: 'incident.update',
      resourceType: 'incident',
      resourceId: id,
      before: { status: before.status, assigneeId: before.assigneeId },
      after: { status: after.status, assigneeId: after.assigneeId },
    });
    return this.get(id);
  }

  private async find(id: string): Promise<DetailRow> {
    const row = await this.prisma.scoped().incident.findUnique({ where: { id }, select: detailSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return row;
  }
}
