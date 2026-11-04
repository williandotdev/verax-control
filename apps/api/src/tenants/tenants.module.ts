import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  imports: [UsersModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
