import { Module } from '@nestjs/common';
import { PlanModule } from '../plan/plan.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [PlanModule],
  controllers: [UsersController],
  providers: [UsersService],
  // O cadastro de clientes cria o primeiro administrador pelo mesmo caminho (senha temporária incluída).
  exports: [UsersService],
})
export class UsersModule {}
