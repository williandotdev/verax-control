import { type DynamicModule, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import {
  GoogleIdTokenKeySource,
  ID_TOKEN_KEY_SOURCE,
  type IdTokenKeySource,
  IdentityTokenVerifier,
} from '../internal/identity-token.js';
import { InternalAccessController } from '../internal/internal-access.controller.js';
import { InternalStepsController } from '../internal/internal-steps.controller.js';
import { STEP_HANDLERS, type StepHandler } from '../internal/step-handler.js';
import { WorkerCallerGuard } from '../internal/worker-caller.js';
import {
  LIFECYCLE_CONTROLLERS,
  LIFECYCLE_PROVIDERS,
  LIFECYCLE_STEP_CLASSES,
} from '../lifecycle/lifecycle.module.js';
import { MAIL_SENDER, type MailSender, mailSenderFor } from '../mail/mail-sender.js';
import { NodeMailSyncController } from '../provisioning/node-mail.js';
import { ProvisioningResumeController } from '../provisioning/provisioning-resume.js';
import { ProvisioningStartController } from '../provisioning/provisioning-start.js';
import {
  PROVISIONING_STEP_HANDLERS,
  ProvisioningModule,
  type ProvisioningModuleOptions,
} from '../provisioning/provisioning.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { DestroyBootstrapStep, RevealEmailStep } from './access-steps.js';
import { AccessModule } from './access.module.js';
import {
  BOOTSTRAP_SECRETS,
  type BootstrapSecrets,
  SecretManagerBootstrapSecrets,
  UnconfiguredBootstrapSecrets,
} from './bootstrap-secrets.js';
import { RevealEmailService } from './reveal-email.service.js';
import { RevealService } from './reveal.service.js';

export interface AccessWorkerModuleOptions {
  /** Só nos testes: o cofre em memória (em produção, o Secret Manager do projeto dos nós). */
  bootstrapSecrets?: BootstrapSecrets;
  /** Só nos testes: o envio em memória (em produção, o SMTP da configuração). */
  mailSender?: MailSender;
  /** Só nos testes: as chaves de um "Google" gerado no teste (em produção, os certificados públicos do Google). */
  idTokenKeys?: IdTokenKeySource;
  /** Só nos testes: as APIs do provisionamento (CP-07) num servidor falso e a sonda em memória. */
  provisioning?: ProvisioningModuleOptions;
}

/**
 * O lado do cp-worker do acesso do cliente (CP-05): a revelação única (`POST /internal/access/reveal`, só para o
 * cp-public), os passos `secrets.destroy_bootstrap` e `access.reveal_email` (`POST /internal/steps/:name`, só para as
 * tasks e o responsável) e o gatilho do plano B para o `tick` do CP-11 (`RevealEmailService.dispatchDue`). Só o
 * `cp-worker` registra este módulo: a conta dele é a que lê e destrói o `admin-bootstrap` e manda e-mail. Desde o
 * CP-07, também os passos do provisionamento (`ProvisioningModule`) na mesma lista de passos, e o `resume` do
 * responsável (`POST /internal/tenants/:id/resume`), atrás da mesma guarda, como a recópia da senha do e-mail dos nós
 * (`POST /internal/nodes/smtp-password/sync`).
 */
@Module({})
export class AccessWorkerModule {
  static forRoot(options: AccessWorkerModuleOptions = {}): DynamicModule {
    return {
      module: AccessWorkerModule,
      imports: [AuditModule, TenantsModule, AccessModule, ProvisioningModule.forRoot(options.provisioning)],
      controllers: [
        InternalAccessController,
        InternalStepsController,
        ProvisioningResumeController,
        ProvisioningStartController,
        NodeMailSyncController,
        ...LIFECYCLE_CONTROLLERS,
      ],
      providers: [
        {
          provide: BOOTSTRAP_SECRETS,
          useFactory: (config: AppConfig): BootstrapSecrets =>
            options.bootstrapSecrets ??
            (config.NODES_PROJECT_ID === undefined
              ? new UnconfiguredBootstrapSecrets()
              : new SecretManagerBootstrapSecrets(config.NODES_PROJECT_ID)),
          inject: [APP_CONFIG],
        },
        {
          provide: MAIL_SENDER,
          useFactory: (config: AppConfig): MailSender => options.mailSender ?? mailSenderFor(config),
          inject: [APP_CONFIG],
        },
        RevealService,
        RevealEmailService,
        DestroyBootstrapStep,
        RevealEmailStep,
        ...LIFECYCLE_PROVIDERS,
        {
          provide: STEP_HANDLERS,
          useFactory: (
            destroy: StepHandler,
            revealEmail: StepHandler,
            provisioning: readonly StepHandler[],
            ...lifecycle: StepHandler[]
          ): StepHandler[] => [destroy, revealEmail, ...provisioning, ...lifecycle],
          inject: [
            DestroyBootstrapStep,
            RevealEmailStep,
            PROVISIONING_STEP_HANDLERS,
            ...LIFECYCLE_STEP_CLASSES,
          ],
        },
        {
          provide: ID_TOKEN_KEY_SOURCE,
          useFactory: (clock: Clock): IdTokenKeySource =>
            options.idTokenKeys ?? new GoogleIdTokenKeySource(clock),
          inject: [CLOCK],
        },
        {
          provide: IdentityTokenVerifier,
          useFactory: (keys: IdTokenKeySource, clock: Clock) => new IdentityTokenVerifier(keys, clock),
          inject: [ID_TOKEN_KEY_SOURCE, CLOCK],
        },
        WorkerCallerGuard,
      ],
      exports: [RevealEmailService],
    };
  }
}
