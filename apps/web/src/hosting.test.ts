import { describe, expect, it } from 'vitest';
import { securityHeaders } from './build-guards';
import { firebaseHostingConfig, STRICT_TRANSPORT_SECURITY } from './hosting';

describe('configuração do Firebase Hosting', () => {
  const config = firebaseHostingConfig('https://api.cliente.control.example.com.br');
  const all = config.headers.find((rule) => rule.glob === '**')?.headers ?? {};

  it('usa os mesmos cabeçalhos de segurança do preview (validados no e2e), mais o HSTS', () => {
    expect(all).toEqual({
      ...securityHeaders('https://api.cliente.control.example.com.br'),
      'Strict-Transport-Security': STRICT_TRANSPORT_SECURITY,
      'Cache-Control': 'no-cache',
    });
    expect(all['Content-Security-Policy']).toContain(
      "connect-src 'self' https://api.cliente.control.example.com.br",
    );
    expect(all['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });

  it('a demonstração só conversa com a própria origem', () => {
    const demo = firebaseHostingConfig('https://demo.example.com.br');
    const csp = demo.headers.find((rule) => rule.glob === '**')?.headers['Content-Security-Policy'];
    expect(csp).toContain("connect-src 'self' https://demo.example.com.br;");
  });

  it('tudo revalidado a cada visita; cache longo só em /assets, numa regra posterior', () => {
    expect(all['Cache-Control']).toBe('no-cache');
    const globs = config.headers.map((rule) => rule.glob);
    expect(globs).toEqual(['**', '/assets/**']);
    expect(config.headers[1]?.headers['Cache-Control']).toContain('immutable');
  });

  it('rotas da aplicação caem no index.html', () => {
    expect(config.rewrites).toEqual([{ glob: '**', path: '/index.html' }]);
  });
});
