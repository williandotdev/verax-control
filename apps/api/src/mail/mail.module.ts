import { Global, Module } from '@nestjs/common';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { findWorkspaceRoot } from '../common/config/load-env-file.js';
import { DevMailboxTransport } from './dev-mailbox.transport.js';
import { MAIL_TRANSPORT, type MailTransport } from './mail.types.js';
import { SesMailTransport } from './ses.transport.js';
import { SmtpMailTransport } from './smtp.transport.js';

/** O transporte de e-mail da configuração (também usado pelo bootstrap do nó, fora da aplicação Nest). */
export function mailTransport(config: AppConfig): MailTransport {
  switch (config.MAIL_TRANSPORT) {
    case 'ses':
      return new SesMailTransport(config.AWS_REGION, config.MAIL_FROM);
    case 'smtp':
      // A validação da configuração já exigiu servidor, usuário e senha com MAIL_TRANSPORT=smtp.
      return new SmtpMailTransport({
        host: config.SMTP_HOST as string,
        port: config.SMTP_PORT,
        user: config.SMTP_USER as string,
        password: config.SMTP_PASSWORD as string,
        from: config.MAIL_FROM,
      });
    case 'none':
      // Nó sem e-mail: nenhum link sai (a resposta da rota pública de redefinição é a mesma de sempre).
      return { send: () => Promise.resolve() };
    case 'dev-mailbox':
      return new DevMailboxTransport(
        config.DEV_MAILBOX_DIR ?? join(findWorkspaceRoot() ?? process.cwd(), '.dev-mailbox'),
      );
  }
}

@Global()
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [APP_CONFIG],
      useFactory: mailTransport,
    },
  ],
  exports: [MAIL_TRANSPORT],
})
export class MailModule {}
