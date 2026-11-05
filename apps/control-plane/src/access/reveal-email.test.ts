import { describe, expect, it } from 'vitest';
import { buildRevealEmail, revealLink, statusPageUrl, UnsafeEmailValueError } from './reveal-email.js';

describe('e-mail do plano B', () => {
  it('a página de status sai do SITE_SUCCESS_URL sem a query, e o link leva o valor no fragmento', () => {
    const page = statusPageUrl('https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}');
    expect(page).toBe('https://veraxsistemas.com.br/checkout/sucesso');
    expect(statusPageUrl(undefined)).toBeUndefined();
    expect(revealLink(page ?? '', 'valor')).toBe(
      'https://veraxsistemas.com.br/checkout/sucesso#acesso=valor',
    );
  });

  it('leva o painel, o link e o prazo em português, e nunca a senha', () => {
    const message = buildRevealEmail({
      to: 'admin@cliente-demo-a.example',
      panelUrl: 'https://cliente-demo-a.control.veraxsistemas.com.br',
      link: 'https://veraxsistemas.com.br/checkout/sucesso#acesso=abc_DEF-123',
      linkExpiresAt: new Date('2026-11-07T15:00:00.000Z'),
    });

    expect(message.to).toBe('admin@cliente-demo-a.example');
    expect(message.subject).toContain('pronto');
    expect(message.text).toContain('https://cliente-demo-a.control.veraxsistemas.com.br');
    expect(message.text).toContain('#acesso=abc_DEF-123');
    expect(message.text).toContain('07/11/2026, 12:00 (horário de Brasília)');
    expect(message.text).toContain('não vai por e-mail');
    expect(message.html).toContain(
      '<a href="https://veraxsistemas.com.br/checkout/sucesso#acesso=abc_DEF-123">Ver o acesso do administrador</a>',
    );
    expect(`${message.text}${message.html}`.toLowerCase()).not.toMatch(/senha:|password/);
  });

  it.each([
    ['caractere de HTML no link', { link: 'https://veraxsistemas.com.br/checkout/sucesso#acesso=a&<x>' }],
    ['aspas no painel', { panelUrl: 'https://cliente-demo-a.control.veraxsistemas.com.br/"onmouseover=x' }],
    ['link que não é https', { link: 'javascript:alert(1)' }],
    ['link que não é URL', { link: 'acesso' }],
  ])('recusa montar o HTML com %s, em vez de escapar à mão', (_case, override) => {
    expect(() =>
      buildRevealEmail({
        to: 'admin@cliente-demo-a.example',
        panelUrl: 'https://cliente-demo-a.control.veraxsistemas.com.br',
        link: 'https://veraxsistemas.com.br/checkout/sucesso#acesso=abc',
        linkExpiresAt: new Date('2026-11-07T15:00:00.000Z'),
        ...override,
      }),
    ).toThrow(UnsafeEmailValueError);
  });
});
