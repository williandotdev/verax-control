import { Injectable } from '@nestjs/common';
import type { EscalationContactInput, EscalationContactResponse } from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import {
  ESCALATION_SELECT,
  type EscalationRow,
  escalationContactUpdate,
  queueEscalationConfirmation,
  readEscalationContact,
  restartEscalationConfirmation,
} from './escalation-contact-store.js';

/**
 * O contato de escalonamento do cliente da sessão (D8), na tela do administrador do cliente: ler, trocar e pedir a
 * confirmação de novo. Sempre pelo escopo do cliente da sessão (a rota não recebe id de cliente). A equipe da Verax
 * chega aqui com um cliente selecionado; sem ele, o escopo recusa. Cada mudança entra na trilha do cliente com o estado
 * anterior e o novo.
 */
@Injectable()
export class EscalationContactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async read(): Promise<EscalationContactResponse> {
    const db = this.prisma.scoped();
    return { contact: await readEscalationContact(db, await this.current(db)) };
  }

  /** Troca o contato. Endereço novo volta a aguardar a confirmação, e o e-mail dela entra na fila. */
  async update(input: EscalationContactInput): Promise<EscalationContactResponse> {
    const db = this.prisma.scoped();
    const found = await this.current(db);
    const before = await readEscalationContact(db, found);
    const { data, restart } = escalationContactUpdate(found, input);
    const row = await db.tenant.update({ where: { id: found.id }, data, select: ESCALATION_SELECT });
    if (restart) await queueEscalationConfirmation(db, row.escalationGeneration, new Date());
    const contact = await readEscalationContact(db, row);
    this.audit.describe({
      action: 'escalation_contact.update',
      resourceType: 'tenant',
      resourceId: found.id,
      before,
      after: contact,
    });
    return { contact };
  }

  /** Pede a confirmação de novo (aguardando ou descadastrado), com o mesmo endereço. */
  async requestConfirmation(): Promise<EscalationContactResponse> {
    const db = this.prisma.scoped();
    const found = await this.current(db);
    const before = await readEscalationContact(db, found);
    const { after } = await restartEscalationConfirmation(db, found.id, new Date());
    const contact = await readEscalationContact(db, after);
    this.audit.describe({
      action: 'escalation_contact.resend',
      resourceType: 'tenant',
      resourceId: found.id,
      before,
      after: contact,
    });
    return { contact };
  }

  /** O cadastro do próprio cliente: o escopo só alcança essa linha. */
  private current(db: ReturnType<PrismaService['scoped']>): Promise<EscalationRow> {
    return db.tenant.findFirstOrThrow({ select: ESCALATION_SELECT });
  }
}
