import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  FINDING_SOURCES,
  type Finding,
  type FindingComment,
  type FindingCommentCreate,
  type FindingDetail,
  type FindingListQuery,
  type FindingPeriod,
  type FindingSource,
  type FindingStatusUpdate,
  type Paginated,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { RAW_EVENT_READER, type RawEventReader } from './raw-events.js';

const PERIOD_HOURS = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90,
} as const satisfies Record<FindingPeriod, number>;

/** O detalhe mostra os 500 comentários mais recentes, o limite do contrato; a contagem traz o total. */
const MAX_COMMENTS = 500;

const commentSelect = {
  id: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, name: true } },
} as const satisfies Prisma.FindingCommentSelect;

const findingSelect = {
  id: true,
  accountId: true,
  occurredAt: true,
  severity: true,
  status: true,
  title: true,
  logSource: true,
  eventName: true,
  region: true,
  resource: true,
  actorUser: true,
  actorType: true,
  accessKeyId: true,
  sourceIp: true,
  mitreTactics: true,
  _count: { select: { comments: true } },
} as const satisfies Prisma.FindingSelect;

const detailSelect = {
  ...findingSelect,
  source: true,
  sourceEventId: true,
  ruleId: true,
  ruleLevel: true,
  mitreTechniques: true,
  // Os mais recentes: um comentário novo nunca fica de fora. Na tela, voltam à ordem cronológica.
  comments: { select: commentSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: MAX_COMMENTS },
} as const satisfies Prisma.FindingSelect;

type FindingRow = Prisma.FindingGetPayload<{ select: typeof findingSelect }>;
type DetailRow = Prisma.FindingGetPayload<{ select: typeof detailSelect }>;
type CommentRow = Prisma.FindingCommentGetPayload<{ select: typeof commentSelect }>;

/** O sync só grava fontes conhecidas; uma fora da lista indica dado corrompido, e não vai para a tela. */
function logSourceOf(value: string): FindingSource {
  if ((FINDING_SOURCES as readonly string[]).includes(value)) return value as FindingSource;
  throw new Error(`Fonte de log desconhecida num achado: ${value}`);
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    accountId: row.accountId,
    occurredAt: row.occurredAt.toISOString(),
    severity: row.severity,
    status: row.status,
    title: row.title,
    source: logSourceOf(row.logSource),
    eventName: row.eventName,
    region: row.region,
    resource: row.resource,
    actor: { user: row.actorUser, type: row.actorType, accessKeyId: row.accessKeyId, ip: row.sourceIp },
    mitreTactics: row.mitreTactics,
    // O agrupamento em incidentes (T5.6) é gravado pelo sync, no próximo passo do E5.
    incidentId: null,
    commentCount: row._count.comments,
  };
}

function toComment(row: CommentRow): FindingComment {
  return { id: row.id, body: row.body, createdAt: row.createdAt.toISOString(), author: row.author };
}

const NOT_FOUND = 'Achado não encontrado';

/**
 * Achados do cliente da sessão (T5.4 e T5.5): lista com filtros, detalhe com o evento bruto, mudança de status e
 * comentários. Os achados são criados só pelo sync; pela API, só os estados humanos mudam, e tudo é auditado.
 */
@Injectable()
export class FindingsService {
  private readonly logger = new Logger(FindingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    @Inject(RAW_EVENT_READER) private readonly rawEvents: RawEventReader,
  ) {}

  async list(query: FindingListQuery, now = new Date()): Promise<Paginated<Finding>> {
    const where: Prisma.FindingWhereInput = {
      ...(query.severity && { severity: query.severity }),
      ...(query.status && { status: query.status }),
      ...(query.accountId && { accountId: query.accountId }),
      ...(query.period && {
        occurredAt: { gte: new Date(now.getTime() - PERIOD_HOURS[query.period] * 3_600_000) },
      }),
    };
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.finding.findMany({
        where,
        select: findingSelect,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...toPrismaPage(query),
      }),
      db.finding.count({ where }),
    ]);
    return toPaginated(rows.map(toFinding), total, query);
  }

  async get(id: string): Promise<FindingDetail> {
    return this.toDetail(await this.find(id));
  }

  /** Muda o status (T5.5). O comentário opcional explica a decisão e entra na mesma transação e auditoria. */
  async updateStatus(auth: RequestAuth, id: string, input: FindingStatusUpdate): Promise<FindingDetail> {
    const before = await this.find(id);
    const db = this.prisma.scoped();
    await db.finding.update({ where: { id }, data: { status: input.status }, select: { id: true } });
    let commentId: string | undefined;
    if (input.comment) {
      commentId = (await this.addComment(auth, id, input.comment)).id;
    }
    this.audit.describe({
      action: 'finding.status',
      resourceType: 'finding',
      resourceId: id,
      before: { status: before.status },
      after: { status: input.status, ...(commentId && { commentId }) },
    });
    return this.toDetail(await this.find(id));
  }

  async comment(auth: RequestAuth, id: string, input: FindingCommentCreate): Promise<FindingComment> {
    await this.find(id);
    const comment = await this.addComment(auth, id, input.body);
    this.audit.describe({
      action: 'finding.comment',
      resourceType: 'finding',
      resourceId: id,
      after: { commentId: comment.id },
    });
    return comment;
  }

  private async addComment(auth: RequestAuth, findingId: string, body: string): Promise<FindingComment> {
    const row = await this.prisma.scoped().findingComment.create({
      // O autor vem da sessão; o cliente, do escopo.
      data: { findingId, authorId: auth.userId, body } as Prisma.FindingCommentUncheckedCreateInput,
      select: commentSelect,
    });
    return toComment(row);
  }

  private async find(id: string): Promise<DetailRow> {
    const row = await this.prisma.scoped().finding.findUnique({ where: { id }, select: detailSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return row;
  }

  private async toDetail(row: DetailRow): Promise<FindingDetail> {
    return {
      ...toFinding(row),
      ruleId: row.ruleId,
      ruleLevel: row.ruleLevel,
      mitreTechniques: row.mitreTechniques,
      comments: row.comments.map(toComment).reverse(),
      rawEvent: await this.readRawEvent(row),
    };
  }

  /** Falha do indexer não derruba o detalhe: o achado aparece sem o evento bruto, e o erro vai para o log. */
  private async readRawEvent(row: DetailRow): Promise<Record<string, unknown> | null> {
    try {
      return await this.rawEvents.read(row.source, row.sourceEventId);
    } catch (error) {
      this.logger.warn({ findingId: row.id, error: (error as Error).name }, 'evento bruto indisponível');
      return null;
    }
  }
}
