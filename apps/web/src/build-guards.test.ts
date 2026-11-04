import { describe, expect, it } from 'vitest';
import { assertOnlyAllowedPublicEnv, contentSecurityPolicy } from './build-guards';

describe('variáveis públicas do build', () => {
  it('aceita só VITE_API_URL', () => {
    expect(() =>
      assertOnlyAllowedPublicEnv({ VITE_API_URL: 'https://api.example', NODE_ENV: 'x' }),
    ).not.toThrow();
  });

  it('falha com qualquer outra VITE_*, sem mostrar o valor', () => {
    const run = () => assertOnlyAllowedPublicEnv({ VITE_API_URL: 'x', VITE_SECRET_KEY: 'valor-que-vazaria' });
    expect(run).toThrow(/VITE_SECRET_KEY/);
    expect(run).not.toThrow(/valor-que-vazaria/);
  });
});

describe('CSP do painel', () => {
  it('só permite scripts e estilos do próprio domínio e conexão com a API', () => {
    const csp = contentSecurityPolicy('https://api.example.com/v1');
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain("connect-src 'self' https://api.example.com;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('fora do próprio domínio, só o Turnstile: o script do widget e o iframe do desafio', () => {
    const csp = contentSecurityPolicy('https://api.example.com');
    expect(csp).toContain('frame-src https://challenges.cloudflare.com;');
    // Nenhuma outra origem externa em nenhuma diretiva.
    const external = csp.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(external)).toEqual(
      new Set(['https://challenges.cloudflare.com', 'https://api.example.com']),
    );
  });
});
