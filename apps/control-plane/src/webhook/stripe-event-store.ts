import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CLOCK, type Clock } from '../common/clock.js';
import { ULID_PATTERN } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  DocumentAlreadyExistsError,
  type DocumentStore,
  type DocumentTransaction,
  parseDocument,
} from '../firestore/document-store.js';
import { slugDocumentSchema, slugSchema, stripeIdSchema } from '../tenants/tenant.schema.js';
import { HANDLED_EVENT_TYPES, type ReceivedEvent } from './stripe-events.js';

/** Retenção de `stripeEvents` (plano §3 e §5): 90 dias, pelo TTL em `expiresAt`. */
export const STRIPE_EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;
/**
 * Por quanto tempo uma entrega tem o evento só para si. Passado o prazo (a instância caiu no meio), outra entrega o
 * retoma. O processamento leva segundos (o alvo é menos de 3 s); 60 s é o `timeout` do cp-public.
 */
export const PROCESSING_LEASE_MS = 60_000;

/**
 * `processing` é o estado de passagem de quem está processando; os finais do plano (§3) são `applied` (algo mudou),
 * `ignored` (nada a fazer), `deferred` (o cliente ainda não existe: o evento é reprocessado quando a reserva virar
 * cliente) e `failed` (erro: a Stripe repete a entrega, e a repetição processa de novo).
 */
export const STRIPE_EVENT_OUTCOMES = ['processing', 'applied', 'ignored', 'deferred', 'failed'] as const;
export type StripeEventOutcome = (typeof STRIPE_EVENT_OUTCOMES)[number];
export type FinalOutcome = 'applied' | 'ignored' | 'failed';

const reasonSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * Documento `stripeEvents/{eventId}` (plano §3): nunca o corpo do evento, só tipo, id do objeto e o desfecho. O
 * `tenantId` e o `slug` da reserva ficam no evento adiado, para o reprocessamento achá-lo.
 */
export const stripeEventDocumentSchema = z.strictObject({
  type: z.enum(HANDLED_EVENT_TYPES),
  objectId: stripeIdSchema,
  livemode: z.boolean(),
  eventCreatedAt: z.date(),
  receivedAt: z.date(),
  attempts: z.number().int().min(1),
  outcome: z.enum(STRIPE_EVENT_OUTCOMES),
  reason: reasonSchema.optional(),
  tenantId: z.string().regex(ULID_PATTERN).optional(),
  slug: slugSchema.optional(),
  leaseUntil: z.date().optional(),
  processedAt: z.date().optional(),
  expiresAt: z.date(),
});

export type StripeEventDocument = z.infer<typeof stripeEventDocumentSchema>;

export interface StripeEventRecord extends StripeEventDocument {
  id: string;
}

export type ClaimResult =
  | { status: 'claimed'; record: StripeEventRecord }
  | { status: 'duplicate'; outcome: StripeEventOutcome }
  | { status: 'in_progress' };

export type DeferResult = 'deferred' | 'tenant_exists' | 'reservation_gone' | 'lost';

/**
 * Idempotência do webhook (plano §4b, passo 2) sobre `stripeEvents/{event.id}`. A primeira entrega cria o documento
 * numa transação (`create`); a repetida encontra o documento e, se o desfecho for final (`applied`, `ignored`),
 * responde 200 sem efeito. Uma entrega que falhou (`failed`), um evento adiado (`deferred`) ou um processamento
 * abandonado (`processing` com o prazo vencido) é retomado por quem chegar, com `attempts` mais um: é o número da
 * vez, e quem grava o desfecho precisa ainda ser o dono dela (uma entrega atrasada não sobrescreve a mais nova).
 */
