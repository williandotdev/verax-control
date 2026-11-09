import type { CookieOptions } from 'express';
import { SESSION_ABSOLUTE_MS } from './admin-auth.schema.js';

/**
 * O cookie da sessão do console. Chama-se `__session` porque é o único cookie que o Firebase Hosting repassa ao Cloud
 * Run num rewrite (o site `admin.veraxsistemas.com.br` → cp-admin). `HttpOnly` (o JavaScript da página não o lê),
 * `Secure`, `SameSite=Strict` (nenhuma navegação ou formulário vindo de outro site o leva) e `Path=/`. O valor é o id
 * opaco da sessão (32 bytes aleatórios em base64url); no Firestore fica só o SHA-256 dele.
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

/** Teto de cookies `__session` conferidos por requisição (normalmente há um só). */
const MAX_CANDIDATES = 3;
const MAX_HEADER_LENGTH = 8192;

/** Os valores do cookie `__session` no cabeçalho `Cookie`, sem decodificação (o id só tem caracteres seguros). */
export function sessionCookieValues(header: string | undefined): string[] {
  if (header === undefined || header.length > MAX_HEADER_LENGTH) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
    if (values.length === MAX_CANDIDATES) break;
  }
  return values;
}
