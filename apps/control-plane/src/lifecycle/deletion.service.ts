import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { newUlid } from '../common/ulid.js';
import { ProvisioningStore } from '../provisioning/provisioning-store.js';
import { type AuditContext, TenantStore } from '../tenants/tenant-store.js';
import type { DeletionRequester, LifecycleRunKind, TenantState } from '../tenants/tenant.schema.js';
import { DeletionEngine, LIFECYCLE_RUN_STEPS } from './deletion-engine.js';
import { canStartCryptoDestroy, startDeletionChange, startRunChange } from './lifecycle-rules.js';

export type DeleteNowOutcome =
  | { kind: 'started' | 'restarted'; runId: string; phase: LifecycleRunKind }
  | { kind: 'in_progress'; phase: LifecycleRunKind }
  | { kind: 'deleted'; cryptoDestroyAfter?: Date }
  | { kind: 'purged' }
  | { kind: 'not_found' }
  | { kind: 'confirmation_mismatch' }
  | { kind: 'not_canceled'; state: TenantState };

/**
 * Onde a exclusão começa (CP-11), e só aqui: `startDeletion` (o `tick` com `deleteAfter` vencido, ou o `delete-now`),
 * `startCryptoDestroy` (o `tick` com `cryptoDestroyAfter` vencido) e `deleteNow` (o responsável). Cada um decide
 * dentro de uma transação sobre o cliente relido (`lifecycle-rules.ts`): um cliente que não esteja `canceled` nunca
 * entra em `deleted`, e uma execução em andamento nunca é substituída.
 */
