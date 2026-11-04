import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { rateLimitDocumentSchema } from '../checkout/checkout-store.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { isUlid, newUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import { DOCUMENT_STORE, type DocumentStore, parseDocument } from '../firestore/document-store.js';
import {
  configurationSchema,
  nodeLimitsSchema,
  quoteLineItemSchema,
  versionIdSchema,
} from './pricing.schema.js';
import type { Quote } from './quote.js';

/** Validade da cotação: o preço mostrado é honrado por 24 h, mesmo que outra tabela seja publicada nesse meio-tempo. */
export const QUOTE_TTL_MS = 24 * 60 * 60_000;
/**
 * Teto global de cotações gravadas por dia (UTC), o disjuntor contra quem gera cotações em massa (cada uma é uma
 * escrita no Firestore). O site calcula o total ao vivo pela tabela pública (`GET /v1/public/pricing`) e só pede a
 * cotação quando o visitante vai contratar, então o uso legítimo fica muito abaixo disso.
 */
export const QUOTE_DAILY_LIMIT = 1_000;

const DAY_MS = 24 * 60 * 60_000;

/** Documento `quotes/{quoteId}`: a cotação como o motor a calculou, com o TTL em `expiresAt`. Sem dado pessoal. */
export const quoteDocumentSchema = z.strictObject({
  priceTableVersion: versionIdSchema,
  configuration: configurationSchema,
  sizeDescription: z.string().min(1).max(120),
  lineItems: z.array(quoteLineItemSchema).min(1).max(20),
  monthlyTotal: z.number().int().min(0),
  setupTotal: z.number().int().min(0),
  limits: nodeLimitsSchema,
  createdAt: z.date(),
  expiresAt: z.date(),
});
export type QuoteDocument = z.infer<typeof quoteDocumentSchema>;

export interface StoredQuote extends QuoteDocument {
  quoteId: string;
}

export class QuoteDailyLimitReachedError extends Error {
  constructor(
    readonly limit: number,
    readonly day: string,
    readonly resetsAt: Date,
  ) {
    super(`teto diário de ${limit} cotações atingido em ${day}`);
    this.name = 'QuoteDailyLimitReachedError';
  }
}

/** O balde diário das cotações: um documento por dia UTC em `rateLimits`, que o TTL apaga depois que o dia acaba. */
export function quoteDailyBucket(now: Date): { id: string; day: string; endsAt: Date } {
  const day = now.toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { id: `quotes-${day}`, day, endsAt: new Date(start + DAY_MS) };
}

/** Cotações gravadas (`quotes/{quoteId}`, TTL de 24 h) e o teto diário, na mesma transação. */
@Injectable()
export class QuoteStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Grava a cotação com um id novo (ULID) e validade de 24 h; acima do teto do dia, `QuoteDailyLimitReachedError`. */
  async create(priceTableVersion: string, quoted: Quote): Promise<StoredQuote> {
    const now = this.clock.now();
    const quoteId = newUlid(now.getTime());
    const bucket = quoteDailyBucket(now);
    const document = quoteDocumentSchema.parse({
      priceTableVersion,
      configuration: quoted.configuration,
      sizeDescription: quoted.sizeDescription,
      lineItems: quoted.lineItems,
      monthlyTotal: quoted.monthlyTotal,
      setupTotal: quoted.setupTotal,
      limits: quoted.limits,
      createdAt: now,
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
    });
    await this.store.runTransaction(async (tx) => {
      const counter = await tx.get(COLLECTIONS.rateLimits, bucket.id);
      const count =
        counter === undefined
          ? 0
          : parseDocument(rateLimitDocumentSchema, COLLECTIONS.rateLimits, bucket.id, counter).count;
      if (count >= QUOTE_DAILY_LIMIT) {
        throw new QuoteDailyLimitReachedError(QUOTE_DAILY_LIMIT, bucket.day, bucket.endsAt);
      }
      tx.set(
        COLLECTIONS.rateLimits,
        bucket.id,
        rateLimitDocumentSchema.parse({ count: count + 1, expiresAt: bucket.endsAt }),
      );
      tx.create(COLLECTIONS.quotes, quoteId, { ...document });
    });
    return { quoteId, ...document };
  }

  /** A cotação, se existir e ainda valer (o TTL do Firestore pode levar horas para apagar uma vencida). */
  async getValid(quoteId: string): Promise<StoredQuote | undefined> {
    if (!isUlid(quoteId)) return undefined;
    const data = await this.store.get(COLLECTIONS.quotes, quoteId);
    if (data === undefined) return undefined;
    const document = parseDocument(quoteDocumentSchema, COLLECTIONS.quotes, quoteId, data);
    if (document.expiresAt.getTime() <= this.clock.now().getTime()) return undefined;
    return { quoteId, ...document };
  }
}
