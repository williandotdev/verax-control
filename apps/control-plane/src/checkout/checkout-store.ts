import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { newUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  DocumentAlreadyExistsError,
  type DocumentReader,
  type DocumentStore,
  parseDocument,
} from '../firestore/document-store.js';
import {
  isReservableSlug,
  isSlugFree,
  type PlanId,
  type SlugDocument,
  slugDocumentSchema,
  type SlugOrder,
} from '../tenants/tenant.schema.js';

/** Teto global de sessões do Checkout por dia (UTC), o disjuntor contra criação em massa (plano §2.3). */
export const CHECKOUT_DAILY_LIMIT = 50;
/** Reserva do subdomínio: 2 h 30, meia hora a mais que a sessão do Checkout (plano §2.3). */
export const SLUG_RESERVATION_MS = 150 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Documento `rateLimits/{bucket}` (plano §3): a contagem da janela e o fim dela, que é também o prazo do TTL. */
export const rateLimitDocumentSchema = z.strictObject({
  count: z.number().int().min(0),
  expiresAt: z.date(),
});

/** O balde diário das sessões do Checkout: um documento por dia UTC, que o TTL apaga depois que o dia acaba. */
export function checkoutDailyBucket(now: Date): { id: string; day: string; endsAt: Date } {
  const day = now.toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { id: `checkout-sessions-${day}`, day, endsAt: new Date(start + DAY_MS) };
}

export class DailyLimitReachedError extends Error {
  constructor(
    readonly limit: number,
    readonly day: string,
    readonly resetsAt: Date,
  ) {
    super(`teto diário de ${limit} sessões do Checkout atingido em ${day}`);
    this.name = 'DailyLimitReachedError';
  }
}

export class SlugUnavailableError extends Error {
  constructor(readonly slug: string) {
    super(`subdomínio indisponível: ${slug}`);
    this.name = 'SlugUnavailableError';
  }
}

/** A reserva deixou de ser deste checkout entre a reserva e a sessão (não deveria acontecer: a sessão leva segundos). */
export class ReservationLostError extends Error {
  constructor(readonly slug: string) {
    super(`a reserva do subdomínio ${slug} não é mais deste checkout`);
    this.name = 'ReservationLostError';
  }
}

export interface Reservation {
  tenantId: string;
  slug: string;
  plan: PlanId;
  expiresAt: Date;
}

export interface ReserveRequest {
  slug: string;
  order: SlugOrder;
  requestId?: string;
}

const ACTOR = 'system';

/**
 * Reserva de subdomínio e teto diário do checkout (plano §4a, passos 3 e 4), sobre `slugs/{slug}` e
 * `rateLimits/{bucket}`. Cada escrita leva a auditoria na mesma transação (ator `system`; em `details`, só o slug, o
 * plano e prazos: nada de e-mail, CNPJ ou razão social).
 */
