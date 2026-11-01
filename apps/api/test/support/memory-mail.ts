import type { MailMessage, MailTransport } from '../../src/mail/mail.types.js';

/** Caixa de e-mail em memória para os testes. */
export class MemoryMailTransport implements MailTransport {
  readonly messages: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  to(email: string): MailMessage[] {
    return this.messages.filter((message) => message.to === email);
  }

  /** Token do link (`#token=...`) da última mensagem para o endereço. */
  lastToken(email: string): string | undefined {
    const message = this.to(email).at(-1);
    const match = message ? /#token=([^\s"<]+)/.exec(message.text) : null;
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  }
}
