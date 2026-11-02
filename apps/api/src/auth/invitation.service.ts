import { Inject, Injectable } from '@nestjs/common';
import type { UserRole } from '../generated/prisma/enums.js';
import { AUTH } from './auth.constants.js';
import type { Auth } from './auth.factory.js';
import { invitationRequest } from './password-links.js';
import { provisionUser } from './user-provisioning.js';

export interface Invitation {
  email: string;
  name: string;
  role: UserRole;
  tenantId: string | null;
}

/**
 * Convites (T2.6): o usuário nasce `invited`, sem senha, e recebe por e-mail um link de uso único que vale
 * 60 min. Ao definir a senha, a conta vira `active`; no primeiro login, ele cadastra o MFA. O link usa o
 * mesmo mecanismo da redefinição de senha do Better Auth (token aleatório, guardado só com hash).
 *
 * As rotas de gestão de usuários (T3.2) usam este serviço; ele não faz checagem de permissão.
 */
@Injectable()
export class InvitationService {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async invite(invitation: Invitation): Promise<{ id: string }> {
    const user = await provisionUser(this.auth, { ...invitation, status: 'invited' });
    await this.sendLink(invitation.email);
    return user;
  }

  /**
   * Envia (ou reenvia) o link de convite a um usuário que ainda não ativou a conta. O anterior continua
   * valendo até expirar ou ser usado. Para usuário ativo ou desativado, não envia nada.
   */
  async sendLink(email: string): Promise<void> {
    await invitationRequest.run(true, () =>
      this.auth.api.requestPasswordReset({ body: { email: email.trim().toLowerCase() } }),
    );
  }
}
