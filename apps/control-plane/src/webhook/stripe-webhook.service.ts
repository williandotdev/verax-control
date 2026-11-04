import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import Stripe from 'stripe';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import type { EnvKey } from '../common/config/env.schema.js';
import { ApiError } from '../common/http/api-error.js';
import { StepQueueUnavailableError } from '../queue/step-queue.js';
import { describeStripeError, STRIPE_CLIENT, type StripeClient } from '../stripe/stripe-client.js';
import {
  type ProcessContext,
  type ProcessResult,
  ReservationMissingError,
  StripeEventProcessor,
} from './stripe-event-processor.js';
import { type StripeEventRecord, StripeEventStore } from './stripe-event-store.js';
import { isHandledEventType, type ReceivedEvent, stripeEventEnvelopeSchema } from './stripe-events.js';

/** Sem estas, o webhook responde 503 sem ler nada (a Stripe repete a entrega por até 3 dias). */
export const WEBHOOK_REQUIRED = [
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
] as const satisfies readonly EnvKey[];

/** Tolerância da assinatura (plano §2.3): o carimbo de tempo do cabeçalho pode ter até 300 s. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** O que um erro pode mostrar no log: de um erro da Stripe, tipo, código, status e id; de outro, nome e mensagem. */
function describeFailure(error: unknown): Record<string, unknown> {
  if (error instanceof Stripe.errors.StripeError) return describeStripeError(error);
  if (error instanceof Error) return { type: error.name, message: error.message };
  return { type: typeof error };
}

/** Motivo curto do `failed` em `stripeEvents`. */
function failureReason(error: unknown): string {
  if (error instanceof ReservationMissingError) return error.reason;
  if (error instanceof StepQueueUnavailableError) return 'step_queue_unavailable';
  if (error instanceof Stripe.errors.StripeError) return 'stripe_error';
  return 'internal_error';
}

/**
 * O webhook da Stripe (plano §4b), na ordem do plano: (1) assinatura no corpo bruto (`constructEvent`, 300 s); (2)
 * `stripeEvents/{event.id}` numa transação (repetido com desfecho final → 200 sem efeito); (3) releitura do objeto na
 * API; (4 e 5) transição numa transação com `transitions` e `auditLog`; (6) enfileirar; (7) 200.
 *
 * Desfechos: `applied`, `ignored` e `deferred` respondem 200; uma falha responde 500 e grava `failed`, e a Stripe
 * repete a entrega, que processa de novo (os efeitos são idempotentes). Assinatura inválida responde 400 sem tocar o
 * banco; evento de tipo não assinado ou do outro modo (teste × produção) responde 200 sem tocar o banco.
 *
 * Nenhum log leva o segredo, o corpo, o cabeçalho da assinatura, e-mail, CNPJ ou razão social: só ids, tipos e
 * desfechos.
 */
