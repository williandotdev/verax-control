import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { newUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentReader,
  type DocumentStore,
  parseDocument,
} from '../firestore/document-store.js';
import { canTransition } from './tenant-transitions.js';
import {
  type Tenant,
  type TenantLock,
  type TenantRecord,
  tenantSchema,
  type TenantState,
  type TenantTransition,
  transitionSchema,
} from './tenant.schema.js';

/** Quem pediu a operação, para a auditoria. */
export interface AuditContext {
  actor: string;
  requestId?: string;
}

/** Campos que o `TenantStore` preenche sozinho na criação. */
export type NewTenant = Omit<Tenant, 'state' | 'stateUpdatedAt' | 'createdAt' | 'updatedAt' | 'lock'>;

export interface CreateTenantOptions {
  /** O que criou o cliente (ex.: `checkout.session.completed`). */
  reason: string;
  eventId?: string;
  audit: AuditContext;
}

export interface TransitionRequest {
  to: TenantState;
  reason: string;
  eventId?: string;
  audit: AuditContext;
  /**
   * Mudanças que acompanham a transição (ex.: `billing.graceUntil` ao entrar em `past_due`), aplicadas sobre o
   * documento relido na transação. Não pode mexer em `state`, nos carimbos de tempo nem na `lock`.
   */
  mutate?: (tenant: Tenant) => Tenant;
}

