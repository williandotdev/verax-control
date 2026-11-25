import { type CanActivate, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { WEB_LOGS_DISABLED_CODE } from '@verax/shared';
import { APP_CONFIG, type AppConfig } from '../../common/config/config.module.js';
import { awsSourceFeatures } from '../../common/config/web-logs.js';
import { ApiError } from '../../common/http/api-error.js';

/**
 * As rotas de `/v1/web-logs` só existem no nó com os ataques web ligados. Desligado, 404 para quem tem sessão e permissão
 * (os guards globais vêm antes: sem sessão, 401; sem permissão, 403), antes de o corpo ser conferido e de qualquer leitura.
 * No controller inteiro, e não rota a rota: uma rota nova já nasce atrás dele.
 */
@Injectable()
export class WebLogsEnabledGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(): boolean {
    if (awsSourceFeatures(this.config).webLogs) return true;
    throw new ApiError(
      HttpStatus.NOT_FOUND,
      'Os ataques web pelos logs do balanceador não estão ligados neste ambiente.',
      WEB_LOGS_DISABLED_CODE,
    );
  }
}
