import type { Provider, Type } from '@nestjs/common';
import type { StepHandler } from '../internal/step-handler.js';
import { ContractService } from './contract.service.js';
import { DeletionEngine } from './deletion-engine.js';
import { DELETION_STEP_CLASSES } from './deletion-steps.js';
import { DeletionService } from './deletion.service.js';
import { ExportService } from './export.service.js';
import { LifecycleOwnerController, TickController } from './lifecycle.controller.js';
import { NodeStartStep, NodeStopStep } from './node-power.js';
import { TickService } from './tick.service.js';

/** Os passos do ciclo de vida (CP-11) na fila `lifecycle`: parar e ligar a VM e as duas exclusões. */
export const LIFECYCLE_STEP_CLASSES: readonly Type<StepHandler>[] = [
  NodeStopStep,
  NodeStartStep,
  ...DELETION_STEP_CLASSES,
];

/**
 * O ciclo de vida do cliente depois da venda (CP-11), só no cp-worker: o `tick`, a suspensão e a reativação da VM, as
 * duas exclusões e as operações do responsável (`delete-now` e `export`). Registrado pelo `AccessWorkerModule`, que já
 * tem a guarda das rotas internas, o e-mail, o plano B da revelação e as APIs do provisionamento.
 */
export const LIFECYCLE_PROVIDERS: readonly Provider[] = [
  ContractService,
  DeletionEngine,
  DeletionService,
  ExportService,
  TickService,
  ...LIFECYCLE_STEP_CLASSES,
];

export const LIFECYCLE_CONTROLLERS = [TickController, LifecycleOwnerController] as const;
