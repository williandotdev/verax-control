import { Global, Module } from '@nestjs/common';
import { join } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { findWorkspaceRoot } from '../common/config/load-env-file.js';
import { DevMailboxTransport } from './dev-mailbox.transport.js';
import { MAIL_TRANSPORT, type MailTransport } from './mail.types.js';
import { SesMailTransport } from './ses.transport.js';

@Global()
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MailTransport =>
        config.MAIL_TRANSPORT === 'ses'
          ? new SesMailTransport(config.AWS_REGION, config.MAIL_FROM)
          : new DevMailboxTransport(
              config.DEV_MAILBOX_DIR ?? join(findWorkspaceRoot() ?? process.cwd(), '.dev-mailbox'),
            ),
    },
  ],
  exports: [MAIL_TRANSPORT],
})
export class MailModule {}
