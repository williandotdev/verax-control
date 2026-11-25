import { Module } from '@nestjs/common';
import { PlanModule } from '../plan/plan.module.js';
import { CasesController, CaseStatusController, FindingTriageController } from './cases.controller.js';
import { CasesVisibleGuard } from './cases.guard.js';
import { CASE_READ_LIMITS, CasesService, DEFAULT_CASE_READ_LIMITS } from './cases.service.js';

/** A leitura dos casos na API. A atribuição dos alertas roda no worker (`case-tasks.ts`), fora do Nest. */
@Module({
  // O período e o intervalo do filtro não passam do histórico do plano.
  imports: [PlanModule],
  // A situação antes de `cases/:id`, para "status" não ser lido como id.
  controllers: [CaseStatusController, CasesController, FindingTriageController],
  providers: [
    CasesService,
    CasesVisibleGuard,
    { provide: CASE_READ_LIMITS, useValue: DEFAULT_CASE_READ_LIMITS },
  ],
})
export class CasesModule {}
