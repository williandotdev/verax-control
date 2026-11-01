import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MailMessage, MailTransport } from './mail.types.js';

/**
 * Caixa de e-mail local de desenvolvimento: cada mensagem vira um arquivo JSON em `.dev-mailbox/` (fora do
 * git e bloqueado para o agente). Os links de convite e de redefinição são tokens, por isso nunca vão para
 * o log; a pasta é o único lugar onde aparecem.
 */
export class DevMailboxTransport implements MailTransport {
  constructor(private readonly directory: string) {}

  async send(message: MailMessage): Promise<void> {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta vinda da configuração
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(
      this.directory,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração, nome gerado aqui
    await writeFile(file, JSON.stringify(message, null, 2), { mode: 0o600 });
  }
}
