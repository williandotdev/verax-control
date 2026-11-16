import type { Provider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { PROVISIONING_APIS, type ProvisioningApis } from '../provisioning/provisioning-settings.js';
import { type FleetCloud, GoogleFleetCloud } from './fleet-cloud.js';
import { FLEET_CLOUD, FLEET_SETTINGS, type FleetSettings, resolveFleetSettings } from './fleet-settings.js';
import { FleetStore } from './fleet-store.js';
import { FleetService } from './fleet.service.js';
import { InternalFleetController } from './internal-fleet.controller.js';
import { FleetTickStep, RolloutEngine } from './rollout-engine.js';

/**
 * A atualização da frota no cp-worker (`AccessWorkerModule`, que já tem a guarda das rotas internas, a auditoria, os
 * clientes, as células e as APIs do provisionamento): as rotas do responsável, o motor e a volta dele (`fleet.tick`, na
 * lista de passos). `cloud` troca as APIs do Google por um dublê (só nos testes).
 */
export const FLEET_CONTROLLERS = [InternalFleetController];

export function fleetProviders(cloud?: FleetCloud): Provider[] {
  return [
    FleetStore,
    RolloutEngine,
    FleetService,
    FleetTickStep,
    {
      provide: FLEET_SETTINGS,
      useFactory: (config: AppConfig): FleetSettings | null => resolveFleetSettings(config) ?? null,
      inject: [APP_CONFIG],
    },
    {
      provide: FLEET_CLOUD,
      useFactory: (settings: FleetSettings | null, apis: ProvisioningApis): FleetCloud | null =>
        cloud ?? (settings === null ? null : new GoogleFleetCloud(apis, settings.releaseBucket)),
      inject: [FLEET_SETTINGS, PROVISIONING_APIS],
    },
  ];
}
