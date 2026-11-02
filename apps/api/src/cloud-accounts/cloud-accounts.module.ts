import { Module } from '@nestjs/common';
import { CloudAccountsController } from './cloud-accounts.controller.js';
import { CloudAccountsService } from './cloud-accounts.service.js';

@Module({
  controllers: [CloudAccountsController],
  providers: [CloudAccountsService],
})
export class CloudAccountsModule {}
