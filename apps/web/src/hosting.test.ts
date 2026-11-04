import { describe, expect, it } from 'vitest';
import { securityHeaders } from './build-guards';
import {
  firebaseHostingConfig,
  type HostingConfig,
  siteHostingConfig,
  STRICT_TRANSPORT_SECURITY,
} from './hosting';

const TEMPLATE = 'https://api-{tenant}.veraxsistemas.com.br';

/** Fontes da `connect-src` da CSP do site (a regra `**`). */
function connectSources(config: HostingConfig): string[] {
  const csp = config.headers.find((rule) => rule.glob === '**')?.headers['Content-Security-Policy'] ?? '';
  const directive = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src');
  return directive?.slice(1) ?? [];
}

describe('build único: configuração de cada site', () => {
  const template = firebaseHostingConfig(TEMPLATE);

  it('a do site é a mesma gerada direto com a API do cliente', () => {
    expect(siteHostingConfig(template, 'cliente-demo-a')).toEqual(
      firebaseHostingConfig('https://api-cliente-demo-a.veraxsistemas.com.br'),
    );
  });

  it('a connect-src de cada site tem exatamente a API dele', () => {
    expect(connectSources(siteHostingConfig(template, 'cliente-demo-a'))).toEqual([
      "'self'",
      'https://api-cliente-demo-a.veraxsistemas.com.br',
    ]);
    expect(connectSources(siteHostingConfig(template, 'cliente-demo-b'))).toEqual([
      "'self'",
      'https://api-cliente-demo-b.veraxsistemas.com.br',
    ]);
  });

  it('dois sites só diferem na CSP', () => {
    const a = siteHostingConfig(template, 'cliente-demo-a');
    const b = siteHostingConfig(template, 'cliente-demo-b');
    const withoutCsp = (config: HostingConfig) =>
      config.headers.map((rule) => {
        const { ['Content-Security-Policy']: _csp, ...rest } = rule.headers;
        return { glob: rule.glob, headers: rest };
      });
    expect(withoutCsp(a)).toEqual(withoutCsp(b));
    expect(a.rewrites).toEqual(b.rewrites);
    expect(connectSources(a)).not.toEqual(connectSources(b));
  });

  it('o modelo não serve para publicar: carrega o marcador, que o script de publicação recusa', () => {
    expect(JSON.stringify(template)).toContain('{tenant}');
    expect(JSON.stringify(siteHostingConfig(template, 'cliente-demo-a'))).not.toContain('{tenant}');
  });

  it.each(['', 'Cliente', 'xn--clnte-bsa', 'evil.example.com', 'a b', '"x"'])(
    'recusa cliente inválido (%j)',
    (tenant) => {
      expect(() => siteHostingConfig(template, tenant)).toThrow(/inválido/);
    },
  );

  it('recusa a configuração de um destino só (sem o marcador)', () => {
    const fixed = firebaseHostingConfig('https://api-verax.veraxsistemas.com.br');
    expect(() => siteHostingConfig(fixed, 'cliente-demo-a')).toThrow(/build único/);
  });
});

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
