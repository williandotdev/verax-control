import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { isUlid, newUlid } from '../common/ulid.js';
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
  billingModeOf,
  isSlugFree,
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

/** Os prazos que o `tick` varre junto com o estado (os índices compostos de `collections.ts`). */
export type DueField = 'billing.graceUntil' | 'lifecycle.deleteAfter' | 'lifecycle.cryptoDestroyAfter';

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
  /**
   * O id reservado no checkout (`slugs/{slug}.tenantId`, o `client_reference_id` da sessão): a reserva vira o cliente
   * com o mesmo id. Sem ele, um ULID novo.
   */
  tenantId?: string;
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

/**
 * Uma mudança decidida sobre o documento relido na transação (`TenantStore.change`). Com `to`, é uma transição de
 * estado (tabela, `transitions` e auditoria `tenant.transition`); sem `to`, só campos mudam (auditoria `tenant.update`
 * com os nomes dos campos, sem registro em `transitions`), e `mutate` é obrigatório.
 */
export interface TenantChange {
  to?: TenantState;
  reason: string;
  eventId?: string;
  audit: AuditContext;
  mutate?: (tenant: Tenant) => Tenant;
  /**
   * Só sem `to`: a razão social pode mudar (sincronizada da Stripe pelo `customer.updated`). O CNPJ, o slug e o
   * aceite continuam imutáveis.
   */
  allowLegalNameChange?: boolean;
}

