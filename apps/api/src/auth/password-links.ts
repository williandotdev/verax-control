import { passwordResetMail } from '../mail/templates.js';
import type { MailMessage } from '../mail/mail.types.js';
import { PASSWORD_LINK_TTL_SECONDS } from './auth.constants.js';

interface LinkRecipient {
  email: string;
  name: string;
  status?: unknown;
}

/**
 * Monta o e-mail com o link de redefinição de senha (T2.6), só para quem está ativo; os demais não recebem nada, e a
 * resposta da API é a mesma. Conta nova não recebe link: nasce com senha temporária, entregue pelo administrador.
 *
 * O token vai no fragmento (`#token=`): o navegador nunca o envia a servidor nenhum, nem no `Referer`, e ele não
 * aparece em log de CDN ou de proxy.
 */
export function passwordLinkMail(
  webOrigin: string,
  user: LinkRecipient,
  token: string,
): MailMessage | undefined {
  if (user.status !== 'active') return undefined;
  return passwordResetMail({
    to: user.email,
    name: user.name,
    link: `${webOrigin}/redefinir-senha#token=${encodeURIComponent(token)}`,
    validMinutes: PASSWORD_LINK_TTL_SECONDS / 60,
  });
}
