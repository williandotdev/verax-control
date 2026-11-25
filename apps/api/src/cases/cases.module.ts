import { Module } from '@nestjs/common';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { PlanModule } from '../plan/plan.module.js';
import { CaseSplitService } from './case-split.service.js';
import { CasesController, CaseStatusController, FindingTriageController } from './cases.controller.js';
import { CasesOperableGuard, CasesVisibleGuard } from './cases.guard.js';
import { CASE_READ_LIMITS, CasesService, DEFAULT_CASE_READ_LIMITS } from './cases.service.js';
import { CaseSplitController, TriageOperationsController } from './triage-operations.controller.js';
import {
  DEFAULT_TRIAGE_LIMITS,
  TRIAGE_LIMITS,
  TriageOperationsService,
} from './triage-operations.service.js';

/**
 * Os casos na API: a leitura, a triagem em massa e dividir um caso. A atribuição dos alertas e a fila das operações rodam
 * no worker (`case-tasks.ts`), fora do Nest.
 */
@Module({
  // O período e o intervalo do filtro não passam do histórico do plano; promover abre o incidente pelo módulo dele.
  imports: [PlanModule, IncidentsModule],
  // A situação antes de `cases/:id`, para "status" não ser lido como id.
  controllers: [
    CaseStatusController,
    CasesController,
    CaseSplitController,
    FindingTriageController,
    TriageOperationsController,
  ],
  providers: [
    CasesService,
    CaseSplitService,
    TriageOperationsService,
    CasesVisibleGuard,
    CasesOperableGuard,
    { provide: CASE_READ_LIMITS, useValue: DEFAULT_CASE_READ_LIMITS },
    { provide: TRIAGE_LIMITS, useValue: DEFAULT_TRIAGE_LIMITS },
  ],
})
export class CasesModule {}
