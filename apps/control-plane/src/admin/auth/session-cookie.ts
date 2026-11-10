import type { CookieOptions, Response } from 'express';
import { SESSION_ABSOLUTE_MS } from './admin-auth.schema.js';

/**
 * O cookie da sessão do console. Chama-se `__session` porque é o único cookie que o Firebase Hosting repassa ao Cloud
 * Run num rewrite (o site `admin.veraxsistemas.com.br` → cp-admin). `HttpOnly` (o JavaScript da página não o lê),
 * `Secure`, `SameSite=Strict` (nenhuma navegação ou formulário vindo de outro site o leva) e `Path=/`, sem `Domain`
 * (só este host). O valor é o id opaco da sessão (32 bytes aleatórios em base64url); no Firestore fica só o SHA-256.
 */
export const SESSION_COOKIE_NAME = '__session';

const BASE_OPTIONS: CookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };

export function sessionCookieOptions(): CookieOptions {
  return { ...BASE_OPTIONS, maxAge: SESSION_ABSOLUTE_MS };
}

/** As mesmas opções sem prazo, para o `clearCookie` (o navegador só apaga o cookie com o mesmo caminho e atributos). */
export function clearedSessionCookieOptions(): CookieOptions {
  return { ...BASE_OPTIONS };
}

/**
 * Teto de cookies `__session` conferidos numa requisição. Um site irmão sob o mesmo domínio (`*.veraxsistemas.com.br`)
 * pode plantar `__session` com `Domain=veraxsistemas.com.br` e caminhos mais longos, que o navegador manda antes do
 * nosso ("cookie tossing"). As combinações de domínio e caminho que casam com uma rota do console são poucas (bem
 * menos de 20): todas são conferidas, e o cookie de verdade não fica de fora. O tamanho do cabeçalho já é limitado
 * pelo Node (16 KiB por requisição); aqui nada é descartado pelo tamanho.
 */
export const MAX_SESSION_COOKIES = 20;

/** Os valores do cookie `__session` no cabeçalho `Cookie`, sem decodificação (o id só tem caracteres seguros). */
export function sessionCookieValues(header: string | undefined): string[] {
  if (header === undefined) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
    if (values.length === MAX_SESSION_COOKIES) break;
  }
  return values;
}

/** Os caminhos em que um `__session` plantado casaria com as rotas do console. */
export const TOSSED_COOKIE_PATHS = ['/', '/v1', '/v1/admin'] as const;

/**
 * Apaga os `__session` que um site irmão possa ter plantado com `Domain=<zona>` (no login, na saída e na recusa por
 * sessão ausente ou vencida). O cookie do console é só do host (sem `Domain`): este `Set-Cookie` não o toca, nem o
 * `__session` só do host do site `conta` (o do cp-public). Num endereço fora da zona (o `run.app`), o navegador ignora
 * o `Set-Cookie` de outro domínio.
 */
export function clearTossedSessionCookies(res: Response, zone: string): void {
  for (const path of TOSSED_COOKIE_PATHS) {
    res.clearCookie(SESSION_COOKIE_NAME, { ...BASE_OPTIONS, domain: zone, path });
  }
}
