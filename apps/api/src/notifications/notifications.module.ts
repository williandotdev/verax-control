import { Module } from '@nestjs/common';
import { NotificationPreferencesController } from './notification-preferences.controller.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';

/**
 * A parte dos avisos por e-mail que a API serve: a preferência da própria pessoa (fase 2, PR-17'). A fila de saída e a
 * entrega rodam no worker (`notification-dispatcher.ts`).
 */
@Module({
  controllers: [NotificationPreferencesController],
  providers: [NotificationPreferencesService],
})
export class NotificationsModule {}
