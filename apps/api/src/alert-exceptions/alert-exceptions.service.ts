import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AlertException,
  AlertExceptionCreate,
  AlertExceptionListQuery,
  AlertExceptionUpdate,
  Paginated,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

const exceptionSelect = {
  id: true,
  ruleId: true,
  field: true,
  value: true,
  reason: true,
  expiresAt: true,
  matchedCount: true,
  lastMatchedAt: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AlertExceptionSelect;

type ExceptionRow = Prisma.AlertExceptionGetPayload<{ select: typeof exceptionSelect }>;

function toException(row: ExceptionRow, now = new Date()): AlertException {
  return {
    ...row,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    active: row.expiresAt === null || row.expiresAt > now,
    lastMatchedAt: row.lastMatchedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDate(value: string | null | undefined): Date | null | undefined {
  return value === undefined ? undefined : value === null ? null : new Date(value);
}

const NOT_FOUND = 'Exceção não encontrada';

/** Exceções de alerta do cliente da sessão (T3.5). Toda alteração vai para a auditoria. */
@Injectable()
export class AlertExceptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async list(query: AlertExceptionListQuery): Promise<Paginated<AlertException>> {
    const now = new Date();
    const where: Prisma.AlertExceptionWhereInput = {
      ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      ...(query.active === 'true' ? { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } : {}),
      ...(query.active === 'false' ? { expiresAt: { lte: now } } : {}),
    };
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.alertException.findMany({
        where,
        select: exceptionSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      db.alertException.count({ where }),
    ]);
    return toPaginated(
      rows.map((row) => toException(row, now)),
      total,
      query,
    );
  }

  async get(id: string): Promise<AlertException> {
    return toException(await this.find(id));
  }

  async create(auth: RequestAuth, input: AlertExceptionCreate): Promise<AlertException> {
    let row: ExceptionRow;
    try {
      row = await this.prisma.scoped().alertException.create({
        data: {
          ruleId: input.ruleId,
          field: input.field,
          value: input.value,
          reason: input.reason,
          expiresAt: toDate(input.expiresAt) ?? null,
          // O autor vem da sessão, nunca do corpo.
          createdById: auth.userId,
        } as Prisma.AlertExceptionUncheckedCreateInput,
        select: exceptionSelect,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ApiError(HttpStatus.CONFLICT, 'Já existe uma exceção para esta regra e este valor');
      }
      throw error;
    }
    const exception = toException(row);
    this.audit.describe({
      action: 'alert_exception.create',
      resourceType: 'alert_exception',
      resourceId: exception.id,
      after: exception,
    });
    return exception;
  }

  async update(id: string, input: AlertExceptionUpdate): Promise<AlertException> {
    const before = toException(await this.find(id));
    const after = toException(
      await this.prisma.scoped().alertException.update({
        where: { id },
        data: { reason: input.reason, expiresAt: toDate(input.expiresAt) },
        select: exceptionSelect,
      }),
    );
    this.audit.describe({
      action: 'alert_exception.update',
      resourceType: 'alert_exception',
      resourceId: id,
      before,
      after,
    });
    return after;
  }

  /** Remove a exceção; ela inteira fica na auditoria como estado anterior. */
  async remove(id: string): Promise<void> {
    const before = toException(await this.find(id));
    await this.prisma.scoped().alertException.delete({ where: { id } });
    this.audit.describe({
      action: 'alert_exception.delete',
      resourceType: 'alert_exception',
      resourceId: id,
      before,
    });
  }

  private async find(id: string): Promise<ExceptionRow> {
    const row = await this.prisma
      .scoped()
      .alertException.findUnique({ where: { id }, select: exceptionSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return row;
  }
}
