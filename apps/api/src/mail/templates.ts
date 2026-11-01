import { PRODUCT_NAME } from '@verax/shared';
import type { MailMessage } from './mail.types.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface LinkMail {
  to: string;
  name: string;
  link: string;
  validMinutes: number;
}

function render(
  subject: string,
  intro: string,
  action: string,
  { to, name, link, validMinutes }: LinkMail,
): MailMessage {
  const closing = `O link vale por ${validMinutes} minutos e só pode ser usado uma vez. Se você não esperava esta mensagem, ignore-a.`;
  return {
    to,
    subject,
    text: `Olá, ${name}.\n\n${intro}\n\n${action}: ${link}\n\n${closing}\n\n${PRODUCT_NAME}`,
    html: [
      `<p>Olá, ${escapeHtml(name)}.</p>`,
      `<p>${escapeHtml(intro)}</p>`,
      `<p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>`,
      `<p>${escapeHtml(closing)}</p>`,
      `<p>${escapeHtml(PRODUCT_NAME)}</p>`,
    ].join('\n'),
  };
}

export function invitationMail(data: LinkMail): MailMessage {
  return render(
    `Convite para o ${PRODUCT_NAME}`,
    `Você foi convidado para acessar o painel ${PRODUCT_NAME}. Defina sua senha para ativar o acesso; no primeiro login você vai cadastrar a verificação em duas etapas.`,
    'Definir senha',
    data,
  );
}

export function passwordResetMail(data: LinkMail): MailMessage {
  return render(
    `Redefinição de senha do ${PRODUCT_NAME}`,
    'Recebemos um pedido para redefinir a sua senha.',
    'Redefinir senha',
    data,
  );
}
