import { Module } from '@nestjs/common';
import { AwsAccessKeyCheck } from '../aws/aws-key-check.js';
import { CloudflareTokenCheck } from '../cloudflare/cloudflare-token-check.js';
import { CredentialIntakeService } from '../credentials/credential-intake.service.js';
import { GcpServiceAccountKeyCheck } from '../gcp/gcp-key-check.js';
import { PlanModule } from '../plan/plan.module.js';
import { AwsOnboardingController } from './aws-onboarding.controller.js';
import { AwsOnboardingService } from './aws-onboarding.service.js';
import { CloudAccountsController } from './cloud-accounts.controller.js';
import { CloudAccountsService } from './cloud-accounts.service.js';
import { CloudCredentialsController } from './cloud-credentials.controller.js';

@Module({
  imports: [PlanModule],
  controllers: [CloudAccountsController, CloudCredentialsController, AwsOnboardingController],
  providers: [
    CloudAccountsService,
    AwsOnboardingService,
    CredentialIntakeService,
    // Sempre o host oficial do Cloudflare; os testes trocam o provider por um que aponta para um servidor falso local.
    { provide: CloudflareTokenCheck, useFactory: () => new CloudflareTokenCheck() },
    // As chaves de leitura da VM própria do cliente: o STS da AWS e o token do Google com o Pub/Sub, nos endereços
    // oficiais (os testes trocam pelos falsos). Só a VM própria as aceita; nos outros nós, nunca são chamadas.
    { provide: AwsAccessKeyCheck, useFactory: () => new AwsAccessKeyCheck() },
    { provide: GcpServiceAccountKeyCheck, useFactory: () => new GcpServiceAccountKeyCheck() },
  ],
})
export class CloudAccountsModule {}
