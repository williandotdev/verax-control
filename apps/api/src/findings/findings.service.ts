import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  FINDING_SOURCES,
  type Finding,
  type FindingComment,
  type FindingCommentCreate,
  type FindingDetail,
  type FindingEvidence,
  type FindingListQuery,
  type FindingSource,
  type FindingStatusUpdate,
  MAX_RELATED_FINDINGS,
  type Paginated,
  RELATED_FINDINGS_WINDOW_MINUTES,
  type RelatedFindings,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { relatedFindings } from '../incidents/correlation.js';
import { webEvidenceSchema } from '../weblogs/evidence.js';
import { findingWhere } from './finding-filters.js';
import { RAW_EVENT_READER, type RawEventReader } from './raw-events.js';

/** O detalhe mostra os 500 comentários mais recentes, o limite do contrato; a contagem traz o total. */
const MAX_COMMENTS = 500;

const commentSelect = {
  id: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, name: true } },
} as const satisfies Prisma.FindingCommentSelect;

export const findingSelect = {
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
  incidentId: true,
  _count: { select: { comments: true } },
} as const satisfies Prisma.FindingSelect;

const detailSelect = {
  ...findingSelect,
  triagedAt: true,
  source: true,
  rawEventId: true,
  ruleId: true,
  ruleLevel: true,
  mitreTechniques: true,
  // Os mais recentes: um comentário novo nunca fica de fora. Na tela, voltam à ordem cronológica.
  comments: { select: commentSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: MAX_COMMENTS },
} as const satisfies Prisma.FindingSelect;

/** Os campos que a sugestão de relacionados compara (as chaves de correlação, o cliente e o horário). */
const relatedSelect = {
  id: true,
  tenantId: true,
  occurredAt: true,
  actorUser: true,
  accessKeyId: true,
  sourceIp: true,
  resource: true,
} as const satisfies Prisma.FindingSelect;

export type FindingRow = Prisma.FindingGetPayload<{ select: typeof findingSelect }>;
type DetailRow = Prisma.FindingGetPayload<{ select: typeof detailSelect }>;
type CommentRow = Prisma.FindingCommentGetPayload<{ select: typeof commentSelect }>;

/** O sync só grava fontes conhecidas; uma fora da lista indica dado corrompido, e não vai para a tela. */
function logSourceOf(value: string): FindingSource {
  if ((FINDING_SOURCES as readonly string[]).includes(value)) return value as FindingSource;
  throw new Error(`Fonte de log desconhecida num achado: ${value}`);
}

export function toFinding(row: FindingRow): Finding {
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
    incidentId: row.incidentId,
    commentCount: row._count.comments,
  };
}

function toComment(row: CommentRow): FindingComment {
  return { id: row.id, body: row.body, createdAt: row.createdAt.toISOString(), author: row.author };
}

const NOT_FOUND = 'Alerta não encontrado';

