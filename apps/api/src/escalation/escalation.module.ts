import { Module } from '@nestjs/common';
import { EscalationContactController, EscalationLinksController } from './escalation-contact.controller.js';
import { EscalationContactService } from './escalation-contact.service.js';
import { EscalationLinkGuard } from './escalation-link.guard.js';
import { EscalationLinksService } from './escalation-links.service.js';

/**
 * Contato de escalonamento do cliente (D8): a tela do administrador do cliente e os links públicos do e-mail
 * (confirmar e descadastrar). Os e-mails saem do worker, pela fila de saída (`notification-dispatcher.ts`).
 */
@Module({
  controllers: [EscalationContactController, EscalationLinksController],
  providers: [EscalationContactService, EscalationLinksService, EscalationLinkGuard],
})
export class EscalationModule {}