@Injectable()
export class DeletionService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly runs: ProvisioningStore,
    private readonly engine: DeletionEngine,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(DeletionService.name) private readonly logger: PinoLogger,
  ) {}

  /** `canceled` → `deleted` e a Exclusão 1 na fila. `undefined` se o cliente não pode (ou já começou). */
  async startDeletion(
    tenantId: string,
    by: DeletionRequester,
    audit: AuditContext,
  ): Promise<{ runId: string } | undefined> {
    const now = this.clock.now();
    const runId = newUlid(now.getTime());
    const firstStep = LIFECYCLE_RUN_STEPS.delete[0] ?? '';
    const result = await this.tenants.change(tenantId, (current) =>
      startDeletionChange(current, now, by, { runId, firstStep }, audit),
    );
    if (!result.transitioned) return undefined;
    await this.launch(tenantId, runId, 'delete', firstStep, by);
    return { runId };
  }

  /** A Exclusão 2 na fila, com `cryptoDestroyAfter` vencido e a Exclusão 1 terminada. */
  async startCryptoDestroy(tenantId: string, audit: AuditContext): Promise<{ runId: string } | undefined> {
    const now = this.clock.now();
    const runId = newUlid(now.getTime());
    const firstStep = LIFECYCLE_RUN_STEPS.crypto_destroy[0] ?? '';
    const result = await this.tenants.change(tenantId, (current) =>
      canStartCryptoDestroy(current, now)
        ? startRunChange(
            current,
            'crypto_destroy',
            now,
            { runId, firstStep },
            'crypto_destroy_scheduled',
            audit,
          )
        : undefined,
    );
    if (!result.changed) return undefined;
    await this.launch(tenantId, runId, 'crypto_destroy', firstStep, 'schedule');
    return { runId };
  }

  /**
   * `delete-now` do responsável. A confirmação é o subdomínio do cliente, digitado de novo: um id trocado não exclui o
   * cliente errado. Só um cliente `canceled` começa a Exclusão 1 (os outros estados: `not_canceled`, auditado). Num
   * cliente já `deleted`, nada novo começa (idempotente), a não ser a repetição de uma execução que parou com erro.
   * Não adianta a Exclusão 2: os backups saem pela retenção do bucket, contada do cancelamento.
   */
  async deleteNow(
    tenantId: string,
    confirmSlug: string,
    actor: string,
    requestId?: string,
  ): Promise<DeleteNowOutcome> {
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) return { kind: 'not_found' };
    const audit = { actor, requestId };
    if (confirmSlug !== tenant.slug) {
      await this.audit.write({
        ...audit,
        action: 'tenant.delete_now_refused',
        tenantId,
        details: { reason: 'confirmation_mismatch', state: tenant.state },
      });
      return { kind: 'confirmation_mismatch' };
    }
    if (tenant.state === 'canceled') {
      const started = await this.startDeletion(tenantId, 'owner', audit);
      if (started === undefined) return this.deleteNowAfterRace(tenantId);
      await this.audit.write({
        ...audit,
        action: 'tenant.delete_now_requested',
        tenantId,
        details: { runId: started.runId },
      });
      return { kind: 'started', runId: started.runId, phase: 'delete' };
    }
    if (tenant.state !== 'deleted') {
      await this.audit.write({
        ...audit,
        action: 'tenant.delete_now_refused',
        tenantId,
        details: { reason: 'not_canceled', state: tenant.state },
      });
      return { kind: 'not_canceled', state: tenant.state };
    }
    const lifecycle = tenant.lifecycle;
    if (lifecycle?.purgedAt !== undefined) return { kind: 'purged' };
    const run = lifecycle?.run;
    if (run !== undefined && run.lastError === undefined) return { kind: 'in_progress', phase: run.kind };
    if (run === undefined && lifecycle?.deletedAt !== undefined) {
      return { kind: 'deleted', cryptoDestroyAfter: lifecycle.cryptoDestroyAfter };
    }
    // A execução parou com erro (ou a Exclusão 1 nunca terminou): recomeça do primeiro passo da mesma fase.
    const phase: LifecycleRunKind = run?.kind ?? 'delete';
    const restarted = await this.restart(tenantId, phase, audit);
    if (restarted === undefined) return this.deleteNowAfterRace(tenantId);
    await this.audit.write({
      ...audit,
      action: 'tenant.delete_now_restarted',
      tenantId,
      details: { runId: restarted.runId, phase, previousError: run?.lastError?.code },
    });
    return { kind: 'restarted', runId: restarted.runId, phase };
  }

  private async restart(
    tenantId: string,
    kind: LifecycleRunKind,
    audit: AuditContext,
  ): Promise<{ runId: string } | undefined> {
    const now = this.clock.now();
    const runId = newUlid(now.getTime());
    const firstStep = LIFECYCLE_RUN_STEPS[kind][0] ?? '';
    const result = await this.tenants.change(tenantId, (current) =>
      startRunChange(current, kind, now, { runId, firstStep }, 'deletion_restarted', audit),
    );
    if (!result.changed) return undefined;
    await this.launch(tenantId, runId, kind, firstStep, 'owner');
    return { runId };
  }

  /** Outro pedido mudou o cliente entre a leitura e a transação: responde com o que ficou. */
  private async deleteNowAfterRace(tenantId: string): Promise<DeleteNowOutcome> {
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) return { kind: 'not_found' };
    const run = tenant.lifecycle?.run;
    if (tenant.state === 'deleted' && run !== undefined) return { kind: 'in_progress', phase: run.kind };
    if (tenant.state === 'deleted')
      return { kind: 'deleted', cryptoDestroyAfter: tenant.lifecycle?.cryptoDestroyAfter };
    return { kind: 'not_canceled', state: tenant.state };
  }

  private async launch(
    tenantId: string,
    runId: string,
    kind: LifecycleRunKind,
    firstStep: string,
    by: DeletionRequester,
  ): Promise<void> {
    await this.runs.ensureRun(runId, tenantId, kind);
    await this.engine.enqueue(tenantId, runId, firstStep);
    this.logger.info({ event: 'deletion_started', tenantId, runId, kind, by }, 'exclusão começou');
  }
}
