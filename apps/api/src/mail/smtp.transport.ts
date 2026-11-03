import { createTransport, type SMTPTransportOptions } from 'nodemailer';
import type { MailMessage, MailTransport } from './mail.types.js';

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Endereço do remetente: a própria caixa autenticada ou um alias dela (o servidor recusa outro). */
  from: string;
}

/** Nome que aparece como remetente. */
export const MAIL_FROM_NAME = 'Verax Control';

/**
 * Opções do SMTP, sempre com TLS e certificado conferido: na porta 465 a conexão já começa cifrada; nas outras, o
 * STARTTLS é obrigatório (sem ele, a senha e o link de redefinição trafegariam abertos). Nada aqui desliga a verificação
 * do certificado do servidor.
 */
export function smtpOptions(settings: SmtpSettings): SMTPTransportOptions {
  const implicitTls = settings.port === 465;
  return {
    host: settings.host,
    port: settings.port,
    secure: implicitTls,
    requireTLS: !implicitTls,
    auth: { user: settings.user, pass: settings.password },
    tls: { minVersion: 'TLSv1.2', servername: settings.host },
    // Poucos e-mails (redefinições de senha): uma conexão por envio, com tempo limite curto, para uma
    // falha do servidor não prender a requisição de quem pediu o link.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  };
}

/**
 * Envio por SMTP autenticado (no nó da Verax, o Zoho Mail do domínio, que já tem SPF e DKIM). A senha é de aplicativo,
 * vem do cofre de segredos do nó e nunca vai para log.
 */
export class SmtpMailTransport implements MailTransport {
  private readonly transporter: ReturnType<typeof createTransport>;

  constructor(
    private readonly settings: SmtpSettings,
    create: typeof createTransport = createTransport,
  ) {
    this.transporter = create(smtpOptions(settings));
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: { name: MAIL_FROM_NAME, address: this.settings.from },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
