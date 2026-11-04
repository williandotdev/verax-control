import { describe, expect, it } from 'vitest';
import { buildRevealEmail, revealLink, statusPageUrl } from './reveal-email.js';

describe('e-mail do plano B', () => {
  it('a página de status sai do SITE_SUCCESS_URL sem a query, e o link leva o valor no fragmento', () => {
    const page = statusPageUrl('https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}');
    expect(page).toBe('https://veraxsistemas.com.br/checkout/sucesso');
    expect(statusPageUrl(undefined)).toBeUndefined();
    expect(revealLink(page ?? '', 'valor')).toBe(
      'https://veraxsistemas.com.br/checkout/sucesso#acesso=valor',
    );
  });

  it('leva o painel, o link e o prazo em português, com o HTML escapado, e nunca a senha', () => {
    const message = buildRevealEmail({
      to: 'admin@cliente-demo-a.example',
      panelUrl: 'https://cliente-demo-a.control.veraxsistemas.com.br',
      link: 'https://veraxsistemas.com.br/checkout/sucesso#acesso=abc&<x>',
      linkExpiresAt: new Date('2026-11-07T15:00:00.000Z'),
    });

    expect(message.to).toBe('admin@cliente-demo-a.example');
    expect(message.subject).toContain('pronto');
    expect(message.text).toContain('https://cliente-demo-a.control.veraxsistemas.com.br');
    expect(message.text).toContain('#acesso=abc&<x>');
    expect(message.text).toContain('07/11/2026, 12:00 (horário de Brasília)');
    expect(message.text).toContain('não vai por e-mail');
    expect(message.html).toContain('#acesso=abc&amp;&lt;x&gt;');
    expect(message.html).not.toContain('<x>');
    expect(`${message.text}${message.html}`.toLowerCase()).not.toMatch(/senha:|password/);
  });
});