export class TenantNotFoundError extends Error {
  constructor(readonly tenantId: string) {
    super(`cliente não encontrado: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly tenantId: string,
    readonly from: TenantState,
    readonly to: TenantState,
  ) {
    super(`transição não permitida para o cliente ${tenantId}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class LockHeldError extends Error {
  constructor(
    readonly tenantId: string,
    readonly owner: string,
    readonly expiresAt: Date,
  ) {
    super(`cliente ${tenantId} travado por ${owner} até ${expiresAt.toISOString()}`);
    this.name = 'LockHeldError';
  }
}

export class LockNotHeldError extends Error {
  constructor(
    readonly tenantId: string,
    readonly owner: string,
  ) {
    super(`${owner} não tem a trava do cliente ${tenantId}`);
    this.name = 'LockNotHeldError';
  }
}

function sameLock(a: TenantLock | undefined, b: TenantLock | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.owner === b.owner && a.expiresAt.getTime() === b.expiresAt.getTime();
}

/**
 * Repositório de `tenants` (plano §3 e §4b): toda mudança de estado acontece numa transação que relê o documento,
 * confere a tabela de transições, grava o documento inteiro validado, o registro em `transitions` e a auditoria.
 * Duas transações concorrentes sobre o mesmo cliente: uma commita, a outra relê o estado novo e é recusada.
 *
 * A `lock` dos passos do provisionamento (dono = `runId`, 20 min renovados) é independente das transições: os
 * campos de cobrança nunca disputam a trava (plano §4b), e uma trava vencida é tomada por quem chegar.
 */
@Injectable()
export class TenantStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** Cria o cliente em `pending` (a reserva do slug vira tenant no `checkout.session.completed`). */
  async create(input: NewTenant, options: CreateTenantOptions): Promise<TenantRecord> {
    const now = this.clock.now();
    const id = newUlid(now.getTime());
    const tenant = tenantSchema.parse({
      ...input,
      state: 'pending',
      stateUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await this.store.runTransaction((tx) => {
      tx.create(COLLECTIONS.tenants, id, tenant);
      tx.create(
        COLLECTIONS.transitions(id),
        this.store.newId(),
        transitionSchema.parse({
          from: null,
          to: 'pending',
          reason: options.reason,
          eventId: options.eventId,
          at: now,
        }),
      );
      this.audit.record(tx, {
        actor: options.audit.actor,
        action: 'tenant.create',
        tenantId: id,
        details: {
          slug: tenant.slug,
          plan: tenant.plan,
          to: 'pending',
          reason: options.reason,
          eventId: options.eventId,
        },
        requestId: options.audit.requestId,
      });
      return Promise.resolve();
    });
    return { id, ...tenant };
  }

  async get(tenantId: string): Promise<TenantRecord | undefined> {
    const data = await this.store.get(COLLECTIONS.tenants, tenantId);
    if (data === undefined) return undefined;
    return { id: tenantId, ...parseDocument(tenantSchema, COLLECTIONS.tenants, tenantId, data) };
  }

  async require(tenantId: string): Promise<TenantRecord> {
    const tenant = await this.get(tenantId);
    if (tenant === undefined) throw new TenantNotFoundError(tenantId);
    return tenant;
  }

  async findBySlug(slug: string): Promise<TenantRecord | undefined> {
    const [doc] = await this.store.query(COLLECTIONS.tenants, {
      where: [{ field: 'slug', op: '==', value: slug }],
      limit: 1,
    });
    if (doc === undefined) return undefined;
    return { id: doc.id, ...parseDocument(tenantSchema, COLLECTIONS.tenants, doc.id, doc.data) };
  }

  /** Muda o estado conforme a tabela de transições, gravando `transitions` e a auditoria na mesma transação. */
  async transition(tenantId: string, request: TransitionRequest): Promise<TenantRecord> {
    return this.store.runTransaction(async (tx) => {
      const current = await this.read(tx, tenantId);
      if (!canTransition(current.state, request.to)) {
        throw new InvalidTransitionError(tenantId, current.state, request.to);
      }
      const now = this.clock.now();
      const mutated = request.mutate === undefined ? current : request.mutate(current);
      if (!sameLock(mutated.lock, current.lock)) {
        throw new TypeError('a mutação de uma transição não pode mexer na lock');
      }
      const next = tenantSchema.parse({ ...mutated, state: request.to, stateUpdatedAt: now, updatedAt: now });
      tx.set(COLLECTIONS.tenants, tenantId, next);
      tx.create(
        COLLECTIONS.transitions(tenantId),
        this.store.newId(),
        transitionSchema.parse({
          from: current.state,
          to: request.to,
          reason: request.reason,
          eventId: request.eventId,
          at: now,
        }),
      );
      this.audit.record(tx, {
        actor: request.audit.actor,
        action: 'tenant.transition',
        tenantId,
        details: { from: current.state, to: request.to, reason: request.reason, eventId: request.eventId },
        requestId: request.audit.requestId,
      });
      return { id: tenantId, ...next };
    });
  }

  /** Histórico de estados, do mais antigo ao mais novo. */
  async listTransitions(tenantId: string): Promise<TenantTransition[]> {
    const collection = COLLECTIONS.transitions(tenantId);
    const docs = await this.store.query(collection, { orderBy: { field: 'at' } });
    return docs.map(({ id, data }) => parseDocument(transitionSchema, collection, id, data));
  }

  /** Toma a trava se estiver livre, vencida ou já for do mesmo dono (renovação implícita). */
  async acquireLock(tenantId: string, owner: string, ttlMs: number): Promise<TenantLock> {
    return this.store.runTransaction(async (tx) => {
      const tenant = await this.read(tx, tenantId);
      const now = this.clock.now();
      const current = tenant.lock;
      if (current !== undefined && current.owner !== owner && current.expiresAt.getTime() > now.getTime()) {
        throw new LockHeldError(tenantId, current.owner, current.expiresAt);
      }
      return this.writeLock(tx, tenantId, tenant, { owner, expiresAt: new Date(now.getTime() + ttlMs) }, now);
    });
  }

  /** Estende a trava de quem a tem; vencida ou de outro dono, recusa (o passo precisa adquirir de novo). */
  async renewLock(tenantId: string, owner: string, ttlMs: number): Promise<TenantLock> {
    return this.store.runTransaction(async (tx) => {
      const tenant = await this.read(tx, tenantId);
      const now = this.clock.now();
      if (!this.holds(tenant, owner, now)) throw new LockNotHeldError(tenantId, owner);
      return this.writeLock(tx, tenantId, tenant, { owner, expiresAt: new Date(now.getTime() + ttlMs) }, now);
    });
  }

  /** Solta a trava do dono. Sem trava é idempotente; trava de outro dono é recusada e fica como está. */
  async releaseLock(tenantId: string, owner: string): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      const tenant = await this.read(tx, tenantId);
      if (tenant.lock === undefined) return;
      if (tenant.lock.owner !== owner) throw new LockNotHeldError(tenantId, owner);
      const { lock: _released, ...rest } = tenant;
      tx.set(COLLECTIONS.tenants, tenantId, tenantSchema.parse({ ...rest, updatedAt: this.clock.now() }));
    });
  }

  private holds(tenant: Tenant, owner: string, now: Date): boolean {
    return (
      tenant.lock !== undefined &&
      tenant.lock.owner === owner &&
      tenant.lock.expiresAt.getTime() > now.getTime()
    );
  }

  private writeLock(
    tx: { set(collection: string, id: string, data: Tenant): void },
    tenantId: string,
    tenant: Tenant,
    lock: TenantLock,
    now: Date,
  ): TenantLock {
    tx.set(COLLECTIONS.tenants, tenantId, tenantSchema.parse({ ...tenant, lock, updatedAt: now }));
    return lock;
  }

  private async read(reader: DocumentReader, tenantId: string): Promise<Tenant> {
    const data = await reader.get(COLLECTIONS.tenants, tenantId);
    if (data === undefined) throw new TenantNotFoundError(tenantId);
    return parseDocument(tenantSchema, COLLECTIONS.tenants, tenantId, data);
  }
}
