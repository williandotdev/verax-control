import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { type AccessAuditContext, AccessStore, type RevealClaim } from './access-store.js';
import {
  BOOTSTRAP_SECRETS,
  type BootstrapCredentials,
  type BootstrapSecrets,
  BootstrapUnavailableError,
} from './bootstrap-secrets.js';
import type { StatusTokenKind } from './status-token.js';
import { tenantUrls } from './tenant-urls.js';

/** O passo que destrói as versões do `admin-bootstrap` depois da revelação (plano §4c, passo 10). */
export const DESTROY_BOOTSTRAP_STEP = 'secrets.destroy_bootstrap';

/** O que a revelação entrega, uma vez: o painel, o login e a senha temporária (e até quando ela vale). */
export interface RevealedAccess {
  panelUrl: string;
  adminEmail: string;
  password: string;
  passwordExpiresAt: Date;
}

/** Nada foi mostrado e a marcação foi desfeita (ou nem foi feita): o cliente pode tentar de novo. */
export class RevealUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`revelação indisponível: ${reason}`);
    this.name = 'RevealUnavailableError';
  }
}

/** A senha temporária já venceu: nada foi mostrado, a marcação foi desfeita, e o responsável renova (plano §10.7). */
export class PasswordExpiredError extends Error {
  constructor() {
    super('a senha temporária já venceu');
    this.name = 'PasswordExpiredError';
  }
}

function grpcCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

/**
 * A revelação única (plano §4c, passo 10), no cp-worker, com a identidade dele (a única com `secretAccessor` no
 * `admin-bootstrap` de cada tenant). Em ordem:
 * 1. a transação marca `access.passwordRevealedAt` (e o uso do link do e-mail) antes de qualquer leitura: a segunda
 *    revelação recebe 409, mesmo ao mesmo tempo;
 * 2. lê a versão `latest` do segredo; a senha entra na máscara do logger antes do próximo `await`;
 * 3. enfileira `secrets.destroy_bootstrap` (fila `lifecycle`, id determinístico por tenant) **antes** de responder:
 *    se a resposta se perder no caminho, a versão é destruída do mesmo jeito;
 * 4. devolve painel, login e senha. A auditoria `access.revealed` entrou na transação do passo 1.
 * Se o passo 2 ou o 3 falhar, ou a senha já tiver vencido, nada foi mostrado: a marcação é desfeita
 * (`access.reveal_reverted`) e o cliente pode tentar de novo.
 */
@Injectable()
export class RevealService {
  constructor(
    private readonly access: AccessStore,
    @Inject(BOOTSTRAP_SECRETS) private readonly secrets: BootstrapSecrets,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(RevealService.name) private readonly logger: PinoLogger,
  ) {}

  async reveal(
    kind: StatusTokenKind,
    value: string,
    context: AccessAuditContext = {},
  ): Promise<RevealedAccess> {
    // Sem o projeto dos nós não há de onde ler: recusa antes de marcar.
    if (this.config.NODES_PROJECT_ID === undefined) {
      this.logger.warn(
        { event: 'reveal_unconfigured', missing: ['NODES_PROJECT_ID'] },
        'revelação sem configuração',
      );
      throw new RevealUnavailableError('unconfigured');
    }
    const claim = await this.access.claimReveal(value, kind, context);
    const tenantId = claim.tenant.id;

    let credentials: BootstrapCredentials;
    try {
      credentials = await this.secrets.readLatest(claim.tenant.slug);
      registerLiveSecret(credentials.password);
    } catch (error) {
      const reason =
        error instanceof BootstrapUnavailableError ? `secret_${error.reason}` : 'secret_read_failed';
      // Só o código do erro: a mensagem do Secret Manager cita o nome do segredo (com o slug e o projeto).
      this.logger.error(
        { event: 'reveal_secret_unavailable', tenantId, reason, grpcCode: grpcCodeOf(error) },
        'senha inicial indisponível; revelação desfeita',
      );
      await this.undo(claim, reason, context);
      throw new RevealUnavailableError(reason);
    }

    if (credentials.expiresAt.getTime() <= this.clock.now().getTime()) {
      forgetLiveSecret(credentials.password);
      this.logger.warn({ event: 'reveal_password_expired', tenantId }, 'senha temporária vencida');
      await this.undo(claim, 'password_expired', context);
      throw new PasswordExpiredError();
    }

    try {
      await this.queue.enqueue({
        queue: 'lifecycle',
        step: DESTROY_BOOTSTRAP_STEP,
        tenantId,
        runId: tenantId,
      });
    } catch (error) {
      forgetLiveSecret(credentials.password);
      this.logger.error(
        { event: 'reveal_destroy_not_enqueued', tenantId, err: error },
        'a destruição da senha inicial não entrou na fila; revelação desfeita',
      );
      await this.undo(claim, 'destroy_not_enqueued', context);
      throw new RevealUnavailableError('destroy_not_enqueued');
    }

    if (credentials.email.toLowerCase() !== claim.tenant.adminEmail?.toLowerCase()) {
      // O e-mail do cliente mudou depois do provisionamento (customer.updated) ou o segredo é de outra conta: a
      // revelação segue com o login do segredo, e o responsável confere. Nenhum dos dois e-mails vai ao log.
      this.logger.warn(
        { event: 'reveal_admin_email_differs', tenantId },
        'login do segredo difere do cadastro',
      );
    }
    this.logger.info({ event: 'access_revealed', tenantId, via: kind }, 'senha inicial revelada');
    return {
      panelUrl: tenantUrls(claim.tenant.slug, this.config).panelUrl,
      adminEmail: credentials.email,
      password: credentials.password,
      passwordExpiresAt: credentials.expiresAt,
    };
  }

  /** Desfaz a marcação; se nem isso der, o responsável precisa saber (o cliente veria "senha já mostrada"). */
  private async undo(claim: RevealClaim, reason: string, context: AccessAuditContext): Promise<void> {
    try {
      await this.access.revertReveal(claim, reason, context);
    } catch (error) {
      this.logger.error(
        { event: 'reveal_revert_failed', tenantId: claim.tenant.id, reason, err: error },
        'não foi possível desfazer a marcação da revelação',
      );
    }
  }
}
