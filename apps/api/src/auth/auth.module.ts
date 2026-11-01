import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { AuthController } from './auth.controller.js';
import { AUTH } from './auth.constants.js';
import { createAuth } from './auth.factory.js';
import { MeController } from './me.controller.js';
import { SessionGuard } from './session.guard.js';

@Global()
@Module({
  controllers: [AuthController, MeController],
  providers: [
    {
      provide: AUTH,
      inject: [APP_CONFIG, PrismaService, PinoLogger],
      useFactory: (config: AppConfig, prisma: PrismaService, logger: PinoLogger) => {
        logger.setContext('BetterAuth');
        return createAuth({ config, prisma, logger });
      },
    },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
