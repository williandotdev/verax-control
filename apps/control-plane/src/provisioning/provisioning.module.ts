import { type DynamicModule, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import type { StepHandler } from '../internal/step-handler.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { ProvisioningEngine } from './provisioning-engine.js';
import { ProvisioningResumeService } from './provisioning-resume.js';
import {
  createProvisioningApis,
  PROVISIONING_APIS,
  type ProvisioningApiOptions,
  resolveProvisioningSettings,
} from './provisioning-settings.js';
import { PROVISIONING_STEP_CLASSES } from './provisioning-steps.js';
import { ProvisioningStore } from './provisioning-store.js';

/** Os dez passos do provisionamento, para a lista `STEP_HANDLERS` do cp-worker. */
export const PROVISIONING_STEP_HANDLERS = Symbol('PROVISIONING_STEP_HANDLERS');

/** Avisa na partida, só pelos nomes, que o provisionamento está desligado ou incompleto. */
@Injectable()
class ProvisioningStartupCheck implements OnModuleInit {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger('Provisioning') private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const result = resolveProvisioningSettings(this.config);
    if (result.ready) return;
    this.logger.warn(
      { event: 'provisioning_unconfigured', missing: result.missing },
      'provisionamento desligado: o preflight para cada cliente com provisioning_disabled até a configuração existir',
    );
  }
}

export interface ProvisioningModuleOptions {
  /** Só nos testes: as APIs num servidor falso em 127.0.0.1, o token falso e a sonda em memória. */
  apis?: ProvisioningApiOptions;
}

/**
 * O provisionamento (CP-07), só no cp-worker: os passos 1 a 10 do plano §4c (`provisioning-steps.ts`), o motor que os
 * encadeia (`provisioning-engine.ts`), o repositório das execuções e o `resume` do responsável. O controlador do
 * `resume` fica no módulo das rotas internas (`AccessWorkerModule`), junto da guarda de quem chama.
 */
@Module({})
export class ProvisioningModule {
  static forRoot(options: ProvisioningModuleOptions = {}): DynamicModule {
    return {
      module: ProvisioningModule,
      imports: [TenantsModule],
      providers: [
        ProvisioningStore,
        ProvisioningEngine,
        ProvisioningResumeService,
        ProvisioningStartupCheck,
        { provide: PROVISIONING_APIS, useFactory: () => createProvisioningApis(options.apis) },
        ...PROVISIONING_STEP_CLASSES,
        {
          provide: PROVISIONING_STEP_HANDLERS,
          useFactory: (...steps: StepHandler[]): StepHandler[] => steps,
          inject: [...PROVISIONING_STEP_CLASSES],
        },
      ],
      exports: [PROVISIONING_STEP_HANDLERS, ProvisioningResumeService, ProvisioningStore],
    };
  }
}
