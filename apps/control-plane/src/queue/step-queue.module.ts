import { type DynamicModule, Global, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import type { EnvKey } from '../common/config/env.schema.js';
import { CloudTasksStepQueue, type CloudTasksSettings } from './cloud-tasks-step-queue.js';
import { STEP_QUEUE, type StepQueue, StepQueueUnavailableError, type StepTask } from './step-queue.js';

/** Variáveis sem as quais nada é enfileirado (plano §2.5, grupo "Estado e filas"). O Terraform deriva todas. */
export const STEP_QUEUE_REQUIRED = [
  'TASKS_PROJECT_ID',
  'TASKS_LOCATION',
  'TASKS_QUEUE_PROVISIONING',
  'TASKS_QUEUE_LIFECYCLE',
  'WORKER_URL',
  'WORKER_SA_EMAIL',
] as const satisfies readonly EnvKey[];

export type StepQueueSettingsResult =
  { ready: true; settings: CloudTasksSettings } | { ready: false; missing: readonly EnvKey[] };

export function resolveStepQueueSettings(config: AppConfig): StepQueueSettingsResult {
  const missing = STEP_QUEUE_REQUIRED.filter((key) => config[key] === undefined);
  const {
    TASKS_PROJECT_ID: projectId,
    TASKS_LOCATION: location,
    TASKS_QUEUE_PROVISIONING: provisioning,
    TASKS_QUEUE_LIFECYCLE: lifecycle,
    WORKER_URL: workerUrl,
    WORKER_SA_EMAIL: serviceAccountEmail,
  } = config;
  if (
    projectId === undefined ||
    location === undefined ||
    provisioning === undefined ||
    lifecycle === undefined ||
    workerUrl === undefined ||
    serviceAccountEmail === undefined
  ) {
    return { ready: false, missing };
  }
  return {
    ready: true,
    settings: { projectId, location, queues: { provisioning, lifecycle }, workerUrl, serviceAccountEmail },
  };
}

/** A fila sem configuração: toda chamada falha sem efeito, e quem chamou decide (o webhook responde 500). */
export class UnconfiguredStepQueue implements StepQueue {
  constructor(private readonly missing: readonly string[]) {}

  enqueue(_task: StepTask): Promise<never> {
    return Promise.reject(new StepQueueUnavailableError(this.missing));
  }
}

export const STEP_QUEUE_SETTINGS = Symbol('STEP_QUEUE_SETTINGS');

/** Avisa na partida quais variáveis da fila faltam, só pelos nomes. */
@Injectable()
class StepQueueStartupCheck implements OnModuleInit {
  constructor(
    @Inject(STEP_QUEUE_SETTINGS) private readonly settings: StepQueueSettingsResult,
    @InjectPinoLogger('StepQueue') private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    if (this.settings.ready) return;
    this.logger.warn(
      { event: 'step_queue_unconfigured', missing: this.settings.missing },
      'fila de passos sem configuração: o provisionamento não é enfileirado até ela ser preenchida',
    );
  }
}

export interface StepQueueModuleOptions {
  /** Só nos testes: o dublê em memória. Em produção, o Cloud Tasks pela configuração. */
  stepQueue?: StepQueue;
}

/** A fila de passos (Cloud Tasks), nos dois papéis: o cp-public enfileira o primeiro passo, o cp-worker os seguintes. */
@Global()
@Module({})
export class StepQueueModule {
  static forRoot(options: StepQueueModuleOptions = {}): DynamicModule {
    return {
      module: StepQueueModule,
      providers: [
        {
          provide: STEP_QUEUE_SETTINGS,
          useFactory: (config: AppConfig) => resolveStepQueueSettings(config),
          inject: [APP_CONFIG],
        },
        {
          provide: STEP_QUEUE,
          useFactory: (settings: StepQueueSettingsResult): StepQueue => {
            if (options.stepQueue !== undefined) return options.stepQueue;
            return settings.ready
              ? new CloudTasksStepQueue(settings.settings)
              : new UnconfiguredStepQueue(settings.missing);
          },
          inject: [STEP_QUEUE_SETTINGS],
        },
        StepQueueStartupCheck,
      ],
      exports: [STEP_QUEUE],
    };
  }
}