/** Quantos candidatos a sugestão lê do banco antes de conferir as chaves (o bastante para os 49 que ela mostra). */
const RELATED_SCAN = 500;

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
    const where = findingWhere(query, now);
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.finding.findMany({
        where,
        select: findingSelect,
        // A mais grave primeiro, quando pedida (E-06): o enum do Prisma é declarado `critical, high, medium, low`, então
        // `asc` é a mais grave; dentro dela, a mais recente, como sempre.
        orderBy: [
          ...(query.sort === 'severity' ? [{ severity: 'asc' as const }] : []),
          { occurredAt: 'desc' as const },
          { id: 'desc' as const },
        ],
        ...toPrismaPage(query),
      }),
      db.finding.count({ where }),
    ]);
    return toPaginated(rows.map(toFinding), total, query);
  }

  async get(id: string): Promise<FindingDetail> {
    return this.toDetail(await this.find(id));
  }

  /**
   * Alertas relacionados (decisão de 17/11/2026): a sugestão que o painel pré-seleciona ao promover um alerta a
   * incidente. Do cliente da sessão, ainda em validação (novo ou em análise), fora de incidente, com usuário, chave de
   * acesso, IP ou recurso em comum e a até 60 minutos do alerta. A regra é a de `correlation.ts`; o banco só estreita.
   */
  async related(id: string): Promise<RelatedFindings> {
    const db = this.prisma.scoped();
    const anchor = await db.finding.findUnique({ where: { id }, select: relatedSelect });
    if (!anchor) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    const shared: Prisma.FindingWhereInput[] = [
      ...(anchor.actorUser === null ? [] : [{ actorUser: anchor.actorUser }]),
      ...(anchor.accessKeyId === null ? [] : [{ accessKeyId: anchor.accessKeyId }]),
      ...(anchor.sourceIp === null ? [] : [{ sourceIp: anchor.sourceIp }]),
      ...(anchor.resource === null ? [] : [{ resource: anchor.resource }]),
    ];
    if (shared.length === 0) return { items: [] };
    const window = RELATED_FINDINGS_WINDOW_MINUTES * 60_000;
    const at = anchor.occurredAt.getTime();
    const rows = await db.finding.findMany({
      where: {
        id: { not: id },
        incidentId: null,
        status: { in: ['new', 'investigating'] },
        occurredAt: { gte: new Date(at - window), lte: new Date(at + window) },
        OR: shared,
      },
      select: { ...findingSelect, ...relatedSelect },
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
      take: RELATED_SCAN,
    });
    const asCandidate = (row: Prisma.FindingGetPayload<{ select: typeof relatedSelect }>) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const related = relatedFindings(
      asCandidate(anchor),
      rows.map(asCandidate),
      RELATED_FINDINGS_WINDOW_MINUTES,
    );
    return {
      items: related.slice(0, MAX_RELATED_FINDINGS).flatMap((candidate) => {
        const row = byId.get(candidate.id);
        return row ? [toFinding(row)] : [];
      }),
    };
  }

  /**
   * A evidência própria do achado (os ataques web pelos logs do ALB), numa rota à parte do detalhe: o contrato do detalhe é
   * estrito, e um painel de antes recusaria um campo novo. Sem evidência, `null`, e não 404: o 404 é do achado que não
   * existe, ou de outro cliente.
   *
   * O que vem do banco passa pelo schema estrito antes de ir para a tela, como qualquer entrada. O que não passa (um
   * formato de outra versão do nó, depois de uma volta de versão) não é mostrado, e o aviso vai para o log.
   */
  async evidence(id: string): Promise<FindingEvidence> {
    const row = await this.prisma.scoped().finding.findUnique({
      where: { id },
      select: { evidence: { select: { data: true, firstSeenAt: true, samplesPurgedAt: true } } },
    });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    if (row.evidence === null) return { evidence: null, samplesPurgedAt: null };
    const parsed = webEvidenceSchema.safeParse(row.evidence.data);
    if (!parsed.success) {
      this.logger.warn({ findingId: id }, 'evidência fora do formato desta versão');
      return { evidence: null, samplesPurgedAt: null };
    }
    return {
      // A evidência é a da atividade mais recente; a primeira é a do achado.
      evidence: { ...parsed.data, firstSeenAt: row.evidence.firstSeenAt.toISOString() },
      samplesPurgedAt: row.evidence.samplesPurgedAt?.toISOString() ?? null,
    };
  }

  /** Muda o status (T5.5). O comentário opcional explica a decisão e entra na mesma transação e auditoria. */
  async updateStatus(auth: RequestAuth, id: string, input: FindingStatusUpdate): Promise<FindingDetail> {
    const before = await this.find(id);
    const db = this.prisma.scoped();
    // A primeira saída de "novo" marca a triagem (relatório de tempo até a triagem); as seguintes não mudam a data.
    const firstTriage = before.status === 'new' && input.status !== 'new' && before.triagedAt === null;
    await db.finding.update({
      where: { id },
      // A decisão de agora vale no lugar da triagem em massa (desfazer a operação não mexe mais neste alerta) e da exceção
      // ampla que marcou o alerta: a severidade que sobe depois não desfaz o que uma pessoa decidiu.
      data: {
        status: input.status,
        triageOpId: null,
        scopedExceptionId: null,
        ...(firstTriage && { triagedAt: new Date() }),
      },
      select: { id: true },
    });
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

  /**
   * Falha do indexer não derruba o detalhe: o achado aparece sem o evento bruto, e o erro vai para o log. Achado sem
   * ID do alerta (GCP) não tem evento bruto guardado.
   */
  private async readRawEvent(row: DetailRow): Promise<Record<string, unknown> | null> {
    if (row.rawEventId === null) return null;
    try {
      return await this.rawEvents.read(row.source, row.rawEventId);
    } catch (error) {
      this.logger.warn({ findingId: row.id, error: (error as Error).name }, 'evento bruto indisponível');
      return null;
    }
  }
}
