import { createTransport, type SMTPTransportOptions } from 'nodemailer';
import type { AppConfig } from '../common/config/config.module.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Envio de e-mail do plano de controle (só o cp-worker: é ele que lê `cp-smtp-password`). Em produção, SMTP
 * autenticado (o Zoho Mail do domínio, que já tem SPF e DKIM); nos testes, um dublê em memória.
 */
export interface MailSender {
  send(message: MailMessage): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');

/** O SMTP não está configurado (`SMTP_HOST` e o grupo): nada foi enviado. */
export class MailUnavailableError extends Error {
  constructor() {
    super('e-mail sem configuração: SMTP_HOST, SMTP_USER, SMTP_PASSWORD e MAIL_FROM');
    this.name = 'MailUnavailableError';
  }
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  /** `MAIL_FROM`: `endereco@dominio` ou `Nome <endereco@dominio>` (conferido na partida). */
  from: string;
}

/**
 * Opções do SMTP, sempre com TLS e certificado conferido (a mesma regra da API, `apps/api/src/mail/smtp.transport.ts`):
 * na porta 465 a conexão já começa cifrada; nas outras, o STARTTLS é obrigatório. Nada aqui desliga a verificação do
 * certificado do servidor, e o nodemailer não registra nada (o corpo leva o link de uso único).
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
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    logger: false,
    debug: false,
  };
}

export class SmtpMailSender implements MailSender {
  private readonly transporter: ReturnType<typeof createTransport>;

  constructor(
    private readonly settings: SmtpSettings,
    create: typeof createTransport = createTransport,
  ) {
    this.transporter = create(smtpOptions(settings));
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

export class UnconfiguredMailSender implements MailSender {
  send(_message: MailMessage): Promise<never> {
    return Promise.reject(new MailUnavailableError());
  }
}

/** O envio da configuração: com `SMTP_HOST`, o schema já exigiu usuário, senha e remetente (só no worker). */
export function mailSenderFor(config: AppConfig): MailSender {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASSWORD: password, MAIL_FROM: from } = config;
  if (host === undefined || user === undefined || password === undefined || from === undefined) {
    return new UnconfiguredMailSender();
  }
  return new SmtpMailSender({ host, port: config.SMTP_PORT, user, password, from });
}
