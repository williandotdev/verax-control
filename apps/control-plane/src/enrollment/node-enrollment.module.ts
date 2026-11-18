import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { MetadataIdTokenSource } from '../status/id-token.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import {
  ENROLLMENT_GATEWAY,
  type EnrollmentGateway,
  UnconfiguredEnrollmentGateway,
  WorkerEnrollmentGateway,
} from './enrollment-gateway.js';
import { ENROLLMENT_RATE_LIMITS_PROVIDER, NodeEnrollmentController } from './node-enrollment.controller.js';

export interface NodeEnrollmentModuleOptions {
  /** Só nos testes: o caminho até o registro sem HTTP (em produção, o cp-worker em `WORKER_URL`). */
  enrollmentGateway?: EnrollmentGateway;
}

/**
 * O registro da VM do cliente, lado público. Só o `cp-public` registra este módulo; o registro em si (o código, o token
 * do túnel, o cofre) roda no cp-worker (`EnrollmentService`), chamado em `WORKER_URL` com o token de identidade do
 * cp-public, como a revelação da página de status.
 */
@Module({})
export class NodeEnrollmentModule {
  static forRoot(options: NodeEnrollmentModuleOptions = {}): DynamicModule {
    return {
      module: NodeEnrollmentModule,
      imports: [TenantsModule],
      controllers: [NodeEnrollmentController],
      providers: [
        ENROLLMENT_RATE_LIMITS_PROVIDER,
        {
          provide: ENROLLMENT_GATEWAY,
          useFactory: (config: AppConfig, clock: Clock): EnrollmentGateway => {
            if (options.enrollmentGateway !== undefined) return options.enrollmentGateway;
            return config.WORKER_URL === undefined
              ? new UnconfiguredEnrollmentGateway()
              : new WorkerEnrollmentGateway(config.WORKER_URL, new MetadataIdTokenSource(clock));
          },
          inject: [APP_CONFIG, CLOCK],
        },
      ],
    };
  }
}
