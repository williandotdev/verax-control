import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { MailMessage, MailTransport } from './mail.types.js';

/**
 * Envio pelo Amazon SES (pendência 3). As credenciais vêm do papel IAM da task no ECS (cadeia padrão do
 * SDK); nenhuma chave de acesso fica na configuração.
 */
export class SesMailTransport implements MailTransport {
  private readonly client: SESv2Client;

  constructor(
    region: string,
    private readonly from: string,
  ) {
    this.client = new SESv2Client({ region });
  }

  async send(message: MailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              Html: { Data: message.html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
  }
}
