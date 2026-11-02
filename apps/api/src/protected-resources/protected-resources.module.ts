import { Module } from '@nestjs/common';
import { ProtectedResourcesController } from './protected-resources.controller.js';
import { ProtectedResourcesService } from './protected-resources.service.js';

@Module({
  controllers: [ProtectedResourcesController],
  providers: [ProtectedResourcesService],
})
export class ProtectedResourcesModule {}
