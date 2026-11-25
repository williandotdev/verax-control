import { Module } from '@nestjs/common';
import { CasesOperableGuard } from '../cases/cases.guard.js';
import { CaseExceptionsController, ScopedExceptionsController } from './scoped-exceptions.controller.js';
import { ScopedExceptionsService } from './scoped-exceptions.service.js';

/** Exceções a partir de um caso (casos, PR-9): as amplas e as de usuário, IP ou recurso em lote. */
@Module({
  controllers: [ScopedExceptionsController, CaseExceptionsController],
  providers: [ScopedExceptionsService, CasesOperableGuard],
})
export class ScopedExceptionsModule {}