@Injectable()
export class StripeWebhookService implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient | null,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: StripeEventStore,
    private readonly processor: StripeEventProcessor,
    @InjectPinoLogger(StripeWebhookService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const missing = WEBHOOK_REQUIRED.filter((key) => this.config[key] === undefined);
    if (missing.length === 0) return;
    this.logger.warn(
      { event: 'webhook_unconfigured', missing },
      'webhook da Stripe desligado: configuração incompleta (responde 503 até ela ser preenchida)',
    );
  }

  async receive(payload: unknown, signature: unknown, requestId?: string): Promise<void> {
    const secret = this.config.STRIPE_WEBHOOK_SECRET;
    if (secret === undefined || this.stripe === null) {
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Webhook indisponível', 'webhook_unavailable');
    }
    const event = this.verify(payload, signature, secret, requestId);
    const parsed = stripeEventEnvelopeSchema.safeParse(event);
    if (!parsed.success) {
      this.logger.warn(
        { event: 'stripe_webhook_unexpected_payload' },
        'evento assinado fora do formato; ignorado',
      );
      return;
    }
    const { id, type, created, livemode, data } = parsed.data;
    if (!isHandledEventType(type)) {
      this.logger.debug(
        { event: 'stripe_webhook_unhandled', eventId: id, eventType: type },
        'evento não assinado',
      );
      return;
    }
    if (livemode !== this.config.STRIPE_LIVE) {
      this.logger.warn(
        { event: 'stripe_webhook_livemode_mismatch', eventId: id, eventType: type, livemode },
        'evento do outro modo da Stripe (teste × produção); ignorado',
      );
      return;
    }
    const received: ReceivedEvent = {
      id,
      type,
      objectId: data.object.id,
      livemode,
      created: new Date(created * 1000),
    };
    const claim = await this.events.claim(received);
    if (claim.status === 'duplicate') {
      this.logger.info(
        { event: 'stripe_webhook_duplicate', eventId: id, eventType: type, outcome: claim.outcome },
        'evento repetido: já processado, nada a fazer',
      );
      return;
    }
    if (claim.status === 'in_progress') {
      // Outra entrega do mesmo evento está processando agora: a Stripe repete esta mais tarde.
      throw new ApiError(HttpStatus.CONFLICT, 'Evento em processamento', 'event_in_progress');
    }
    await this.run(claim.record, requestId);
  }

  /** Assinatura no corpo bruto; recusada, 400 sem tocar o banco, com a linha que o alerta procura. */
  private verify(payload: unknown, signature: unknown, secret: string, requestId?: string): Stripe.Event {
    if (Buffer.isBuffer(payload) && typeof signature === 'string' && signature !== '') {
      try {
        return Stripe.webhooks.constructEvent(
          payload,
          signature,
          secret,
          SIGNATURE_TOLERANCE_SECONDS,
          undefined,
          this.clock.now().getTime(),
        );
      } catch {
        // A mensagem do SDK fica de fora: só a linha do alerta.
      }
    }
    // Pelo logger raiz: a linha do alerta (monitoring.tf) leva só o requestId, sem o `req` da requisição.
    PinoLogger.root.warn(
      { event: 'stripe_webhook_signature_failed', requestId, context: StripeWebhookService.name },
      'webhook da Stripe recusado: assinatura ausente ou inválida',
    );
    throw new ApiError(HttpStatus.BAD_REQUEST, 'Assinatura inválida', 'invalid_signature');
  }

  /** Processa a vez `record.attempts` do evento e grava o desfecho. Falha → `failed` e 500. */
  private async run(record: StripeEventRecord, requestId?: string): Promise<void> {
    const ctx: ProcessContext = {
      eventId: record.id,
      type: record.type,
      objectId: record.objectId,
      occurredAt: record.eventCreatedAt,
      requestId,
    };
    try {
      let result: ProcessResult = await this.processor.process(ctx);
      if (result.outcome === 'deferred') {
        const deferral = await this.events.defer(record.id, record.attempts, result);
        if (deferral !== 'tenant_exists') {
          this.logProcessed(ctx, deferral === 'deferred' ? 'deferred' : 'ignored', deferral, result.tenantId);
          return;
        }
        // O cliente nasceu entre a releitura e o adiamento: agora ele existe, e o evento se aplica a ele.
        result = await this.processor.process(ctx);
        if (result.outcome === 'deferred')
          throw new Error('o cliente existe, mas o evento ainda pede adiamento');
      }
      if (result.checkoutTenantId !== undefined) {
        await this.reprocessPending(result.checkoutTenantId, record.id, requestId);
      }
      await this.events.finish(record.id, record.attempts, {
        outcome: result.outcome,
        reason: result.reason,
        tenantId: result.tenantId,
      });
      this.logProcessed(ctx, result.outcome, result.reason, result.tenantId);
    } catch (error) {
      this.logger.error(
        {
          event: 'stripe_webhook_failed',
          eventId: record.id,
          eventType: record.type,
          attempt: record.attempts,
          failure: describeFailure(error),
        },
        'falha ao processar evento da Stripe; a Stripe repete a entrega',
      );
      try {
        await this.events.finish(record.id, record.attempts, {
          outcome: 'failed',
          reason: failureReason(error),
        });
      } catch (finishError) {
        // O processamento vence pelo prazo e a próxima entrega o retoma.
        this.logger.error(
          {
            event: 'stripe_webhook_record_failed',
            eventId: record.id,
            failure: describeFailure(finishError),
          },
          'não foi possível gravar a falha do evento',
        );
      }
      throw new ApiError(HttpStatus.INTERNAL_SERVER_ERROR, 'Erro interno', 'webhook_failed');
    }
  }

  /**
   * A reserva virou cliente: os eventos que esperavam por ele (adiados, ou que falharam ao ser reprocessados) são
   * processados agora, do mais antigo ao mais novo. Uma falha aqui faz a entrega do evento do Checkout falhar também,
   * para a Stripe repeti-la e o reprocessamento acontecer de novo.
   */
  private async reprocessPending(
    tenantId: string,
    currentEventId: string,
    requestId?: string,
  ): Promise<void> {
    for (const pending of await this.events.listPending(tenantId)) {
      if (pending.id === currentEventId) continue;
      const claim = await this.events.claimStored(pending.id);
      if (claim?.status !== 'claimed') continue;
      await this.run(claim.record, requestId);
    }
  }

  private logProcessed(ctx: ProcessContext, outcome: string, reason: string, tenantId?: string): void {
    this.logger.info(
      {
        event: 'stripe_webhook_processed',
        eventId: ctx.eventId,
        eventType: ctx.type,
        outcome,
        reason,
        tenantId,
      },
      'evento da Stripe processado',
    );
  }
}
