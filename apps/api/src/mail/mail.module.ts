import { Global, Module } from '@nestjs/common';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { findWorkspaceRoot } from '../common/config/load-env-file.js';
import { DevMailboxTransport } from './dev-mailbox.transport.js';
import { MAIL_TRANSPORT, type MailTransport } from './mail.types.js';
import { SesMailTransport } from './ses.transport.js';
import { SmtpMailTransport } from './smtp.transport.js';

/**
 * O que o transporte usa da configuração: a da API ou a do worker. No worker, o remetente só é obrigatório com o e-mail
 * ligado (fora de `none`), e a validação da configuração já o exigiu.
 */
export type MailConfig = Pick<
  AppConfig,
  | 'MAIL_TRANSPORT'
  | 'AWS_REGION'
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'SMTP_USER'
  | 'SMTP_PASSWORD'
  | 'DEV_MAILBOX_DIR'
> & { readonly MAIL_FROM?: string | undefined };

/**
 * O transporte de e-mail da configuração: o da API, o do bootstrap do nó (fora da aplicação Nest) e o dos avisos do
 * worker (fase 2, PR-16), a mesma fábrica.
 */
export function mailTransport(config: MailConfig): MailTransport {
  switch (config.MAIL_TRANSPORT) {
    case 'ses':
      return new SesMailTransport(config.AWS_REGION, config.MAIL_FROM as string);
    case 'smtp':
      // A validação da configuração já exigiu servidor, usuário, senha e remetente com MAIL_TRANSPORT=smtp.
      return new SmtpMailTransport({
        host: config.SMTP_HOST as string,
        port: config.SMTP_PORT,
        user: config.SMTP_USER as string,
        password: config.SMTP_PASSWORD as string,
        from: config.MAIL_FROM as string,
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
