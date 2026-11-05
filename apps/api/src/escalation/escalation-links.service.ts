import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ESCALATION_LINK_INVALID_CODE,
  ESCALATION_LINK_INVALID_MESSAGE,
  type EscalationContactStatus,
  type EscalationLinkResult,
} from '@verax/shared';
import type { Request } from 'express';
import { requestEntry } from '../common/audit/audit-request.js';
import { AuditService } from '../common/audit/audit.service.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { EscalationTokenPurpose, Prisma } from '../generated/prisma/client.js';
import { escalationTokenHash } from './escalation-tokens.js';

/** A mesma recusa para todo link que não vale, sem dizer o motivo nem de que cliente ele é. */
function invalidLink(): ApiError {
  return new ApiError(HttpStatus.BAD_REQUEST, ESCALATION_LINK_INVALID_MESSAGE, ESCALATION_LINK_INVALID_CODE);
}

interface FoundToken {
  tenantId: string;
  generation: number;
}

/**
 * Os links dos e-mails ao contato de escalonamento (D8), abertos sem login: confirmar o endereço e deixar de receber. O
 * valor do link é a credencial; o banco só tem o SHA-256 dele, e é por ele que o cliente aparece (busca de sistema,
 * a única sem escopo aqui). Tudo o mais vai pelo escopo do cliente do link, numa transação só.
 *
 * - Confirmar: o link de confirmação, dentro das 72 h, da geração atual do endereço, com o contato aguardando. Vale uma
 *   vez: ele e os outros de confirmação do cliente saem na mesma transação.
 * - Descadastrar: o link de descadastro, dentro de um ano, da geração atual. Idempotente: o segundo clique responde o
 *   mesmo, sem mudar nada. Os links de confirmação que ainda valiam saem junto.
 * - Qualquer outro caso (desconhecido, vencido, usado, de um endereço anterior, do outro tipo) recebe a mesma recusa.
 *
 * Só a mudança de estado entra na trilha do cliente (ator anônimo, com o IP de quem clicou). A recusa e o segundo
 * clique não gravam nada: como as recusas anônimas dos guards, ficam só no log, para ninguém de fora encher a trilha.
 */
@Injectable()
export class EscalationLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  confirm(token: string, request: Request): Promise<EscalationLinkResult> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const found = await this.find(tx, token, 'confirm', now);
      const db = scopeToTenant(tx, found.tenantId);
      const { count } = await db.tenant.updateMany({
        where: { id: found.tenantId, escalationGeneration: found.generation, escalationState: 'pending' },
        data: { escalationState: 'confirmed', escalationConfirmedAt: now },
      });
      if (count !== 1) throw invalidLink();
      // Uso único: este link e qualquer outro de confirmação do cliente deixam de valer.
      await db.escalationContactToken.deleteMany({ where: { purpose: 'confirm' } });
      await this.record(tx, request, found.tenantId, 'escalation_contact.confirm', 'pending', 'confirmed');
      return { status: 'confirmed' };
    });
  }

  unsubscribe(token: string, request: Request): Promise<EscalationLinkResult> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const found = await this.find(tx, token, 'unsubscribe', now);
      const db = scopeToTenant(tx, found.tenantId);
      const current = await db.tenant.findUnique({
        where: { id: found.tenantId },
        select: { escalationState: true, escalationGeneration: true },
      });
      if (current?.escalationGeneration !== found.generation || current.escalationState === null) {
        throw invalidLink();
      }
      // Segundo clique: a mesma resposta, sem mudar nada nem gravar de novo.
      if (current.escalationState === 'unsubscribed') return { status: 'unsubscribed' };
      const { count } = await db.tenant.updateMany({
        where: {
          id: found.tenantId,
          escalationGeneration: found.generation,
          escalationState: current.escalationState,
        },
        data: {
          escalationState: 'unsubscribed',
          escalationUnsubscribedAt: now,
          escalationConfirmedAt: null,
        },
      });
      // Outro clique (ou uma troca de endereço) chegou antes: relê para responder pelo estado de agora.
      if (count !== 1) {
        const after = await db.tenant.findUnique({
          where: { id: found.tenantId },
          select: { escalationState: true, escalationGeneration: true },
        });
        if (after?.escalationGeneration === found.generation && after.escalationState === 'unsubscribed') {
          return { status: 'unsubscribed' };
        }
        throw invalidLink();
      }
      await db.escalationContactToken.deleteMany({ where: { purpose: 'confirm' } });
      await this.record(
        tx,
        request,
        found.tenantId,
        'escalation_contact.unsubscribe',
        current.escalationState,
        'unsubscribed',
      );
      return { status: 'unsubscribed' };
    });
  }

  /** O link pelo hash: do tipo pedido e ainda dentro da validade. */
  private async find(
    tx: Prisma.TransactionClient,
    token: string,
    purpose: EscalationTokenPurpose,
    now: Date,
  ): Promise<FoundToken> {
    const found = await tx.escalationContactToken.findUnique({
      where: { tokenHash: escalationTokenHash(token) },
      select: { tenantId: true, purpose: true, generation: true, expiresAt: true },
    });
    if (found?.purpose !== purpose || found.expiresAt <= now) throw invalidLink();
    return { tenantId: found.tenantId, generation: found.generation };
  }

  /** A mudança de estado na trilha do cliente do link, na mesma transação. Ator anônimo: o contato não tem login. */
  private record(
    tx: Prisma.TransactionClient,
    request: Request,
    tenantId: string,
    action: 'escalation_contact.confirm' | 'escalation_contact.unsubscribe',
    before: EscalationContactStatus,
    after: EscalationContactStatus,
  ): Promise<void> {
    const entry = requestEntry(request);
    return this.auditService.write(tx, {
      ...entry,
      actor: { type: 'anonymous', tenantId },
      action,
      outcome: 'success',
      statusCode: HttpStatus.OK,
      resourceType: 'tenant',
      resourceId: tenantId,
      before: { status: before },
      after: { status: after },
    });
  }
}
