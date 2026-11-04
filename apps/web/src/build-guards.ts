/**
 * Travas do build do painel (regra 2 do PLANO: nenhum segredo no front).
 *
 * Tudo o que começa com `VITE_` vai parar no JavaScript público. A única variável permitida é a URL pública
 * da API; qualquer outra faz o build falhar, para um segredo nunca entrar no bundle por engano.
 */
export const ALLOWED_PUBLIC_ENV = ['VITE_API_URL'] as const;

export function assertOnlyAllowedPublicEnv(env: Record<string, string | undefined>): void {
  const forbidden = Object.keys(env).filter(
    (key) => key.startsWith('VITE_') && !(ALLOWED_PUBLIC_ENV as readonly string[]).includes(key),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Variáveis VITE_* não permitidas (iriam para o bundle público): ${forbidden.join(', ')}. ` +
        'Só VITE_API_URL é aceita.',
    );
  }
}

/** Origem do Cloudflare Turnstile: o script do widget e o iframe do desafio (login e "esqueci minha senha"). */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Content-Security-Policy do painel. A mesma política vale no `vite preview` (testes e2e) e no Firebase Hosting,
 * para o e2e pegar qualquer violação antes de produção. Fora do próprio domínio, só o Turnstile: o script e o
 * iframe do desafio (a documentação da Cloudflare pede `script-src` e `frame-src`).
 */
export function contentSecurityPolicy(apiUrl: string): string {
  const apiOrigin = new URL(apiUrl).origin;
  return [
    "default-src 'self'",
    `script-src 'self' ${TURNSTILE_ORIGIN}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Headers de segurança do painel (mesmos no preview e no CloudFront). */
export function securityHeaders(apiUrl: string): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(apiUrl),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}
