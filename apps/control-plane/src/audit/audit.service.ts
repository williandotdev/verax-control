import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '../common/clock.js';
import { sanitize } from '../common/logger/sanitize.js';
import { newUlid, ULID_PATTERN } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentStore,
  type DocumentTransaction,
  parseDocument,
} from '../firestore/document-store.js';

/** Retenção da auditoria (LGPD, plano §5): o Firestore apaga pelo campo `expiresAt`. */
export const AUDIT_RETENTION_MONTHS = 24;

/** Acima disso o detalhe não é gravado inteiro: guarda-se só o tamanho, para não inflar o documento. */
export const MAX_DETAILS_BYTES = 16 * 1024;

/** Quem agiu: `system`, `stripe:<eventId>`, `owner:<e-mail no token>` ou `customer:<tenantId>` (plano §3). */
export const auditActorSchema = z
  .string()
  .regex(/^(system|stripe:[A-Za-z0-9_]{1,128}|owner:\S{1,254}|customer:[0-9A-HJKMNP-TV-Z]{26})$/, {
    error: 'ator deve ser system, stripe:<eventId>, owner:<principal> ou customer:<tenantId>',
  });

export const auditActionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{1,99}$/, { error: 'ação deve ser um nome como tenant.transition' });

export const auditRecordSchema = z.strictObject({
  actor: auditActorSchema,
  action: auditActionSchema,
  tenantId: z.string().regex(ULID_PATTERN).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,64}$/)
    .optional(),
  at: z.date(),
  expiresAt: z.date(),
});

export type AuditRecord = z.infer<typeof auditRecordSchema>;
export interface AuditRecordWithId extends AuditRecord {
  id: string;
}

export interface AuditEntry {
  actor: string;
  action: string;
  tenantId?: string;
  /** Contexto da ação. Passa pela mesma limpeza dos logs: senha, token, chave e assinatura nunca são gravados. */
  details?: Record<string, unknown>;
  requestId?: string;
}

/** Detalhes com a mesma limpeza dos logs e um teto de tamanho. */
export function toStoredDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const cleaned = sanitize(details) as Record<string, unknown>;
  const bytes = Buffer.byteLength(JSON.stringify(cleaned) ?? '', 'utf8');
  if (bytes > MAX_DETAILS_BYTES) return { truncated: true, bytes };
  return cleaned;
}

export function auditRetentionLimit(at: Date): Date {
  const limit = new Date(at.getTime());
  limit.setUTCMonth(limit.getUTCMonth() + AUDIT_RETENTION_MONTHS);
  return limit;
}

/**
 * Única forma de gravar auditoria. Só insere: não existe método de alteração nem de exclusão. Toda escrita de
 * estado e toda operação do responsável passam por aqui (plano §5), de preferência na mesma transação da mudança.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Grava dentro de uma transação aberta pelo chamador (a mesma da mudança de estado). */
  record(tx: DocumentTransaction, entry: AuditEntry): void {
    const record = this.toRecord(entry);
    // Id ordenado pelo tempo: a listagem por `at` desempata pelo id, igual nos dois backends.
    tx.create(COLLECTIONS.auditLog, newUlid(record.at.getTime()), record);
  }

  /** Grava sozinho, para ações que não mudam estado (ex.: uma operação recusada). */
  async write(entry: AuditEntry): Promise<void> {
    await this.store.runTransaction((tx) => {
      this.record(tx, entry);
      return Promise.resolve();
    });
  }

  /**
   * Registros de um cliente, do mais antigo ao mais novo (consulta por igualdade: sem índice composto). Empate em
   * `at` sai pelo id, que é um ULID do mesmo instante.
   */
  async listForTenant(tenantId: string): Promise<AuditRecordWithId[]> {
    const docs = await this.store.query(COLLECTIONS.auditLog, {
      where: [{ field: 'tenantId', op: '==', value: tenantId }],
    });
    return docs
      .map(({ id, data }) => ({ id, ...parseDocument(auditRecordSchema, COLLECTIONS.auditLog, id, data) }))
      .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1));
  }

  /**
   * Os registros cujas ações começam por `prefix` (ex.: `legal.terms.`), do mais novo ao mais antigo, até `limit`.
   * Desigualdade num campo só (`action >= prefix` e `action < prefix + '￿'`): sem índice composto. Lê todos os do
   * prefixo e ordena aqui; serve a ações raras do console do responsável, nunca às de cliente.
   */
  async listByActionPrefix(prefix: string, limit: number): Promise<AuditRecordWithId[]> {
    if (!auditActionSchema.safeParse(`${prefix}x`).success) throw new TypeError('prefixo de ação inválido');
    const docs = await this.store.query(COLLECTIONS.auditLog, {
      where: [
        { field: 'action', op: '>=', value: prefix },
        { field: 'action', op: '<', value: `${prefix}￿` },
      ],
    });
    return docs
      .map(({ id, data }) => ({ id, ...parseDocument(auditRecordSchema, COLLECTIONS.auditLog, id, data) }))
      .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }

  private toRecord(entry: AuditEntry): AuditRecord {
    const at = this.clock.now();
    return auditRecordSchema.parse({
      actor: entry.actor,
      action: entry.action,
      tenantId: entry.tenantId,
      details: toStoredDetails(entry.details),
      requestId: entry.requestId,
      at,
      expiresAt: auditRetentionLimit(at),
    });
  }
}
