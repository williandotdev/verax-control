import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  Author,
  Incident,
  IncidentAttach,
  IncidentCreate,
  IncidentDetail,
  IncidentListQuery,
  IncidentUpdate,
  Paginated,
} from '@verax/shared';
import { lockTenantFindings } from '../alerts/finding-store.js';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { type AuditDetails, requestContext } from '../common/context/request-context.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { findingSelect, toFinding } from '../findings/findings.service.js';
import type { FindingSeverity, Prisma } from '../generated/prisma/client.js';
import { enqueueNotices, incidentNotices } from '../notifications/finding-notices.js';
import {
  incidentFindingSelect,
  type IncidentFindingRow,
  incidentSummaryData,
  protectedItemsOf,
} from './incident-summary.js';
import { resummarizeIncident } from './incident-summary-store.js';

/** A linha do tempo do detalhe mostra até 500 achados, o limite do contrato: os mais recentes. */
const MAX_TIMELINE = 500;

/** O incidente da lista (também nas linhas de incidente da tela Detecções). */
export const incidentSelect = {
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
  createdBy: { select: { id: true, name: true } },
  findings: {
    select: findingSelect,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: MAX_TIMELINE,
  },
} as const satisfies Prisma.IncidentSelect;

export type IncidentRow = Prisma.IncidentGetPayload<{ select: typeof incidentSelect }>;
type DetailRow = Prisma.IncidentGetPayload<{ select: typeof detailSelect }>;

