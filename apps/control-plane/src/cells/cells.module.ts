import type { Provider } from '@nestjs/common';
import { GoogleAccessTokenSource } from '../provisioning/cloud-http.js';
import { CellCommandPublisher } from './cell-command-publisher.js';
import { CELL_COMMAND_SINK, type CellCommandSink, PubsubCommandSink } from './cell-pubsub.js';
import { CellReportsService } from './cell-reports.service.js';
import { CellStore } from './cell-store.js';
import { InternalCellsController } from './internal-cells.controller.js';

/**
 * O lado do plano de controle do canal da célula (CE-06), registrado só no cp-worker (`AccessWorkerModule`), que já tem
 * a guarda das rotas internas: a rota que recebe os relatórios e o publicador dos comandos. `sink` troca a publicação
 * no Pub/Sub por um dublê (só nos testes).
 */
export const CELL_CONTROLLERS = [InternalCellsController];

export function cellProviders(sink?: CellCommandSink): Provider[] {
  return [
    CellStore,
    CellReportsService,
    CellCommandPublisher,
    {
      provide: CELL_COMMAND_SINK,
      useFactory: (): CellCommandSink => sink ?? new PubsubCommandSink(new GoogleAccessTokenSource()),
    },
  ];
}
