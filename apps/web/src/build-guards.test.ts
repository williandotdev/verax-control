import { describe, expect, it } from 'vitest';
import { assertOnlyAllowedPublicEnv, assertValidApiUrl, contentSecurityPolicy } from './build-guards';

const TEMPLATE = 'https://api-{tenant}.veraxsistemas.com.br';

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

  it('o modelo do build único continua sendo a mesma VITE_API_URL, sem variável nova', () => {
    expect(() => assertOnlyAllowedPublicEnv({ VITE_API_URL: TEMPLATE })).not.toThrow();
    expect(() =>
      assertOnlyAllowedPublicEnv({ VITE_API_URL: TEMPLATE, VITE_TENANT: 'cliente-demo-a' }),
    ).toThrow(/VITE_TENANT/);
  });
});

describe('VITE_API_URL', () => {
  it.each([
    'http://localhost:3000',
    'https://api-verax.veraxsistemas.com.br',
    'https://api.example.com/v1',
    TEMPLATE,
    'https://{tenant}.api.example.com',
  ])('aceita %s', (value) => {
    expect(() => assertValidApiUrl(value)).not.toThrow();
  });

  it.each([
    ['texto que não é URL', 'api.example.com', /não é uma URL/],
    ['esquema fora de http(s)', 'javascript:alert(1)', /http ou https/],
    ['modelo sem https', 'http://api-{tenant}.veraxsistemas.com.br', /https/],
    ['marcador duas vezes', 'https://api-{tenant}.{tenant}.veraxsistemas.com.br', /mais de uma vez/],
    ['marcador fora do primeiro rótulo', 'https://api.{tenant}.veraxsistemas.com.br', /primeiro rótulo/],
    ['marcador no caminho', 'https://api.veraxsistemas.com.br/{tenant}', /primeiro rótulo/],
    ['modelo sem domínio fixo', 'https://api-{tenant}', /domínio fixo/],
    ['modelo com caminho', 'https://api-{tenant}.veraxsistemas.com.br/v1', /só a origem/],
    ['modelo com barra final', 'https://api-{tenant}.veraxsistemas.com.br/', /só a origem/],
    ['modelo com credencial', 'https://user@api-{tenant}.veraxsistemas.com.br', /só a origem/],
    ['modelo com maiúscula', 'https://API-{tenant}.veraxsistemas.com.br', /só a origem/],
  ])('recusa %s', (_case, value, message) => {
    expect(() => assertValidApiUrl(value)).toThrow(message);
  });
});

describe('CSP do painel', () => {
  it('só permite scripts e estilos do próprio domínio e conexão com a API', () => {
    const csp = contentSecurityPolicy('https://api.example.com/v1');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self' https://api.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('no build único, a política sai com o marcador no lugar da API (cada site recebe a sua no deploy)', () => {
    const csp = contentSecurityPolicy(TEMPLATE);
    expect(csp).toContain(`connect-src 'self' ${TEMPLATE};`);
    expect(csp.replace(TEMPLATE, 'https://api-cliente-demo-a.veraxsistemas.com.br')).toBe(
      contentSecurityPolicy('https://api-cliente-demo-a.veraxsistemas.com.br'),
    );
  });

  it('um modelo malformado não gera política', () => {
    expect(() => contentSecurityPolicy('https://api-{tenant}.veraxsistemas.com.br/v1')).toThrow(
      /VITE_API_URL/,
    );
  });
});
