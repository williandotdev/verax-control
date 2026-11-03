import { describe, expect, it, vi } from 'vitest';
import { SmtpMailTransport, smtpOptions } from './smtp.transport.js';

const settings = {
  host: 'smtp.exemplo.com',
  port: 465,
  user: 'nao-responda@exemplo.com',
  password: 'senha-de-aplicativo',
  from: 'nao-responda@exemplo.com',
};

describe('SMTP', () => {
  it('porta 465: TLS desde o início, certificado conferido e TLS 1.2 no mínimo', () => {
    const options = smtpOptions(settings);
    expect(options).toMatchObject({
      host: 'smtp.exemplo.com',
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: 'nao-responda@exemplo.com', pass: 'senha-de-aplicativo' },
      tls: { minVersion: 'TLSv1.2', servername: 'smtp.exemplo.com' },
      logger: false,
      debug: false,
    });
    expect(JSON.stringify(options)).not.toContain('rejectUnauthorized');
  });

  it('outra porta: STARTTLS obrigatório, nunca texto aberto', () => {
    expect(smtpOptions({ ...settings, port: 587 })).toMatchObject({ secure: false, requireTLS: true });
  });

  it('envia com o remetente configurado, o texto e o HTML', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
    const create = vi.fn().mockReturnValue({ sendMail });
    const transport = new SmtpMailTransport(settings, create as never);
    await transport.send({
      to: 'pessoa@exemplo.com',
      subject: 'Convite',
      text: 'texto',
      html: '<p>html</p>',
    });
    expect(create).toHaveBeenCalledWith(smtpOptions(settings));
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'Verax Control', address: 'nao-responda@exemplo.com' },
      to: 'pessoa@exemplo.com',
      subject: 'Convite',
      text: 'texto',
      html: '<p>html</p>',
    });
  });

  it('falha do servidor chega a quem chamou (o link não fica como enviado)', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('535 Authentication Failed'));
    const transport = new SmtpMailTransport(settings, vi.fn().mockReturnValue({ sendMail }) as never);
    await expect(
      transport.send({ to: 'pessoa@exemplo.com', subject: 's', text: 't', html: 'h' }),
    ).rejects.toThrow('535');
  });
});
