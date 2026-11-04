import { Module } from '@nestjs/common';
import { CloudflareTokenCheck } from '../cloudflare/cloudflare-token-check.js';
import { CredentialIntakeService } from '../credentials/credential-intake.service.js';
import { CloudAccountsController } from './cloud-accounts.controller.js';
import { CloudAccountsService } from './cloud-accounts.service.js';
import { CloudCredentialsController } from './cloud-credentials.controller.js';

@Module({
  controllers: [CloudAccountsController, CloudCredentialsController],
  providers: [
    CloudAccountsService,
    CredentialIntakeService,
    // Sempre o host oficial do Cloudflare; os testes trocam o provider por um que aponta para um servidor falso local.
    { provide: CloudflareTokenCheck, useFactory: () => new CloudflareTokenCheck() },
  ],
})
export class CloudAccountsModule {}
