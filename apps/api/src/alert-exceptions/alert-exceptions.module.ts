import { Module } from '@nestjs/common';
import { AlertExceptionsController } from './alert-exceptions.controller.js';
import { AlertExceptionsService } from './alert-exceptions.service.js';

@Module({
  controllers: [AlertExceptionsController],
  providers: [AlertExceptionsService],
})
export class AlertExceptionsModule {}
