import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  Paginated,
  ProtectedResource,
  ProtectedResourceCreate,
  ProtectedResourceListQuery,
  ProtectedResourceUpdate,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

const itemSelect = {
  id: true,
  type: true,
  identifier: true,
  reason: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ProtectedResourceSelect;

type ItemRow = Prisma.ProtectedResourceGetPayload<{ select: typeof itemSelect }>;

function toItem(row: ItemRow): ProtectedResource {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

const NOT_FOUND = 'Item não encontrado na lista de proteção';

/** Lista de proteção do cliente da sessão (T3.4). Toda alteração vai para a auditoria. */
@Injectable()
export class ProtectedResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async list(query: ProtectedResourceListQuery): Promise<Paginated<ProtectedResource>> {
    const where: Prisma.ProtectedResourceWhereInput = query.type ? { type: query.type } : {};
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.protectedResource.findMany({
        where,
        select: itemSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      db.protectedResource.count({ where }),
    ]);
    return toPaginated(rows.map(toItem), total, query);
  }

  async get(id: string): Promise<ProtectedResource> {
    return toItem(await this.find(id));
  }

  async create(auth: RequestAuth, input: ProtectedResourceCreate): Promise<ProtectedResource> {
    let row: ItemRow;
    try {
      row = await this.prisma.scoped().protectedResource.create({
        data: {
          type: input.type,
          identifier: input.identifier,
          reason: input.reason,
          // Quem incluiu vem da sessão, nunca do corpo.
          createdById: auth.userId,
        } as Prisma.ProtectedResourceUncheckedCreateInput,
        select: itemSelect,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ApiError(HttpStatus.CONFLICT, 'Este item já está na lista de proteção');
      }
      throw error;
    }
    const item = toItem(row);
    this.audit.describe({
      action: 'protected_resource.create',
      resourceType: 'protected_resource',
      resourceId: item.id,
      after: item,
    });
    return item;
  }

  async update(id: string, input: ProtectedResourceUpdate): Promise<ProtectedResource> {
    const before = toItem(await this.find(id));
    const after = toItem(
      await this.prisma
        .scoped()
        .protectedResource.update({ where: { id }, data: { reason: input.reason }, select: itemSelect }),
    );
    this.audit.describe({
      action: 'protected_resource.update',
      resourceType: 'protected_resource',
      resourceId: id,
      before,
      after,
    });
    return after;
  }

  /** Remove da lista; o item inteiro fica na auditoria como estado anterior. */
  async remove(id: string): Promise<void> {
    const before = toItem(await this.find(id));
    await this.prisma.scoped().protectedResource.delete({ where: { id } });
    this.audit.describe({
      action: 'protected_resource.delete',
      resourceType: 'protected_resource',
      resourceId: id,
      before,
    });
  }

  private async find(id: string): Promise<ItemRow> {
    const row = await this.prisma
      .scoped()
      .protectedResource.findUnique({ where: { id }, select: itemSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return row;
  }
}