export function toIncident(row: IncidentRow): Incident {
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
const FINDING_NOT_FOUND = 'Alerta não encontrado';

/** Códigos (409) das recusas de promover, anexar e remover alertas, para o painel explicar. */
export const FINDING_IN_INCIDENT_CODE = 'FINDING_IN_INCIDENT';
export const INCIDENT_RESOLVED_CODE = 'INCIDENT_RESOLVED';
export const INCIDENT_LAST_FINDING_CODE = 'INCIDENT_LAST_FINDING';

/** Quem pode ser responsável: usuários ativos do cliente que operam incidentes e a equipe da Verax. */
const CLIENT_OPERATORS = ['admin_cliente', 'analista_cliente'] as const;

/**
 * Incidentes do cliente da sessão (T5.7; decisão de 17/11/2026): lista pela nota de risco, detalhe com a linha do tempo
 * dos alertas, status e responsável, e o trabalho de quem confirma: promover alertas a um incidente novo, anexar alertas
 * a um incidente que não está resolvido e remover um alerta do incidente. O sync não abre nem alimenta incidente. Tudo
 * pelo escopo do cliente da sessão (nenhum id do corpo escolhe o cliente) e auditado.
 *
 * Promover, anexar e remover tomam o lock dos alertas do cliente (`lockTenantFindings`), o mesmo dos coletores e do
 * expurgo: o resumo do incidente é recalculado sem nenhum alerta entrar ou sair no meio.
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
      createdBy: row.createdBy,
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
    await this.lockIncident(sessionTenantId(), id);
    const before = await this.find(id);
    if (input.assigneeId) await this.assertAssignee(auth, input.assigneeId);
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

  /**
   * Promove alertas a um incidente novo (`incident.create`): os alertas do cliente da sessão, todos fora de incidente.
   * Quem promove fica como quem confirmou; o responsável é opcional. O incidente confirmado avisa por e-mail em qualquer
   * severidade (`incident_opened`).
   */
  async create(auth: RequestAuth, input: IncidentCreate): Promise<IncidentDetail> {
    const { id, details } = await this.open(auth, input);
    this.audit.describe(details);
    return this.get(id);
  }

  /**
   * O mesmo que `create`, para quem abre o incidente no meio de outra operação (a triagem em massa): devolve o registro
   * da auditoria, que quem chama grava, e não o detalhe.
   */
  async open(auth: RequestAuth, input: IncidentCreate): Promise<{ id: string; details: AuditDetails }> {
    const { db, tenantId } = await this.lockedScope();
    const findings = await this.freeFindings(db, input.findingIds);
    if (input.assigneeId) await this.assertAssignee(auth, input.assigneeId);
    const data = incidentSummaryData(findings, await this.protectedItems(db));
    const { id } = await db.incident.create({
      // O cliente vem do escopo; quem confirmou, da sessão.
      data: {
        ...data,
        assigneeId: input.assigneeId ?? null,
        createdById: auth.userId,
      } as Prisma.IncidentUncheckedCreateInput,
      select: { id: true },
    });
    await db.finding.updateMany({
      where: { id: { in: [...input.findingIds] }, incidentId: null },
      data: { incidentId: id },
    });
    await enqueueNotices(
      db,
      incidentNotices(tenantId, { change: 'opened', incidentId: id, severity: data.severity }),
    );
    return {
      id,
      details: {
        action: 'incident.create',
        resourceType: 'incident',
        resourceId: id,
        before: null,
        after: {
          findingIds: [...input.findingIds],
          assigneeId: input.assigneeId ?? null,
          ...summaryOf(data),
        },
      },
    };
  }

  /**
   * Anexa alertas a um incidente que não está resolvido (`incident.attach`). O resumo é recalculado; se a severidade
   * sobe para alta ou crítica, avisa por e-mail (`incident_escalated`).
   */
  async attach(id: string, input: IncidentAttach): Promise<IncidentDetail> {
    const { db, tenantId } = await this.lockedScope();
    const incident = await this.openIncident(db, tenantId, id);
    await this.freeFindings(db, input.findingIds);
    await db.finding.updateMany({
      where: { id: { in: [...input.findingIds] }, incidentId: null },
      data: { incidentId: id },
    });
    const data = await resummarizeIncident(this.prisma.db(), tenantId, id);
    await enqueueNotices(
      db,
      incidentNotices(tenantId, {
        change: 'attached',
        incidentId: id,
        severity: data.severity,
        previousSeverity: incident.severity,
      }),
    );
    this.audit.describe({
      action: 'incident.attach',
      resourceType: 'incident',
      resourceId: id,
      before: summaryOf(incident),
      after: { findingIds: [...input.findingIds], ...summaryOf(data) },
    });
    return this.get(id);
  }

  /**
   * Tira um alerta do incidente (`incident.detach`): ele volta à fila de validação com o status que tinha. O último
   * alerta não sai (não existe incidente sem alerta): para encerrar o incidente, marca-se como resolvido.
   */
  async detach(id: string, findingId: string): Promise<IncidentDetail> {
    const { db, tenantId } = await this.lockedScope();
    const incident = await this.openIncident(db, tenantId, id);
    const finding = await db.finding.findFirst({
      where: { id: findingId, incidentId: id },
      select: { id: true },
    });
    if (!finding) throw new ApiError(HttpStatus.NOT_FOUND, FINDING_NOT_FOUND);
    if ((await db.finding.count({ where: { incidentId: id } })) <= 1) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'O incidente precisa de pelo menos um alerta. Para encerrá-lo, marque o incidente como resolvido.',
        INCIDENT_LAST_FINDING_CODE,
      );
    }
    await db.finding.update({ where: { id: findingId }, data: { incidentId: null }, select: { id: true } });
    const data = await resummarizeIncident(this.prisma.db(), tenantId, id);
    this.audit.describe({
      action: 'incident.detach',
      resourceType: 'incident',
      resourceId: id,
      before: { findingId, ...summaryOf(incident) },
      after: { findingId, ...summaryOf(data) },
    });
    return this.get(id);
  }

  /** O escopo do cliente da sessão, com o lock dos alertas dele tomado na transação da requisição. */
  private async lockedScope(): Promise<{ db: Prisma.TransactionClient; tenantId: string }> {
    // `scoped()` recusa a sessão sem cliente (admin_verax sem cliente escolhido) antes de qualquer leitura.
    const db = this.prisma.scoped();
    const tenantId = sessionTenantId();
    await lockTenantFindings(this.prisma.db(), tenantId);
    return { db, tenantId };
  }

  /**
   * Trava a linha do incidente do cliente até o fim da transação da requisição. Anexar e remover leem o status com a
   * linha travada, e a mudança de status também trava: um "resolvido" que chega no meio espera, ou faz o outro pedido
   * ver o incidente já resolvido. O `id` já chega validado como UUID pela rota.
   */
  private async lockIncident(tenantId: string, id: string): Promise<void> {
    await this.prisma.db()
      .$executeRaw`SELECT 1 FROM "Incident" WHERE "id" = ${id}::uuid AND "tenantId" = ${tenantId}::uuid FOR UPDATE`;
  }

  /** O incidente do cliente, se não está resolvido (o resolvido não ganha nem perde alerta: reabra antes). */
  private async openIncident(db: Prisma.TransactionClient, tenantId: string, id: string) {
    await this.lockIncident(tenantId, id);
    const incident = await db.incident.findUnique({
      where: { id },
      select: { id: true, status: true, severity: true, riskScore: true, findingCount: true },
    });
    if (!incident) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    if (incident.status === 'resolved') {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Incidente resolvido não muda de alertas. Reabra o incidente antes.',
        INCIDENT_RESOLVED_CODE,
      );
    }
    return incident;
  }

  /**
   * Os alertas pedidos, todos do cliente da sessão e fora de qualquer incidente. Um id que o escopo não acha (de outro
   * cliente, ou que não existe) recusa o pedido inteiro com 404, sem dizer qual; um alerta que já está num incidente,
   * com 409: tire-o de lá antes.
   */
  private async freeFindings(
    db: Prisma.TransactionClient,
    ids: readonly string[],
  ): Promise<IncidentFindingRow[]> {
    const rows = await db.finding.findMany({
      where: { id: { in: [...ids] } },
      select: { ...incidentFindingSelect, incidentId: true },
    });
    if (rows.length !== ids.length) throw new ApiError(HttpStatus.NOT_FOUND, FINDING_NOT_FOUND);
    if (rows.some((row) => row.incidentId !== null)) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Um dos alertas já está em um incidente. Remova-o de lá antes.',
        FINDING_IN_INCIDENT_CODE,
      );
    }
    return rows;
  }

  /** A lista de proteção do cliente (+15 na nota de risco). */
  private async protectedItems(db: Prisma.TransactionClient): Promise<Set<string>> {
    return protectedItemsOf(
      await db.protectedResource.findMany({ select: { type: true, identifier: true } }),
    );
  }

  private async assertAssignee(auth: RequestAuth, assigneeId: string): Promise<void> {
    const allowed = await this.assignees(auth);
    if (!allowed.items.some((user) => user.id === assigneeId)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Responsável inválido para este cliente');
    }
  }

  private async find(id: string): Promise<DetailRow> {
    const row = await this.prisma.scoped().incident.findUnique({ where: { id }, select: detailSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return row;
  }
}

/** O resumo que a auditoria guarda antes e depois de uma mudança de alertas. */
function summaryOf(data: { severity: FindingSeverity; riskScore: number; findingCount: number }) {
  return { severity: data.severity, riskScore: data.riskScore, findingCount: data.findingCount };
}

/** O cliente da sessão (o `scoped()` já recusou a sessão sem cliente). */
function sessionTenantId(): string {
  const tenantId = requestContext.getStore()?.auth?.scopeTenantId;
  if (!tenantId)
    throw new ApiError(HttpStatus.CONFLICT, 'Selecione um cliente para continuar', 'TENANT_REQUIRED');
  return tenantId;
}
