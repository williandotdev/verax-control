import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { AuditService } from '../common/audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { MAIL_TRANSPORT, type MailTransport } from '../mail/mail.types.js';
import { AuthController } from './auth.controller.js';
import { AUTH } from './auth.constants.js';
import { createAuth } from './auth.factory.js';
import { AuthClientConfigController } from './client-config.controller.js';
import { CSRF_UTILITIES, CsrfController, CsrfGuard, createCsrfUtilities } from './csrf.js';
import { MeController } from './me.controller.js';
import { PermissionsGuard } from './permissions.guard.js';
import { SessionTenantController } from './session-tenant.controller.js';
import { SessionGuard } from './session.guard.js';

@Global()
@Module({
  // A configuração pública vem antes do `AuthController`: o `*path` dele pegaria `/auth/client-config` (ordem do Express).
  controllers: [
    AuthClientConfigController,
    AuthController,
    MeController,
    CsrfController,
    SessionTenantController,
  ],
  providers: [
    {
      provide: AUTH,
      inject: [APP_CONFIG, PrismaService, PinoLogger, AuditService, MAIL_TRANSPORT],
      useFactory: (
        config: AppConfig,
        prisma: PrismaService,
        logger: PinoLogger,
        auditService: AuditService,
        mail: MailTransport,
      ) => {
        logger.setContext('BetterAuth');
        // Eventos de autenticação gravados fora de transação de requisição (o Better Auth tem as próprias).
        return createAuth({
          config,
          prisma,
          logger,
          mail,
          audit: (entry) => auditService.write(prisma, entry),
        });
      },
    },
    { provide: CSRF_UTILITIES, inject: [APP_CONFIG], useFactory: createCsrfUtilities },
    // A ordem importa: sessão, depois permissão (nega por padrão), depois CSRF (só em escrita autenticada).
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
