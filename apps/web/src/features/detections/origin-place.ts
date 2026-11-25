/**
 * O lugar da faixa do mapa de origens na página, guardado neste navegador por pessoa e cliente: se ela existia da última vez
 * e, aberta, com que altura. Só depois da resposta da API se sabe que o cliente tem o mapa, e o mapa é baixado à parte: com o
 * lugar guardado, a lista não pula quando ele chega, e quem não tem o mapa nunca vê um lugar vazio. O armazenamento pode
 * faltar (janela privada, bloqueio): a página segue sem reservar.
 */

const STORAGE_KEY = 'verax:deteccoes:origens:lugar:';
/** O mapa inteiro, numa tela qualquer, fica bem abaixo disto: além, o guardado não é uma altura. */
const MAX_HEIGHT = 4_000;

export interface OriginPlace {
  /** A altura do conteúdo com a largura de janela de agora; null com outra largura (ou nunca aberta). */
  height: number | null;
}

const keyOf = (userId: string, scope: string): string => `${STORAGE_KEY}${userId}:${scope}`;

/** `largura x altura`, em px inteiros; a altura falta enquanto a faixa nunca foi vista aberta. */
function parse(stored: string): { width: number; height: number } | null {
  const [width, height, ...rest] = stored.split('x').map(Number);
  return rest.length === 0 &&
    width !== undefined &&
    height !== undefined &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    height > 0 &&
    height <= MAX_HEIGHT
    ? { width, height }
    : null;
}

export function readOriginPlace(userId: string, scope: string): OriginPlace | null {
  try {
    const stored = window.localStorage.getItem(keyOf(userId, scope));
    if (stored === null) return null;
    const size = parse(stored);
    return { height: size !== null && size.width === window.innerWidth ? size.height : null };
  } catch {
    return null;
  }
}

/** A faixa existe. Com a altura, a de agora; sem, a guardada fica. */
export function rememberOriginPlace(userId: string, scope: string, height?: number): void {
  try {
    const key = keyOf(userId, scope);
    if (height !== undefined) window.localStorage.setItem(key, `${window.innerWidth}x${Math.ceil(height)}`);
    else if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, 'sim');
  } catch {
    // Sem armazenamento, nada é reservado na próxima vez.
  }
}

export function forgetOriginPlace(userId: string, scope: string): void {
  try {
    window.localStorage.removeItem(keyOf(userId, scope));
  } catch {
    // Sem armazenamento, não há o que esquecer.
  }
}
