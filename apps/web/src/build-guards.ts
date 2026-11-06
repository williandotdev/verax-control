import { fillTenant, TENANT_PLACEHOLDER } from './lib/tenant-address';

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

/** Cliente qualquer, válido, só para conferir a forma do modelo de `VITE_API_URL`. */
const PROBE_TENANT = 'probe';

/**
 * Confere `VITE_API_URL` no build. Duas formas: uma URL `http(s)` (build de um destino só, como sempre foi) ou o
 * modelo do build único (`tenant-address.ts`), que precisa ser só a origem, em HTTPS, com `{tenant}` uma única vez e
 * dentro do primeiro rótulo do host (`https://api-{tenant}.veraxsistemas.com.br`). Assim, a troca em tempo de execução
 * muda só o subdomínio da API, nunca o domínio, o caminho ou o esquema.
 */
export function assertValidApiUrl(value: string): void {
  const invalid = (reason: string): Error => new Error(`VITE_API_URL inválida: ${reason}.`);
  const at = value.indexOf(TENANT_PLACEHOLDER);
  if (at === -1) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw invalid('não é uma URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('esperado http ou https');
    return;
  }
  const scheme = 'https://';
  if (at !== value.lastIndexOf(TENANT_PLACEHOLDER))
    throw invalid('o marcador {tenant} aparece mais de uma vez');
  if (!value.startsWith(scheme)) throw invalid('o modelo com {tenant} precisa ser https');
  if (value.slice(scheme.length, at).includes('.')) {
    throw invalid('o marcador {tenant} precisa estar no primeiro rótulo do host');
  }
  if (!value.slice(at).includes('.')) throw invalid('o modelo com {tenant} precisa de um domínio fixo');
  const probe = fillTenant(value, PROBE_TENANT);
  let origin: string;
  try {
    origin = new URL(probe).origin;
  } catch {
    throw invalid('não é uma URL');
  }
  // Sem caminho, credencial, consulta, maiúscula ou caractere fora do ASCII: o modelo é exatamente a origem.
  if (origin !== probe) throw invalid('o modelo com {tenant} precisa ser só a origem, em minúsculas');
}

/** Origem da API para a CSP. No modelo do build único, a origem com o marcador, trocado por site no deploy. */
export function apiOrigin(apiUrl: string): string {
  if (!apiUrl.includes(TENANT_PLACEHOLDER)) return new URL(apiUrl).origin;
  assertValidApiUrl(apiUrl);
  return apiUrl;
}

/** Origem do Cloudflare Turnstile: o script do widget e o iframe do desafio (login e "esqueci minha senha"). */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Content-Security-Policy do painel. A mesma política vale no `vite preview` (testes e2e) e no Firebase Hosting,
 * para o e2e pegar qualquer violação antes de produção. Fora do próprio domínio, só a API do site e o Turnstile (o
 * script e o iframe do desafio; a documentação da Cloudflare pede `script-src` e `frame-src`). No build único, a
 * `connect-src` sai com o marcador e cada site recebe a sua (`siteHostingConfig`, em `hosting.ts`); o resto da
 * política é o mesmo em todos os sites.
 */
export function contentSecurityPolicy(apiUrl: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${TURNSTILE_ORIGIN}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin(apiUrl)}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** Headers de segurança do painel (mesmos no preview e no Firebase Hosting). */
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
