import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AlertException,
  AlertExceptionCreate,
  AlertExceptionCreated,
  AlertExceptionListQuery,
  AlertExceptionRuleTitles,
  AlertExceptionOpenPreviewQuery,
  AlertExceptionUpdate,
  ExceptionCreateQuery,
  ExceptionOpenPreview,
  ExceptionOpenResolution,
  Paginated,
} from '@verax/shared';
import {
  alertExceptionComment,
  alertExceptionTarget,
  previewOpenAlerts,
  resolveOpenAlerts,
} from '../alerts/exception-open-alerts.js';
import { lockFindingsBriefly } from '../cases/triage-store.js';
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

/** Até quando o título de uma regra é procurado nos alertas do cliente (E-09). */
const RULE_TITLE_WINDOW_DAYS = 180;

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

/** Um registro na trilha para o lote inteiro, com as contagens. */
function openAudit(id: string, resolution: ExceptionOpenResolution) {
  return {
    action: 'alert_exception.resolve_open',
    resourceType: 'alert_exception',
    resourceId: id,
    after: { exceptionId: id, ...resolution },
  };
}

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

  /**
   * O título de cada regra pedida: o do alerta mais recente dela no cliente da sessão, nos últimos 180 dias (a descrição
   * da regra do Wazuh). Uma consulta por regra, com o limite de cima da página (50), cada uma parando no primeiro achado
   * pelo índice da data; a regra sem alerta na janela fica fora da resposta.
   */
  async ruleTitles(ruleIds: readonly string[]): Promise<AlertExceptionRuleTitles> {
    const since = new Date(Date.now() - RULE_TITLE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const db = this.prisma.scoped();
    const unique = [...new Set(ruleIds)];
    const found = await Promise.all(
      unique.map(async (ruleId) => {
        const row = await db.finding.findFirst({
          where: { ruleId, occurredAt: { gte: since } },
          orderBy: { occurredAt: 'desc' },
          select: { title: true },
        });
        const title = row?.title.trim() ?? '';
        return title === '' ? [] : [{ ruleId, title }];
      }),
    );
    return { items: found.flat() };
  }

  async get(id: string): Promise<AlertException> {
    return toException(await this.find(id));
  }

  /**
   * "Vai resolver N alertas em aberto (M em incidentes ficam)": os alertas em aberto que a exceção resolveria se fosse
   * criada agora, pela mesma regra da chegada. Só leitura.
   */
  async previewOpen(query: AlertExceptionOpenPreviewQuery): Promise<ExceptionOpenPreview> {
    const now = new Date();
    return previewOpenAlerts(
      this.prisma.scoped(),
      alertExceptionTarget({ id: '', ...query, expiresAt: null }),
      now,
    );
  }

  /**
   * Cria a exceção e resolve os alertas em aberto que ela cobre (decisão do dono de 26/11/2026), na mesma transação. A
   * contagem só vai na resposta para quem a pede (`openAlerts=true`): a resposta de sempre é estrita no painel de antes.
   */
  async create(
    auth: RequestAuth,
    input: AlertExceptionCreate,
    query: ExceptionCreateQuery = {},
  ): Promise<AlertException | AlertExceptionCreated> {
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
    const settled = await this.resolveOpen(auth, row, new Date());
    const exception = toException(settled.row);
    this.audit.describe({
      action: 'alert_exception.create',
      resourceType: 'alert_exception',
      resourceId: exception.id,
      after: exception,
    });
    if (settled.resolution.resolved > 0 || settled.resolution.keptInIncident > 0) {
      this.audit.also(openAudit(exception.id, settled.resolution));
    }
    return query.openAlerts === 'true' ? { ...exception, openAlerts: settled.resolution } : exception;
  }

  /**
   * "Resolver os próximos": a criação parou no teto da requisição, e esta resolve mais um tanto, pela mesma regra. Só a
   * exceção em vigor. Rodar de novo sem nada em aberto não muda nada.
   */
  async resolveOpenAgain(auth: RequestAuth, id: string): Promise<ExceptionOpenResolution> {
    const row = await this.find(id);
    if (!toException(row).active) {
      throw new ApiError(HttpStatus.CONFLICT, 'Esta exceção não está mais em vigor');
    }
    const { resolution } = await this.resolveOpen(auth, row, new Date());
    this.audit.describe(openAudit(id, resolution));
    return resolution;
  }

  /** Os alertas em aberto que a exceção cobre viram legítimos, e a contagem dela sobe com eles. */
  private async resolveOpen(
    auth: RequestAuth,
    row: ExceptionRow,
    now: Date,
  ): Promise<{ row: ExceptionRow; resolution: ExceptionOpenResolution }> {
    const db = this.prisma.scoped();
    const resolution = await resolveOpenAlerts(db, alertExceptionTarget(row), {
      now,
      comment: { authorId: auth.userId, body: alertExceptionComment(row, row.createdBy.name) },
      lock: () => lockFindingsBriefly(this.prisma.db(), this.prisma.scopeTenantId()),
    });
    if (resolution.resolved === 0) return { row, resolution };
    const updated = await db.alertException.update({
      where: { id: row.id },
      data: { matchedCount: { increment: resolution.resolved }, lastMatchedAt: now },
      select: exceptionSelect,
    });
    return { row: updated, resolution };
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
