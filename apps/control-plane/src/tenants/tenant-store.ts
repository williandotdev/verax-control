import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { newUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  DocumentAlreadyExistsError,
  type DocumentReader,
  type DocumentStore,
  equalValues,
  parseDocument,
} from '../firestore/document-store.js';
import { canTransition } from './tenant-transitions.js';
import {
  type SlugDocument,
  slugDocumentSchema,
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
   * documento relido na transação. Recebe uma cópia profunda dele: pode editá-la no lugar ou devolver outro objeto.
   * Não pode mexer em `state` nem nos carimbos de tempo (o store os define) nem nos campos de
   * `IMMUTABLE_IN_TRANSITION`.
   */
  mutate?: (tenant: Tenant) => Tenant;
}

export class TenantNotFoundError extends Error {
  constructor(readonly tenantId: string) {
    super(`cliente não encontrado: ${tenantId}`);
    this.name = 'TenantNotFoundError';
  }
}

export class SlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`subdomínio já em uso: ${slug}`);
    this.name = 'SlugTakenError';
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

/**
 * O que uma transição nunca muda: a identidade do cliente (`slug`, `company`), o aceite dos textos legais
 * (`consent`), a data de criação e a trava, que tem fluxo próprio (`acquireLock`/`renewLock`/`releaseLock`).
 */
export const IMMUTABLE_IN_TRANSITION = ['slug', 'company', 'consent', 'createdAt', 'lock'] as const;

/**
 * Repositório de `tenants` (plano §3 e §4b): toda mudança de estado acontece numa transação que relê o documento,
 * confere a tabela de transições, grava o documento inteiro validado, o registro em `transitions` e a auditoria.
 * Duas transações concorrentes sobre o mesmo cliente: uma commita, a outra relê o estado novo e é recusada.
 *
 * A `lock` dos passos do provisionamento (dono = `runId`, 20 min renovados) é independente das transições: os
 * campos de cobrança nunca disputam a trava (plano §4b), e uma trava vencida é tomada por quem chegar.
 *
 * Os ids de `transitions` (e da auditoria) são ULIDs do instante da escrita: a listagem por `at` desempata pelo id,
 * então dois registros do mesmo milissegundo saem na mesma ordem no Firestore e no dublê.
 */
@Injectable()
export class TenantStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /**
   * Cria o cliente em `pending` e toma o subdomínio em `slugs/{slug}` na mesma transação. O slug precisa estar livre
   * ou reservado para o mesmo checkout (`consent.checkoutSessionId`); uma reserva vencida de outro checkout também
   * conta como livre. Caso contrário, `SlugTakenError`, e nada é gravado.
   */
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
    const taken = slugDocumentSchema.parse({
      state: 'taken',
      tenantId: id,
      checkoutSessionId: tenant.consent?.checkoutSessionId,
      updatedAt: now,
    });
    try {
      await this.store.runTransaction(async (tx) => {
        // Leitura antes de qualquer escrita, como o Firestore exige.
        const current = await this.readSlug(tx, tenant.slug);
        if (current === undefined) tx.create(COLLECTIONS.slugs, tenant.slug, taken);
        else if (slugAvailableFor(current, tenant, now)) tx.set(COLLECTIONS.slugs, tenant.slug, taken);
        else throw new SlugTakenError(tenant.slug);
        tx.create(COLLECTIONS.tenants, id, tenant);
        tx.create(
          COLLECTIONS.transitions(id),
          newUlid(now.getTime()),
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
      });
    } catch (error) {
      // Duas criações simultâneas sem reserva: as duas leem o slug livre e a segunda falha no commit do `create`.
      if (
        error instanceof DocumentAlreadyExistsError &&
        error.documents.includes(`${COLLECTIONS.slugs}/${tenant.slug}`)
      ) {
        throw new SlugTakenError(tenant.slug);
      }
      throw error;
    }
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

  /** O documento `slugs/{slug}`, se existir. */
  async getSlug(slug: string): Promise<SlugDocument | undefined> {
    return this.readSlug(this.store, slug);
  }

  /** Muda o estado conforme a tabela de transições, gravando `transitions` e a auditoria na mesma transação. */
  async transition(tenantId: string, request: TransitionRequest): Promise<TenantRecord> {
    return this.store.runTransaction(async (tx) => {
      const current = await this.read(tx, tenantId);
      if (!canTransition(current.state, request.to)) {
        throw new InvalidTransitionError(tenantId, current.state, request.to);
      }
      const now = this.clock.now();
      // A mutação recebe uma cópia profunda: uma edição no lugar (`tenant.slug = ...`, `tenant.lock.owner = ...`,
      // mesmo por trás de uma cópia rasa) nunca alcança `current`, que é a referência da comparação dos campos
      // imutáveis e o `from` da transição.
      const mutated = request.mutate === undefined ? current : request.mutate(structuredClone(current));
      for (const key of IMMUTABLE_IN_TRANSITION) {
        if (!equalValues(mutated[key], current[key])) {
          throw new TypeError(`a mutação de uma transição não pode mexer em ${key}`);
        }
      }
      const next = tenantSchema.parse({ ...mutated, state: request.to, stateUpdatedAt: now, updatedAt: now });
      tx.set(COLLECTIONS.tenants, tenantId, next);
      tx.create(
        COLLECTIONS.transitions(tenantId),
        newUlid(now.getTime()),
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

  /** Histórico de estados, do mais antigo ao mais novo (empate em `at` sai pelo id, nos dois backends). */
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

  private async readSlug(reader: DocumentReader, slug: string): Promise<SlugDocument | undefined> {
    const data = await reader.get(COLLECTIONS.slugs, slug);
    if (data === undefined) return undefined;
    return parseDocument(slugDocumentSchema, COLLECTIONS.slugs, slug, data);
  }
}

/** Reserva do mesmo checkout, ou reserva de outro já vencida (o TTL ainda não a apagou): o slug está livre. */
function slugAvailableFor(current: SlugDocument, tenant: Tenant, now: Date): boolean {
  if (current.state !== 'reserved') return false;
  const sameCheckout =
    current.checkoutSessionId !== undefined &&
    current.checkoutSessionId === tenant.consent?.checkoutSessionId;
  const expired = current.expiresAt !== undefined && current.expiresAt.getTime() <= now.getTime();
  return sameCheckout || expired;
}
