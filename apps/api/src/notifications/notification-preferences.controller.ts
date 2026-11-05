import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import {
  type NotificationPreferences,
  type NotificationPreferencesUpdate,
  notificationPreferencesUpdateSchema,
} from '@verax/shared';
import type { Request } from 'express';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { NotificationPreferencesService } from './notification-preferences.service.js';

/** A preferência de aviso por e-mail da própria pessoa (fase 2, PR-17'): ler e mudar, sempre a da sessão. */
@Controller('notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  @RequirePermission('notification_preferences:read')
  read(@Req() request: Request): Promise<NotificationPreferences> {
    return this.preferences.read(request.auth as RequestAuth);
  }

  @Put()
  @RequirePermission('notification_preferences:write')
  update(
    @Req() request: Request,
    @Body({ schema: notificationPreferencesUpdateSchema }) body: NotificationPreferencesUpdate,
  ): Promise<NotificationPreferences> {
    return this.preferences.update(request.auth as RequestAuth, body);
  }
}
