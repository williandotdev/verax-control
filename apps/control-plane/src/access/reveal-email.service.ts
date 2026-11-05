import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { MAIL_SENDER, type MailSender, MailUnavailableError } from '../mail/mail-sender.js';
import { STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { TenantStore } from '../tenants/tenant-store.js';
import {
  type AccessAuditContext,
  AccessStore,
  REVEAL_EMAIL_AFTER_MS,
  REVEAL_EMAIL_UNTIL_MS,
  REVEAL_STATE,
} from './access-store.js';
import { buildRevealEmail, revealLink, statusPageUrl } from './reveal-email.js';
import { tenantUrls } from './tenant-urls.js';

/** O passo que manda o e-mail do plano B a um cliente (fila `lifecycle`, id determinístico por tenant). */
export const REVEAL_EMAIL_STEP = 'access.reveal_email';

export type RevealEmailOutcome =
  'sent' | 'already_revealed' | 'already_sent' | 'not_waiting' | 'window_closed' | 'unknown_tenant';

export interface RevealEmailDispatch {
  /** Clientes no prazo, sem revelação e sem e-mail. */
  due: number;
  /** Tasks novas (uma repetida no mesmo intervalo do Cloud Tasks não conta). */
  enqueued: number;
}

/**
 * Plano B da revelação (plano §4c, passo 9): 48 h depois de o cliente entrar em `waiting_customer_connection` sem ver
 * a senha, um e-mail com um link de uso único (`statusTokens` do tipo `email_reveal`, 24 h) para a página de status.
 * O e-mail nunca leva a senha. Duas metades:
 * - `dispatchDue`, que o `tick` horário do CP-11 chama: acha os clientes no prazo e enfileira um passo por cliente;
 * - `send`, o passo `access.reveal_email` no cp-worker: confere de novo, cria o link, envia e marca
 *   `access.revealEmailSentAt` (só depois de enviar: uma falha do SMTP faz a task repetir, e o link criado e não
 *   enviado vence sozinho).
 */
@Injectable()
export class RevealEmailService {
  constructor(
    private readonly access: AccessStore,
    private readonly tenants: TenantStore,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(RevealEmailService.name) private readonly logger: PinoLogger,
  ) {}

  /** O gatilho do plano B, para o `tick` (CP-11): enfileira o e-mail de cada cliente no prazo. */
  async dispatchDue(now: Date = this.clock.now()): Promise<RevealEmailDispatch> {
    const due = await this.access.findDueForRevealEmail(now);
    let enqueued = 0;
    for (const tenant of due) {
      const result = await this.queue.enqueue({
        queue: 'lifecycle',
        step: REVEAL_EMAIL_STEP,
        tenantId: tenant.id,
        runId: tenant.id,
      });
      if (result.created) enqueued += 1;
    }
    if (due.length > 0) {
      this.logger.info(
        { event: 'reveal_email_dispatched', due: due.length, enqueued },
        'plano B enfileirado',
      );
    }
    return { due: due.length, enqueued };
  }

  /** O passo `access.reveal_email`. Sem SMTP ou sem a página de status, falha (a task repete). */
  async send(tenantId: string, context: AccessAuditContext = {}): Promise<RevealEmailOutcome> {
    const pageUrl = statusPageUrl(this.config.SITE_SUCCESS_URL);
    if (pageUrl === undefined) throw new MailUnavailableError();
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) return 'unknown_tenant';
    if (tenant.access?.passwordRevealedAt !== undefined) return 'already_revealed';
    if (tenant.access?.revealEmailSentAt !== undefined) return 'already_sent';
    if (tenant.state !== REVEAL_STATE || tenant.adminEmail === undefined) return 'not_waiting';
    const waitingMs = this.clock.now().getTime() - tenant.stateUpdatedAt.getTime();
    if (waitingMs < REVEAL_EMAIL_AFTER_MS || waitingMs >= REVEAL_EMAIL_UNTIL_MS) return 'window_closed';

    const link = await this.access.mint(tenantId, 'email_reveal', 'system', context);
    // O link é uma credencial: fica fora de qualquer linha de log enquanto o envio estiver em andamento.
    registerLiveSecret(link.value);
    try {
      await this.mail.send(
        buildRevealEmail({
          to: tenant.adminEmail,
          panelUrl: tenantUrls(tenant.slug, this.config).panelUrl,
          link: revealLink(pageUrl, link.value),
          linkExpiresAt: link.expiresAt,
        }),
      );
    } finally {
      forgetLiveSecret(link.value);
    }
    await this.access.markRevealEmailSent(tenantId, context);
    this.logger.info({ event: 'reveal_email_sent', tenantId }, 'e-mail do plano B enviado');
    return 'sent';
  }
}