@Injectable()
export class StripeEventStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async claim(event: ReceivedEvent): Promise<ClaimResult> {
    const now = this.clock.now();
    try {
      return await this.store.runTransaction(async (tx) => {
        const current = await this.read(tx, event.id);
        if (current !== undefined) return this.takeOver(tx, event.id, current, now);
        const record = stripeEventDocumentSchema.parse({
          type: event.type,
          objectId: event.objectId,
          livemode: event.livemode,
          eventCreatedAt: event.created,
          receivedAt: now,
          attempts: 1,
          outcome: 'processing',
          leaseUntil: new Date(now.getTime() + PROCESSING_LEASE_MS),
          expiresAt: new Date(now.getTime() + STRIPE_EVENT_RETENTION_MS),
        });
        tx.create(COLLECTIONS.stripeEvents, event.id, record);
        return { status: 'claimed', record: { id: event.id, ...record } } satisfies ClaimResult;
      });
    } catch (error) {
      // Duas entregas simultâneas do mesmo evento: as duas leem "não existe" e a segunda falha no commit do `create`.
      if (error instanceof DocumentAlreadyExistsError) return { status: 'in_progress' };
      throw error;
    }
  }

  /** Retoma um evento já gravado (o reprocessamento dos adiados); `undefined` se ele não existir. */
  async claimStored(eventId: string): Promise<ClaimResult | undefined> {
    const now = this.clock.now();
    return this.store.runTransaction(async (tx) => {
      const current = await this.read(tx, eventId);
      return current === undefined ? undefined : this.takeOver(tx, eventId, current, now);
    });
  }

  /** Grava o desfecho da vez `attempt`. Se outra entrega já retomou o evento, não mexe e devolve `false`. */
  async finish(
    eventId: string,
    attempt: number,
    result: { outcome: FinalOutcome; reason: string; tenantId?: string },
  ): Promise<boolean> {
    const now = this.clock.now();
    return this.store.runTransaction(async (tx) => {
      const current = await this.read(tx, eventId);
      if (current?.outcome !== 'processing' || current.attempts !== attempt) return false;
      const { leaseUntil: _lease, ...rest } = current;
      tx.set(
        COLLECTIONS.stripeEvents,
        eventId,
        stripeEventDocumentSchema.parse({
          ...rest,
          outcome: result.outcome,
          reason: result.reason,
          tenantId: result.tenantId ?? current.tenantId,
          processedAt: now,
        }),
      );
      return true;
    });
  }

  /**
   * Adia o evento até a reserva virar cliente, numa transação que lê o cliente e a reserva: a criação do cliente
   * (`TenantStore.create`) grava a mesma reserva (`taken`), então as duas se serializam. Ou o adiamento commita antes
   * (e quem criou o cliente o encontra ao reprocessar os adiados), ou ele vê o cliente já criado (`tenant_exists`, e
   * quem chamou processa de novo na hora). Sem a reserva (vencida ou liberada), o evento fica `ignored`.
   */
  async defer(
    eventId: string,
    attempt: number,
    target: { tenantId: string; slug: string; reason: string },
  ): Promise<DeferResult> {
    const now = this.clock.now();
    return this.store.runTransaction(async (tx) => {
      const current = await this.read(tx, eventId);
      const tenant = await tx.get(COLLECTIONS.tenants, target.tenantId);
      const slugData = await tx.get(COLLECTIONS.slugs, target.slug);
      if (current?.outcome !== 'processing' || current.attempts !== attempt) return 'lost';
      if (tenant !== undefined) return 'tenant_exists';
      const reservation =
        slugData === undefined
          ? undefined
          : parseDocument(slugDocumentSchema, COLLECTIONS.slugs, target.slug, slugData);
      const reserved = reservation?.state === 'reserved' && reservation.tenantId === target.tenantId;
      const { leaseUntil: _lease, ...rest } = current;
      tx.set(
        COLLECTIONS.stripeEvents,
        eventId,
        stripeEventDocumentSchema.parse({
          ...rest,
          outcome: reserved ? 'deferred' : 'ignored',
          reason: reserved ? target.reason : 'reservation_gone',
          tenantId: target.tenantId,
          slug: target.slug,
          processedAt: now,
        }),
      );
      return reserved ? 'deferred' : 'reservation_gone';
    });
  }

  /**
   * Os eventos deste cliente que ainda esperam processamento (adiados, ou que falharam ao ser reprocessados), do mais
   * antigo ao mais novo. Só igualdades: o Firestore resolve com os índices simples.
   */
  async listPending(tenantId: string): Promise<StripeEventRecord[]> {
    const lists = await Promise.all(
      (['deferred', 'failed'] as const).map((outcome) =>
        this.store.query(COLLECTIONS.stripeEvents, {
          where: [
            { field: 'tenantId', op: '==', value: tenantId },
            { field: 'outcome', op: '==', value: outcome },
          ],
        }),
      ),
    );
    return lists
      .flat()
      .map(({ id, data }) => ({
        id,
        ...parseDocument(stripeEventDocumentSchema, COLLECTIONS.stripeEvents, id, data),
      }))
      .sort((a, b) => a.eventCreatedAt.getTime() - b.eventCreatedAt.getTime() || (a.id < b.id ? -1 : 1));
  }

  async get(eventId: string): Promise<StripeEventRecord | undefined> {
    const data = await this.store.get(COLLECTIONS.stripeEvents, eventId);
    if (data === undefined) return undefined;
    return {
      id: eventId,
      ...parseDocument(stripeEventDocumentSchema, COLLECTIONS.stripeEvents, eventId, data),
    };
  }

  private takeOver(
    tx: DocumentTransaction,
    eventId: string,
    current: StripeEventDocument,
    now: Date,
  ): ClaimResult {
    if (current.outcome === 'applied' || current.outcome === 'ignored') {
      return { status: 'duplicate', outcome: current.outcome };
    }
    const leased =
      current.outcome === 'processing' &&
      current.leaseUntil !== undefined &&
      current.leaseUntil.getTime() > now.getTime();
    if (leased) return { status: 'in_progress' };
    const record = stripeEventDocumentSchema.parse({
      ...current,
      outcome: 'processing',
      attempts: current.attempts + 1,
      leaseUntil: new Date(now.getTime() + PROCESSING_LEASE_MS),
    });
    tx.set(COLLECTIONS.stripeEvents, eventId, record);
    return { status: 'claimed', record: { id: eventId, ...record } };
  }

  private async read(tx: DocumentTransaction, eventId: string): Promise<StripeEventDocument | undefined> {
    const data = await tx.get(COLLECTIONS.stripeEvents, eventId);
    if (data === undefined) return undefined;
    return parseDocument(stripeEventDocumentSchema, COLLECTIONS.stripeEvents, eventId, data);
  }
}
