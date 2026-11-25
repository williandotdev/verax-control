import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import {
  ALERT_EXCEPTION_VALUE_MAX,
  type AlertExceptionBatch,
  type AlertExceptionBatchResult,
  canWriteScopedExceptions,
  type CaseExceptionDraft,
  type FindingSeverity,
  MAX_ACTIVE_SCOPED_EXCEPTIONS,
  MAX_ALERT_EXCEPTIONS_PER_REQUEST,
  type Paginated,
  SCOPED_EXCEPTION_MAX_DAYS,
  SCOPED_EXCEPTION_PREVIEW_DAYS,
  SCOPED_EXCEPTION_SEVERITIES,
  type ScopedException,
  type ScopedExceptionCreateParsed,
  type ScopedExceptionListQuery,
  type ScopedExceptionPreview,
  type ScopedExceptionPreviewQuery,
  type ScopedExceptionSeverity,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const exceptionSelect = {
  id: true,
  ruleId: true,
  logSource: true,
  accountId: true,
  eventName: true,
  resourcePrefix: true,
  maxSeverity: true,
  reason: true,
  expiresAt: true,
  matchedCount: true,
  lastMatchedAt: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
  revokedAt: true,
  revokedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.ScopedExceptionSelect;

type ExceptionRow = Prisma.ScopedExceptionGetPayload<{ select: typeof exceptionSelect }>;

function toException(row: ExceptionRow, now = new Date()): ScopedException {
  return {
    ...row,
    // O CHECK do banco nunca deixa crítico; o tipo do Prisma é o enum inteiro.
    maxSeverity: row.maxSeverity as ScopedExceptionSeverity,
    expiresAt: row.expiresAt.toISOString(),
    active: row.revokedAt === null && row.expiresAt > now,
    lastMatchedAt: row.lastMatchedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

const NOT_FOUND = 'Exceção não encontrada';
const CASE_NOT_FOUND = 'Caso não encontrado';
const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * O prefixo como texto no `LIKE` que o Prisma monta para `startsWith`: ele não escapa `%` nem `_` (o teste de integração
 * confere), e um nome de repositório do ECR com `_` viraria curinga. O escape é o padrão do Postgres, a barra invertida.
 */
function likeLiteral(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** As severidades que a exceção marca: até a máxima, nunca crítico. */
function severitiesUpTo(max: ScopedExceptionSeverity): ScopedExceptionSeverity[] {
  return SCOPED_EXCEPTION_SEVERITIES.slice(0, SCOPED_EXCEPTION_SEVERITIES.indexOf(max) + 1);
}

/** Só os administradores (D8). Sem permissão nova no `/v1/me`: a recusa é 403, e a escrita recusada vai para a trilha. */
function assertAdmin(auth: RequestAuth): void {
  if (!canWriteScopedExceptions(auth.role)) throw new ForbiddenException();
}

/**
 * Exceções a partir de um caso (casos, PR-9), no cliente da sessão: as amplas (prévia, criar, listar, revogar), o que é
 * constante num caso e as de usuário, IP ou recurso em lote. Toda escrita vai para a auditoria.
 */
@Injectable()
export class ScopedExceptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async list(query: ScopedExceptionListQuery): Promise<Paginated<ScopedException>> {
    const now = new Date();
    const active = { revokedAt: null, expiresAt: { gt: now } } satisfies Prisma.ScopedExceptionWhereInput;
    const where: Prisma.ScopedExceptionWhereInput =
      query.active === 'true'
        ? active
        : query.active === 'false'
          ? { OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] }
          : {};
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.scopedException.findMany({
        where,
        select: exceptionSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      db.scopedException.count({ where }),
    ]);
    return toPaginated(
      rows.map((row) => toException(row, now)),
      total,
      query,
    );
  }

  /** "Teria coberto N alertas nos últimos 30 dias, M altos": os alertas que chegaram na janela e que ela marcaria. */
  async preview(auth: RequestAuth, target: ScopedExceptionPreviewQuery): Promise<ScopedExceptionPreview> {
    assertAdmin(auth);
    const since = new Date(Date.now() - SCOPED_EXCEPTION_PREVIEW_DAYS * DAY_MS);
    const where: Prisma.FindingWhereInput = {
      ruleId: target.ruleId,
      logSource: target.logSource,
      accountId: target.accountId,
      createdAt: { gte: since },
      severity: { in: severitiesUpTo(target.maxSeverity) },
      ...(target.eventName !== undefined && { eventName: target.eventName }),
      ...(target.resourcePrefix !== undefined && {
        resource: { startsWith: likeLiteral(target.resourcePrefix) },
      }),
    };
    const db = this.prisma.scoped();
    const [matched, high] = await Promise.all([
      db.finding.count({ where }),
      target.maxSeverity === 'high' ? db.finding.count({ where: { ...where, severity: 'high' } }) : 0,
    ]);
    return { days: SCOPED_EXCEPTION_PREVIEW_DAYS, matched, high };
  }

  async create(auth: RequestAuth, input: ScopedExceptionCreateParsed): Promise<ScopedException> {
    assertAdmin(auth);
    const now = new Date();
    const expiresAt = new Date(input.expiresAt);
    // De novo, com o relógio de agora: o CHECK do banco conta os 90 dias desde a criação.
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + SCOPED_EXCEPTION_MAX_DAYS * DAY_MS) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        `A validade precisa estar em até ${SCOPED_EXCEPTION_MAX_DAYS} dias`,
      );
    }
    const db = this.prisma.scoped();
    const active = await db.scopedException.count({ where: { revokedAt: null, expiresAt: { gt: now } } });
    if (active >= MAX_ACTIVE_SCOPED_EXCEPTIONS) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        `O cliente já tem ${MAX_ACTIVE_SCOPED_EXCEPTIONS} exceções amplas em vigor; revogue alguma antes`,
      );
    }
    const row = await db.scopedException.create({
      data: {
        ruleId: input.ruleId,
        logSource: input.logSource,
        accountId: input.accountId,
        eventName: input.eventName ?? null,
        resourcePrefix: input.resourcePrefix ?? null,
        maxSeverity: input.maxSeverity,
        reason: input.reason,
        expiresAt,
        createdAt: now,
        // O autor vem da sessão, nunca do corpo.
        createdById: auth.userId,
      } as Prisma.ScopedExceptionUncheckedCreateInput,
      select: exceptionSelect,
    });
    const exception = toException(row, now);
    this.audit.describe({
      action: 'alert_exception.scoped_create',
      resourceType: 'alert_exception',
      resourceId: exception.id,
      after: exception,
    });
    return exception;
  }

  /** Revogar não apaga: a exceção para de valer na hora e fica listada, com quem revogou. */
  async revoke(auth: RequestAuth, id: string): Promise<ScopedException> {
    assertAdmin(auth);
    const db = this.prisma.scoped();
    const current = await db.scopedException.findUnique({ where: { id }, select: exceptionSelect });
    if (!current) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    if (current.revokedAt !== null) throw new ApiError(HttpStatus.CONFLICT, 'Esta exceção já foi revogada');
    const now = new Date();
    const before = toException(current, now);
    const after = toException(
      await db.scopedException.update({
        where: { id },
        data: { revokedAt: now, revokedById: auth.userId },
        select: exceptionSelect,
      }),
      now,
    );
    this.audit.describe({
      action: 'alert_exception.scoped_revoke',
      resourceType: 'alert_exception',
      resourceId: id,
      before,
      after,
    });
    return after;
  }

  /**
   * O que é constante nos alertas de um caso: as combinações de regra, fonte, conta e evento, e os valores de usuário, IP
   * e recurso, até o teto de cada um. Caso de outro cliente: 404, como o que não existe.
   */
  async draft(caseId: string): Promise<CaseExceptionDraft> {
    const db = this.prisma.scoped();
    await this.assertCase(caseId);
    const where = { caseId } satisfies Prisma.FindingWhereInput;
    const cap = MAX_ALERT_EXCEPTIONS_PER_REQUEST;
    const [groups, users, ips, resources] = await Promise.all([
      db.finding.groupBy({
        by: ['ruleId', 'logSource', 'accountId', 'eventName', 'severity'],
        where,
        _count: { _all: true },
        orderBy: [{ ruleId: 'asc' }, { logSource: 'asc' }, { accountId: 'asc' }, { eventName: 'asc' }],
        take: cap * 4 + 1,
      }),
      db.finding.groupBy({
        by: ['actorUser'],
        where: { ...where, actorUser: { not: null } },
        orderBy: { actorUser: 'asc' },
        take: cap + 1,
      }),
      db.finding.groupBy({
        by: ['sourceIp'],
        where: { ...where, sourceIp: { not: null } },
        orderBy: { sourceIp: 'asc' },
        take: cap + 1,
      }),
      db.finding.groupBy({
        by: ['resource'],
        where: { ...where, resource: { not: null } },
        orderBy: { resource: 'asc' },
        take: cap + 1,
      }),
    ]);
    const targets = new Map<string, CaseExceptionDraft['targets'][number]>();
    for (const group of groups.slice(0, cap * 4)) {
      const key = JSON.stringify([group.ruleId, group.logSource, group.accountId, group.eventName]);
      const known = targets.get(key);
      const alerts = group._count._all;
      if (known === undefined) {
        targets.set(key, {
          ruleId: group.ruleId,
          logSource: group.logSource,
          accountId: group.accountId,
          eventName: group.eventName,
          alerts,
          severity: group.severity,
        });
      } else {
        known.alerts += alerts;
        if (SEVERITY_ORDER[group.severity] < SEVERITY_ORDER[known.severity]) known.severity = group.severity;
      }
    }
    // O valor que não cabe numa exceção (um recurso longo) não é oferecido: o lote inteiro seria recusado por ele.
    const values = (rows: { value: string | null }[]) => {
      const offered = rows
        .slice(0, cap)
        .flatMap(({ value }) => (value === null || value.length > ALERT_EXCEPTION_VALUE_MAX ? [] : [value]));
      return { values: offered, complete: offered.length === rows.length };
    };
    const list = [...targets.values()];
    return {
      caseId,
      targets: list.slice(0, cap),
      targetsComplete: groups.length <= cap * 4 && list.length <= cap,
      values: {
        user: values(users.map((row) => ({ value: row.actorUser }))),
        ip: values(ips.map((row) => ({ value: row.sourceIp }))),
        resource: values(resources.map((row) => ({ value: row.resource }))),
      },
    };
  }

  /**
   * As exceções de usuário, IP ou recurso de um caso, de uma vez (até 20, da mesma regra e com o mesmo motivo). A que já
   * existe (mesma regra, campo e valor) fica como estava. Um registro na auditoria, com os valores.
   */
  async createBatch(
    auth: RequestAuth,
    caseId: string,
    input: AlertExceptionBatch,
  ): Promise<AlertExceptionBatchResult> {
    await this.assertCase(caseId);
    const { count } = await this.prisma.scoped().alertException.createMany({
      data: input.values.map(
        (value) =>
          ({
            ruleId: input.ruleId,
            field: input.field,
            value,
            reason: input.reason,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
            createdById: auth.userId,
          }) as Prisma.AlertExceptionCreateManyInput,
      ),
      skipDuplicates: true,
    });
    const result = { created: count, existing: input.values.length - count };
    this.audit.describe({
      action: 'alert_exception.create_batch',
      resourceType: 'alert_exception',
      resourceId: caseId,
      after: { caseId, ...input, ...result },
    });
    return result;
  }

  private async assertCase(caseId: string): Promise<void> {
    const found = await this.prisma
      .scoped()
      .alertCase.findUnique({ where: { id: caseId }, select: { id: true } });
    if (!found) throw new ApiError(HttpStatus.NOT_FOUND, CASE_NOT_FOUND);
  }
}
