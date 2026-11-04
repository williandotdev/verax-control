import { z } from 'zod';
import { stripeIdSchema } from '../tenants/tenant.schema.js';

/**
 * Os 13 eventos assinados no endpoint do webhook (plano §4b). Os mesmos, na mesma ordem, saem do `stripe-setup`
 * (`WEBHOOK_EVENTS`, conferido por teste). Qualquer outro tipo recebe 200 sem tocar o banco.
 */
export const HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'radar.early_fraud_warning.created',
  'customer.updated',
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(value: string): value is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Eventos de dinheiro: chegando para um cliente que o plano de controle não conhece, viram alerta ao responsável
 * (plano §4b, "eventos de tenant desconhecido → ignored com alerta se forem de pagamento").
 */
export const PAYMENT_EVENT_TYPES: ReadonlySet<HandledEventType> = new Set<HandledEventType>([
  'checkout.session.async_payment_succeeded',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'radar.early_fraud_warning.created',
]);

/**
 * O pouco do evento assinado que o webhook lê: id, tipo, data, modo e o id do objeto. O resto do corpo nunca é usado
 * nem guardado: o objeto que decide é relido na API da Stripe (plano §4b, passo 3).
 */
export const stripeEventEnvelopeSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{1,250}$/),
  type: z.string().min(1).max(100),
  created: z.number().int().positive(),
  livemode: z.boolean(),
  data: z.object({ object: z.object({ id: stripeIdSchema }) }),
});

export interface ReceivedEvent {
  id: string;
  type: HandledEventType;
  objectId: string;
  livemode: boolean;
  /** Quando aconteceu, segundo a Stripe (o `created` assinado). Os prazos de cobrança contam daqui. */
  created: Date;
}
