import { AsyncLocalStorage } from 'node:async_hooks';
import { invitationMail, passwordResetMail } from '../mail/templates.js';
import type { MailMessage } from '../mail/mail.types.js';
import { PASSWORD_LINK_TTL_SECONDS } from './auth.constants.js';

interface LinkRecipient {
  email: string;
  name: string;
  status?: unknown;
}

/**
 * Marca o pedido de link feito pelo `InvitationService` (convite ou reenvio pelo administrador). A rota
 * pública de redefinição roda fora dele.
 */
export const invitationRequest = new AsyncLocalStorage<true>();

/**
 * Monta o e-mail com o link de definição de senha (T2.6). A resposta da API é a mesma em todos os casos.
 * - convite: só para quem ainda não ativou a conta, e só pelo `InvitationService`. Pela rota pública, um
 *   convidado não recebe nada: senão o convite nunca expiraria de fato;
 * - redefinição: só para quem já está ativo, pela rota pública;
 * - usuário desativado não recebe nada.
 *
 * O token vai no fragmento (`#token=`): o navegador nunca o envia a servidor nenhum, nem no `Referer`, e
 * ele não aparece em log de CDN ou de proxy.
 */
export function passwordLinkMail(
  webOrigin: string,
  user: LinkRecipient,
  token: string,
  { invitation }: { invitation: boolean },
): MailMessage | undefined {
  const validMinutes = PASSWORD_LINK_TTL_SECONDS / 60;
  const fragment = `#token=${encodeURIComponent(token)}`;
  if (user.status === 'invited' && invitation) {
    return invitationMail({
      to: user.email,
      name: user.name,
      link: `${webOrigin}/convite${fragment}`,
      validMinutes,
    });
  }
  if (user.status === 'active' && !invitation) {
    return passwordResetMail({
      to: user.email,
      name: user.name,
      link: `${webOrigin}/redefinir-senha${fragment}`,
      validMinutes,
    });
  }
  return undefined;
}
