import { type DynamicModule, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { InternalAccessController } from '../internal/internal-access.controller.js';
import { InternalStepsController } from '../internal/internal-steps.controller.js';
import { STEP_HANDLERS, type StepHandler } from '../internal/step-handler.js';
import { WorkerCallerGuard } from '../internal/worker-caller.js';
import { MAIL_SENDER, type MailSender, mailSenderFor } from '../mail/mail-sender.js';
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
}

/**
 * O lado do cp-worker do acesso do cliente (CP-05): a revelação única (`POST /internal/access/reveal`, só para o
 * cp-public), os passos `secrets.destroy_bootstrap` e `access.reveal_email` (`POST /internal/steps/:name`, só para as
 * tasks e o responsável) e o gatilho do plano B para o `tick` do CP-11 (`RevealEmailService.dispatchDue`). Só o
 * `cp-worker` registra este módulo: a conta dele é a que lê e destrói o `admin-bootstrap` e manda e-mail.
 */
@Module({})
export class AccessWorkerModule {
  static forRoot(options: AccessWorkerModuleOptions = {}): DynamicModule {
    return {
      module: AccessWorkerModule,
      imports: [AuditModule, TenantsModule, AccessModule],
      controllers: [InternalAccessController, InternalStepsController],
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
        {
          provide: STEP_HANDLERS,
          useFactory: (...handlers: StepHandler[]): StepHandler[] => handlers,
          inject: [DestroyBootstrapStep, RevealEmailStep],
        },
        WorkerCallerGuard,
      ],
      exports: [RevealEmailService],
    };
  }
}
