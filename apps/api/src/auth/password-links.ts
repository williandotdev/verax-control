import { invitationMail, passwordResetMail } from '../mail/templates.js';
import type { MailMessage } from '../mail/mail.types.js';
import { PASSWORD_LINK_TTL_SECONDS } from './auth.constants.js';

interface LinkRecipient {
  email: string;
  name: string;
  status?: unknown;
}

/**
 * Monta o e-mail com o link de definição de senha (T2.6): convite para quem ainda não ativou a conta,
 * redefinição para quem já está ativo, e nada para usuário desativado (a resposta da API é a mesma).
 *
 * O token vai no fragmento (`#token=`): o navegador nunca o envia a servidor nenhum, nem no `Referer`, e
 * ele não aparece em log de CDN ou de proxy.
 */
export function passwordLinkMail(
  webOrigin: string,
  user: LinkRecipient,
  token: string,
): MailMessage | undefined {
  const validMinutes = PASSWORD_LINK_TTL_SECONDS / 60;
  const fragment = `#token=${encodeURIComponent(token)}`;
  if (user.status === 'invited') {
    return invitationMail({
      to: user.email,
      name: user.name,
      link: `${webOrigin}/convite${fragment}`,
      validMinutes,
    });
  }
  if (user.status === 'active') {
    return passwordResetMail({
      to: user.email,
      name: user.name,
      link: `${webOrigin}/redefinir-senha${fragment}`,
      validMinutes,
    });
  }
  return undefined;
}