export interface TenantChangeResult {
  /** O documento depois da mudança (igual ao relido quando nada mudou). */
  tenant: TenantRecord;
  /** O documento relido na transação, antes da mudança. */
  before: TenantRecord;
  changed: boolean;
  transitioned: boolean;
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

/** O id reservado já tem cliente (outra entrega do mesmo checkout chegou antes). */
export class TenantAlreadyExistsError extends Error {
  constructor(readonly tenantId: string) {
    super(`cliente já existe: ${tenantId}`);
    this.name = 'TenantAlreadyExistsError';
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

/** Campos de primeiro nível que mudaram entre dois documentos (para a auditoria: só os nomes, nunca os valores). */
function changedFields(before: Tenant, after: Tenant): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => !equalValues(before[key as keyof Tenant], after[key as keyof Tenant]))
    .sort();
}

/**
 * Repositório de `tenants` (plano §3 e §4b): toda mudança de estado acontece numa transação que relê o documento,
 * confere a tabela de transições, grava o documento inteiro validado, o registro em `transitions` e a auditoria.
 * Duas transações concorrentes sobre o mesmo cliente: uma commita, a outra relê o estado novo e é recusada (ou, em
 * `change`, decide de novo sobre ele).
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
   * ou reservado para o mesmo checkout (`consent.checkoutSessionId` e, com `options.tenantId`, o mesmo id); uma
   * reserva vencida de outro checkout também conta como livre. Caso contrário, `SlugTakenError`, e nada é gravado.
   * Com o id reservado já usado por um cliente, `TenantAlreadyExistsError`.
   */
  async create(input: NewTenant, options: CreateTenantOptions): Promise<TenantRecord> {
    const now = this.clock.now();
    if (options.tenantId !== undefined && !isUlid(options.tenantId)) {
      throw new TypeError('id de cliente reservado inválido');
    }
    const id = options.tenantId ?? newUlid(now.getTime());
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
        // Leituras antes de qualquer escrita, como o Firestore exige.
        const existing = options.tenantId === undefined ? undefined : await tx.get(COLLECTIONS.tenants, id);
        const current = await this.readSlug(tx, tenant.slug);
        if (existing !== undefined) throw new TenantAlreadyExistsError(id);
        if (current === undefined) tx.create(COLLECTIONS.slugs, tenant.slug, taken);
        else if (slugAvailableFor(current, tenant, options.tenantId, now))
          tx.set(COLLECTIONS.slugs, tenant.slug, taken);
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
            size: tenant.configuration.size,
            priceTableVersion: tenant.pricing.priceTableVersion,
            billingMode: billingModeOf(tenant),
            to: 'pending',
            reason: options.reason,
            eventId: options.eventId,
          },
          requestId: options.audit.requestId,
        });
      });
    } catch (error) {
      if (error instanceof DocumentAlreadyExistsError) {
        // Duas criações simultâneas: as duas leem livre e a segunda falha no commit do `create`.
        if (error.documents.includes(`${COLLECTIONS.tenants}/${id}`)) throw new TenantAlreadyExistsError(id);
        if (error.documents.includes(`${COLLECTIONS.slugs}/${tenant.slug}`)) {
          throw new SlugTakenError(tenant.slug);
        }
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
    return this.findOne('slug', slug);
  }

  /** O cliente do Customer da Stripe (consulta por igualdade: o índice simples do Firestore basta). */
  async findByStripeCustomer(customerId: string): Promise<TenantRecord | undefined> {
    return this.findOne('stripe.customerId', customerId);
  }

  /** O cliente da assinatura da Stripe. */
  async findByStripeSubscription(subscriptionId: string): Promise<TenantRecord | undefined> {
    return this.findOne('stripe.subscriptionId', subscriptionId);
  }

  /**
   * Os clientes num estado, para o `tick` (CP-11). Com `due`, só os que têm o prazo (`billing.graceUntil`,
   * `lifecycle.deleteAfter` ou `lifecycle.cryptoDestroyAfter`) até `due.at`, pelo índice composto (estado, prazo) de
   * `collections.ts`; sem, a igualdade pelo índice simples. Até `limit` por chamada (o `tick` seguinte pega o resto).
   */
  async listInState(
    state: TenantState,
    options: { due?: { field: DueField; at: Date }; limit?: number } = {},
  ): Promise<TenantRecord[]> {
    const where = [
      { field: 'state', op: '==' as const, value: state },
      ...(options.due === undefined
        ? []
        : [{ field: options.due.field, op: '<=' as const, value: options.due.at }]),
    ];
    const docs = await this.store.query(COLLECTIONS.tenants, {
      where,
      ...(options.due === undefined ? {} : { orderBy: { field: options.due.field } }),
      limit: options.limit ?? 500,
    });
    return docs.map((doc) => ({
      id: doc.id,
      ...parseDocument(tenantSchema, COLLECTIONS.tenants, doc.id, doc.data),
    }));
  }

  /** Os contratos diretos com o cancelamento marcado até `at` (`lifecycle.cancelScheduledFor`, índice simples). */
  async listCancelScheduled(at: Date, limit = 500): Promise<TenantRecord[]> {
    const docs = await this.store.query(COLLECTIONS.tenants, {
      where: [{ field: 'lifecycle.cancelScheduledFor', op: '<=', value: at }],
      limit,
    });
    return docs.map((doc) => ({
      id: doc.id,
      ...parseDocument(tenantSchema, COLLECTIONS.tenants, doc.id, doc.data),
    }));
  }

  /**
   * Os clientes com uma execução da exclusão em andamento ou parada (`lifecycle.run`, índice simples): só os que ainda
   * têm trabalho, nunca os milhares já terminados.
   */
  async listWithLifecycleRun(limit = 500): Promise<TenantRecord[]> {
    const docs = await this.store.query(COLLECTIONS.tenants, {
      where: [{ field: 'lifecycle.run.startedAt', op: '>=', value: new Date(0) }],
      limit,
    });
    return docs.map((doc) => ({
      id: doc.id,
      ...parseDocument(tenantSchema, COLLECTIONS.tenants, doc.id, doc.data),
    }));
  }

  /**
   * Os clientes cuja VM o plano de controle parou ou mandou parar (`lifecycle.nodeStoppedAt` ou
   * `lifecycle.nodeStopRequestedAt`), em qualquer estado: duas consultas de índice simples, sem repetição.
   */
  async listNodeStopped(limit = 500): Promise<TenantRecord[]> {
    const found = new Map<string, TenantRecord>();
    for (const field of ['lifecycle.nodeStoppedAt', 'lifecycle.nodeStopRequestedAt']) {
      const docs = await this.store.query(COLLECTIONS.tenants, {
        where: [{ field, op: '>=', value: new Date(0) }],
        limit,
      });
      for (const doc of docs) {
        found.set(doc.id, {
          id: doc.id,
          ...parseDocument(tenantSchema, COLLECTIONS.tenants, doc.id, doc.data),
        });
      }
    }
    return [...found.values()];
  }

  /**
   * Os clientes mais novos primeiro (o console do responsável), até `limit`. Um documento fora do formato não derruba
   * a lista: sai em `unreadable` (só o id), para o responsável ver que existe e investigar.
   */
  async listRecent(limit: number): Promise<{ tenants: TenantRecord[]; unreadable: string[] }> {
    const docs = await this.store.query(COLLECTIONS.tenants, {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
    });
    const tenants: TenantRecord[] = [];
    const unreadable: string[] = [];
    for (const { id, data } of docs) {
      const parsed = tenantSchema.safeParse(data);
      if (parsed.success) tenants.push({ id, ...parsed.data });
      else unreadable.push(id);
    }
    return { tenants, unreadable };
  }

  /**
   * Uma página de todos os clientes em ordem de subdomínio, depois de `after` (exclusive), com até `limit` documentos:
   * a varredura da recópia da senha do e-mail dos nós. O `slug` é único e nunca muda, então a ordem é estável e o
   * último `slug` de uma página é o cursor da seguinte, mesmo com os documentos mudando no meio (a recópia regrava
   * `resources.nodeMailPasswordAt`, que por isso não serve de cursor). Desigualdade e ordenação no mesmo campo: o
   * índice simples do Firestore basta. Uma página mais curta que `limit` é a última.
   */
  async listPageBySlug(after: string | undefined, limit: number): Promise<TenantRecord[]> {
    const docs = await this.store.query(COLLECTIONS.tenants, {
      ...(after === undefined ? {} : { where: [{ field: 'slug', op: '>' as const, value: after }] }),
      orderBy: { field: 'slug' },
      limit,
    });
    return docs.map((doc) => ({
      id: doc.id,
      ...parseDocument(tenantSchema, COLLECTIONS.tenants, doc.id, doc.data),
    }));
  }

  /** O documento `slugs/{slug}`, se existir. */
  async getSlug(slug: string): Promise<SlugDocument | undefined> {
    return this.readSlug(this.store, slug);
  }

  /** Muda o estado conforme a tabela de transições, gravando `transitions` e a auditoria na mesma transação. */
  async transition(tenantId: string, request: TransitionRequest): Promise<TenantRecord> {
    return (await this.change(tenantId, () => request)).tenant;
  }

  /**
   * Decide e aplica uma mudança sobre o documento relido dentro da transação: `decide` recebe uma cópia dele e
   * devolve a mudança, ou `undefined` para não gravar nada. No Firestore a transação pode repetir (contenção), e
   * `decide` roda de novo sobre o estado novo: precisa ser pura. É o que deixa duas entregas de eventos diferentes do
   * mesmo cliente, ao mesmo tempo, chegarem ao mesmo resultado em qualquer ordem.
   */
  async change(
    tenantId: string,
    decide: (current: TenantRecord) => TenantChange | undefined,
  ): Promise<TenantChangeResult> {
    return this.store.runTransaction(async (tx) => {
      const current = await this.read(tx, tenantId);
      const before: TenantRecord = { id: tenantId, ...current };
      const request = decide(structuredClone(before));
      if (request === undefined) return { tenant: before, before, changed: false, transitioned: false };
      const now = this.clock.now();
      const transitioning = request.to !== undefined;
      if (request.to !== undefined && !canTransition(current.state, request.to)) {
        throw new InvalidTransitionError(tenantId, current.state, request.to);
      }
      if (!transitioning && request.mutate === undefined) {
        throw new TypeError('uma mudança sem transição precisa de mutate');
      }
      // A mutação recebe uma cópia profunda: uma edição no lugar (`tenant.slug = ...`, `tenant.lock.owner = ...`,
      // mesmo por trás de uma cópia rasa) nunca alcança `current`, que é a referência da comparação dos campos
      // imutáveis e o `from` da transição.
      const mutated = request.mutate === undefined ? current : request.mutate(structuredClone(current));
      for (const key of IMMUTABLE_IN_TRANSITION) {
        const allowed =
          key === 'company' &&
          !transitioning &&
          request.allowLegalNameChange === true &&
          mutated.company.cnpj === current.company.cnpj;
        if (!allowed && !equalValues(mutated[key], current[key])) {
          throw new TypeError(`a mutação de uma transição não pode mexer em ${key}`);
        }
      }
      if (request.to === undefined) {
        const next = tenantSchema.parse({ ...mutated, state: current.state });
        const fields = changedFields(current, next);
        if (fields.length === 0) return { tenant: before, before, changed: false, transitioned: false };
        const written = tenantSchema.parse({ ...next, updatedAt: now });
        tx.set(COLLECTIONS.tenants, tenantId, written);
        this.audit.record(tx, {
          actor: request.audit.actor,
          action: 'tenant.update',
          tenantId,
          details: { state: current.state, fields, reason: request.reason, eventId: request.eventId },
          requestId: request.audit.requestId,
        });
        return { tenant: { id: tenantId, ...written }, before, changed: true, transitioned: false };
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
      return { tenant: { id: tenantId, ...next }, before, changed: true, transitioned: true };
    });
  }

  /**
   * Devolve o subdomínio tomado por este cliente (`taken` → `released`): o cliente foi cancelado sem nunca ter
   * provisionado nada (boleto do 1.º ciclo vencido, plano §4b), e outro pode reservar o nome. Idempotente: se o slug
   * não está tomado por este cliente, não mexe e devolve `false`.
   */
  async releaseSlug(tenantId: string, slug: string, reason: string, audit: AuditContext): Promise<boolean> {
    return this.store.runTransaction(async (tx) => {
      const current = await this.readSlug(tx, slug);
      if (current?.state !== 'taken' || current.tenantId !== tenantId) return false;
      tx.set(
        COLLECTIONS.slugs,
        slug,
        slugDocumentSchema.parse({ state: 'released', tenantId, updatedAt: this.clock.now() }),
      );
      this.audit.record(tx, {
        actor: audit.actor,
        action: 'tenant.slug_released',
        tenantId,
        details: { slug, reason },
        requestId: audit.requestId,
      });
      return true;
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

  private async findOne(field: string, value: string): Promise<TenantRecord | undefined> {
    const [doc] = await this.store.query(COLLECTIONS.tenants, {
      where: [{ field, op: '==', value }],
      limit: 1,
    });
    if (doc === undefined) return undefined;
    return { id: doc.id, ...parseDocument(tenantSchema, COLLECTIONS.tenants, doc.id, doc.data) };
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

/**
 * Reserva do mesmo checkout (a mesma sessão e, com id reservado, o mesmo id), ou subdomínio livre (liberado, ou
 * reserva de outro já vencida que o TTL ainda não apagou): o slug pode ser tomado.
 */
function slugAvailableFor(
  current: SlugDocument,
  tenant: Tenant,
  reservedId: string | undefined,
  now: Date,
): boolean {
  const sameCheckout =
    current.state === 'reserved' &&
    current.checkoutSessionId !== undefined &&
    current.checkoutSessionId === tenant.consent?.checkoutSessionId &&
    (reservedId === undefined || current.tenantId === reservedId);
  return sameCheckout || isSlugFree(current, now);
}
