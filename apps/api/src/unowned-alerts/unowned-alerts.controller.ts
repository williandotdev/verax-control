import { Controller, Get, Query } from '@nestjs/common';
import {
  type Paginated,
  type UnownedAccounts,
  type UnownedAccountsQuery,
  unownedAccountsQuerySchema,
  type UnownedAlert,
  type UnownedAlertListQuery,
  unownedAlertListQuerySchema,
} from '@verax/shared';
import { RequirePermission } from '../auth/decorators.js';
import { UnownedAlertsService } from './unowned-alerts.service.js';

/** Fila de alertas sem dono (T5.2): só a equipe da Verax lê, com ou sem cliente escolhido. */
@Controller('unowned-alerts')
export class UnownedAlertsController {
  constructor(private readonly alerts: UnownedAlertsService) {}

  @Get()
  @RequirePermission('unowned_alerts:read')
  list(
    @Query({ schema: unownedAlertListQuerySchema }) query: UnownedAlertListQuery,
  ): Promise<Paginated<UnownedAlert>> {
    return this.alerts.list(query);
  }

  @Get('accounts')
  @RequirePermission('unowned_alerts:read')
  accounts(
    @Query({ schema: unownedAccountsQuerySchema }) query: UnownedAccountsQuery,
  ): Promise<UnownedAccounts> {
    return this.alerts.accounts(query);
  }
}
