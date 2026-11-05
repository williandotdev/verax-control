import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  type EscalationContactInput,
  escalationContactInputSchema,
  type EscalationContactResponse,
  type EscalationLink,
  type EscalationLinkResult,
  escalationLinkSchema,
} from '@verax/shared';
import type { Request } from 'express';
import { Public, RequirePermission, SelfManaged } from '../auth/decorators.js';
import { EscalationContactService } from './escalation-contact.service.js';
import { EscalationLinkGuard } from './escalation-link.guard.js';
import { EscalationLinksService } from './escalation-links.service.js';

/** O contato de escalonamento do cliente da sessão (D8): só administradores; nenhuma rota recebe id de cliente. */
@Controller('escalation-contact')
export class EscalationContactController {
  constructor(private readonly contacts: EscalationContactService) {}

  @Get()
  @RequirePermission('escalation_contact:read')
  read(): Promise<EscalationContactResponse> {
    return this.contacts.read();
  }

  /** Troca o contato. Endereço novo volta a aguardar a confirmação, e o e-mail dela entra na fila. */
  @Put()
  @RequirePermission('escalation_contact:write')
  update(
    @Body({ schema: escalationContactInputSchema }) body: EscalationContactInput,
  ): Promise<EscalationContactResponse> {
    return this.contacts.update(body);
  }

  /** Pede a confirmação de novo, com o mesmo endereço (aguardando ou descadastrado). */
  @Post('confirmation')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('escalation_contact:write')
  requestConfirmation(): Promise<EscalationContactResponse> {
    return this.contacts.requestConfirmation();
  }
}

/**
 * Os links do e-mail ao contato de escalonamento, sem login (D8). A página pública do painel lê o token do fragmento e
 * o manda no corpo. O token é a credencial: sem sessão, sem CSRF de sessão, mas só da origem do painel, em JSON e com
 * limite por IP (`EscalationLinkGuard`).
 */
@Controller('public/escalation-contact')
@Public()
@SelfManaged(
  'O token do link é a credencial, validada pelo schema e pelo hash no banco; só a mudança de estado entra na trilha do cliente, e a recusa anônima fica no log (ninguém de fora enche a trilha)',
)
@UseGuards(EscalationLinkGuard)
export class EscalationLinksController {
  constructor(private readonly links: EscalationLinksService) {}

  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  confirm(
    @Body({ schema: escalationLinkSchema }) body: EscalationLink,
    @Req() request: Request,
  ): Promise<EscalationLinkResult> {
    return this.links.confirm(body.token, request);
  }

  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  unsubscribe(
    @Body({ schema: escalationLinkSchema }) body: EscalationLink,
    @Req() request: Request,
  ): Promise<EscalationLinkResult> {
    return this.links.unsubscribe(body.token, request);
  }
}
