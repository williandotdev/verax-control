import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ID_TOKEN_KEY_SOURCE, type IdTokenKeySource } from '../internal/identity-token.js';
import { MetadataIdTokenSource } from '../status/id-token.js';
import { InternalNodeSyncController } from './internal-node-sync.controller.js';
import { NodeIdentityVerifier } from './node-identity.js';
import {
  NODE_SYNC_GATEWAY,
  type NodeSyncGateway,
  UnconfiguredNodeSyncGateway,
  WorkerNodeSyncGateway,
} from './node-sync-gateway.js';
import { NODE_SYNC_RATE_LIMITS_PROVIDER, NodeSyncController } from './node-sync.controller.js';
import { NodeSyncService } from './node-sync.service.js';

export interface NodeSyncModuleOptions {
  /** Só nos testes: o caminho até a sincronização sem HTTP (em produção, o cp-worker em `WORKER_URL`). */
  nodeSyncGateway?: NodeSyncGateway;
}

/**
 * A sincronização do nó dedicado, lado público. Só o `cp-public` registra este módulo; a sincronização em si (conferir
 * a credencial, escolher o cliente, ler e gravar o Firestore) roda no cp-worker (`NodeSyncService`), chamado em
 * `WORKER_URL` com o token de identidade do cp-public, como o registro da VM do cliente.
 */
@Module({})
export class NodeSyncModule {
  static forRoot(options: NodeSyncModuleOptions = {}): DynamicModule {
    return {
      module: NodeSyncModule,
      controllers: [NodeSyncController],
      providers: [
        NODE_SYNC_RATE_LIMITS_PROVIDER,
        {
          provide: NODE_SYNC_GATEWAY,
          useFactory: (config: AppConfig, clock: Clock): NodeSyncGateway => {
            if (options.nodeSyncGateway !== undefined) return options.nodeSyncGateway;
            return config.WORKER_URL === undefined
              ? new UnconfiguredNodeSyncGateway()
              : new WorkerNodeSyncGateway(config.WORKER_URL, new MetadataIdTokenSource(clock));
          },
          inject: [APP_CONFIG, CLOCK],
        },
      ],
    };
  }
}

/**
 * O lado do cp-worker, registrado pelo `AccessWorkerModule` (que já tem a guarda das rotas internas e as chaves do
 * Google, `ID_TOKEN_KEY_SOURCE`): `POST /internal/node-sync`, só para o cp-public.
 */
export const NODE_SYNC_WORKER_CONTROLLERS = [InternalNodeSyncController] as const;

export const NODE_SYNC_WORKER_PROVIDERS: readonly Provider[] = [
  {
    provide: NodeIdentityVerifier,
    useFactory: (keys: IdTokenKeySource, clock: Clock, config: AppConfig) =>
      new NodeIdentityVerifier(keys, clock, config.NODE_SYNC_AUDIENCE),
    inject: [ID_TOKEN_KEY_SOURCE, CLOCK, APP_CONFIG],
  },
  NodeSyncService,
];