@Injectable()
export class CheckoutStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** O subdomínio pode ser pedido agora: formato válido, fora da lista reservada e livre em `slugs/{slug}`. */
  async isSlugAvailable(slug: string): Promise<boolean> {
    if (!isReservableSlug(slug)) return false;
    return isSlugFree(await this.readSlug(this.store, slug), this.clock.now());
  }

  /**
   * Numa transação: confere o teto diário (`DailyLimitReachedError`) e o subdomínio (livre, liberado ou reserva
   * vencida; senão `SlugUnavailableError`), conta mais uma sessão no balde do dia e grava a reserva por 2 h 30 com o
   * `tenantId` novo e o pedido. Uma disputa pelo mesmo slug termina com uma reserva e um `SlugUnavailableError`.
   * Um subdomínio indisponível não consome o teto.
   */
  async reserve(request: ReserveRequest): Promise<Reservation> {
    const { slug, order } = request;
    if (!isReservableSlug(slug)) throw new SlugUnavailableError(slug);
    const now = this.clock.now();
    const tenantId = newUlid(now.getTime());
    const expiresAt = new Date(now.getTime() + SLUG_RESERVATION_MS);
    const bucket = checkoutDailyBucket(now);
    const reserved = slugDocumentSchema.parse({
      state: 'reserved',
      tenantId,
      order,
      updatedAt: now,
      expiresAt,
    });
    try {
      await this.store.runTransaction(async (tx) => {
        // Todas as leituras antes de qualquer escrita, como o Firestore exige.
        const counter = await tx.get(COLLECTIONS.rateLimits, bucket.id);
        const current = await this.readSlug(tx, slug);
        const count =
          counter === undefined
            ? 0
            : parseDocument(rateLimitDocumentSchema, COLLECTIONS.rateLimits, bucket.id, counter).count;
        if (count >= CHECKOUT_DAILY_LIMIT) {
          throw new DailyLimitReachedError(CHECKOUT_DAILY_LIMIT, bucket.day, bucket.endsAt);
        }
        if (!isSlugFree(current, now)) throw new SlugUnavailableError(slug);
        tx.set(
          COLLECTIONS.rateLimits,
          bucket.id,
          rateLimitDocumentSchema.parse({ count: count + 1, expiresAt: bucket.endsAt }),
        );
        if (current === undefined) tx.create(COLLECTIONS.slugs, slug, reserved);
        else tx.set(COLLECTIONS.slugs, slug, reserved);
        this.audit.record(tx, {
          actor: ACTOR,
          action: 'checkout.slug_reserved',
          tenantId,
          details: { slug, plan: order.plan, expiresAt },
          requestId: request.requestId,
        });
      });
    } catch (error) {
      // Duas reservas simultâneas de um slug sem documento: as duas leem livre e a segunda falha no commit do `create`.
      if (
        error instanceof DocumentAlreadyExistsError &&
        error.documents.includes(`${COLLECTIONS.slugs}/${slug}`)
      ) {
        throw new SlugUnavailableError(slug);
      }
      throw error;
    }
    return { tenantId, slug, plan: order.plan, expiresAt };
  }

  /** Grava na reserva a sessão criada (o `checkout.session.completed` a reconhece por ela) e audita a criação. */
  async attachSession(
    reservation: Reservation,
    session: { id: string; livemode: boolean; expiresAt: Date },
    requestId?: string,
  ): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      const current = await this.readSlug(tx, reservation.slug);
      if (!this.isOwnReservation(current, reservation)) throw new ReservationLostError(reservation.slug);
      tx.set(
        COLLECTIONS.slugs,
        reservation.slug,
        slugDocumentSchema.parse({ ...current, checkoutSessionId: session.id, updatedAt: this.clock.now() }),
      );
      this.audit.record(tx, {
        actor: ACTOR,
        action: 'checkout.session_created',
        tenantId: reservation.tenantId,
        details: {
          slug: reservation.slug,
          plan: reservation.plan,
          livemode: session.livemode,
          sessionExpiresAt: session.expiresAt,
        },
        requestId,
      });
    });
  }

  /**
   * Desfaz a reserva deste checkout (a Stripe falhou depois dela, ou a sessão venceu sem pagamento, CP-04):
   * `released`, sem o pedido e sem prazo, e o slug volta a aceitar reserva na hora. Se a reserva já não for deste
   * checkout, não mexe e devolve `false`. O ator padrão é `system`; o webhook passa `stripe:<eventId>`.
   */
  async release(
    reservation: Pick<Reservation, 'tenantId' | 'slug'>,
    reason: string,
    requestId?: string,
    actor: string = ACTOR,
  ): Promise<boolean> {
    return this.store.runTransaction(async (tx) => {
      const current = await this.readSlug(tx, reservation.slug);
      if (!this.isOwnReservation(current, reservation)) return false;
      tx.set(
        COLLECTIONS.slugs,
        reservation.slug,
        slugDocumentSchema.parse({
          state: 'released',
          tenantId: reservation.tenantId,
          updatedAt: this.clock.now(),
        }),
      );
      this.audit.record(tx, {
        actor,
        action: 'checkout.slug_released',
        tenantId: reservation.tenantId,
        details: { slug: reservation.slug, reason },
        requestId,
      });
      return true;
    });
  }

  private isOwnReservation(
    current: SlugDocument | undefined,
    reservation: Pick<Reservation, 'tenantId'>,
  ): current is SlugDocument {
    return current?.state === 'reserved' && current.tenantId === reservation.tenantId;
  }

  private async readSlug(reader: DocumentReader, slug: string): Promise<SlugDocument | undefined> {
    const data = await reader.get(COLLECTIONS.slugs, slug);
    if (data === undefined) return undefined;
    return parseDocument(slugDocumentSchema, COLLECTIONS.slugs, slug, data);
  }
}
