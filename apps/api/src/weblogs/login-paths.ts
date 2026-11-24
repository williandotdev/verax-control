import { upToScript } from './path.js';

/**
 * Rotas de login sem configuração: POST ou PUT num caminho com um segmento de login. A lista é a das regras do Cloudflare
 * (`cloudflare-security-rules.ts`), casada por **segmento** e não por trecho (`auth` não casa `author`), com as formas no
 * plural e derivadas que o trecho pegava.
 *
 * **Rota:** o caminho até o primeiro segmento forte (`login`, `signin`, `wp-login`...), ou até o script
 * (`/login.php/qualquer-coisa` é `/login.php`): sem esse corte, trocar o fim do caminho a cada tentativa espalharia a força
 * bruta por rotas diferentes e calaria a regra por rota. Com só um segmento fraco (`auth`, `token`, `session`...), a rota é
 * o caminho inteiro, para não juntar o `/auth/refresh` com o `/auth/login`.
 *
 * **Limites:** `doLogin`, `/graphql` e autenticação HTTP Basic por GET não são reconhecidos: o cliente declara a rota
 * (`routes.ts`). Um prefixo trocado a cada tentativa (`/a/login`, `/b/login`), num app que aceite qualquer prefixo, espalha.
 */
const STRONG: ReadonlySet<string> = new Set([
  'login',
  'logon',
  'signin',
  'sign-in',
  'sign_in',
  'entrar',
  'wp-login',
  'xmlrpc',
]);
const WEAK: ReadonlySet<string> = new Set([
  'auth',
  'oauth',
  'oauth2',
  'authenticate',
  'authentication',
  'session',
  'sessions',
  'password',
  'passwords',
  'senha',
  'token',
  'tokens',
]);

/** O segmento sem a extensão (`login.php` é `login`). */
function base(segment: string): string {
  const dot = segment.indexOf('.', 1);
  return dot < 0 ? segment : segment.slice(0, dot);
}

/** O nome do segmento, ou uma das palavras dele separadas por `-` ou `_` (`user-login`, `login_check`). */
function isStrong(segment: string): boolean {
  const name = base(segment);
  if (STRONG.has(name)) return true;
  let start = 0;
  for (let i = 0; i <= name.length; i += 1) {
    const code = i < name.length ? name.charCodeAt(i) : 45;
    if (code !== 45 && code !== 95) continue;
    if (i > start && STRONG.has(name.slice(start, i))) return true;
    start = i + 1;
  }
  return false;
}

/** Quantos segmentos do caminho formam a rota de login; 0 se não é uma. */
export function loginRouteLength(all: readonly string[]): number {
  const strong = all.findIndex(isStrong);
  if (strong >= 0) return strong + 1;
  // A palavra fraca vale só como o segmento inteiro: `/session-events` é telemetria, não login.
  const segments = upToScript(all);
  return segments.some((segment) => WEAK.has(base(segment))) ? segments.length : 0;
}

/** Os métodos de uma tentativa de login sem configuração. */
export const LOGIN_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT']);
/** Respostas de credencial recusada, sem configuração. */
export const DEFAULT_FAILURE_CODES: readonly number[] = [400, 401, 403, 422, 429];

/** Resposta de login aceito, sem configuração: 2xx e os redirecionamentos de formulário. */
export function isDefaultSuccess(status: number): boolean {
  return (status >= 200 && status <= 299) || status === 302 || status === 303;
}
