import { Module } from '@nestjs/common';
import { IncidentsController } from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';

@Module({
  controllers: [IncidentsController],
  providers: [IncidentsService],
  // A triagem em massa abre o incidente por aqui.
  exports: [IncidentsService],
})
export class IncidentsModule {}
