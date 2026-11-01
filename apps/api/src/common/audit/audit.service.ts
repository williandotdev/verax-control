import { Injectable } from '@nestjs/common';
import type { AuditActorType, AuditOutcome, Prisma } from '../../generated/prisma/client.js';
import { sanitize } from '../logger/sanitize.js';

/** Acima disso o estado não é gravado inteiro: guarda-se só o tamanho, para não inflar a tabela. */
export const MAX_STATE_BYTES = 16 * 1024;

export interface AuditActor {
  type: AuditActorType;
  id?: string;
  tenantId?: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  action: string;
  outcome: AuditOutcome;
  statusCode?: number;
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

function truncate(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : value.slice(0, max);
}

/** Estado anterior/novo com a mesma limpeza dos logs (senha, token, segredo AWS etc. nunca são gravados). */
export function toStoredState(state: unknown): Prisma.InputJsonValue | undefined {
  if (state === undefined || state === null) return undefined;
  const cleaned = sanitize(state);
  const size = Buffer.byteLength(JSON.stringify(cleaned) ?? '', 'utf8');
  if (size > MAX_STATE_BYTES) return { truncated: true, bytes: size };
  return cleaned as Prisma.InputJsonValue;
}

export function toAuditLogData(entry: AuditEntry): Prisma.AuditLogCreateInput {
  return {
    actorType: entry.actor.type,
    actorId: entry.actor.id ?? null,
    tenantId: entry.actor.tenantId ?? null,
    action: truncate(entry.action, 200) ?? '',
    outcome: entry.outcome,
    statusCode: entry.statusCode ?? null,
    resourceType: truncate(entry.resourceType, 100) ?? null,
    resourceId: truncate(entry.resourceId, 200) ?? null,
    before: toStoredState(entry.before),
    after: toStoredState(entry.after),
    ip: truncate(entry.ip, 64) ?? null,
    userAgent: truncate(entry.userAgent, 256) ?? null,
    requestId: truncate(entry.requestId, 64) ?? null,
  };
}

/**
 * Única forma de gravar auditoria. Só insere: não existe método de alteração nem de exclusão, e o banco
 * bloqueia as duas operações por trigger.
 */
@Injectable()
export class AuditService {
  async write(db: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await db.auditLog.create({ data: toAuditLogData(entry), select: { id: true } });
  }
}
