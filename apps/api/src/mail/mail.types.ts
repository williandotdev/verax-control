export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Transporte de e-mail. Em produção, SES; em desenvolvimento, uma caixa local; nos testes, memória. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
