import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { InvoiceStore } from './invoice-store.js';
import { StripeEventProcessor } from './stripe-event-processor.js';
import { StripeEventStore } from './stripe-event-store.js';
import { StripeWebhookController } from './stripe-webhook.controller.js';
import { StripeWebhookService } from './stripe-webhook.service.js';

/**
 * Webhook da Stripe e máquina de estados do cliente (CP-04). Só o `cp-public` registra este módulo (`app.module.ts`);
 * o corpo bruto da rota vem de `raw-body.ts`, registrado em `app.setup.ts` só no mesmo papel. Usa o cliente da Stripe
 * do `StripeModule` e a fila de passos do `StepQueueModule`, ambos globais.
 */
@Module({
  imports: [AuditModule, TenantsModule, CheckoutModule],
  controllers: [StripeWebhookController],
  providers: [StripeEventStore, InvoiceStore, StripeEventProcessor, StripeWebhookService],
})
export class WebhookModule {}
