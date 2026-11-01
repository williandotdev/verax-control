import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { AuditService } from '../common/audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { AuthController } from './auth.controller.js';
import { AUTH } from './auth.constants.js';
import { createAuth } from './auth.factory.js';
import { CSRF_UTILITIES, CsrfController, CsrfGuard, createCsrfUtilities } from './csrf.js';
import { MeController } from './me.controller.js';
import { SessionGuard } from './session.guard.js';

@Global()
@Module({
  controllers: [AuthController, MeController, CsrfController],
  providers: [
    {
      provide: AUTH,
      inject: [APP_CONFIG, PrismaService, PinoLogger, AuditService],
      useFactory: (
        config: AppConfig,
        prisma: PrismaService,
        logger: PinoLogger,
        auditService: AuditService,
      ) => {
        logger.setContext('BetterAuth');
        // Eventos de autenticação gravados fora de transação de requisição (o Better Auth tem as próprias).
        return createAuth({ config, prisma, logger, audit: (entry) => auditService.write(prisma, entry) });
      },
    },
    { provide: CSRF_UTILITIES, inject: [APP_CONFIG], useFactory: createCsrfUtilities },
    // A ordem importa: primeiro a sessão, depois o CSRF (que só vale para requisições autenticadas).
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
