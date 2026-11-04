import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Put, Req } from '@nestjs/common';
import { type CloudAccount, type CloudCredentialInput, cloudCredentialInputSchema } from '@verax/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { CredentialIntakeService } from '../credentials/credential-intake.service.js';

const accountIdSchema = z.uuid();

/**
 * Credencial de leitura de uma conta cloud, no cofre do nó (fase 2): só administradores colam, trocam e removem
 * (`cloud_credentials:write`). Não há leitura do segredo: a conta mostra só os metadados (`keyStatus`).
 */
@Controller('cloud-accounts')
export class CloudCredentialsController {
  constructor(private readonly intake: CredentialIntakeService) {}

  /** Cola ou troca a credencial. Responde a conta, com os metadados da credencial nova. */
  @Put(':id/credential')
  @RequirePermission('cloud_credentials:write')
  put(
    @Req() request: Request,
    @Param('id', { schema: accountIdSchema }) id: string,
    @Body({ schema: cloudCredentialInputSchema }) body: CloudCredentialInput,
  ): Promise<CloudAccount> {
    return this.intake.put(request.auth as RequestAuth, id, body);
  }

  @Delete(':id/credential')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('cloud_credentials:write')
  remove(@Param('id', { schema: accountIdSchema }) id: string): Promise<void> {
    return this.intake.remove(id);
  }
}
