import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { RevealEmailService } from '../access/reveal-email.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { PROVISIONING_APIS, type ProvisioningApis } from '../provisioning/provisioning-settings.js';
import { ProvisioningStore } from '../provisioning/provisioning-store.js';
import { STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { STRIPE_CLIENT, type StripeClient } from '../stripe/stripe-client.js';
import { TenantStore } from '../tenants/tenant-store.js';
import type { TenantRecord } from '../tenants/tenant.schema.js';
import { GRACE_PERIOD_MS } from '../webhook/billing-rules.js';
import { DeletionEngine } from './deletion-engine.js';
import { DeletionService } from './deletion.service.js';
import {
  graceExpiredChange,
  mayHaveNode,
  NODE_RUNNING_STATES,
  NODE_STOPPED_STATES,
  scheduledCancelChange,
  unpaidCancelChange,
  unpaidCancelDueAt,
} from './lifecycle-rules.js';
import { NODE_START_STEP, NODE_STOP_STEP, requestNodePower } from './node-power-request.js';

/** As partes do `tick`, na ordem em que rodam. Cada uma é independente: a falha de uma não impede as outras. */
export const TICK_SECTIONS = [
  'grace',
  'unpaid',
  'contract_end',
  'deletion',
  'crypto_destroy',
  'deletion_redrive',
  'node_power',
  'activation',
  'reveal_email',
] as const;
export type TickSection = (typeof TICK_SECTIONS)[number];

export type TickSummary = Record<TickSection, number> & { failed: TickSection[] };

const ACCOUNTS_PATTERN = /^[0-9]{1,6}$/;
const SYSTEM = { actor: 'system' } as const;
/** Assinatura que ainda cobra uma dívida (a única que o `tick` cancela) e a já encerrada (só a transição). */
const DELINQUENT_SUBSCRIPTIONS = new Set(['past_due', 'unpaid']);
const ENDED_SUBSCRIPTIONS = new Set(['canceled', 'incomplete_expired']);

/** O status da Stripe no motivo do log: só letras e sublinhado. */
function statusLabel(status: string): string {
  return /^[a-z_]{1,32}$/.test(status) ? status : 'other';
}

/** Ainda suspenso por falta de pagamento, com os 30 dias vencidos. */
function unpaidCancelIsDue(tenant: TenantRecord, now: Date): boolean {
  const due = unpaidCancelDueAt(tenant);
  return due !== undefined && due.getTime() <= now.getTime();
}

/**
 * O `tick` horário (`POST /internal/tick`, Cloud Scheduler, plano §4b e §4d), o relógio do ciclo de vida. Em ordem:
 * 1. `past_due` com a carência vencida → `suspended` (`grace_expired`) e a VM para (D+7);
 * 2. suspenso por falta de pagamento há 30 dias → assinatura cancelada na Stripe → `canceled` (D+37);
 * 3. `canceled` com `deleteAfter` vencido → Exclusão 1 (`deleted`);
 * 4. Exclusão 1 terminada e `cryptoDestroyAfter` vencido → Exclusão 2;
 * 5. uma execução da exclusão em andamento tem o passo atual de volta na fila (a task perdida não para a exclusão);
 * 6. a VM de quem está suspenso ou cancelado e ainda não foi parada → `node.stop`; a VM que o plano de controle parou de
 *    quem voltou a pagar → `node.start`;
 * 7. `waiting_customer_connection` com `verax/accounts-connected >= 1` no nó → `active`;
 * 8. o plano B da revelação (`RevealEmailService.dispatchDue`, CP-05).
 * Nada aqui exclui um cliente fora de `canceled`, nem cancela quem não está suspenso por falta de pagamento: as regras
 * são as de `lifecycle-rules.ts`, decididas de novo dentro da transação de cada cliente.
 */
@Injectable()
export class TickService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly deletions: DeletionService,
    private readonly engine: DeletionEngine,
    private readonly runs: ProvisioningStore,
    private readonly revealEmails: RevealEmailService,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    @Inject(STRIPE_CLIENT) private readonly stripe: StripeClient | null,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(TickService.name) private readonly logger: PinoLogger,
  ) {}

  async run(): Promise<TickSummary> {
    const now = this.clock.now();
    const summary = {
      ...(Object.fromEntries(TICK_SECTIONS.map((section) => [section, 0])) as Record<TickSection, number>),
      failed: [] as TickSection[],
    };
    const sections: Record<TickSection, () => Promise<number>> = {
      grace: () => this.grace(now),
      unpaid: () => this.unpaid(now),
      contract_end: () => this.contractEnd(now),
      deletion: () => this.deletion(now),
      crypto_destroy: () => this.cryptoDestroy(now),
      deletion_redrive: () => this.redrive(),
      node_power: () => this.nodePower(),
      activation: () => this.activation(),
      reveal_email: async () => (await this.revealEmails.dispatchDue(now)).enqueued,
    };
    for (const section of TICK_SECTIONS) {
      try {
        summary[section] = await sections[section]();
      } catch (error) {
        summary.failed.push(section);
        this.logger.error(
          { event: 'tick_section_failed', section, error: error instanceof Error ? error.name : 'unknown' },
          'parte do tick falhou',
        );
      }
    }
    this.logger.info({ event: 'tick', ...summary }, 'tick');
    return summary;
  }

  private async grace(now: Date): Promise<number> {
    let count = 0;
    for (const tenant of await this.tenants.listInState('past_due', {
      due: { field: 'billing.graceUntil', at: now },
    })) {
      const result = await this.tenants.change(tenant.id, (current) =>
        graceExpiredChange(current, now, SYSTEM),
      );
      // A VM para pela parte `node_power`, na mesma passada.
      if (result.transitioned) count += 1;
    }
    return count;
  }

  /**
   * D+37: quem ficou 30 dias suspenso por falta de pagamento tem a assinatura cancelada na Stripe (idempotente) antes da
   * transição. Cancelar é destrutivo e a transição não o desfaz: um cliente que pagou perto de D+37 (o `invoice.paid`
   * já processado, ou ainda a caminho) não pode perder a assinatura. Por isso, logo antes de cancelar, tudo é conferido
   * de novo (`unpaidCancelCheck`); qualquer dúvida pula o cliente nesta passada (`event=unpaid_cancel_skipped`).
   */
  private async unpaid(now: Date): Promise<number> {
    let count = 0;
    for (const listed of await this.tenants.listInState('suspended')) {
      if (!unpaidCancelIsDue(listed, now)) continue;
      const check = await this.unpaidCancelCheck(listed.id, now);
      if (check.kind === 'skip') {
        this.logger.info(
          { event: 'unpaid_cancel_skipped', tenantId: listed.id, reason: check.reason },
          'cancelamento por falta de pagamento adiado',
        );
        continue;
      }
      if (check.kind === 'cancel' && this.stripe !== null) {
        await this.stripe.cancelSubscription(check.subscriptionId, `cancel-unpaid-${listed.id}`);
      }
      const result = await this.tenants.change(listed.id, (current) =>
        unpaidCancelChange(current, now, SYSTEM),
      );
      if (!result.transitioned) continue;
      count += 1;
      this.logger.info(
        { event: 'tenant_canceled_unpaid', tenantId: listed.id },
        'cancelado por falta de pagamento',
      );
    }
    return count;
  }

  /**
   * A conferência antes do cancelamento por falta de pagamento: o cliente relido ainda está suspenso por falta de
   * pagamento e no prazo; a assinatura relida na Stripe está `past_due` ou `unpaid` (já encerrada: só a transição, sem
   * chamada); há fatura em aberto (`open` ou `uncollectible`) há mais que a carência; e o cliente, relido de novo
   * depois das leituras da Stripe, continua igual. Uma fatura paga no meio deixa a assinatura `active` e nenhuma fatura
   * em aberto, e o cliente é pulado.
   */
  private async unpaidCancelCheck(
    tenantId: string,
    now: Date,
  ): Promise<
    { kind: 'cancel'; subscriptionId: string } | { kind: 'ended' } | { kind: 'skip'; reason: string }
  > {
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined || !unpaidCancelIsDue(tenant, now)) return { kind: 'skip', reason: 'not_due' };
    const subscriptionId = tenant.stripe?.subscriptionId;
    if (subscriptionId === undefined) return { kind: 'skip', reason: 'no_subscription' };
    if (this.stripe === null) return { kind: 'skip', reason: 'stripe_unconfigured' };
    const subscription = await this.stripe.retrieveSubscription(subscriptionId);
    if (ENDED_SUBSCRIPTIONS.has(subscription.status)) return { kind: 'ended' };
    if (!DELINQUENT_SUBSCRIPTIONS.has(subscription.status)) {
      return { kind: 'skip', reason: `subscription_${statusLabel(subscription.status)}` };
    }
    const owingSince = await this.stripe.oldestOutstandingInvoiceAt(subscriptionId);
    if (owingSince === undefined) return { kind: 'skip', reason: 'no_outstanding_invoice' };
    if (now.getTime() - owingSince.getTime() < GRACE_PERIOD_MS)
      return { kind: 'skip', reason: 'debt_too_recent' };
    const again = await this.tenants.get(tenantId);
    if (
      again === undefined ||
      !unpaidCancelIsDue(again, now) ||
      again.stripe?.subscriptionId !== subscriptionId
    ) {
      return { kind: 'skip', reason: 'changed_meanwhile' };
    }
    return { kind: 'cancel', subscriptionId };
  }

  /**
   * Contrato direto com o cancelamento marcado pelo responsável para uma data que chegou: cancelado com essa data (os
   * prazos da exclusão contam dela). É a única coisa que o relógio faz sozinho com um contrato direto, e só porque o
   * responsável marcou.
   */
  private async contractEnd(now: Date): Promise<number> {
    let count = 0;
    for (const tenant of await this.tenants.listCancelScheduled(now)) {
      const result = await this.tenants.change(tenant.id, (current) =>
        scheduledCancelChange(current, now, SYSTEM),
      );
      if (result.transitioned) count += 1;
    }
    return count;
  }

  private async deletion(now: Date): Promise<number> {
    let count = 0;
    for (const tenant of await this.tenants.listInState('canceled', {
      due: { field: 'lifecycle.deleteAfter', at: now },
    })) {
      if ((await this.deletions.startDeletion(tenant.id, 'schedule', SYSTEM)) !== undefined) count += 1;
    }
    return count;
  }

  private async cryptoDestroy(now: Date): Promise<number> {
    let count = 0;
    for (const tenant of await this.tenants.listInState('deleted', {
      due: { field: 'lifecycle.cryptoDestroyAfter', at: now },
    })) {
      if ((await this.deletions.startCryptoDestroy(tenant.id, SYSTEM)) !== undefined) count += 1;
    }
    return count;
  }

  /**
   * O passo atual de cada exclusão em andamento de volta na fila, com o número da próxima consulta: o id da task é o
   * mesmo da que já está lá (o Cloud Tasks recusa a repetida), e o motor ignora a que chegar fora de hora.
   */
  private async redrive(): Promise<number> {
    let count = 0;
    for (const tenant of await this.tenants.listWithLifecycleRun()) {
      const run = tenant.lifecycle?.run;
      if (tenant.state !== 'deleted') continue;
      if (run === undefined || run.lastError !== undefined) continue;
      const step = await this.runs.getStep(run.runId, run.step);
      if (step?.status === 'running') continue;
      await this.engine.enqueue(tenant.id, run.runId, run.step, step?.nextPoll);
      count += 1;
    }
    return count;
  }

  /**
   * A VM que deveria estar parada e não foi (ainda), e a que o plano de controle parou, ou mandou parar, de quem voltou a
   * pagar (`nodeStoppedAt` ou `nodeStopRequestedAt` num estado de VM ligada: o pedido de ligar pode ter se perdido).
   */
  private async nodePower(): Promise<number> {
    let count = 0;
    for (const state of NODE_STOPPED_STATES) {
      for (const tenant of await this.tenants.listInState(state)) {
        if (!mayHaveNode(tenant) || tenant.lifecycle?.nodeStoppedAt !== undefined) continue;
        await requestNodePower(this.queue, this.clock, tenant.id, NODE_STOP_STEP);
        count += 1;
      }
    }
    for (const tenant of await this.tenants.listNodeStopped()) {
      if (!NODE_RUNNING_STATES.includes(tenant.state) || !mayHaveNode(tenant)) continue;
      await requestNodePower(this.queue, this.clock, tenant.id, NODE_START_STEP);
      count += 1;
    }
    return count;
  }

  /** O nó viu a primeira conta conectada: `waiting_customer_connection` → `active` (plano §4b). */
  private async activation(): Promise<number> {
    let count = 0;
    for (const tenant of await this.tenants.listInState('waiting_customer_connection')) {
      const project = tenant.resources?.nodesProject;
      const zone = tenant.resources?.zone;
      const instance = tenant.resources?.instanceName;
      if (project === undefined || zone === undefined || instance === undefined) continue;
      if (tenant.lifecycle?.nodeStoppedAt !== undefined) continue;
      const attributes = await this.apis.compute.guestAttributes(project, zone, instance);
      const connected = attributes.get('accounts-connected') ?? '';
      if (!ACCOUNTS_PATTERN.test(connected) || Number(connected) < 1) continue;
      const result = await this.tenants.change(tenant.id, (current) =>
        current.state === 'waiting_customer_connection'
          ? { to: 'active', reason: 'accounts_connected', audit: SYSTEM }
          : undefined,
      );
      if (result.transitioned) count += 1;
    }
    return count;
  }
}
