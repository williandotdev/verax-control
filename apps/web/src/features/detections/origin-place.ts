/**
 * O lugar da faixa do mapa de origens na página, guardado neste navegador por pessoa e cliente: se ela existia da última vez
 * e, aberta, com que altura (a do conteúdo e a do cabeçalho, que ganha texto com a resposta). Só depois da resposta da API se sabe que o cliente tem o mapa, e o mapa é baixado à parte: com o
 * lugar guardado, a lista não pula quando ele chega, e quem não tem o mapa nunca vê um lugar vazio. O armazenamento pode
 * faltar (janela privada, bloqueio): a página segue sem reservar.
 */

const STORAGE_KEY = 'verax:deteccoes:origens:lugar:';
/** O mapa inteiro, numa tela qualquer, fica bem abaixo disto: além, o guardado não é uma altura. */
const MAX_HEIGHT = 4_000;

export interface OriginSize {
  /** A altura do conteúdo. */
  height: number;
  /** A do cabeçalho. */
  header: number;
}

/** Com a largura de janela de agora; null com outra largura (ou nunca aberta). */
export type OriginPlace = OriginSize | { height: null; header: null };

const NO_SIZE: OriginPlace = { height: null, header: null };

const keyOf = (userId: string, scope: string): string => `${STORAGE_KEY}${userId}:${scope}`;

const isSize = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value > 0 && value <= MAX_HEIGHT;

/** `largura x conteúdo x cabeçalho`, em px inteiros; as alturas faltam enquanto a faixa nunca foi vista aberta. */
function parse(stored: string): (OriginSize & { width: number }) | null {
  const [width, height, header, ...rest] = stored.split('x').map(Number);
  return rest.length === 0 && Number.isInteger(width) && isSize(height) && isSize(header)
    ? { width: width as number, height, header }
    : null;
}

export function readOriginPlace(userId: string, scope: string): OriginPlace | null {
  try {
    const stored = window.localStorage.getItem(keyOf(userId, scope));
    if (stored === null) return null;
    const size = parse(stored);
    if (size === null || size.width !== window.innerWidth) return NO_SIZE;
    return { height: size.height, header: size.header };
  } catch {
    return null;
  }
}

/** A faixa existe. Com o tamanho, o de agora; sem, o guardado fica. */
export function rememberOriginPlace(userId: string, scope: string, size?: OriginSize): void {
  try {
    const key = keyOf(userId, scope);
    if (size !== undefined) {
      window.localStorage.setItem(
        key,
        [window.innerWidth, Math.ceil(size.height), Math.ceil(size.header)].join('x'),
      );
    } else if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, 'sim');
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
