import { HttpStatus, Injectable } from '@nestjs/common';
import {
  INCIDENT_NOTICE_ROLES,
  type NotificationPreferences,
  type NotificationPreferencesUpdate,
  NOTICES_NOT_FOR_ROLE_MESSAGE,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/** Código da recusa para quem não recebe avisos: o painel não oferece a opção a esses papéis. */
export const NOTICES_NOT_FOR_ROLE_CODE = 'NOTICES_NOT_FOR_ROLE';

/** Sem linha na tabela, vale o padrão: recebe. */
const DEFAULT_INCIDENT_EMAILS = true;

/**
 * Preferência de aviso por e-mail da própria pessoa (fase 2, PR-17'). A pessoa é sempre a da sessão: nenhuma rota
 * recebe o id de outra, então ninguém muda a escolha de ninguém (o administrador só vê, na lista de usuários). Tudo
 * pelo escopo do cliente da sessão, e a mudança entra na trilha de auditoria com o estado anterior e o novo.
 *
 * Só administradores e analistas do cliente recebem os avisos de incidente (D8). Para `leitura` e para a equipe da
 * Verax, a leitura responde que o papel não recebe (`eligible: false`), e a mudança é recusada.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async read(auth: RequestAuth): Promise<NotificationPreferences> {
    if (!eligible(auth)) return { incidentEmails: false, eligible: false };
    return { incidentEmails: await this.current(auth.userId), eligible: true };
  }

  async update(auth: RequestAuth, input: NotificationPreferencesUpdate): Promise<NotificationPreferences> {
    if (!eligible(auth)) {
      throw new ApiError(HttpStatus.FORBIDDEN, NOTICES_NOT_FOR_ROLE_MESSAGE, NOTICES_NOT_FOR_ROLE_CODE);
    }
    const before = await this.current(auth.userId);
    const saved = await this.prisma.scoped().notificationPreference.upsert({
      where: { userId: auth.userId },
      // A pessoa vem da sessão, nunca do corpo; o cliente, do escopo.
      create: {
        userId: auth.userId,
        incidentEmails: input.incidentEmails,
      } as Prisma.NotificationPreferenceUncheckedCreateInput,
      update: { incidentEmails: input.incidentEmails },
      select: { incidentEmails: true },
    });
    this.audit.describe({
      action: 'user.notification_preference',
      resourceType: 'user',
      resourceId: auth.userId,
      before: { incidentEmails: before },
      after: { incidentEmails: saved.incidentEmails },
    });
    return { incidentEmails: saved.incidentEmails, eligible: true };
  }

  private async current(userId: string): Promise<boolean> {
    const row = await this.prisma.scoped().notificationPreference.findUnique({
      where: { userId },
      select: { incidentEmails: true },
    });
    return row?.incidentEmails ?? DEFAULT_INCIDENT_EMAILS;
  }
}

/**
 * Pessoa de cliente, no próprio cliente, com um papel que recebe os avisos de incidente. A equipe da Verax não tem
 * cliente (e, com um cliente selecionado, continua sem ser dele).
 */
function eligible(auth: RequestAuth): boolean {
  return (
    auth.tenantId !== null &&
    auth.tenantId === auth.scopeTenantId &&
    (INCIDENT_NOTICE_ROLES as readonly string[]).includes(auth.role)
  );
}
