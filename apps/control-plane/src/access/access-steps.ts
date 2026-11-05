import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service.js';
import type { StepContext, StepHandler, StepInput } from '../internal/step-handler.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { BOOTSTRAP_SECRETS, type BootstrapSecrets } from './bootstrap-secrets.js';
import { REVEAL_EMAIL_STEP, RevealEmailService } from './reveal-email.service.js';
import { DESTROY_BOOTSTRAP_STEP } from './reveal.service.js';

/**
 * `secrets.destroy_bootstrap` (plano §4c, passo 10): destrói todas as versões do `vx-<slug>-admin-bootstrap` do
 * cliente (`versions.destroy`, permanente), com o `secretVersionManager` que o cp-worker tem nesse segredo. Só depois
 * da revelação: um cliente sem `access.passwordRevealedAt` não perde a senha que ainda não viu. Idempotente (sem
 * versão viva, nada a fazer); erro do Secret Manager faz a task repetir.
 */
@Injectable()
export class DestroyBootstrapStep implements StepHandler {
  readonly name = DESTROY_BOOTSTRAP_STEP;

  constructor(
    private readonly tenants: TenantStore,
    private readonly audit: AuditService,
    @Inject(BOOTSTRAP_SECRETS) private readonly secrets: BootstrapSecrets,
    @InjectPinoLogger(DestroyBootstrapStep.name) private readonly logger: PinoLogger,
  ) {}

  async run(input: StepInput, context: StepContext): Promise<string> {
    const tenant = await this.tenants.get(input.tenantId);
    if (tenant === undefined) return 'unknown_tenant';
    if (tenant.access?.passwordRevealedAt === undefined) {
      this.logger.warn(
        { event: 'destroy_bootstrap_not_revealed', tenantId: input.tenantId },
        'senha não revelada',
      );
      return 'not_revealed';
    }
    const versions = await this.secrets.destroyAll(tenant.slug);
    if (versions > 0) {
      await this.audit.write({
        actor: 'system',
        action: 'access.bootstrap_destroyed',
        tenantId: input.tenantId,
        details: { versions },
        requestId: context.requestId,
      });
    }
    this.logger.info(
      { event: 'bootstrap_destroyed', tenantId: input.tenantId, versions },
      'senha inicial destruída',
    );
    return versions > 0 ? 'destroyed' : 'nothing_to_destroy';
  }
}

/** `access.reveal_email`: o e-mail do plano B de um cliente (`RevealEmailService.send`). */
@Injectable()
export class RevealEmailStep implements StepHandler {
  readonly name = REVEAL_EMAIL_STEP;

  constructor(private readonly reveals: RevealEmailService) {}

  run(input: StepInput, context: StepContext): Promise<string> {
    return this.reveals.send(input.tenantId, context);
  }
}
