/** As telas de acesso: voltar para elas depois de entrar não faz sentido. */
const ACCESS_PATHS = ['/entrar', '/configurar'];

/**
 * O caminho para onde voltar depois de entrar (`?voltar=`), só se for uma tela deste console: começa com uma barra e
 * não com duas (`//outro-site`), sem barra invertida nem esquema. Qualquer outra coisa volta ao início (`/`).
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  // Caracteres de controle (inclusive quebra de linha) nunca entram num caminho do console.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  const pathname = value.split(/[?#]/, 1)[0] ?? '/';
  if (ACCESS_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return '/';
  return value;
}

/** O endereço da tela de entrada, guardando a tela atual para voltar depois. */
export function loginPath(current: string): string {
  const back = safeReturnPath(current);
  return back === '/' ? '/entrar' : `/entrar?voltar=${encodeURIComponent(back)}`;
}
