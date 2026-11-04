import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentStore,
  equalValues,
  parseDocument,
} from '../firestore/document-store.js';
import type { InvoiceSnapshot } from '../stripe/stripe-client.js';
import type { AuditContext } from '../tenants/tenant-store.js';
import { type InvoiceDocument, invoiceSchema, type Tenant } from '../tenants/tenant.schema.js';

export type InvoiceRecordResult = 'created' | 'updated' | 'unchanged';

/** A URL da fatura hospedada só entra se for https (é o que a Stripe devolve); outra coisa fica de fora. */
function hostedUrl(value: string | null): string | undefined {
  if (value === null) return undefined;
  return invoiceSchema.shape.hostedInvoiceUrl.safeParse(value).success ? value : undefined;
}

/**
 * Faturas pagas em `tenants/{id}/invoices/{invoiceId}` (plano §3 e §4f). Cada `invoice.paid` grava a fatura como a
 * releitura a mostrou, com `nfse.status=manual` (a NFS-e é emitida à mão na v1; o resumo diário do CP-12 lista as
 * faturas sem nota). Gravar de novo a mesma fatura não duplica nem mexe em `nfse` (o responsável pode já tê-la
 * marcado como emitida). A auditoria leva o id, o motivo e o valor, nunca a URL da fatura.
 */
@Injectable()
export class InvoiceStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async record(
    tenantId: string,
    invoice: InvoiceSnapshot,
    paymentMethodType: NonNullable<Tenant['stripe']>['paymentMethodType'],
    context: AuditContext & { eventId: string },
  ): Promise<InvoiceRecordResult> {
    const collection = COLLECTIONS.invoices(tenantId);
    return this.store.runTransaction(async (tx) => {
      const data = await tx.get(collection, invoice.id);
      const existing =
        data === undefined ? undefined : parseDocument(invoiceSchema, collection, invoice.id, data);
      const now = this.clock.now();
      const next: InvoiceDocument = invoiceSchema.parse({
        amount: invoice.amountPaid,
        currency: invoice.currency,
        status: invoice.status ?? 'unknown',
        billingReason: invoice.billingReason ?? undefined,
        subscriptionId: invoice.subscriptionId ?? undefined,
        periodStart: invoice.periodStart ?? undefined,
        periodEnd: invoice.periodEnd ?? undefined,
        paidAt: invoice.paidAt ?? undefined,
        hostedInvoiceUrl: hostedUrl(invoice.hostedInvoiceUrl),
        paymentMethodType: existing?.paymentMethodType ?? paymentMethodType,
        nfse: existing?.nfse ?? { status: 'manual' },
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing?.updatedAt ?? now,
      });
      if (existing !== undefined && equalValues(next, existing)) return 'unchanged';
      tx.set(collection, invoice.id, { ...next, updatedAt: now });
      this.audit.record(tx, {
        actor: context.actor,
        action: existing === undefined ? 'billing.invoice_recorded' : 'billing.invoice_updated',
        tenantId,
        details: {
          invoiceId: invoice.id,
          billingReason: next.billingReason,
          status: next.status,
          amount: next.amount,
          currency: next.currency,
          nfse: next.nfse.status,
          eventId: context.eventId,
        },
        requestId: context.requestId,
      });
      return existing === undefined ? 'created' : 'updated';
    });
  }

  async list(tenantId: string): Promise<(InvoiceDocument & { id: string })[]> {
    const collection = COLLECTIONS.invoices(tenantId);
    const docs = await this.store.query(collection);
    return docs.map(({ id, data }) => ({ id, ...parseDocument(invoiceSchema, collection, id, data) }));
  }
}
