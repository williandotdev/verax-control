import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuditEntry, AuditEntryDetail, AuditListQuery, AuditPeriod, Paginated } from '@verax/shared';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma, UserRole } from '../generated/prisma/client.js';

const PERIOD_HOURS: Readonly<Record<AuditPeriod, number>> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };

const entrySelect = {
  id: true,
  occurredAt: true,
  actorType: true,
  actorId: true,
  action: true,
  resourceType: true,
  resourceId: true,
  outcome: true,
  statusCode: true,
  ip: true,
  requestId: true,
} as const satisfies Prisma.AuditLogSelect;

const detailSelect = {
  ...entrySelect,
  userAgent: true,
  before: true,
  after: true,
} as const satisfies Prisma.AuditLogSelect;

type EntryRow = Prisma.AuditLogGetPayload<{ select: typeof entrySelect }>;
type Actor = { id: string; name: string; role: UserRole };

/** Quem lê a trilha: o papel e o cliente da sessão. */
type Viewer = Pick<RequestAuth, 'role' | 'scopeTenantId'>;

function toEntry(row: EntryRow, actors: ReadonlyMap<string, Actor>, viewer: Viewer): AuditEntry {
  const user = row.actorType === 'user' && row.actorId !== null ? actors.get(row.actorId) : undefined;
  const verax = user?.role === 'admin_verax';
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actor: { type: row.actorType, id: user?.id ?? null, name: user?.name ?? null, verax },
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    outcome: row.outcome,
    statusCode: row.statusCode,
    // O cliente vê o que a equipe da Verax fez na trilha dele, mas não de onde (IP) nem com que navegador.
    ip: verax && viewer.role !== 'admin_verax' ? null : row.ip,
    requestId: row.requestId,
  };
}

/**
 * Trilha de auditoria para leitura (tela Auditoria). Só lê: a gravação é do `AuditService`, e o banco recusa
 * alteração e exclusão.
 */
@Injectable()
export class AuditTrailService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A trilha que a sessão alcança. Com cliente (o próprio, ou o escolhido pelo admin_verax), a desse cliente, pelo
   * escopo de sempre. O admin_verax sem cliente escolhido vê a da própria Verax: os registros sem cliente.
   */
  private trail(viewer: Viewer): { db: Prisma.TransactionClient; where: Prisma.AuditLogWhereInput } {
    if (viewer.role === 'admin_verax' && viewer.scopeTenantId === null) {
      return { db: this.prisma.db(), where: { tenantId: null } };
    }
    return { db: this.prisma.scoped(), where: {} };
  }

  /**
   * Nome e papel de quem agiu, só pelos ids da página já filtrada. Para quem é de cliente, só pessoas do próprio
   * cliente ou da equipe da Verax: nenhum nome de outro cliente sai daqui, mesmo que um registro o citasse.
   */
  private async actors(rows: readonly EntryRow[], viewer: Viewer): Promise<Map<string, Actor>> {
    const ids = [
      ...new Set(rows.flatMap((row) => (row.actorType === 'user' && row.actorId ? [row.actorId] : []))),
    ];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.db().user.findMany({
      where: {
        id: { in: ids },
        ...(viewer.role !== 'admin_verax' && {
          OR: [{ tenantId: viewer.scopeTenantId }, { role: 'admin_verax' }],
        }),
      },
      select: { id: true, name: true, role: true },
    });
    return new Map(users.map((user) => [user.id, user]));
  }

  async list(viewer: Viewer, query: AuditListQuery, now = new Date()): Promise<Paginated<AuditEntry>> {
    const trail = this.trail(viewer);
    const where: Prisma.AuditLogWhereInput = {
      ...trail.where,
      ...(query.outcome && { outcome: query.outcome }),
      ...(query.resourceType && { resourceType: query.resourceType }),
      ...(query.actorId && { actorType: 'user', actorId: query.actorId }),
      ...(query.period && {
        occurredAt: { gte: new Date(now.getTime() - PERIOD_HOURS[query.period] * 3_600_000) },
      }),
    };
    const [rows, total] = await Promise.all([
      trail.db.auditLog.findMany({
        where,
        select: entrySelect,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...toPrismaPage(query),
      }),
      trail.db.auditLog.count({ where }),
    ]);
    const actors = await this.actors(rows, viewer);
    return toPaginated(
      rows.map((row) => toEntry(row, actors, viewer)),
      total,
      query,
    );
  }

  async get(viewer: Viewer, id: string): Promise<AuditEntryDetail> {
    const trail = this.trail(viewer);
    const row = await trail.db.auditLog.findFirst({ where: { ...trail.where, id }, select: detailSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'Registro de auditoria não encontrado');
    const entry = toEntry(row, await this.actors([row], viewer), viewer);
    return {
      ...entry,
      userAgent: entry.actor.verax && viewer.role !== 'admin_verax' ? null : row.userAgent,
      // Gravados já sem senha, token ou segredo (a mesma limpeza dos logs, na gravação).
      before: (row.before ?? null) as AuditEntryDetail['before'],
      after: (row.after ?? null) as AuditEntryDetail['after'],
    };
  }
}
